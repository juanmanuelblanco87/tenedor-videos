// Mudanza final Hostinger → R2 (20/11/2026, dueño: «terminá de pasar Hostinger»). Deja TODO lo que la app todavía sirve
// desde datos.tenedor.com.ar en R2 (bucket tenedor-media, servido por media.tenedor.com.ar) y repunta las filas de D1.
//
// Medido el 20/11 (sólo lectura): de 12.230 videos de videos_copia en Hostinger, 12.217 ya están en R2 con el mismo tamaño
// (a-r2.yml los copió); 13 no están en ningún lado (404 en Hostinger también). Lo que de verdad falta es el REPUNTE: las
// filas siguen diciendo datos.tenedor.com.ar y el Worker de medios cae a Hostinger cuando algo no está en R2 o la carpeta
// no es de las suyas (fotos-woki/, fotos-web/, videos de la web en la raíz).
//
// Fases (en este orden, por prioridad: visibles primero, después S → A → B, después el resto):
//   1. cola    recorre por rowid las columnas con URLs de Hostinger (tabla de abajo), con tope de filas y fuera del pico,
//              y la deja en R2 control/colas/hostinger-a-r2.json (la reusan las corridas siguientes; --rearmar la rehace).
//   2. copiar  lo que no está en R2 (o tiene otro tamaño, en videos): Hostinger → R2, misma clave (los archivos sueltos de
//              la raíz van a sitio/<nombre>). Frena ante 429/503 de Hostinger, corta a los 3 errores seguidos.
//   3. repuntar las filas cuya clave YA está en R2: UPDATE … FROM json_each por rowid y con la URL vieja como guarda
//              (si otra tarea cambió la fila, no se toca). De a 200 filas por consulta, con pausa.
//
// Modo prueba por defecto: arma la cola y dice qué haría (cuántas filas, cuántos GB, cuánto tarda). Escribe SÓLO con
// --escribir. Cada tanda escrita queda en el registro (R2 control/hostinger-a-r2/registro/<corrida>/<n>.jsonl, privado:
// el Worker no sirve control/) con rowid, URL vieja y nueva. --restaurar <corrida> vuelve cada fila a la URL vieja (si
// nadie la cambió después); también en modo prueba salvo --escribir.
//
// Uso:  node hostinger-a-r2.mjs [--escribir] [--rearmar] [--copiar N] [--repuntar N] [--a-la-vez 3] [--pausa 150]
//                               [--minutos 100] [--tope-filas 400000] [--forzar]
//       node hostinger-a-r2.mjs --restaurar <corrida> [--escribir]
// Sale siempre con 0 (un rojo de GitHub manda mail) y escribe «quedan=<n>» en $GITHUB_OUTPUT.
import { appendFileSync } from "node:fs";
import { agotado, d1Base, resumenLecturas, salirSiPico } from "./d1.mjs";
import { bajarR2, hayS3, listarR2, subirR2 } from "./r2.mjs";

const env = process.env;
for (const k of ["CLOUDFLARE_API_TOKEN", "CLOUDFLARE_ACCOUNT_ID", "D1_APP_ID"]) if (!env[k]) throw new Error(`Falta el secreto ${k}`);
const arg = (n, d) => {
  const i = process.argv.indexOf(n);
  return i > 0 ? process.argv[i + 1] : d;
};
const num = (n, d) => Number(arg(n, d));
const ESCRIBIR = process.argv.includes("--escribir");
const REARMAR = process.argv.includes("--rearmar");
const RESTAURAR = arg("--restaurar", "");
const TOPE_COPIAR = num("--copiar", 20_000);
const TOPE_REPUNTAR = num("--repuntar", 200_000);
const A_LA_VEZ = num("--a-la-vez", 3);
const PAUSA = num("--pausa", 150);
const MINUTOS = num("--minutos", 100);
const TANDA = 200;
const CORRIDA = env.GITHUB_RUN_ID ?? `local-${new Date().toISOString().replace(/\D/g, "").slice(0, 14)}`;
const HOST = "https://datos.tenedor.com.ar/";
const MEDIA = "https://media.tenedor.com.ar/";
const COLA = "hostinger-a-r2";
const REGISTRO = "control/hostinger-a-r2/registro";
const t0 = Date.now();
const quedaTiempo = () => Date.now() - t0 < MINUTOS * 60_000;
const espera = (ms) => new Promise((ok) => setTimeout(ok, ms));
const d1 = (sql, params = []) => d1Base(env.D1_APP_ID, sql, params);
const salir = (quedan) => {
  console.log(`\nListo en ${Math.round((Date.now() - t0) / 60000)} min · ${ESCRIBIR ? "ESCRIBIÓ" : "modo prueba (no escribió nada)"} · quedan ${quedan} · ${resumenLecturas()}`);
  if (env.GITHUB_OUTPUT) appendFileSync(env.GITHUB_OUTPUT, `quedan=${quedan}\n`);
  process.exit(0);
};

