// Procesa las subidas de «Tus videos» (18/11/2026; app: src/lib/subidas.ts, docs/subidas-tenedor-crudo.md y
// docs/contenido-panel-y-revisor-diseno-v2.md §5-§6). Corre en GitHub Actions (procesar-subida.yml), nunca en la PC.
//
// Por cada subida «recibida» (la toma un UPDATE … WHERE estado = 'recibida': dos corridas no procesan dos veces, R5):
//   · archivo: lo baja de tenedor-crudo (bucket privado, API S3 firmada);
//   · link (Instagram, TikTok, YouTube Shorts; sólo cuentas públicas): lo baja yt-dlp, con la cuenta y la fecha original
//     (N1: la publicación cuenta con esa fecha). Si la cuenta no es la del comercio, queda marcada «cuenta ajena».
//     Corte por bloqueo como el motor: 2 fallas seguidas de una red = no se insiste con esa red en esta corrida.
//   · video: 720 px del lado corto, H.264 CRF 28, SIN AUDIO (L3), sin metadatos, faststart, hasta 3 min. Portadas
//     (cuadro de 0,5 s: portada.mjs, 720 y 160 px). Medida en video_medida (fuente mp4, con el id de la publicación).
//   · imagen: WebP de 1080 px como máximo, sin EXIF; HEIC pasa por heif-convert. Portadas 720 y 160 px.
//   · todo queda en tenedor-crudo/subidas/<id>/ (video.mp4 o imagen.webp, portada.jpg, portada-160.jpg), se borra el
//     original y la subida pasa a «en_revision»: la aprueba o la rechaza una persona en el back.
//   · si algo falla: 2 reintentos (vuelve a «recibida»); al 3.º, «fallo» (el comercio ve «volvé a subirlo»).
// R4 (repo público): el log sólo lleva contadores y tiempos, nunca ids, links, cuentas ni textos.
// Escribe «quedan=<n>» en $GITHUB_OUTPUT: el workflow se vuelve a lanzar solo mientras queden «recibida».
import { execFile } from "node:child_process";
import { createHash, createHmac } from "node:crypto";
import { appendFileSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { portadaDeVideo } from "./portada.mjs";

const ejecutar = promisify(execFile);
const env = process.env;
for (const k of ["CLOUDFLARE_API_TOKEN", "CLOUDFLARE_ACCOUNT_ID", "D1_APP_ID", "R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY", "R2_ENDPOINT"]) if (!env[k]) throw new Error(`Falta el secreto ${k}`);
const arg = (n, def) => {
  const i = process.argv.indexOf(n);
  return i > 0 ? Number(process.argv[i + 1]) : def;
};
const MAXIMO = arg("--max", 20);
const MINUTOS = arg("--minutos", 40);
const INTENTOS_MAX = 3;
const BUCKET = "tenedor-crudo";
const t0 = Date.now();
const quedaTiempo = () => Date.now() - t0 < MINUTOS * 60_000;
const espera = (ms) => new Promise((ok) => setTimeout(ok, ms));
const ahora = () => new Date().toISOString();

// ---------- D1 por la API REST (como a-r2.mjs) ----------
async function d1(sql, params = [], intento = 0) {
  const r = await fetch(`https://api.cloudflare.com/client/v4/accounts/${env.CLOUDFLARE_ACCOUNT_ID}/d1/database/${env.D1_APP_ID}/query`, {
    method: "POST",
    headers: { authorization: `Bearer ${env.CLOUDFLARE_API_TOKEN}`, "content-type": "application/json" },
    body: JSON.stringify({ sql, params }),
    signal: AbortSignal.timeout(60_000),
  }).catch((e) => ({ ok: false, status: String(e?.name ?? e), json: async () => null }));
  const j = await r.json().catch(() => null);
  if (!r.ok || !j?.success) {
    const m = `D1 ${r.status}`;
    if ((r.status === 429 || /overloaded|Timeout|fetch failed/i.test(JSON.stringify(j?.errors ?? ""))) && intento < 4) {
      await espera([3_000, 8_000, 15_000, 30_000][intento]);
      return d1(sql, params, intento + 1);
    }
    throw new Error(m);
  }
  return j.result?.[0]?.results ?? [];
}

// ---------- tenedor-crudo por la API S3 de R2 (firma en el encabezado) ----------
const S3 = { id: env.R2_ACCESS_KEY_ID, secreto: env.R2_SECRET_ACCESS_KEY, base: env.R2_ENDPOINT.replace(/\/$/, "") };
const hmac = (k, d) => createHmac("sha256", k).update(d).digest();
const sha = (d) => createHash("sha256").update(d).digest("hex");
const cod = (x) => encodeURIComponent(x).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
function s3(metodo, k, cuerpo, tipo) {
  const url = new URL(`${S3.base}/${BUCKET}/${k.split("/").map(cod).join("/")}`);
  const fecha = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
  const dia = fecha.slice(0, 8);
  const h = { host: url.host, "x-amz-content-sha256": "UNSIGNED-PAYLOAD", "x-amz-date": fecha, ...(tipo ? { "content-type": tipo } : {}) };
  const firmados = Object.keys(h).sort().join(";");
  const canonico = [metodo, url.pathname, "", ...Object.keys(h).sort().map((x) => `${x}:${h[x]}`), "", firmados, "UNSIGNED-PAYLOAD"].join("\n");
  const alcance = `${dia}/auto/s3/aws4_request`;
  const aFirmar = ["AWS4-HMAC-SHA256", fecha, alcance, sha(canonico)].join("\n");
  const llave = hmac(hmac(hmac(hmac(`AWS4${S3.secreto}`, dia), "auto"), "s3"), "aws4_request");
  const firma = createHmac("sha256", llave).update(aFirmar).digest("hex");
  const { host, ...resto } = h;
  return fetch(url, { method: metodo, headers: { ...resto, authorization: `AWS4-HMAC-SHA256 Credential=${S3.id}/${alcance}, SignedHeaders=${firmados}, Signature=${firma}` }, body: cuerpo, signal: AbortSignal.timeout(300_000) });
}
async function bajar(k, archivo) {
  const r = await s3("GET", k);
  if (!r.ok) throw new Error(`crudo GET ${r.status}`);
  writeFileSync(archivo, Buffer.from(await r.arrayBuffer()));
}
async function subir(k, cuerpo, tipo) {
  for (let i = 0; ; i++) {
    const r = await s3("PUT", k, cuerpo, tipo).catch((e) => ({ ok: false, status: String(e?.name ?? e) }));
    if (r.ok) return;
    if (i >= 2) throw new Error(`crudo PUT ${r.status}`);
    await espera(3_000 * (i + 1));
  }
}
const borrar = (k) => s3("DELETE", k).catch(() => null);

// ---------- medidas ----------
async function medir(archivo) {
  const { stdout } = await ejecutar("ffprobe", ["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height:stream_tags=rotate:stream_side_data=rotation:format=duration", "-of", "json", archivo], { timeout: 60_000 });
  const j = JSON.parse(stdout);
  const s = j.streams?.[0] ?? {};
  const giro = Math.abs(Number(s.tags?.rotate ?? s.side_data_list?.find((x) => x.rotation != null)?.rotation ?? 0)) % 180 === 90;
  const ancho = Number(giro ? s.height : s.width) || null;
  const alto = Number(giro ? s.width : s.height) || null;
  return { ancho, alto, duracion: Number(j.format?.duration) || null };
}
/** Igual que esVertical de la app (src/lib/seleccion-videos-calculo.ts). */
const esVertical = (a, h) => Boolean(a && h && h / a >= 1.5);

// ---------- recodificar ----------
async function video(entrada, salida) {
  // 720 px del lado corto (sin agrandar), sin audio, sin metadatos, hasta 3 min.
  const vf = "scale='if(gt(iw,ih),-2,min(720,iw))':'if(gt(iw,ih),min(720,ih),-2)':flags=lanczos,format=yuv420p";
  await ejecutar("ffmpeg", ["-v", "error", "-y", "-i", entrada, "-t", "180", "-vf", vf, "-c:v", "libx264", "-preset", "veryfast", "-crf", "28", "-an", "-map_metadata", "-1", "-map_chapters", "-1", "-fflags", "+bitexact", "-movflags", "+faststart", salida], { timeout: 900_000 });
}
async function imagen(entrada, dir) {
  let fuente = entrada;
  if (/\.heic$/i.test(entrada)) {
    fuente = join(dir, "convertida.jpg");
    await ejecutar("heif-convert", ["-q", "95", entrada, fuente], { timeout: 120_000 });
  }
  const webp = join(dir, "imagen.webp");
  const g = join(dir, "p.jpg");
  const c = join(dir, "c.jpg");
  // -map_metadata -1: sin EXIF (ubicación, celular). La orientación ya la aplica ffmpeg al decodificar.
  await ejecutar("ffmpeg", ["-v", "error", "-y", "-i", fuente, "-vf", "scale='min(1080,iw)':-2", "-map_metadata", "-1", "-c:v", "libwebp", "-quality", "82", webp], { timeout: 120_000 });
  await ejecutar("ffmpeg", ["-v", "error", "-y", "-i", webp, "-filter_complex", "[0:v]split=2[a][b];[a]scale='min(720,iw)':-2[g];[b]scale=160:-2[c]", "-map", "[g]", "-q:v", "4", g, "-map", "[c]", "-q:v", "5", c], { timeout: 60_000 });
  return { webp, grande: readFileSync(g), chica: readFileSync(c) };
}

// ---------- links ----------
const bloqueada = new Map(); // red → fallas seguidas
async function bajarLink(s, dir) {
  const { stdout } = await ejecutar("yt-dlp", ["--no-warnings", "-q", "-J", "--no-playlist", s.link], { timeout: 120_000, maxBuffer: 20 * 1024 * 1024 });
  const info = JSON.parse(stdout);
  if (info.is_live || info.availability === "needs_auth" || info.availability === "private") throw new Error("link no público");
  await ejecutar("yt-dlp", ["--no-warnings", "-q", "--no-playlist", "-f", "b[ext=mp4]/bv*[ext=mp4]+ba[ext=m4a]/bv*+ba/b", "--merge-output-format", "mp4", "-o", join(dir, "entrada.%(ext)s"), s.link], { timeout: 600_000 });
  const archivo = readdirSync(dir).find((f) => f.startsWith("entrada."));
  if (!archivo) throw new Error("yt-dlp no bajó nada");
  const cuenta = String(info.uploader_id || info.channel || info.uploader || "").replace(/^@/, "").toLowerCase();
  const fecha = info.timestamp ? new Date(info.timestamp * 1000).toISOString() : /^\d{8}$/.test(String(info.upload_date ?? "")) ? `${info.upload_date.slice(0, 4)}-${info.upload_date.slice(4, 6)}-${info.upload_date.slice(6, 8)}T12:00:00.000Z` : null;
  return { archivo: join(dir, archivo), cuenta, fecha };
}
const limpiar = (x) => String(x ?? "").trim().replace(/^@/, "").replace(/^https?:\/\/(www\.)?(instagram|tiktok|youtube)\.com\/@?/i, "").split(/[/?#]/)[0].toLowerCase();

// ---------- una subida ----------
async function procesar(s) {
  const dir = mkdtempSync(join(tmpdir(), "subida-"));
  try {
    let entrada;
    let tipo = s.tipo;
    const extra = { cuenta_link: "", cuenta_ajena: 0, fecha_original: null };
    if (s.origen === "archivo") {
      entrada = join(dir, `entrada.${s.clave.split(".").pop()}`);
      await bajar(s.clave, entrada);
    } else {
      if ((bloqueada.get(s.red) ?? 0) >= 2) throw Object.assign(new Error("red cortada"), { sinIntento: true });
      try {
        const l = await bajarLink(s, dir);
        bloqueada.set(s.red, 0);
        entrada = l.archivo;
        tipo = "video";
        const [local] = await d1("SELECT instagram, tiktok, youtube FROM restaurantes WHERE id = ?", [s.restaurante_id]);
        const propias = [local?.instagram, local?.tiktok, local?.youtube].map(limpiar).filter(Boolean);
        extra.cuenta_link = l.cuenta;
        extra.cuenta_ajena = l.cuenta && propias.includes(l.cuenta) ? 0 : 1;
        extra.fecha_original = l.fecha;
      } catch (e) {
        bloqueada.set(s.red, (bloqueada.get(s.red) ?? 0) + 1);
        throw e;
      }
    }
    const base = `subidas/${s.id}`;
    let procesado;
    let medida;
    if (tipo === "video") {
      const salida = join(dir, "video.mp4");
      await video(entrada, salida);
      medida = await medir(salida);
      const { grande, chica } = await portadaDeVideo(salida);
      procesado = `${base}/video.mp4`;
      await subir(procesado, readFileSync(salida), "video/mp4");
      await subir(`${base}/portada.jpg`, grande, "image/jpeg");
      await subir(`${base}/portada-160.jpg`, chica, "image/jpeg");
      await d1(
        `INSERT INTO video_medida (publicacion_id, fuente, ancho, alto, vertical, motivo, medido_en) VALUES (?, 'mp4', ?, ?, ?, '', ?)
         ON CONFLICT (publicacion_id, fuente) DO UPDATE SET ancho = excluded.ancho, alto = excluded.alto, vertical = excluded.vertical, medido_en = excluded.medido_en`,
        [s.publicacion_id, medida.ancho, medida.alto, esVertical(medida.ancho, medida.alto) ? 1 : 0, ahora()],
      );
    } else {
      const { webp, grande, chica } = await imagen(entrada, dir);
      medida = { ...(await medir(webp)), duracion: null };
      procesado = `${base}/imagen.webp`;
      await subir(procesado, readFileSync(webp), "image/webp");
      await subir(`${base}/portada.jpg`, grande, "image/jpeg");
      await subir(`${base}/portada-160.jpg`, chica, "image/jpeg");
    }
    const hecho = await d1(
      `UPDATE subidas SET estado = 'en_revision', tipo = ?, procesado = ?, portada = ?, ancho = ?, alto = ?, duracion = ?, cuenta_link = ?, cuenta_ajena = ?,
         fecha_original = ?, actualizado_en = ? WHERE id = ? AND estado = 'procesando' RETURNING id`,
      [tipo, procesado, `${base}/portada.jpg`, medida.ancho, medida.alto, medida.duracion, extra.cuenta_link, extra.cuenta_ajena, extra.fecha_original, ahora(), s.id],
    );
    // El original ya no hace falta (y si la rechazaron mientras tanto, se borra todo lo nuestro).
    if (s.origen === "archivo") await borrar(s.clave);
    if (!hecho.length) for (const k of [procesado, `${base}/portada.jpg`, `${base}/portada-160.jpg`]) await borrar(k);
    return "ok";
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// ---------- vuelta ----------
const est = { tomadas: 0, ok: 0, reintento: 0, fallo: 0 };
while (quedaTiempo() && est.tomadas < MAXIMO) {
  const lote = await d1(
    `UPDATE subidas SET estado = 'procesando', actualizado_en = ? WHERE estado = 'recibida'
       AND id IN (SELECT id FROM subidas WHERE estado = 'recibida' ORDER BY creado_en LIMIT ?) RETURNING id, restaurante_id, origen, tipo, clave, link, red, intentos, publicacion_id`,
    [ahora(), Math.min(5, MAXIMO - est.tomadas)],
  );
  if (!lote.length) break;
  est.tomadas += lote.length;
  for (const s of lote) {
    try {
      await procesar(s);
      est.ok++;
    } catch (e) {
      const intentos = Number(s.intentos ?? 0) + (e?.sinIntento ? 0 : 1);
      const fallo = intentos >= INTENTOS_MAX;
      await d1("UPDATE subidas SET estado = ?, intentos = ?, actualizado_en = ? WHERE id = ? AND estado = 'procesando'", [fallo ? "fallo" : "recibida", intentos, ahora(), s.id]).catch(() => {});
      if (fallo && s.origen === "archivo") await borrar(s.clave);
      fallo ? est.fallo++ : est.reintento++;
    }
  }
  // Lo devuelto a «recibida» en esta vuelta no se vuelve a tomar enseguida: queda para la próxima corrida.
  if (est.reintento) break;
}
const [{ n: quedan } = { n: 0 }] = await d1("SELECT count(*) AS n FROM subidas WHERE estado = 'recibida'").catch(() => [{ n: 0 }]);
console.log(`procesar-subida: tomadas ${est.tomadas} · listas para revisar ${est.ok} · reintento ${est.reintento} · fallo ${est.fallo} · quedan ${quedan} · ${Math.round((Date.now() - t0) / 1000)} s`);
if (env.GITHUB_OUTPUT) appendFileSync(env.GITHUB_OUTPUT, `quedan=${est.reintento ? 0 : quedan}\n`);
