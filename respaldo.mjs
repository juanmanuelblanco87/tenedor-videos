// Respaldo fuera de Cloudflare, en Hostinger, con tope de 45 GB (20/11/2026, dueño: «tener un respaldo significaría tener
// doble gasto en almacenamiento: sólo mantenemos el código y el contenido más relevante de toda la base; para esto
// podemos usar Hostinger hasta los 45 GB»). Hostinger ya no sirve a la app (todo sale de R2, hostinger-a-r2.mjs): queda
// como destino de respaldo. Habla con respaldo.php (tenedor-cf-ig/hostinger/), que guarda todo FUERA de public_html.
//
// Qué entra (medido el 20/11):
//   d1      export de las 3 D1 por tabla (JSONL.gz en partes, + esquema.jsonl.gz), leyendo por rowid de a 2.000 filas: NO
//           usa `wrangler d1 export`, que bloquea la base mientras exporta (1,4 GB de la app = minutos sin servir).
//           Rotación: las 4 semanales más recientes + la primera de cada mes de los últimos 3 meses.
//   codigo  git bundle de los repos (tenedor-videos y tenedor-cf-ig, todas las ramas). Quedan los 3 últimos de cada uno.
//   medios  lo más relevante, INCREMENTAL, hasta lo que deje libre el tope: (1) los comercios con equipo (adheridos),
//           (2) S, (3) A por puntaje; de cada uno sus videos elegidos, sus otros videos con copia y sus fotos propias.
//           Se suben de R2; si el archivo todavía está en public_html de Hostinger (la copia vieja), se MUEVE
//           («conservar», sin transferir). Lo que sale de la selección se borra del respaldo (rota por relevancia).
//   podar   (una vez, después de la mudanza) borra de public_html las copias viejas que ya están en R2: libera el disco.
//
// Modo prueba por defecto: lee D1, R2 y el estado de Hostinger y dice qué subiría/borraría y cuánto ocupa. Escribe SÓLO
// con --escribir.
//
// Uso:  node respaldo.mjs [--d1] [--codigo] [--medios] [--rotar] [--podar] [--escribir] [--minutos 300]
//       node respaldo.mjs --medios --solo-conservar --escribir   (1.ª vez, antes de --podar)
//       node respaldo.mjs --estado
//       node respaldo.mjs --restaurar-d1 <app|fondo|hechos> <AAAA-MM-DD> <archivo.sql>   (arma el SQL; NO toca D1)
//       node respaldo.mjs --restaurar-medios [--escribir]   (lo del respaldo que falte en R2 vuelve a R2)
// Variables: CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID, D1_APP_ID, D1_FONDO_ID, D1_HECHOS_ID, RESPALDO_URL,
//            RESPALDO_SECRET [, R2_* para S3]. El código de la app sale de ./app (checkout con la deploy key).
import { execFileSync } from "node:child_process";
import { createHash, createHmac } from "node:crypto";
import { appendFileSync, createWriteStream, existsSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";
import { d1Base, resumenLecturas } from "./d1.mjs";
import { bajarR2, listarR2, subirR2 } from "./r2.mjs";

const env = process.env;
const tiene = (n) => process.argv.includes(n);
const arg = (n, d) => {
  const i = process.argv.indexOf(n);
  return i > 0 ? process.argv[i + 1] : d;
};
const ESCRIBIR = tiene("--escribir");
// --solo-conservar: la primera pasada, con el disco de Hostinger lleno: sólo MUEVE a respaldo-tenedor/ las copias viejas
// relevantes que ya están en public_html (no sube nada); después --podar libera el resto y la pasada normal completa.
const SOLO_CONSERVAR = tiene("--solo-conservar");
const MINUTOS = Number(arg("--minutos", 300));
const GB = 1024 ** 3;
const TOPE = 45 * GB; // regla del dueño (respaldo.php tiene el mismo tope y se niega a pasarlo)
const MARGEN = 2 * GB; // aire para el próximo export de D1 y lo que crezca
const TRAMO = 8 * 1024 ** 2 - 1024; // respaldo.php acepta 8 MB por pedido
const BASES = { app: env.D1_APP_ID, fondo: env.D1_FONDO_ID, hechos: env.D1_HECHOS_ID };
const hoy = new Date().toISOString().slice(0, 10);
const t0 = Date.now();
const quedaTiempo = () => Date.now() - t0 < MINUTOS * 60_000;
const espera = (ms) => new Promise((ok) => setTimeout(ok, ms));
const informe = [];
const anotar = (s) => {
  console.log(s);
  informe.push(s);
};
const gb = (b) => `${(b / GB).toFixed(2)} GB`;

// ---------- respaldo.php (HMAC, igual que archivo.php) ----------
export function firmar(secreto, ts, accion, ruta, desde, fin, total, cuerpo) {
  const h = createHash("sha256").update(cuerpo).digest("hex");
  return { h, firma: createHmac("sha256", secreto).update(`respaldo\n${ts}\n${accion}\n${ruta}\n${desde}\n${fin}\n${total}\n${h}`).digest("hex") };
}
async function php(accion, ruta = "", cuerpo = Buffer.alloc(0), { desde = 0, fin = 0, total = 0 } = {}) {
  if (!env.RESPALDO_URL || !env.RESPALDO_SECRET) throw new Error("Faltan RESPALDO_URL / RESPALDO_SECRET (secretos del repo)");
  for (let intento = 0; ; intento++) {
    const ts = String(Math.floor(Date.now() / 1000));
    const { h, firma } = firmar(env.RESPALDO_SECRET, ts, accion, ruta, desde, fin, total, cuerpo);
    const url = `${env.RESPALDO_URL}?accion=${accion}&ruta=${encodeURIComponent(ruta)}&desde=${desde}&fin=${fin}&total=${total}`;
    const r = await fetch(url, { method: "POST", headers: { "content-type": "application/octet-stream", "x-respaldo-ts": ts, "x-respaldo-firma": firma, "x-respaldo-cuerpo": h }, body: cuerpo, signal: AbortSignal.timeout(180_000) }).catch((e) => ({ ok: false, status: String(e?.name ?? e), headers: new Headers(), json: async () => ({}), arrayBuffer: async () => new ArrayBuffer(0) }));
    // 429/503 de Hostinger: esperar y reintentar (regla de operación: frenar, no insistir).
    if ((r.status === 429 || r.status === 503 || /Timeout|TypeError/.test(String(r.status))) && intento < 3) {
      await espera(20_000 * (intento + 1));
      continue;
    }
    return r;
  }
}
const phpJson = async (...a) => {
  const r = await php(...a);
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`respaldo.php ${a[0]} ${a[1] ?? ""}: ${r.status} ${JSON.stringify(j)}`);
  return j;
};
/** Sube un archivo entero en tramos de 8 MB (respaldo.php los junta y lo cierra con fin=1). */
async function subirRespaldo(ruta, datos) {
  let desde = 0;
  do {
    const parte = datos.subarray(desde, desde + TRAMO);
    const fin = desde + parte.length >= datos.length ? 1 : 0;
    await phpJson("guardar", ruta, parte, { desde, fin, total: desde === 0 ? datos.length : 0 });
    desde += parte.length;
  } while (desde < datos.length);
}
async function leerRespaldo(ruta) {
  const partes = [];
  for (let desde = 0; ; ) {
    const r = await php("leer", ruta, Buffer.alloc(0), { desde });
    if (!r.ok) throw new Error(`leer ${ruta}: ${r.status}`);
    const b = Buffer.from(await r.arrayBuffer());
    partes.push(b);
    desde += b.length;
    if (!b.length || desde >= Number(r.headers.get("x-respaldo-total"))) break;
  }
  return Buffer.concat(partes);
}
async function listarRespaldo(prefijo) {
  const m = new Map();
  for (let desde = 0; ; ) {
    const j = await phpJson("listar", prefijo, Buffer.alloc(0), { desde });
    for (const a of j.archivos ?? []) m.set(a.ruta, a.bytes);
    desde += (j.archivos ?? []).length;
    if (!j.sigue) break;
  }
  return m;
}