/**
 * Columnas con URLs propias en Hostinger (medido el 20/11 sobre todas las columnas *url/foto/portada/video de las 3 D1:
 * sólo estas tienen alguna). `rid` = de qué comercio es (para la prioridad); null = sin comercio (guardados).
 */
export const COLUMNAS = [
  { t: "videos_copia", col: "url", rid: "restaurante_id", oculta: "0" },
  { t: "publicaciones", col: "media_url", rid: "restaurante_id", oculta: "oculta" },
  { t: "publicaciones", col: "portada_url", rid: "restaurante_id", oculta: "oculta" },
  { t: "fotos_reales", col: "url", rid: "restaurante_id", oculta: "0" },
  { t: "publicaciones_guardadas", col: "portada", rid: null, oculta: "0" },
];

/** Clave en Hostinger y clave en R2 de una URL de Hostinger (null si no es un archivo copiable: img-t.php, carpetas raras). */
export function claves(url) {
  if (typeof url !== "string" || !url.startsWith(HOST)) return null;
  const k = decodeURIComponent(url.slice(HOST.length).split(/[?#]/)[0]);
  if (!/^[a-z0-9._:/-]+$/i.test(k) || k.includes("..") || /\.php$/i.test(k)) return null;
  // Los archivos sueltos de la raíz (videos y portadas de la web de los comercios: video-<cuenta>.mp4, ig-<cuenta>-….mp4)
  // van a sitio/ en R2: el Worker sólo sirve carpetas conocidas.
  return { h: k, r: k.includes("/") ? k : `sitio/${k}` };
}
/** Prioridad (menor = antes): visibles de S, de A, de B, sin nivel; después los ocultos o cerrados en el mismo orden. */
export const prioridad = (x) => (x.vis ? 0 : 10) + ({ S: 0, A: 1, B: 2 }[x.nivel] ?? 3);

// ---------- --restaurar <corrida> ----------
if (RESTAURAR) {
  const archivos = [...(await listarR2(`${REGISTRO}/${RESTAURAR}/`)).keys()].sort();
  console.log(`Restaurar la corrida ${RESTAURAR}: ${archivos.length} tandas en el registro${ESCRIBIR ? "" : " (modo prueba: sólo cuenta)"}`);
  let filas = 0;
  let vueltas = 0;
  for (const a of archivos) {
    const lineas = String(await bajarR2(a)).split("\n").filter(Boolean).map((l) => JSON.parse(l));
    filas += lineas.length;
    const porColumna = new Map();
    for (const l of lineas) porColumna.set(`${l.t}.${l.col}`, [...(porColumna.get(`${l.t}.${l.col}`) ?? []), l]);
    for (const [tc, ls] of porColumna) {
      const [t, col] = tc.split(".");
      if (!COLUMNAS.some((c) => c.t === t && c.col === col)) throw new Error(`columna desconocida en el registro: ${tc}`);
      if (!ESCRIBIR) continue;
      const { cambios } = await d1(
        `UPDATE ${t} SET ${col} = j.viejo FROM (SELECT value->>'rowid' AS rid, value->>'viejo' AS viejo, value->>'nuevo' AS nuevo FROM json_each(?)) AS j WHERE ${t}.rowid = j.rid AND ${t}.${col} = j.nuevo`,
        [JSON.stringify(ls.map((l) => ({ rowid: l.rowid, viejo: l.viejo, nuevo: l.nuevo })))],
      );
      vueltas += cambios;
      await espera(PAUSA);
    }
  }
  console.log(`Registro: ${filas} filas · ${ESCRIBIR ? `vueltas a la URL vieja: ${vueltas} (las demás ya habían cambiado y no se tocan)` : "nada escrito"}`);
  salir(0);
}

salirSiPico("hostinger-a-r2");

// ---------- 1) Cola ----------
async function armarCola() {
  const items = [];
  for (const c of COLUMNAS) {
    let desde = 0;
    for (;;) {
      if (agotado()) throw new Error(`tope de filas agotado armando la cola (${c.t}.${c.col}); subir --tope-filas`);
      const sel = c.rid
        ? `SELECT t.rowid AS rowid, t.${c.col} AS u, t.${c.rid} AS rid, ${c.oculta === "0" ? "0" : `t.${c.oculta}`} AS oculta,
                  r.estado AS estado, r.estado_vida AS vida, r.fuera_de_rubro_en AS fuera, lp.nivel AS nivel
           FROM ${c.t} t LEFT JOIN restaurantes r ON r.id = t.${c.rid} LEFT JOIN locales_prioridad lp ON lp.restaurante_id = t.${c.rid}`
        : `SELECT t.rowid AS rowid, t.${c.col} AS u, NULL AS rid, 0 AS oculta, NULL AS estado, NULL AS vida, NULL AS fuera, NULL AS nivel FROM ${c.t} t`;
      const { filas } = await d1(`${sel} WHERE t.rowid > ? AND t.${c.col} LIKE '${HOST}%' ORDER BY t.rowid LIMIT 2000`, [desde]);
      for (const f of filas) {
        const k = claves(f.u);
        if (!k) continue;
        const vis = Number(f.oculta) === 0 && f.estado !== "cerrado" && f.vida !== "cerrado" && !f.fuera && (c.rid ? Boolean(f.estado) : true);
        items.push({ t: c.t, col: c.col, rowid: Number(f.rowid), u: f.u, h: k.h, r: k.r, rid: f.rid, vis, nivel: f.nivel ?? "" });
      }
      if (filas.length < 2000) break;
      desde = Number(filas.at(-1).rowid);
    }
    console.log(`  ${c.t}.${c.col}: ${items.filter((x) => x.t === c.t && x.col === c.col).length} filas con URL de Hostinger`);
  }
  items.sort((a, b) => prioridad(a) - prioridad(b));
  return items;
}

let cola = REARMAR ? null : await leerColaPropia();
async function leerColaPropia() {
  // A diferencia de leerCola (d1.mjs), ésta se reusa entre corridas a propósito: es cara de armar.
  const r = await bajarR2(`control/colas/${COLA}.json`).catch(() => null);
  if (!r) return null;
  const j = JSON.parse(String(r));
  return Date.now() - Date.parse(j.armada_en) < 3 * 86_400_000 ? j.items : null; // más de 3 días: se rehace
}
if (!cola) {
  console.log("Armando la cola (recorrido por rowid de las columnas con URLs de Hostinger)…");
  cola = await armarCola();
  // Por S3 (la cola de ~140 k filas pesa varios MB; guardarCola de d1.mjs va por la API REST).
  if (ESCRIBIR) await subirR2(`control/colas/${COLA}.json`, JSON.stringify({ corrida: CORRIDA, armada_en: new Date().toISOString(), items: cola }), "application/json");
  else console.log("Modo prueba: la cola no se guarda (la próxima corrida la vuelve a armar).");
}

// ---------- Estado contra R2 ----------
const prefijos = [...new Set(cola.map((x) => (x.r.startsWith("sitio/") ? "sitio/" : x.r.split("/")[0] + "/")))];
const enR2 = new Map();
for (const p of prefijos) for (const [k, b] of await listarR2(p)) enR2.set(k, b);
// Tamaño esperado sólo para videos_copia (columna bytes): ahí un archivo de otro tamaño es una copia vieja (achicar.mjs).
const tamanoVideo = new Map();
if (cola.some((x) => x.t === "videos_copia")) {
  for (const f of (await d1("SELECT url, bytes FROM videos_copia WHERE url LIKE 'https://datos.tenedor.com.ar/videos-ig/%'")).filas) tamanoVideo.set(claves(f.url)?.r, Number(f.bytes));
}
const esta = (x) => enR2.has(x.r) && (!tamanoVideo.has(x.r) || !tamanoVideo.get(x.r) || enR2.get(x.r) === tamanoVideo.get(x.r));
const porCopiar = [...new Map(cola.filter((x) => !esta(x)).map((x) => [x.r, x])).values()];
const resumen = {};
for (const x of cola) {
  const k = `${x.t}.${x.col} ${x.r.split("/")[0]}`;
  const e = (resumen[k] ??= { filas: 0, visibles: 0, en_r2: 0, faltan: 0 });
  e.filas++;
  if (x.vis) e.visibles++;
  if (esta(x)) e.en_r2++;
  else e.faltan++;
}
console.log(`Cola: ${cola.length} filas · archivos por copiar ${porCopiar.length} (visibles ${porCopiar.filter((x) => x.vis).length})`);
console.table(resumen);

// ---------- 2) Copiar Hostinger → R2 ----------
const est = { copiados: 0, gb: 0, no_estan_en_hostinger: 0, errores: 0, corte: "" };
const noEstan = [];
if (ESCRIBIR && !hayS3) console.log("Sin claves S3 de R2: la copia va por la API REST (más lenta, comparte el cupo de api.cloudflare.com).");
if (!ESCRIBIR) {
  // Muestra de tamaños (HEAD a Hostinger, hasta 12 al azar por carpeta) para estimar GB y tiempo sin bajar nada.
  const porCarpeta = new Map();
  for (const x of porCopiar) {
    const c = x.r.split("/")[0];
    if (!porCarpeta.has(c)) porCarpeta.set(c, []);
    porCarpeta.get(c).push(x);
  }
  let gb = 0;
  for (const [c, xs] of porCarpeta) {
    const muestra = [...xs].sort(() => Math.random() - 0.5).slice(0, 12);
    let bytes = 0;
    let n = 0;
    let faltan = 0;
    for (const x of muestra) {
      const r = await fetch(HOST + x.h, { method: "HEAD", signal: AbortSignal.timeout(20_000) }).catch(() => null);
      if (r?.ok) {
        bytes += Number(r.headers.get("content-length")) || 0;
        n++;
      } else faltan++;
      await espera(PAUSA);
    }
    const g = n ? ((bytes / n) * xs.length * (n / (n + faltan))) / 1e9 : 0;
    gb += g;
    est.no_estan_en_hostinger += faltan;
    console.log(`  ${c}: ${xs.length} por copiar · promedio ${n ? Math.round(bytes / n / 1024) : "?"} KB · ~${g.toFixed(2)} GB · muestra ${muestra.length} (${faltan} no están en Hostinger)`);
  }
  console.log(`Modo prueba · copiaría ${porCopiar.length} archivos (~${gb.toFixed(2)} GB) · ~${Math.ceil(porCopiar.length / (A_LA_VEZ * 2) / 60)} min a ${A_LA_VEZ} a la vez (≈2 por segundo cada uno)`);
} else {
  const lista = porCopiar.slice(0, TOPE_COPIAR);
  let i = 0;
  let seguidos = 0;
  await Promise.all(
    Array.from({ length: Math.max(1, Math.min(A_LA_VEZ, lista.length)) }, async () => {
      while (i < lista.length && !est.corte) {
        if (!quedaTiempo()) {
          est.corte ||= "tiempo";
          break;
        }
        const x = lista[i++];
        try {
          const r = await fetch(HOST + x.h, { signal: AbortSignal.timeout(120_000) });
          if (r.status === 404) {
            await r.body?.cancel();
            est.no_estan_en_hostinger++;
            noEstan.push(x.h);
            continue;
          }
          if (r.status === 429 || r.status === 503 || r.status === 508) {
            await r.body?.cancel();
            est.corte = `Hostinger ${r.status}: freno, sigue la próxima corrida`;
            break;
          }
          if (!r.ok) throw new Error(`Hostinger ${r.status}`);
          const cuerpo = new Uint8Array(await r.arrayBuffer());
          await subirR2(x.r, cuerpo, r.headers.get("content-type") ?? (x.r.endsWith(".mp4") ? "video/mp4" : "image/jpeg"));
          enR2.set(x.r, cuerpo.length);
          tamanoVideo.delete(x.r);
          est.copiados++;
          est.gb += cuerpo.length / 1e9;
          seguidos = 0;
          if (est.copiados % 500 === 0) console.log(`  copiados ${est.copiados} · ${est.gb.toFixed(2)} GB · ${Math.round((Date.now() - t0) / 1000)} s`);
        } catch (e) {
          est.errores++;
          console.log(`  error ${x.h}: ${e instanceof Error ? e.message : e}`);
          if (++seguidos >= 3) est.corte = "3 errores seguidos (regla de operación)";
        }
        await espera(PAUSA);
      }
    }),
  );
  est.gb = Number(est.gb.toFixed(3));
  console.log(`Copia: ${JSON.stringify(est)}${noEstan.length ? ` · no están en Hostinger: ${noEstan.slice(0, 30).join(", ")}${noEstan.length > 30 ? "…" : ""}` : ""}`);
}

// ---------- 3) Repuntar ----------
const aRepuntar = cola.filter(esta).slice(0, TOPE_REPUNTAR);
const rep = { filas: aRepuntar.length, escritas: 0, tandas: 0, saltadas_por_guarda: 0 };
if (!ESCRIBIR) {
  console.log(`Modo prueba · repuntaría ${aRepuntar.length} filas (${aRepuntar.filter((x) => x.vis).length} visibles) a ${MEDIA} en ${Math.ceil(aRepuntar.length / TANDA)} consultas de ${TANDA} (~${Math.ceil((aRepuntar.length / TANDA) * (PAUSA + 400) / 60000)} min)`);
} else {
  const grupos = new Map();
  for (const x of aRepuntar) {
    const g = `${x.t}.${x.col}`;
    if (!grupos.has(g)) grupos.set(g, []);
    grupos.get(g).push(x);
  }
  let n = 0;
  for (const [g, xs] of grupos) {
    const [t, col] = g.split(".");
    for (let i = 0; i < xs.length && quedaTiempo(); i += TANDA) {
      const tanda = xs.slice(i, i + TANDA).map((x) => ({ t, col, rowid: x.rowid, viejo: x.u, nuevo: MEDIA + x.r }));
      // Primero el registro (si no se puede guardar, no se escribe).
      await subirR2(`${REGISTRO}/${CORRIDA}/${String(n++).padStart(5, "0")}.jsonl`, tanda.map((l) => JSON.stringify(l)).join("\n") + "\n", "application/x-ndjson");
      const { cambios } = await d1(
        `UPDATE ${t} SET ${col} = j.nuevo FROM (SELECT value->>'rowid' AS rid, value->>'viejo' AS viejo, value->>'nuevo' AS nuevo FROM json_each(?)) AS j WHERE ${t}.rowid = j.rid AND ${t}.${col} = j.viejo`,
        [JSON.stringify(tanda.map(({ rowid, viejo, nuevo }) => ({ rowid, viejo, nuevo })))],
      );
      rep.escritas += cambios;
      rep.saltadas_por_guarda += tanda.length - cambios;
      rep.tandas++;
      await espera(PAUSA);
    }
  }
  console.log(`Repunte: ${JSON.stringify(rep)} · registro en R2 ${REGISTRO}/${CORRIDA}/ (para volver atrás: --restaurar ${CORRIDA} --escribir)`);
}
const quedan = ESCRIBIR ? Math.max(0, porCopiar.length - est.copiados - est.no_estan_en_hostinger) + Math.max(0, cola.filter(esta).length - rep.escritas - rep.saltadas_por_guarda) : 0;
if (ESCRIBIR && quedan === 0) await subirR2(`control/colas/${COLA}.json`, JSON.stringify({ armada_en: "2000-01-01T00:00:00Z", items: [] }), "application/json"); // cola terminada: la próxima la rehace y mide
salir(quedan);
