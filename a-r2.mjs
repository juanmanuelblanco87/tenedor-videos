// Copia de medios a Cloudflare R2 (12/11/2026, dueño: «aplicá los arreglos de velocidad, vamos con los 5» y «todo se
// guarda en nuestros servidores: recuperar lo vencido y poner a salvo lo por vencer»). Bucket `tenedor-media`, servido
// por media.tenedor.com.ar (src/cf/medios.ts de la app). Corre en GitHub Actions, nunca en la PC:
//   a-r2.yml           (Hostinger → R2, misma ruta)  --portadas N --fotos N --videos N [--hostinger-a-la-vez 2]
//   a-r2-directos.yml  (Instagram → R2)               --directos N [--partes 4 --parte k] [--a-la-vez 3] [--recuperar]
//
// Hostinger → R2:
//   portadas-ig/<id>.jpg y <id>-160.jpg de los videos con copia; fotos-ig/… de fotos_reales y publicaciones; videos-ig/…
//   de videos_copia que faltan en R2 o cambiaron de tamaño (achicar.mjs los reemplaza con el mismo nombre).
// Instagram → R2 («directos»): todo lo visible (o esperando revisión) que todavía apunta al link firmado del CDN de
//   Instagram, ORDENADO POR VENCIMIENTO (el «oe=<hex>» del link; lo que vence antes va primero):
//   - videos (elegidos, visibles o en revisión) sin copia: se bajan, se achican como achicar.mjs (480 px, 0,8 Mbps,
//     faststart), van a R2 videos-ig/<id>.mp4 y se anotan en videos_copia con la URL de media.tenedor.com.ar (igual que
//     la copia propia de siempre: el disparador deja la publicación «no vence»). Portada (cuadro de 0,5 s de la copia,
//     portada.mjs) a R2 y a Hostinger (la app todavía la arma con datos.tenedor.com.ar/portadas-ig/).
//   - fotos (publicaciones tipo foto visibles y fotos_reales de Instagram): van a R2 fotos-ig/<id>.jpg y la fila pasa a
//     apuntar a media.tenedor.com.ar con vence_en 2100 (no hay tabla de copias de fotos: el feed lee media_url directo).
//   - Si el archivo ya está en R2 (copia anterior, o la fila la volvió a pisar un lector con un link nuevo), no se baja:
//     sólo se vuelve a apuntar. Así se RECUPERA también lo vencido que ya tenía copia propia.
//   - Si Instagram niega el archivo (403/404/410) o el link venció, se saltea (no se rodea) y queda anotado en ia_config
//     «r2_directos_vencidos» (comercios) para el lector de anonyig. 429 de Instagram = frenar esa parte.
//   --recuperar: (hasta el 18/11) re-apuntaba con un UPDATE … LIKE las fotos con copia en Hostinger; ver abajo.
//   --armar-cola [--barrido]: sólo arma la cola de directos y la deja en R2 (job «cola» de a-r2-directos.yml).
// Reglas del dueño: 429/503 de Hostinger = frenar (sigue la próxima corrida); 3 errores seguidos = cortar la fase; sin
// notificaciones (sale siempre con 0: un rojo de GitHub manda mail). Lo ya copiado se saltea por el listado de R2.
// Escribe «quedan=<n>» en $GITHUB_OUTPUT: el workflow se vuelve a lanzar solo mientras quede trabajo.
//
// 18/11/2026 (infra ágil, etapa 5: topes a D1). Antes cada parte barría publicaciones y fotos_reales enteras con
// LIKE '%cdninstagram%' (295 k + 206 k + 132 k filas por parte y por corrida, ~450 corridas en 2 días, y la cadena se
// relanzaba cada 20 min aunque cortara por errores). Ahora:
//   · la cola sale de los índices parciales publicaciones_cola_copia y fotos_reales_cola_copia (migración app 0036),
//     paginada por clave (vence_en, id) de a 500, con tope de filas por corrida (--tope-filas, d1.mjs);
//   · la arma UNA máquina (--armar-cola, job «cola» de a-r2-directos.yml) y la deja en R2; las 4 partes la leen de ahí;
//   · cada hora sólo lo VIVO (vence en más de 10 min); una vez por día (--barrido) también lo vencido: recupera lo que
//     ya está en R2 y escribe «r2_directos_vencidos» para el lector de anonyig (antes lo escribía cada corrida);
//   · --recuperar ya no hace el UPDATE … LIKE (340 k filas, 1,6 s): lo cubre el re-apuntado de lo que ya está en R2
//     (a-r2.yml copia fotos-ig/ de Hostinger a R2 con la misma clave);
//   · Hostinger → R2 recorre videos_copia, fotos_reales y publicaciones por clave en tramos, con cursor en ia_config
//     («a_r2_hostinger_cursor»): cada corrida sigue donde quedó la anterior;
//   · no corre en las horas pico de la app (11 a 15 y 19 a 24 h de Buenos Aires).
import { execFile } from "node:child_process";
import { createHash, createHmac } from "node:crypto";
import { appendFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { portadaDeVideo } from "./portada.mjs";
import { COLA_FOTOS_REALES, COLA_PUBLICACIONES, NO_VENCE, HOSTINGER_VIDEOS, agotado, consultar, d1Base, exigirIndices, guardarCola, guardarCursor, hash, leerCola, leerCursor, resumenLecturas, salirSiPico } from "./d1.mjs";

const ejecutar = promisify(execFile);
const arg = (n, def) => {
  const i = process.argv.indexOf(n);
  return i > 0 ? Number(process.argv[i + 1]) : def;
};
const env = process.env;
for (const k of ["CLOUDFLARE_API_TOKEN", "CLOUDFLARE_ACCOUNT_ID", "D1_APP_ID"]) if (!env[k]) throw new Error(`Falta el secreto ${k}`);
const MINUTOS = arg("--minutos", 100);
const horaAR = (new Date().getUTCHours() + 21) % 24;
const NOCHE = horaAR < 8;
const TOPE = {
  portadas: arg("--portadas", 0),
  fotos: arg("--fotos", 0),
  videos: Math.round(arg("--videos", 0) * (NOCHE ? arg("--noche-x", 1) : 1)),
  directos: arg("--directos", 0),
};
const H_A_LA_VEZ = arg("--hostinger-a-la-vez", 1);
const H_PAUSA = arg("--pausa", 150);
const IG_A_LA_VEZ_PEDIDO = arg("--a-la-vez", 3);
const PARTES = arg("--partes", 1);
const PARTE = arg("--parte", 0);
const RECUPERAR = process.argv.includes("--recuperar");
const DOMINIO = env.HOSTINGER_DOMINIO || "datos.tenedor.com.ar";
const ORIGEN = `https://${DOMINIO}/`;
const MEDIA = "https://media.tenedor.com.ar/";
const BUCKET = "tenedor-media";
const R2 = `https://api.cloudflare.com/client/v4/accounts/${env.CLOUDFLARE_ACCOUNT_ID}/r2/buckets/${BUCKET}/objects`;
const auth = { authorization: `Bearer ${env.CLOUDFLARE_API_TOKEN}` };
const t0 = Date.now();
const quedaTiempo = () => Date.now() - t0 < MINUTOS * 60_000;
const espera = (ms) => new Promise((ok) => setTimeout(ok, ms));
const limpio = (id) => String(id).replace(/[^\w-]/g, "");
const clave = (url) => {
  if (!url || !String(url).startsWith(ORIGEN)) return null;
  const k = decodeURIComponent(String(url).slice(ORIGEN.length).split("?")[0]);
  // «:» se acepta (238 fotos-ig/ig-sc:… de fotos-ig-copia): quedan en R2 listas para cuando el Worker las acepte.
  return /^[a-z0-9._:/-]+$/i.test(k) && !k.includes("..") ? k : null;
};
/** Vencimiento real de un link firmado de Instagram: el menor entre «oe=<hex segundos>» y vence_en. */
const venceDe = (url, venceEn) => {
  const oe = String(url ?? "").match(/[?&]oe=([0-9A-Fa-f]{8})/)?.[1];
  const a = oe ? parseInt(oe, 16) * 1000 : Infinity;
  const b = venceEn ? Date.parse(venceEn) : Infinity;
  return Math.min(a, Number.isFinite(b) ? b : Infinity);
};
let quedan = 0;

const ARMAR_COLA = process.argv.includes("--armar-cola");
const BARRIDO = process.argv.includes("--barrido");
const PAGINA = 500;
salirSiPico(ARMAR_COLA ? "a-r2 (cola)" : "a-r2");
// Las partes que leen la cola de R2 sólo escriben por clave; el resto necesita los índices de la migración 0036.
if (ARMAR_COLA || PARTES === 1)
  await exigirIndices(["publicaciones_cola_copia", "fotos_reales_cola_copia", "videos_elegidos_publicacion", "videos_copia_hostinger_bytes"], "a-r2");

// ---------- D1 (d1.mjs: reintentos, filas leídas por llamada y tope por corrida) ----------
const d1 = async (sql, params = []) => {
  const { filas, cambios } = await d1Base(env.D1_APP_ID, sql, params);
  return { filas, cambios };
};

// ---------- R2 por la API REST ----------
async function listarR2(prefijo) {
  const m = new Map();
  let cursor = "";
  for (;;) {
    const r = await fetch(`${R2}?per_page=1000&prefix=${prefijo}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`, { headers: auth, signal: AbortSignal.timeout(60_000) });
    const j = await r.json();
    if (!j.success) throw new Error(`listar R2 ${prefijo}: ${j.errors?.map((e) => e.message).join("; ")}`);
    for (const o of j.result ?? []) m.set(o.key, o.size);
    cursor = j.result_info?.cursor ?? "";
    if (!cursor || String(j.result_info?.is_truncated) === "false") break;
  }
  return m;
}
// Subida: por la API S3 de R2 si están R2_ACCESS_KEY_ID / R2_SECRET_ACCESS_KEY / R2_ENDPOINT (no cuenta para el límite de
// 1.200 pedidos cada 5 min de api.cloudflare.com, que comparten D1 y los demás procesos); si no, por la API REST, y ante
// un 429 espera (30 s, 60 s, 120 s) en vez de insistir: el 12/11 las 4 partes juntas lo tocaron (≈330 «R2 429»).
const S3 = env.R2_ACCESS_KEY_ID && env.R2_SECRET_ACCESS_KEY && env.R2_ENDPOINT ? { id: env.R2_ACCESS_KEY_ID, secreto: env.R2_SECRET_ACCESS_KEY, base: env.R2_ENDPOINT.replace(/\/$/, "") } : null;
const hmac = (k, d) => createHmac("sha256", k).update(d).digest();
const sha = (d) => createHash("sha256").update(d).digest("hex");
const cod = (x) => encodeURIComponent(x).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
function putS3(k, cuerpo, tipo) {
  const url = new URL(`${S3.base}/${BUCKET}/${k.split("/").map(cod).join("/")}`);
  const fecha = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
  const dia = fecha.slice(0, 8);
  const h = { "content-type": tipo, host: url.host, "x-amz-content-sha256": "UNSIGNED-PAYLOAD", "x-amz-date": fecha };
  const firmados = Object.keys(h).sort().join(";");
  const canonico = ["PUT", url.pathname, "", ...Object.keys(h).sort().map((x) => `${x}:${h[x]}`), "", firmados, "UNSIGNED-PAYLOAD"].join("\n");
  const alcance = `${dia}/auto/s3/aws4_request`;
  const aFirmar = ["AWS4-HMAC-SHA256", fecha, alcance, sha(canonico)].join("\n");
  const llave = hmac(hmac(hmac(hmac(`AWS4${S3.secreto}`, dia), "auto"), "s3"), "aws4_request");
  const firma = createHmac("sha256", llave).update(aFirmar).digest("hex");
  const { host, ...resto } = h;
  return fetch(url, { method: "PUT", headers: { ...resto, authorization: `AWS4-HMAC-SHA256 Credential=${S3.id}/${alcance}, SignedHeaders=${firmados}, Signature=${firma}` }, body: cuerpo, signal: AbortSignal.timeout(180_000) });
}
// Sin claves S3, la copia de Hostinger (no urgente: Hostinger ya sirve esos archivos) no corre, para dejarle el cupo de
// api.cloudflare.com a los directos (que vencen); y los directos bajan a 2 a la vez por parte.
if (!S3 && process.argv.includes("--requiere-s3")) {
  console.log("Faltan las claves S3 de R2 (cargar-secretos-r2.cmd): la copia desde Hostinger espera. Nada que hacer.");
  if (env.GITHUB_OUTPUT) appendFileSync(env.GITHUB_OUTPUT, "quedan=0\n");
  process.exit(0);
}
async function subirR2(k, cuerpo, tipo) {
  for (let intento = 0; ; intento++) {
    const p = await (S3
      ? putS3(k, cuerpo, tipo)
      : fetch(`${R2}/${k.split("/").map(encodeURIComponent).join("/")}`, { method: "PUT", headers: { ...auth, "content-type": tipo }, body: cuerpo, signal: AbortSignal.timeout(180_000) })
    ).catch((e) => ({ ok: false, status: String(e?.name ?? e), text: async () => "" }));
    if (p.ok) return;
    const st = String(p.status);
    if (intento >= 3 || !/^(429|5\d\d|TimeoutError|TypeError)$/.test(st)) throw new Error(`R2 ${st} ${(await p.text()).slice(0, 200)}`);
    await espera(st === "429" ? 30_000 * 2 ** intento : 3_000 * (intento + 1));
  }
}

// ---------- Hostinger (sólo para la portada de los directos; API de archivos, TUS) ----------
let sesion = null;
async function subirHostinger(nombre, contenido, reintento = false) {
  if (!env.HOSTINGER_API_TOKEN || !env.HOSTINGER_USUARIO) return;
  for (let intento = 0; !sesion; intento++) {
    const r = await fetch("https://developers.hostinger.com/api/hosting/v1/files/upload-urls", {
      method: "POST",
      headers: { authorization: `Bearer ${env.HOSTINGER_API_TOKEN}`, "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({ username: env.HOSTINGER_USUARIO, domain: DOMINIO }),
      signal: AbortSignal.timeout(20_000),
    }).catch((e) => ({ ok: false, status: String(e?.name ?? e) }));
    if (r.ok) sesion = await r.json();
    else if (intento >= 2) throw new Error(`upload-urls: ${r.status}`);
    else await espera(5_000 * 2 ** intento);
  }
  const destino = `${sesion.url.replace(/\/$/, "")}/${nombre}?override=true`;
  const comunes = { "X-Auth": sesion.auth_key, "X-Auth-Rest": sesion.rest_auth_key, "Tus-Resumable": "1.0.0" };
  const crear = await fetch(destino, { method: "POST", headers: { ...comunes, "Upload-Length": String(contenido.length) }, signal: AbortSignal.timeout(20_000) });
  const enviar = crear.ok
    ? await fetch(destino, { method: "PATCH", headers: { ...comunes, "Upload-Offset": "0", "Content-Type": "application/offset+octet-stream" }, body: new Uint8Array(contenido), signal: AbortSignal.timeout(60_000) })
    : crear;
  if (!enviar.ok) {
    sesion = null;
    if (reintento) throw new Error(`subida Hostinger: ${enviar.status}`);
    return subirHostinger(nombre, contenido, true);
  }
}

// ---------- Fase genérica Hostinger → R2 ----------
let hostingerFrenado = "";
const resumen = {};
async function copiarDeHostinger(nombre, items, pausaMs) {
  const est = (resumen[nombre] = { pendientes: items.length, copiados: 0, faltan_en_hostinger: 0, errores: 0, gb: 0, por_seg: 0, corte: "" });
  const t1 = Date.now();
  let seguidos = 0;
  let i = 0;
  async function trabajador() {
    while (i < items.length && !est.corte) {
      if (hostingerFrenado) est.corte ||= `Hostinger frenado (${hostingerFrenado})`;
      else if (!quedaTiempo()) est.corte ||= "tiempo";
      if (est.corte) break;
      const it = items[i++];
      try {
        const r = await fetch(ORIGEN + it.k, { signal: AbortSignal.timeout(120_000) });
        if (r.status === 404) {
          est.faltan_en_hostinger++;
          await r.body?.cancel();
          continue;
        }
        if (r.status === 429 || r.status === 503 || r.status === 508) {
          hostingerFrenado = `${r.status} en ${it.k}`;
          est.corte = `Hostinger ${r.status}: freno, sigue la próxima corrida`;
          break;
        }
        if (!r.ok) throw new Error(`Hostinger ${r.status}`);
        const cuerpo = new Uint8Array(await r.arrayBuffer());
        await subirR2(it.k, cuerpo, r.headers.get("content-type") ?? (it.k.endsWith(".mp4") ? "video/mp4" : "image/jpeg"));
        est.copiados++;
        est.gb += cuerpo.length / 1e9;
        seguidos = 0;
        if (est.copiados % 500 === 0) console.log(`  ${nombre}: ${est.copiados} copiados, ${est.gb.toFixed(2)} GB, ${Math.round((Date.now() - t0) / 1000)} s`);
      } catch (e) {
        est.errores++;
        console.log(`  error ${it.k}: ${e instanceof Error ? e.message : e}`);
        if (++seguidos >= 3) est.corte = "3 errores seguidos (regla de operación)";
      }
      await espera(pausaMs);
    }
  }
  await Promise.all(Array.from({ length: Math.max(1, Math.min(H_A_LA_VEZ, items.length)) }, trabajador));
  est.gb = Number(est.gb.toFixed(3));
  est.por_seg = Number((est.copiados / Math.max(1, (Date.now() - t1) / 1000)).toFixed(2));
  console.log(`${nombre}: ${JSON.stringify(est)}`);
  return items.length - est.copiados - est.faltan_en_hostinger;
}

// ---------- Hostinger → R2: recorrido por clave con cursor (a-r2.yml) ----------
// Fases en orden: videos (índice parcial videos_copia_hostinger_bytes: sólo los ~12 k que siguen en Hostinger), portadas
// (claves de videos_copia), fotos de fotos_reales y fotos de publicaciones. Las tres últimas van en tramos de 5.000 por
// clave; al llegar al tope de filas de la corrida se guarda dónde quedó y la próxima corrida sigue desde ahí.
const TRAMO = 5_000;
const CURSOR_H = "a_r2_hostinger_cursor";
const hayHostinger = TOPE.videos > 0 || TOPE.portadas > 0 || TOPE.fotos > 0;
const cursorH = hayHostinger ? await leerCursor(CURSOR_H) : {};
let faseH = cursorH.fase ?? "videos";
let desdeH = cursorH.desde ?? null;
const FASES_H = ["videos", "portadas", "fotos_reales", "publicaciones"];
const pasarFase = () => {
  faseH = FASES_H[FASES_H.indexOf(faseH) + 1] ?? "fin";
  desdeH = null;
};

// 0) Videos ya copiados en Hostinger (primero: es lo que el feed espera).
if (faseH === "videos") {
  if (TOPE.videos > 0) {
    const enR2 = await listarR2("videos-ig/");
    const filas = await consultar(`SELECT url, bytes FROM videos_copia WHERE ${HOSTINGER_VIDEOS}`);
    const items = filas.map((f) => ({ k: clave(f.url), b: Number(f.bytes) })).filter((x) => x.k && enR2.get(x.k) !== x.b);
    console.log(`Videos (Hostinger): en R2 ${enR2.size}, faltan ${items.length} de ${filas.length} · tope ${TOPE.videos}${NOCHE ? " (noche)" : ""}`);
    quedan += Math.max(0, items.length - TOPE.videos);
    quedan += await copiarDeHostinger("videos", items.slice(0, TOPE.videos), Math.max(H_PAUSA, 200));
  }
  pasarFase();
}

// 1) Portadas de los videos con copia (portadas-ig/<id>.jpg y -160.jpg), por clave de videos_copia.
if (faseH === "portadas" && TOPE.portadas > 0) {
  const enR2 = await listarR2("portadas-ig/");
  let faltan = [];
  while (faseH === "portadas" && !agotado() && quedaTiempo()) {
    const ids = (await consultar("SELECT publicacion_id AS id FROM videos_copia WHERE publicacion_id > ? ORDER BY publicacion_id LIMIT ?", [desdeH ?? "", TRAMO])).map((x) => String(x.id));
    faltan.push(...ids.flatMap((id) => [`portadas-ig/${limpio(id)}.jpg`, `portadas-ig/${limpio(id)}-160.jpg`]).filter((k) => !enR2.has(k)));
    if (ids.length < TRAMO) pasarFase();
    else desdeH = ids.at(-1);
  }
  console.log(`Portadas: en R2 ${enR2.size}, faltan ${faltan.length} en lo recorrido`);
  quedan += Math.max(0, faltan.length - TOPE.portadas);
  quedan += await copiarDeHostinger("portadas", faltan.slice(0, TOPE.portadas).map((k) => ({ k })), H_PAUSA);
} else if (faseH === "portadas") pasarFase();
if ((faseH === "fotos_reales" || faseH === "publicaciones") && TOPE.fotos === 0) faseH = "fin";

// 2) Fotos de Instagram ya copiadas en Hostinger (fotos-ig/…): fotos_reales por (restaurante_id, orden) y publicaciones
//    por id. Se trae la columna y se filtra acá (con el LIKE en la consulta, cada tramo podía recorrer la tabla entera).
if ((faseH === "fotos_reales" || faseH === "publicaciones") && TOPE.fotos > 0 && quedaTiempo()) {
  const enR2 = await listarR2("fotos-ig/");
  const ks = new Set();
  const esFotoIg = (u) => typeof u === "string" && u.startsWith(`${ORIGEN}fotos-ig/`);
  while (faseH === "fotos_reales" && !agotado() && quedaTiempo()) {
    const [r, o] = desdeH ?? ["", -1];
    const filas = await consultar("SELECT restaurante_id AS r, orden AS o, url AS u FROM fotos_reales WHERE (restaurante_id, orden) > (?, ?) ORDER BY restaurante_id, orden LIMIT ?", [r, o, TRAMO]);
    for (const f of filas) if (esFotoIg(f.u)) ks.add(clave(f.u));
    if (filas.length < TRAMO) pasarFase();
    else desdeH = [filas.at(-1).r, filas.at(-1).o];
  }
  while (faseH === "publicaciones" && !agotado() && quedaTiempo()) {
    const filas = await consultar("SELECT id, media_url AS m, portada_url AS p FROM publicaciones WHERE id > ? ORDER BY id LIMIT ?", [desdeH ?? "", TRAMO]);
    for (const f of filas) for (const u of [f.m, f.p]) if (esFotoIg(u)) ks.add(clave(u));
    if (filas.length < TRAMO) pasarFase();
    else desdeH = filas.at(-1).id;
  }
  ks.delete(null);
  const items = [...ks].filter((k) => !enR2.has(k)).map((k) => ({ k }));
  console.log(`Fotos IG (Hostinger): en R2 ${enR2.size}, faltan ${items.length} de ${ks.size} en lo recorrido`);
  quedan += Math.max(0, items.length - TOPE.fotos);
  quedan += await copiarDeHostinger("fotos", items.slice(0, TOPE.fotos), H_PAUSA);
}
if (hayHostinger) {
  // Si el recorrido quedó a mitad, la cadena del workflow sigue desde el cursor. Si se completó, la cadena para aunque
  // hayan quedado archivos por encima de los topes: los toma la vuelta del día siguiente (así no gira todo el día
  // recorriendo las tablas otra vez).
  quedan = faseH === "fin" ? 0 : 1;
  await guardarCursor(CURSOR_H, faseH === "fin" ? { fase: "videos", desde: null, completo: true } : { fase: faseH, desde: desdeH });
  console.log(`Hostinger → R2: ${faseH === "fin" ? "recorrido completo" : `sigue la próxima corrida desde ${faseH} ${JSON.stringify(desdeH)}`} · ${resumenLecturas()}`);
}

// ---------- 4) Directos de Instagram → R2 ----------
const tmp = mkdtempSync(join(tmpdir(), "a-r2-"));
async function achicar(b, nombre) {
  // Igual que achicar.mjs / motor.mjs (480 px, crf 28, 0,8 Mbps, faststart). Si no mejora 15 %, queda el original.
  const entrada = join(tmp, `${nombre}.mp4`);
  const salida = join(tmp, `${nombre}-chico.mp4`);
  writeFileSync(entrada, b);
  try {
    const { stdout } = await ejecutar("ffprobe", ["-v", "error", "-show_entries", "stream=codec_type,width,height", "-of", "json", entrada]);
    const j = JSON.parse(stdout);
    const v = j.streams.find((s) => s.codec_type === "video");
    const audio = j.streams.some((s) => s.codec_type === "audio");
    const escala = Number(v?.width) > Number(v?.height) ? "scale=-2:'trunc(min(480,ih)/2)*2'" : "scale='trunc(min(480,iw)/2)*2':-2";
    await ejecutar("ffmpeg", ["-y", "-v", "error", "-i", entrada, "-vf", escala, "-c:v", "libx264", "-preset", "veryfast", "-crf", "28", "-maxrate", "800k", "-bufsize", "1600k", "-g", "60",
      ...(audio ? ["-c:a", "aac", "-b:a", "96k", "-ac", "2"] : ["-an"]), "-movflags", "+faststart", salida], { timeout: 300_000 });
    const c = readFileSync(salida);
    return c.length > 0 && c.length < b.length * 0.85 ? c : b;
  } catch {
    return b;
  } finally {
    rmSync(entrada, { force: true });
    rmSync(salida, { force: true });
  }
}

if (RECUPERAR) {
  // 18/11: el UPDATE … LIKE de antes (340 k filas, 1,6 s por llamada) ya no hace falta: las copias de Hostinger
  // (fotos-ig/<id>.jpg) están en R2 con la misma clave, y el paso de directos re-apunta todo lo que ya está en R2.
  console.log("Recuperar: lo cubre el re-apuntado de lo que ya está en R2 (sin barrer publicaciones).");
}

/**
 * Arma la cola de directos desde los índices parciales (migración app 0036), paginada por (vence_en, clave) de a 500.
 * barrido = false: sólo lo vivo (vence en más de 10 min). barrido = true: todo lo pendiente (también vencidos y sin
 * fecha), para re-apuntar lo vencido que ya está en R2 y armar la lista de vencidos para anonyig.
 */
async function armarColaDirectos(barrido) {
  const ahora = Date.now();
  const desdeVivo = new Date(ahora + 10 * 60_000).toISOString();
  const [enR2v, enR2f] = await Promise.all([listarR2("videos-ig/"), listarR2("fotos-ig/")]);
  const todos = [];
  const cuenta = { videos_sin_copia: 0, fotos_en_cdn: 0, paginas: 0, cortada_por_tope: false };
  // Publicaciones (videos y fotos). Los EXISTS sólo se calculan para los videos (CASE corta).
  const fPub = (p) => {
    if (p.tipo === "video") {
      if (String(p.id).startsWith("tv-") || !p.media_url || Number(p.copia) === 1) return;
      if (!(Number(p.oculta) === 0 || Number(p.eleg) === 1 || Number(p.pend) === 1)) return;
      cuenta.videos_sin_copia++;
      todos.push({ tipo: "video", id: String(p.id), rid: String(p.restaurante_id), url: String(p.media_url), eleg: Number(p.eleg) === 1, vence: venceDe(p.media_url, p.vence_en), k: `videos-ig/${limpio(p.id)}.mp4` });
    } else if (Number(p.oculta) === 0) {
      cuenta.fotos_en_cdn++;
      todos.push({ tipo: "foto", id: String(p.id), rid: String(p.restaurante_id), url: String(p.media_url), vence: venceDe(p.media_url, p.vence_en), k: `fotos-ig/${limpio(p.id)}.jpg` });
    }
  };
  const colsPub = `id, restaurante_id, tipo, oculta, media_url, vence_en,
    CASE WHEN tipo = 'video' THEN EXISTS (SELECT 1 FROM videos_elegidos e WHERE e.publicacion_id = p.id) END AS eleg,
    CASE WHEN tipo = 'video' THEN EXISTS (SELECT 1 FROM videos_revision v WHERE v.publicacion_id = p.id AND v.accion = 'pendiente') END AS pend,
    CASE WHEN tipo = 'video' THEN EXISTS (SELECT 1 FROM videos_copia c WHERE c.publicacion_id = p.id) END AS copia`;
  let cur = [barrido ? "" : desdeVivo, ""];
  for (;;) {
    const filas = await consultar(
      `SELECT ${colsPub} FROM publicaciones p WHERE ${COLA_PUBLICACIONES} AND (vence_en, id) > (?, ?) AND vence_en < '${NO_VENCE}' ORDER BY vence_en, id LIMIT ?`,
      [cur[0], cur[1], PAGINA],
    );
    cuenta.paginas++;
    filas.forEach(fPub);
    if (filas.length < PAGINA) break;
    if (agotado()) { cuenta.cortada_por_tope = true; break; }
    cur = [filas.at(-1).vence_en, filas.at(-1).id];
  }
  if (barrido && !agotado()) {
    // Sin fecha de vencimiento (NULL queda fuera del rango de arriba).
    for (let desde = ""; ; ) {
      const filas = await consultar(`SELECT ${colsPub} FROM publicaciones p WHERE ${COLA_PUBLICACIONES} AND vence_en IS NULL AND id > ? ORDER BY id LIMIT ?`, [desde, PAGINA]);
      filas.forEach(fPub);
      if (filas.length < PAGINA || agotado()) break;
      desde = filas.at(-1).id;
    }
  }
  // fotos_reales de Instagram.
  const fFr = (f) => {
    cuenta.fotos_en_cdn++;
    todos.push({ tipo: "foto_real", id: `${f.restaurante_id}#${f.orden}`, rid: String(f.restaurante_id), orden: f.orden, url: String(f.url), vence: venceDe(f.url, f.vence_en), k: `fotos-ig/fr-${limpio(f.restaurante_id)}-${hash(f.url).toString(16)}.jpg` });
  };
  let cf = [barrido ? "" : desdeVivo, "", -1];
  while (!agotado()) {
    const filas = await consultar(
      `SELECT restaurante_id, orden, url, vence_en FROM fotos_reales WHERE ${COLA_FOTOS_REALES} AND (vence_en, restaurante_id, orden) > (?, ?, ?) AND vence_en < '${NO_VENCE}' ORDER BY vence_en, restaurante_id, orden LIMIT ?`,
      [cf[0], cf[1], cf[2], PAGINA],
    );
    cuenta.paginas++;
    filas.forEach(fFr);
    if (filas.length < PAGINA) break;
    if (agotado()) { cuenta.cortada_por_tope = true; break; }
    const u = filas.at(-1);
    cf = [u.vence_en, u.restaurante_id, u.orden];
  }
  if (barrido && !agotado()) {
    for (let d = ["", -1]; ; ) {
      const filas = await consultar(`SELECT restaurante_id, orden, url, vence_en FROM fotos_reales WHERE ${COLA_FOTOS_REALES} AND vence_en IS NULL AND (restaurante_id, orden) > (?, ?) ORDER BY restaurante_id, orden LIMIT ?`, [d[0], d[1], PAGINA]);
      filas.forEach(fFr);
      if (filas.length < PAGINA || agotado()) break;
      d = [filas.at(-1).restaurante_id, filas.at(-1).orden];
    }
  }
  // Lo que ya está en R2 se re-apunta aunque el link haya vencido (recupera); lo vivo se copia por orden de vencimiento.
  const vivo = (x) => x.vence > ahora + 10 * 60_000;
  const enR2 = (x) => (x.tipo === "video" ? enR2v.get(x.k) : enR2f.get(x.k));
  const items = [];
  const vencidos = [];
  for (const x of todos) {
    const b = enR2(x);
    if (b !== undefined) items.push({ ...x, r2: b });
    else if (vivo(x)) items.push(x);
    else vencidos.push(x);
  }
  // Primero los que ya están en R2 (sólo re-apuntar), después los vivos del que vence antes al que vence después.
  items.sort((a, b) => (b.r2 !== undefined) - (a.r2 !== undefined) || (a.r2 === undefined ? a.vence - b.vence : 0));
  return { items, vencidos, cuenta };
}

if (TOPE.directos > 0 && quedaTiempo()) {
  const MAX_ARCHIVO = 60 * 1024 ** 2;
  const NOMBRE_COLA = "a-r2-directos";
  let cola;
  if (ARMAR_COLA || PARTES === 1) {
    const { items, vencidos, cuenta } = await armarColaDirectos(BARRIDO);
    console.log(`Cola de directos${BARRIDO ? " (barrido)" : ""}: ${cuenta.videos_sin_copia} videos sin copia + ${cuenta.fotos_en_cdn} fotos en el CDN · a trabajar ${items.length} · vencidos sin copia ${vencidos.length}${cuenta.cortada_por_tope ? " · CORTADA por el tope de filas" : ""} · ${resumenLecturas()}`);
    // Marca para el lector de anonyig: comercios con contenido vencido sin copia (sólo el barrido ve los vencidos).
    if (BARRIDO && !cuenta.cortada_por_tope)
      await d1("INSERT INTO ia_config (clave, valor, actualizado_en) VALUES (?, ?, ?) ON CONFLICT (clave) DO UPDATE SET valor = excluded.valor, actualizado_en = excluded.actualizado_en", [
        "r2_directos_vencidos",
        JSON.stringify({ en: new Date().toISOString(), restaurantes: [...new Set(vencidos.filter((x) => (x.tipo === "video" ? x.eleg : true)).map((x) => x.rid))] }),
        new Date().toISOString(),
      ]);
    if (ARMAR_COLA) {
      await guardarCola(NOMBRE_COLA, items, { cuenta, vencidos: vencidos.length });
      console.log(`Cola guardada en R2 (control/colas/${NOMBRE_COLA}.json) para las partes.`);
      if (env.GITHUB_OUTPUT) appendFileSync(env.GITHUB_OUTPUT, `quedan=${items.length}\n`);
      process.exit(0);
    }
    cola = items;
  } else {
    const c = await leerCola(NOMBRE_COLA);
    if (!c) {
      console.log("No está la cola de esta corrida en R2 (el job «cola» no la armó): nada que hacer.");
      if (env.GITHUB_OUTPUT) appendFileSync(env.GITHUB_OUTPUT, "quedan=0\n");
      process.exit(0);
    }
    cola = c.items.filter((x) => hash(x.id) % PARTES === PARTE);
  }
  const est = (resumen.directos = {
    parte: `${PARTE + 1}/${PARTES}`,
    cola_parte: cola.length,
    reapuntados: 0,
    videos: 0,
    fotos: 0,
    negados: 0,
    grandes: 0,
    errores: 0,
    mb_bajados: 0,
    mb_subidos: 0,
    proximo_vencimiento: "",
    corte: "",
  });
  console.log(`Directos ${est.parte}: cola de esta parte ${cola.length} · tope ${TOPE.directos}`);
  const negados = new Set();
  const yaEnR2 = (x) => x.r2 !== undefined;
  const vivo = (x) => x.vence > Date.now() + 10 * 60_000;

  // Las filas se anotan de a tandas (una consulta a D1 cada ~40), no una por archivo: menos pedidos a api.cloudflare.com.
  const porAnotar = { video: [], foto: [], foto_real: [] };
  async function anotar() {
    const { video, foto, foto_real } = porAnotar;
    porAnotar.video = [];
    porAnotar.foto = [];
    porAnotar.foto_real = [];
    if (video.length)
      await d1(
        `INSERT INTO videos_copia (publicacion_id, restaurante_id, url, bytes, copiado_en)
         SELECT value->>'p', value->>'r', value->>'u', value->>'b', value->>'c' FROM json_each(?) WHERE true
         ON CONFLICT (publicacion_id) DO UPDATE SET url = excluded.url, bytes = excluded.bytes, copiado_en = excluded.copiado_en`,
        [JSON.stringify(video)],
      );
    if (foto.length)
      await d1(
        `UPDATE publicaciones SET media_url = j.u, vence_en = ? FROM (SELECT value->>'id' AS id, value->>'u' AS u, value->>'o' AS o FROM json_each(?)) AS j
         WHERE publicaciones.id = j.id AND publicaciones.media_url = j.o`,
        [NO_VENCE, JSON.stringify(foto)],
      );
    if (foto_real.length)
      await d1(
        `UPDATE fotos_reales SET url = j.u, vence_en = ? FROM (SELECT value->>'r' AS r, value->>'n' AS n, value->>'u' AS u, value->>'o' AS o FROM json_each(?)) AS j
         WHERE fotos_reales.restaurante_id = j.r AND fotos_reales.orden = j.n AND fotos_reales.url = j.o`,
        [NO_VENCE, JSON.stringify(foto_real)],
      );
  }
  async function apuntar(x, bytes) {
    if (x.tipo === "video") porAnotar.video.push({ p: x.id, r: x.rid, u: MEDIA + x.k, b: bytes, c: new Date().toISOString() });
    else if (x.tipo === "foto") porAnotar.foto.push({ id: x.id, u: MEDIA + x.k, o: x.url });
    else porAnotar.foto_real.push({ r: x.rid, n: x.orden, u: MEDIA + x.k, o: x.url });
    if (porAnotar.video.length + porAnotar.foto.length + porAnotar.foto_real.length >= 40) await anotar();
  }

  async function uno(x) {
    if (yaEnR2(x)) {
      await apuntar(x, x.r2);
      est.reapuntados++;
      return;
    }
    const r = await fetch(x.url, { signal: AbortSignal.timeout(120_000) });
    if (r.status === 429) {
      await r.body?.cancel();
      est.corte = "Instagram 429: freno, sigue la próxima corrida";
      return;
    }
    if (r.status === 403 || r.status === 404 || r.status === 410) {
      // Link vencido o negado: no se rodea; queda para el lector de anonyig.
      await r.body?.cancel();
      est.negados++;
      negados.add(x.rid);
      return;
    }
    if (!r.ok) throw new Error(`Instagram ${r.status}`);
    const b = Buffer.from(await r.arrayBuffer());
    est.mb_bajados += b.length / 1024 ** 2;
    if (b.length > MAX_ARCHIVO) {
      est.grandes++;
      return;
    }
    if (x.tipo === "video") {
      const final = await achicar(b, limpio(x.id));
      await subirR2(x.k, final, "video/mp4");
      est.mb_subidos += final.length / 1024 ** 2;
      // Portada: el cuadro de los 0,5 s de NUESTRA copia (portada.mjs), no la miniatura de Instagram (12/11: el feed
      // arranca el video en ese cuadro; con la miniatura se veía un salto). Si ffmpeg no puede, queda para portadas-05.
      const archivo = join(tmp, `${limpio(x.id)}-portada.mp4`);
      try {
        writeFileSync(archivo, final);
        const p05 = await portadaDeVideo(archivo);
        for (const [n, jpg] of [[`portadas-ig/${limpio(x.id)}.jpg`, p05.grande], [`portadas-ig/${limpio(x.id)}-160.jpg`, p05.chica]]) {
          await subirR2(n, jpg, "image/jpeg").catch(() => null);
          await subirHostinger(n, jpg).catch(() => null);
        }
      } catch {
        // sin portada propia por ahora
      } finally {
        rmSync(archivo, { force: true });
      }
      await apuntar(x, final.length);
      est.videos++;
    } else {
      const tipo = r.headers.get("content-type") ?? "image/jpeg";
      if (!tipo.startsWith("image/")) {
        // 12/11: hay «fotos» cuyo link es un MP4 (publicaciones de video mal tipadas): la app las muestra como imagen, así
        // que copiarlas no sirve. Se saltean sin contar como error (cortaban la parte a los 3 seguidos).
        est.fotos_que_son_video = (est.fotos_que_son_video ?? 0) + 1;
        return;
      }
      await subirR2(x.k, b, tipo);
      est.mb_subidos += b.length / 1024 ** 2;
      await apuntar(x, b.length);
      est.fotos++;
    }
  }

  const lista = cola.slice(0, TOPE.directos);
  let i = 0;
  let seguidos = 0;
  await Promise.all(
    Array.from({ length: Math.max(1, Math.min(S3 ? IG_A_LA_VEZ_PEDIDO : Math.min(2, IG_A_LA_VEZ_PEDIDO), lista.length)) }, async () => {
      while (i < lista.length && !est.corte && quedaTiempo()) {
        const x = lista[i++];
        if (!yaEnR2(x) && !vivo(x)) continue; // venció mientras esperaba en la cola
        try {
          await uno(x);
          seguidos = 0;
        } catch (e) {
          est.errores++;
          console.log(`  error ${x.tipo} ${x.id}: ${e instanceof Error ? e.message : e}`);
          if (++seguidos >= 3) est.corte = "3 errores seguidos (regla de operación)";
        }
        const n = est.videos + est.fotos + est.reapuntados;
        if (n && n % 200 === 0) console.log(`  directos: ${est.videos} videos, ${est.fotos} fotos, ${est.reapuntados} re-apuntados · ${Math.round((Date.now() - t0) / 60000)} min`);
        await espera(x.tipo === "video" ? 300 : 100);
      }
    }),
  );
  await anotar().catch((e) => console.log(`  error al anotar la última tanda: ${e instanceof Error ? e.message : e}`));
  const restantes = cola.slice(i).filter(vivo);
  est.proximo_vencimiento = restantes.length ? new Date(Math.min(...restantes.map((x) => x.vence))).toISOString() : "";
  // Un corte por errores no cuenta como trabajo pendiente: la cadena no se relanza en seguida (antes giraba cada 20 min
  // cortando a los 3 errores); sigue el horario.
  if (!est.corte.startsWith("3 errores")) quedan += cola.length - i;
  est.mb_bajados = Math.round(est.mb_bajados);
  est.mb_subidos = Math.round(est.mb_subidos);
  est.minutos = Math.round((Date.now() - t0) / 60000);
  if (negados.size)
    await d1("INSERT INTO ia_config (clave, valor, actualizado_en) VALUES (?, ?, ?) ON CONFLICT (clave) DO UPDATE SET valor = excluded.valor, actualizado_en = excluded.actualizado_en", [
      `r2_directos_negados_${PARTE}`,
      JSON.stringify({ en: new Date().toISOString(), restaurantes: [...negados] }),
      new Date().toISOString(),
    ]);
  console.log(`directos: ${JSON.stringify(est)}`);
}
rmSync(tmp, { recursive: true, force: true });
console.log(`\nListo en ${Math.round((Date.now() - t0) / 60000)} min · quedan ${quedan} · ${resumenLecturas()}: ${JSON.stringify(resumen)}`);
if (env.GITHUB_OUTPUT) appendFileSync(env.GITHUB_OUTPUT, `quedan=${quedan}\n`);