// ---------- --estado ----------
// Antes de publicar respaldo.php (o sin secretos) el modo prueba igual mide lo de Cloudflare.
const estado = await phpJson("estado").catch((e) => {
  if (ESCRIBIR) throw e;
  anotar(`respaldo.php no responde (${e instanceof Error ? e.message : e}): se mide sólo lo de Cloudflare`);
  return { total: 0, por_carpeta: {}, libre_disco: 0, archivos_en_public_html: "?", sinPhp: true };
});
anotar(`Hostinger (respaldo-tenedor/): ${gb(estado.total)} de ${gb(TOPE)} · ${JSON.stringify(Object.fromEntries(Object.entries(estado.por_carpeta ?? {}).map(([k, v]) => [k, gb(v)])))} · disco libre ${gb(Number(estado.libre_disco) || 0)} · archivos viejos en public_html ${JSON.stringify(estado.archivos_en_public_html)}`);
if (tiene("--estado")) process.exit(0);

// ---------- D1: export por tabla, por rowid (no bloquea la base) ----------
/** Tablas a exportar: las reales y las FTS (su contenido, por rowid); no las sombras de FTS ni las internas. */
export function tablasExportables(maestro) {
  const virtuales = maestro.filter((t) => t.type === "table" && /^CREATE VIRTUAL/i.test(t.sql ?? "")).map((t) => t.name);
  const sombra = (n) => virtuales.some((v) => n.startsWith(`${v}_`));
  return maestro
    .filter((t) => t.type === "table" && !/^(sqlite_|_cf_|d1_)/.test(t.name) && !sombra(t.name))
    .map((t) => ({ nombre: t.name, sinRowid: /WITHOUT ROWID/i.test(t.sql ?? ""), sql: t.sql }));
}
const PARTE_PLANA = 48 * 1024 ** 2; // 48 MB de JSONL por parte (≈ 6-10 MB comprimido)

