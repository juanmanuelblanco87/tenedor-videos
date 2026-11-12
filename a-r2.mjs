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
//   --recuperar: además re-apunta las fotos de Instagram vencidas que ya tienen copia en Hostinger (fotos-ig/<id>.jpg
//     registrada en fotos_reales por fotos-ig-copia).
// Reglas del dueño: 429/503 de Hostinger = frenar (sigue la próxima corrida); 3 errores seguidos = cortar la fase; sin
// notificaciones (sale siempre con 0: un rojo de GitHub manda mail). Lo ya copiado se saltea por el listado de R2.
// Escribe «quedan=<n>» en $GITHUB_OUTPUT: el workflow se vuelve a lanzar solo mientras quede trabajo.
import { execFile } from "node:child_process";
import { createHash, createHmac } from "node:crypto";
import { appendFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { portadaDeVideo } from "./portada.mjs";

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
const NO_VENCE = "2100-01-01T00:00:00.000Z";
const BUCKET = "tenedor-media";
const R2 = `https://api.cloudflare.com/client/v4/accounts/${env.CLOUDFLARE_ACCOUNT_ID}/r2/buckets/${BUCKET}/objects`;
const auth = { authorization: `Bearer ${env.CLOUDFLARE_API_TOKEN}` };
const t0 = Date.now();
const quedaTiempo = () => Date.now() - t0 < MINUTOS * 60_000;
const espera = (ms) => new Promise((ok) => setTimeout(ok, ms));
const limpio = (id) => String(id).replace(/[^\w-]/g, "");
const hash = (s) => [...String(s)].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7);
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

// ---------- D1 por la API REST (reintenta si la base está sobrecargada) ----------
async function d1(sql, params = [], intento = 0) {
  const r = await fetch(`https://api.cloudflare.com/client/v4/accounts/${env.CLOUDFLARE_ACCOUNT_ID}/d1/database/${env.D1_APP_ID}/query`, {
    method: "POST",
    headers: { ...auth, "content-type": "application/json" },
    body: JSON.stringify({ sql, params }),
    signal: AbortSignal.timeout(60_000),
  }).catch((e) => ({ ok: false, status: String(e?.name ?? e), json: async () => null }));
  const j = await r.json().catch(() => null);
  if (!r.ok || !j?.success) {
    const m = `D1 ${r.status} ${j?.errors?.map((e) => e.message).join("; ") ?? ""}`;
    if ((r.status === 429 || /overloaded|Timeout|fetch failed/i.test(m)) && intento < 4) {
      await espera([3_000, 8_000, 15_000, 30_000][intento]);
      return d1(sql, params, intento + 1);
    }
    throw new Error(m);
  }
  return { filas: j.result?.[0]?.results ?? [], cambios: j.result?.[0]?.meta?.changes ?? 0 };
}
const consultar = async (sql, params) => (await d1(sql, params)).filas;

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

// ---------- 0) Videos ya copiados en Hostinger (primero: es lo que el feed espera) ----------
if (TOPE.videos > 0) {
  const enR2 = await listarR2("videos-ig/");
  // 12/11 (medido en el iPhone del dueño): el 56 % de los videos copiados no estaba en R2 y el Worker probaba Hostinger
  // (~0,9 s, muchas veces 429 → 302): esos videos llegaban sin nada bajado. Van PRIMERO (antes que portadas y fotos) y
  // por lo que más se ve: elegidos de locales S, A, B, C; después el resto.
  const filas = await consultar(
    `SELECT v.url, v.bytes FROM videos_copia v LEFT JOIN locales_prioridad lp ON lp.restaurante_id = v.restaurante_id
     WHERE v.url LIKE ?
     ORDER BY (v.publicacion_id IN (SELECT publicacion_id FROM videos_elegidos)) DESC,
              CASE coalesce(lp.nivel, 'C') WHEN 'S' THEN 0 WHEN 'A' THEN 1 WHEN 'B' THEN 2 ELSE 3 END, v.copiado_en DESC`,
    [`${ORIGEN}videos-ig/%`],
  );
  const items = filas.map((f) => ({ k: clave(f.url), b: Number(f.bytes) })).filter((x) => x.k && enR2.get(x.k) !== x.b);
  const gbFaltan = items.reduce((s, x) => s + (x.b || 0), 0) / 1e9;
  console.log(`Videos (Hostinger): en R2 ${enR2.size}, faltan ${items.length} (~${gbFaltan.toFixed(1)} GB) de ${filas.length} · tope ${TOPE.videos}${NOCHE ? " (noche)" : ""}`);
  quedan += Math.max(0, items.length - TOPE.videos);
  quedan += await copiarDeHostinger("videos", items.slice(0, TOPE.videos), Math.max(H_PAUSA, 200));
}