async function exportarBase(base) {
  const id = BASES[base];
  if (!id) return anotar(`d1 ${base}: falta el id (D1_${base.toUpperCase()}_ID)`);
  const maestro = (await d1Base(id, "SELECT type, name, tbl_name, sql FROM sqlite_master WHERE sql IS NOT NULL")).filas;
  const tablas = tablasExportables(maestro);
  const ruta = (n) => `d1/${base}/${hoy}/${n}`;
  if (!ESCRIBIR) {
    const info = await fetch(`https://api.cloudflare.com/client/v4/accounts/${env.CLOUDFLARE_ACCOUNT_ID}/d1/database/${id}`, { headers: { authorization: `Bearer ${env.CLOUDFLARE_API_TOKEN}` } }).then((r) => r.json()).catch(() => null);
    const tam = Number(info?.result?.file_size) || 0;
    return anotar(`d1 ${base}: exportaría ${tablas.length} tablas (${tablas.filter((t) => t.sinRowid).length} sin rowid) a ${ruta("")} · la base pesa ${gb(tam)} (comprimido ≈ ${gb(tam * 0.25)}, a confirmar en la primera corrida)`);
  }
  await subirRespaldo(ruta("esquema.jsonl.gz"), gzipSync(maestro.map((t) => JSON.stringify(t) + "\n").join("")));
  let bytesGz = 0;
  let filasTot = 0;
  for (const t of tablas) {
    let parte = 0;
    let buf = [];
    let tam = 0;
    const cerrar = async () => {
      if (!buf.length) return;
      const gz = gzipSync(buf.join(""));
      await subirRespaldo(ruta(`${t.nombre}.${String(parte++).padStart(3, "0")}.jsonl.gz`), gz);
      bytesGz += gz.length;
      buf = [];
      tam = 0;
    };
    let limite = 2000;
    if (t.sinRowid) {
      // Pocas y chicas (medido: locales_excluidos_ids): de a OFFSET.
      for (let off = 0; ; off += limite) {
        const { filas } = await d1Base(id, `SELECT * FROM "${t.nombre}" LIMIT ? OFFSET ?`, [limite, off]);
        for (const f of filas) buf.push(JSON.stringify(f) + "\n");
        filasTot += filas.length;
        if (filas.length < limite) break;
      }
    } else {
      for (let desde = -Infinity; ; ) {
        let filas;
        try {
          ({ filas } = await d1Base(id, `SELECT rowid AS __rowid, * FROM "${t.nombre}" WHERE rowid > ? ORDER BY rowid LIMIT ?`, [Number.isFinite(desde) ? desde : -9e15, limite]));
        } catch (e) {
          // Respuesta demasiado grande (filas con mucho texto): la mitad, hasta 50.
          if (limite > 50) {
            limite = Math.floor(limite / 2);
            continue;
          }
          throw e;
        }
        for (const f of filas) {
          const l = JSON.stringify(f) + "\n";
          buf.push(l);
          tam += l.length;
        }
        filasTot += filas.length;
        if (tam > PARTE_PLANA) await cerrar();
        if (filas.length < limite) break;
        desde = Number(filas.at(-1).__rowid);
        await espera(50);
      }
    }
    await cerrar();
  }
  anotar(`d1 ${base}: ${tablas.length} tablas, ${filasTot} filas, ${gb(bytesGz)} comprimido → ${ruta("")}`);
}