// ---------- 1) Portadas ----------
if (TOPE.portadas > 0) {
  const enR2 = await listarR2("portadas-ig/");
  const ids = (await consultar("SELECT publicacion_id AS id FROM videos_copia ORDER BY copiado_en DESC")).map((x) => limpio(x.id));
  const items = ids.flatMap((id) => [`portadas-ig/${id}.jpg`, `portadas-ig/${id}-160.jpg`]).filter((k) => !enR2.has(k)).map((k) => ({ k }));
  console.log(`Portadas: en R2 ${enR2.size}, faltan ${items.length} (de ${ids.length * 2})`);
  quedan += items.length - TOPE.portadas > 0 ? items.length - TOPE.portadas : 0;
  quedan += await copiarDeHostinger("portadas", items.slice(0, TOPE.portadas), H_PAUSA);
}

// ---------- 2) Fotos de Instagram ya copiadas en Hostinger ----------
if (TOPE.fotos > 0 && quedaTiempo()) {
  const enR2 = await listarR2("fotos-ig/");
  const urls = await consultar(
    `SELECT url AS u FROM fotos_reales WHERE url LIKE ? UNION SELECT media_url FROM publicaciones WHERE media_url LIKE ? UNION SELECT portada_url FROM publicaciones WHERE portada_url LIKE ?`,
    [`${ORIGEN}fotos-ig/%`, `${ORIGEN}fotos-ig/%`, `${ORIGEN}fotos-ig/%`],
  );
  const ks = [...new Set(urls.map((x) => clave(x.u)).filter(Boolean))];
  const items = ks.filter((k) => !enR2.has(k)).map((k) => ({ k }));
  console.log(`Fotos IG (Hostinger): en R2 ${enR2.size}, faltan ${items.length} (de ${ks.length})`);
  quedan += Math.max(0, items.length - TOPE.fotos);
  quedan += await copiarDeHostinger("fotos", items.slice(0, TOPE.fotos), H_PAUSA);
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
  // Fotos de Instagram (vencidas o no) cuya copia ya está en fotos-ig/<id>.jpg (fotos-ig-copia la registró en
  // fotos_reales): la publicación pasa a apuntar a la copia. Sólo ids que el Worker de medios acepta.
  const { cambios } = await d1(
    `UPDATE publicaciones SET media_url = ? || id || '.jpg', vence_en = ?
     WHERE plataforma = 'instagram' AND tipo = 'foto' AND (media_url LIKE '%cdninstagram%' OR media_url LIKE '%fbcdn%')
       AND id NOT GLOB '*[^A-Za-z0-9._-]*'
       AND (? || id || '.jpg') IN (SELECT url FROM fotos_reales WHERE url LIKE ?)`,
    [`${MEDIA}fotos-ig/`, NO_VENCE, `${ORIGEN}fotos-ig/`, `${ORIGEN}fotos-ig/%`],
  );
  resumen.recuperadas_por_copia_en_hostinger = cambios;
  console.log(`Recuperar: ${cambios} fotos de Instagram re-apuntadas a su copia de fotos-ig/`);
}

if (TOPE.directos > 0 && quedaTiempo()) {
  const MAX_ARCHIVO = 60 * 1024 ** 2;
  const ahora = Date.now();
  const [enR2v, enR2f] = await Promise.all([listarR2("videos-ig/"), listarR2("fotos-ig/")]);
  const videos = await consultar(
    `SELECT p.id, p.restaurante_id, p.media_url, p.portada_url, p.vence_en, (p.id IN (SELECT publicacion_id FROM videos_elegidos)) AS eleg FROM publicaciones p
     WHERE p.tipo = 'video' AND p.plataforma = 'instagram' AND p.id NOT LIKE 'tv-%' AND coalesce(p.media_url,'') <> ''
       AND (p.oculta = 0 OR p.id IN (SELECT publicacion_id FROM videos_elegidos) OR p.id IN (SELECT publicacion_id FROM videos_revision WHERE accion = 'pendiente'))
       AND NOT EXISTS (SELECT 1 FROM videos_copia c WHERE c.publicacion_id = p.id)`,
  );
  const fotos = await consultar(
    `SELECT id, restaurante_id, media_url, vence_en FROM publicaciones
     WHERE tipo = 'foto' AND plataforma = 'instagram' AND oculta = 0 AND (media_url LIKE '%cdninstagram%' OR media_url LIKE '%fbcdn%')`,
  );
  const fotosReales = await consultar(
    `SELECT restaurante_id, orden, url, vence_en FROM fotos_reales WHERE fuente LIKE 'instagram%' AND (url LIKE '%cdninstagram%' OR url LIKE '%fbcdn%')`,
  );
  const todos = [
    ...videos.map((p) => ({ tipo: "video", id: String(p.id), rid: String(p.restaurante_id), url: String(p.media_url), portada: p.portada_url, eleg: Number(p.eleg) === 1, vence: venceDe(p.media_url, p.vence_en), k: `videos-ig/${limpio(p.id)}.mp4` })),
    ...fotos.map((p) => ({ tipo: "foto", id: String(p.id), rid: String(p.restaurante_id), url: String(p.media_url), vence: venceDe(p.media_url, p.vence_en), k: `fotos-ig/${limpio(p.id)}.jpg` })),
    ...fotosReales.map((f) => ({ tipo: "foto_real", id: `${f.restaurante_id}#${f.orden}`, rid: String(f.restaurante_id), orden: f.orden, url: String(f.url), vence: venceDe(f.url, f.vence_en), k: `fotos-ig/fr-${limpio(f.restaurante_id)}-${hash(f.url).toString(16)}.jpg` })),
  ];
  const yaEnR2 = (x) => (x.tipo === "video" ? enR2v.has(x.k) : enR2f.has(x.k));
  const vivo = (x) => x.vence > ahora + 10 * 60_000;
  // Lo que ya está en R2 se re-apunta aunque el link haya vencido (recupera); lo vivo se copia por orden de vencimiento.
  const mios = todos.filter((x) => hash(x.id) % PARTES === PARTE);
  const cola = [...mios.filter(yaEnR2), ...mios.filter((x) => !yaEnR2(x) && vivo(x)).sort((a, b) => a.vence - b.vence)];
  const vencidos = todos.filter((x) => !yaEnR2(x) && !vivo(x));
  const est = (resumen.directos = {
    parte: `${PARTE + 1}/${PARTES}`,
    videos_sin_copia: videos.length,
    fotos_en_cdn: fotos.length + fotosReales.length,
    vivos_total: todos.filter((x) => !yaEnR2(x) && vivo(x)).length,
    vencidos_total: vencidos.length,
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
  console.log(`Directos ${est.parte}: ${videos.length} videos sin copia + ${est.fotos_en_cdn} fotos en el CDN · vivos ${est.vivos_total} · vencidos ${vencidos.length} · cola de esta parte ${cola.length} · tope ${TOPE.directos}`);
  const negados = new Set();

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
      await apuntar(x, x.tipo === "video" ? enR2v.get(x.k) : enR2f.get(x.k));
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
  est.proximo_vencimiento = restantes.length ? new Date(restantes[0].vence).toISOString() : "";
  quedan += cola.length - i;
  est.mb_bajados = Math.round(est.mb_bajados);
  est.mb_subidos = Math.round(est.mb_subidos);
  est.minutos = Math.round((Date.now() - t0) / 60000);
  // Marca para el lector de anonyig: comercios con contenido vencido sin copia (la parte 0 escribe la lista completa;
  // cada parte suma los que Instagram negó).
  if (PARTE === 0)
    await d1("INSERT INTO ia_config (clave, valor, actualizado_en) VALUES (?, ?, ?) ON CONFLICT (clave) DO UPDATE SET valor = excluded.valor, actualizado_en = excluded.actualizado_en", [
      "r2_directos_vencidos",
      JSON.stringify({ en: new Date().toISOString(), restaurantes: [...new Set(vencidos.filter((x) => x.tipo === "video" ? x.eleg : true).map((x) => x.rid))] }),
      new Date().toISOString(),
    ]);
  if (negados.size)
    await d1("INSERT INTO ia_config (clave, valor, actualizado_en) VALUES (?, ?, ?) ON CONFLICT (clave) DO UPDATE SET valor = excluded.valor, actualizado_en = excluded.actualizado_en", [
      `r2_directos_negados_${PARTE}`,
      JSON.stringify({ en: new Date().toISOString(), restaurantes: [...negados] }),
      new Date().toISOString(),
    ]);
  console.log(`directos: ${JSON.stringify(est)}`);
}
rmSync(tmp, { recursive: true, force: true });
console.log(`\nListo en ${Math.round((Date.now() - t0) / 60000)} min · quedan ${quedan}: ${JSON.stringify(resumen)}`);
if (env.GITHUB_OUTPUT) appendFileSync(env.GITHUB_OUTPUT, `quedan=${quedan}\n`);