// ---------- Código ----------
async function respaldarCodigo() {
  const repos = [{ nombre: "tenedor-videos", dir: process.cwd() }];
  // La app (privada) la baja respaldo.yml a ./app con la deploy key de sólo lectura (todas las ramas).
  if (existsSync(join(process.cwd(), "app", ".git"))) repos.push({ nombre: "tenedor-cf-ig", dir: join(process.cwd(), "app") });
  else anotar("codigo: no está ./app (checkout con TENEDOR_DEPLOY_KEY): tenedor-cf-ig no entra esta vez");
  for (const r of repos) {
    const archivo = join(tmpdir(), `${r.nombre}-${hoy}.bundle`);
    execFileSync("git", ["-C", r.dir, "bundle", "create", archivo, "--all"], { stdio: "ignore" });
    const datos = readFileSync(archivo);
    if (ESCRIBIR) await subirRespaldo(`codigo/${r.nombre}/${hoy}.bundle`, datos);
    anotar(`codigo ${r.nombre}: ${gb(datos.length)}${ESCRIBIR ? " subido" : " (modo prueba)"}`);
    rmSync(archivo, { force: true });
  }
}

// ---------- Rotación ----------
/** Fechas de export que quedan: las 4 más recientes + la primera de cada mes de los últimos 3 meses. */
export function fechasQueQuedan(fechas, semanales = 4, meses = 3) {
  const orden = [...new Set(fechas)].sort().reverse();
  const quedan = new Set(orden.slice(0, semanales));
  const primeras = new Map();
  for (const f of [...orden].reverse()) if (!primeras.has(f.slice(0, 7))) primeras.set(f.slice(0, 7), f);
  for (const [, f] of [...primeras].sort().reverse().slice(0, meses)) quedan.add(f);
  return quedan;
}
async function rotar() {
  if (estado.sinPhp) return anotar("rotar: sin respaldo.php, nada que rotar");
  const borrar = [];
  for (const base of Object.keys(BASES)) {
    const archivos = await listarRespaldo(`d1/${base}`);
    const fechas = [...archivos.keys()].map((r) => r.split("/")[2]);
    const quedan = fechasQueQuedan(fechas);
    borrar.push(...[...archivos.keys()].filter((r) => !quedan.has(r.split("/")[2])));
  }
  const cod = await listarRespaldo("codigo");
  const porRepo = new Map();
  for (const r of [...cod.keys()].sort().reverse()) porRepo.set(r.split("/")[1], [...(porRepo.get(r.split("/")[1]) ?? []), r]);
  for (const [, rs] of porRepo) borrar.push(...rs.slice(3));
  anotar(`rotar: ${borrar.length} archivos viejos ${ESCRIBIR ? "borrados" : "se borrarían (modo prueba)"}`);
  if (ESCRIBIR) for (const r of borrar) await phpJson("borrar", r);
}

// ---------- Medios relevantes ----------
const MEDIA = "https://media.tenedor.com.ar/";
const claveR2 = (u) => (typeof u === "string" && u.startsWith(MEDIA) ? decodeURIComponent(u.slice(MEDIA.length).split(/[?#]/)[0]) : null);
/**
 * La selección, en orden de relevancia: adheridos (equipo_local), S, A por puntaje. De cada comercio: videos elegidos,
 * otros videos con copia, fotos propias (fotos_reales en media.tenedor.com.ar) y la portada propia de cada video.
 */
async function seleccion() {
  const app = BASES.app;
  const adheridos = (await d1Base(app, "SELECT DISTINCT restaurante_id AS rid FROM equipo_local")).filas.map((f) => String(f.rid));
  const sa = (await d1Base(app, "SELECT restaurante_id AS rid, nivel FROM locales_prioridad WHERE nivel IN ('S', 'A') ORDER BY CASE nivel WHEN 'S' THEN 0 ELSE 1 END, puntaje DESC")).filas.map((f) => String(f.rid));
  const orden = [...new Set([...adheridos, ...sa])];
  const pos = new Map(orden.map((r, i) => [r, i]));
  const items = [];
  for (let i = 0; i < orden.length; i += 400) {
    const ids = JSON.stringify(orden.slice(i, i + 400));
    const v = (await d1Base(app, `SELECT c.restaurante_id AS rid, c.publicacion_id AS id, c.url, c.bytes, EXISTS (SELECT 1 FROM videos_elegidos e WHERE e.publicacion_id = c.publicacion_id) AS eleg
      FROM videos_copia c WHERE c.restaurante_id IN (SELECT value FROM json_each(?))`, [ids])).filas;
    for (const f of v) {
      const k = claveR2(String(f.url).replace("https://datos.tenedor.com.ar/", MEDIA));
      if (!k) continue;
      items.push({ k, rid: String(f.rid), orden: Number(f.eleg) ? 0 : 1 });
      items.push({ k: `portadas-ig/${String(f.id).replace(/[^\w-]/g, "")}.jpg`, rid: String(f.rid), orden: 0 });
    }
    const fo = (await d1Base(app, `SELECT restaurante_id AS rid, url FROM fotos_reales WHERE restaurante_id IN (SELECT value FROM json_each(?)) AND (url LIKE 'https://media.tenedor.com.ar/%' OR url LIKE 'https://datos.tenedor.com.ar/%')`, [ids])).filas;
    for (const f of fo) {
      const k = claveR2(String(f.url).replace("https://datos.tenedor.com.ar/", MEDIA));
      if (k) items.push({ k, rid: String(f.rid), orden: 2 });
    }
  }
  items.sort((a, b) => pos.get(a.rid) - pos.get(b.rid) || a.orden - b.orden);
  return { items: [...new Map(items.map((x) => [x.k, x])).values()], adheridos: adheridos.length, sa: sa.length };
}
async function respaldarMedios(libre) {
  const { items, adheridos, sa } = await seleccion();
  const prefijos = [...new Set(items.map((x) => x.k.split("/")[0] + "/"))];
  const enR2 = new Map();
  for (const p of prefijos) for (const [k, b] of await listarR2(p)) enR2.set(k, b);
  const yaEstan = estado.sinPhp ? new Map() : await listarRespaldo("medios");
  const yaBytes = [...yaEstan.values()].reduce((s, b) => s + b, 0);
  // Llenar hasta el lugar libre (contando lo que ya está, que se reusa).
  const elegidos = [];
  let usado = 0;
  for (const x of items) {
    const b = enR2.get(x.k);
    if (b === undefined) continue;
    if (usado + b > libre + yaBytes) break;
    elegidos.push({ ...x, b });
    usado += b;
  }
  const quiero = new Set(elegidos.map((x) => `medios/${x.k}`));
  const subir = elegidos.filter((x) => !yaEstan.has(`medios/${x.k}`));
  const sacar = [...yaEstan.keys()].filter((r) => !quiero.has(r));
  const ultimo = elegidos.at(-1);
  anotar(`medios: ${items.length} candidatos (${adheridos} adheridos + ${sa} S/A) · entran ${elegidos.length} (${gb(usado)}) hasta ${ultimo ? `el comercio n.º ${new Set(elegidos.map((x) => x.rid)).size}` : "-"} · ya en el respaldo ${yaEstan.size} · subir ${subir.length} (${gb(subir.reduce((s, x) => s + x.b, 0))}) · sacar ${sacar.length}`);
  if (!ESCRIBIR) return;
  for (const r of sacar) await phpJson("borrar", r);
  const est = { movidos: 0, subidos: 0, gb: 0, errores: 0, corte: "" };
  let seguidos = 0;
  for (const x of subir) {
    if (!quedaTiempo()) {
      est.corte = "tiempo (sigue la próxima corrida)";
      break;
    }
    try {
      // Primero «conservar»: si la copia vieja sigue en public_html, se mueve sin transferir.
      const c = await php("conservar", x.k);
      if (c.ok) est.movidos++;
      else if (SOLO_CONSERVAR) continue;
      else {
        const datos = await bajarR2(x.k);
        if (!datos) continue;
        await subirRespaldo(`medios/${x.k}`, datos);
        est.subidos++;
        est.gb += datos.length / GB;
      }
      seguidos = 0;
    } catch (e) {
      est.errores++;
      console.log(`  error ${x.k}: ${e instanceof Error ? e.message : e}`);
      if (e instanceof Error && /507/.test(e.message)) {
        est.corte = "tope de 45 GB";
        break;
      }
      if (++seguidos >= 3) {
        est.corte = "3 errores seguidos (regla de operación)";
        break;
      }
    }
  }
  est.gb = Number(est.gb.toFixed(2));
  anotar(`medios: ${JSON.stringify(est)}`);
}

// ---------- Podar public_html (después de la mudanza a R2) ----------
async function podar() {
  const carpetas = ["videos-ig/", "fotos-ig/", "fotos-fb/", "fotos-gm/", "fotos-woki/", "fotos-web/", "portadas-ig/", "guardados/"];
  let claves = [];
  for (const c of carpetas) claves.push(...(await listarR2(c)).keys());
  claves = claves.filter((k) => !k.includes("/") || /^[A-Za-z0-9._:-]+\/[A-Za-z0-9._:-]+$/.test(k));
  anotar(`podar: ${claves.length} claves que ya están en R2; las copias viejas en public_html con esa clave ${ESCRIBIR ? "se borran" : "se borrarían (modo prueba)"} · public_html hoy: ${JSON.stringify(estado.archivos_en_public_html)}`);
  if (!ESCRIBIR) return;
  let borrados = 0;
  let bytes = 0;
  for (let i = 0; i < claves.length && quedaTiempo(); i += 2000) {
    const j = await phpJson("podar", "", Buffer.from(JSON.stringify(claves.slice(i, i + 2000))));
    borrados += j.borrados;
    bytes += j.bytes;
    await espera(500);
  }
  anotar(`podar: ${borrados} archivos borrados de public_html (${gb(bytes)} liberados)`);
}

// ---------- Restaurar ----------
if (tiene("--restaurar-d1")) {
  // Arma un .sql para cargar en una base NUEVA (wrangler d1 create tenedor-app-restaurada; wrangler d1 execute
  // tenedor-app-restaurada --remote --file <archivo>). Nunca escribe en las bases de producción.
  const [base, fecha, salida] = process.argv.slice(process.argv.indexOf("--restaurar-d1") + 1);
  if (!BASES[base] && !["app", "fondo", "hechos"].includes(base)) throw new Error("base: app | fondo | hechos");
  const archivos = [...(await listarRespaldo(`d1/${base}/${fecha}`)).keys()].sort();
  if (!archivos.length) throw new Error(`no hay respaldo de ${base} del ${fecha}`);
  const esquema = gunzipSync(await leerRespaldo(`d1/${base}/${fecha}/esquema.jsonl.gz`)).toString();
  const bloques = esquema.split("\n").filter(Boolean).map((l) => JSON.parse(l)).map((t) => ({ tipo: t.type, sql: `${t.sql};` }));
  const out = createWriteStream(salida);
  const sql = (s) => out.write(s + "\n");
  sql("PRAGMA defer_foreign_keys = true;");
  // Orden: tablas → datos → índices → disparadores (así los disparadores no corren durante la carga).
  // Las tablas sombra de FTS (x_fts_data, _idx, …) las crea sola su tabla virtual; las internas no se tocan.
  const nombre = (b) => b.sql.match(/^CREATE (?:VIRTUAL )?TABLE (?:IF NOT EXISTS )?["'`]?(\w+)/i)?.[1] ?? "";
  const virtuales = bloques.filter((x) => x.tipo === "table" && /^CREATE VIRTUAL/i.test(x.sql)).map(nombre);
  for (const b of bloques.filter((x) => x.tipo === "table" && !virtuales.some((v) => nombre(x).startsWith(`${v}_`)) && !/^(sqlite_|_cf_|d1_)/.test(nombre(x)))) sql(b.sql);
  const lit = (v) => (v === null ? "NULL" : typeof v === "number" ? String(v) : `'${String(v).replace(/'/g, "''")}'`);
  for (const a of archivos.filter((r) => r.endsWith(".jsonl.gz") && !r.endsWith("/esquema.jsonl.gz"))) {
    const tabla = a.split("/").pop().replace(/\.\d{3}\.jsonl\.gz$/, "");
    for (const l of gunzipSync(await leerRespaldo(a)).toString().split("\n").filter(Boolean)) {
      const f = JSON.parse(l);
      const cols = Object.keys(f).map((c) => (c === "__rowid" ? "rowid" : c));
      sql(`INSERT INTO "${tabla}" (${cols.map((c) => `"${c}"`).join(", ")}) VALUES (${Object.values(f).map(lit).join(", ")});`);
    }
  }
  for (const b of bloques.filter((x) => x.tipo === "index")) sql(b.sql);
  for (const b of bloques.filter((x) => x.tipo === "trigger" || x.tipo === "view")) sql(b.sql);
  out.end();
  console.log(`Listo: ${salida} (${archivos.length} archivos del respaldo). Cargarlo en una base NUEVA con wrangler d1 execute <base-nueva> --remote --file ${salida}`);
  process.exit(0);
}
if (tiene("--restaurar-medios")) {
  const enRespaldo = await listarRespaldo("medios");
  const prefijos = [...new Set([...enRespaldo.keys()].map((r) => r.split("/")[1] + "/"))];
  const enR2 = new Map();
  for (const p of prefijos) for (const [k, b] of await listarR2(p)) enR2.set(k, b);
  const faltan = [...enRespaldo.keys()].filter((r) => !enR2.has(r.slice("medios/".length)));
  console.log(`Restaurar medios: ${enRespaldo.size} en el respaldo, faltan en R2 ${faltan.length}${ESCRIBIR ? "" : " (modo prueba)"}`);
  if (ESCRIBIR) for (const r of faltan) if (quedaTiempo()) await subirR2(r.slice("medios/".length), await leerRespaldo(r), r.endsWith(".mp4") ? "video/mp4" : "image/jpeg");
  process.exit(0);
}

// ---------- Corrida ----------
try {
  if (tiene("--podar")) await podar();
  if (tiene("--rotar")) await rotar();
  if (tiene("--codigo")) await respaldarCodigo();
  if (tiene("--d1")) for (const b of Object.keys(BASES)) await exportarBase(b);
  if (tiene("--medios")) {
    const e = estado.sinPhp ? estado : await phpJson("estado");
    const otros = Number(e.total) - Number(e.por_carpeta?.medios ?? 0);
    // Lugar para medios = tope − lo que ocupan d1/codigo − margen (el export de la semana que viene) − lo que ya hay.
    const libre = Math.max(0, TOPE - otros - Number(e.por_carpeta?.medios ?? 0) - MARGEN - (Number(e.por_carpeta?.d1 ?? 0) > 0 ? 0 : 3 * GB));
    await respaldarMedios(libre);
  }
} catch (e) {
  anotar(`ERROR: ${e instanceof Error ? e.message : e}`);
}
anotar(`Listo en ${Math.round((Date.now() - t0) / 60000)} min · ${ESCRIBIR ? "escribió" : "MODO PRUEBA (no escribió nada)"} · ${resumenLecturas()}`);
if (env.GITHUB_STEP_SUMMARY) appendFileSync(env.GITHUB_STEP_SUMMARY, informe.map((l) => `- ${l}`).join("\n") + "\n");
