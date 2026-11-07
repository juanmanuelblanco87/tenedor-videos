// Achicado de los videos ya copiados que quedaron pesados (07/11/2026, dueño: «achicá los videos pesados»). La copia
// automática de Cloudflare guarda el original de Instagram (no puede usar ffmpeg): 1.771 pasaban de 4 MB y en el
// celular tardaban en arrancar. Por cada uno: baja de Hostinger (no toca Instagram), lo achica al formato del motor
// (576 px, ~1,2 Mbps, faststart) y lo vuelve a subir con el MISMO nombre (el link no cambia); actualiza bytes.
// Uso: node achicar.mjs [--partes 4 --parte k] [--mb 4] [--minutos 50] [--a-la-vez 2] [--max N]
import { execFile } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const ejecutar = promisify(execFile);
const arg = (n, def) => {
  const i = process.argv.indexOf(n);
  return i > 0 ? Number(process.argv[i + 1]) : def;
};
const PARTES = arg("--partes", 1);
const PARTE = arg("--parte", 0);
const MB = arg("--mb", 4);
const MINUTOS = arg("--minutos", 50);
const A_LA_VEZ = arg("--a-la-vez", 2);
const MAX = arg("--max", Infinity);
const env = process.env;
for (const k of ["CLOUDFLARE_API_TOKEN", "CLOUDFLARE_ACCOUNT_ID", "D1_APP_ID", "HOSTINGER_API_TOKEN", "HOSTINGER_USUARIO"]) if (!env[k]) throw new Error(`Falta el secreto ${k}`);
const DOMINIO = env.HOSTINGER_DOMINIO || "datos.tenedor.com.ar";
const t0 = Date.now();
const espera = (ms) => new Promise((ok) => setTimeout(ok, ms));
// ---------- D1 por la API REST (reintenta si la base está sobrecargada) ----------
async function d1(base, sql, params = [], intento = 0) {
  const r = await fetch(`https://api.cloudflare.com/client/v4/accounts/${env.CLOUDFLARE_ACCOUNT_ID}/d1/database/${base}/query`, {
    method: "POST",
    headers: { authorization: `Bearer ${env.CLOUDFLARE_API_TOKEN}`, "content-type": "application/json" },
    body: JSON.stringify({ sql, params }),
    signal: AbortSignal.timeout(60_000),
  });
  const j = await r.json().catch(() => null);
  if (!r.ok || !j?.success) {
    const m = `D1 ${r.status} ${j?.errors?.map((e) => e.message).join("; ") ?? ""}`;
    if ((r.status === 429 || /overloaded/i.test(m)) && intento < 4) {
      await espera([3_000, 8_000, 15_000, 30_000][intento]);
      return d1(base, sql, params, intento + 1);
    }
    throw new Error(m);
  }
  return j.result?.[0]?.results ?? [];
}

// ---------- Hostinger (API de archivos, TUS) ----------
let sesion = null;
async function subir(nombre, contenido, reintento = false) {
  if (!sesion) {
    const r = await fetch("https://developers.hostinger.com/api/hosting/v1/files/upload-urls", {
      method: "POST",
      headers: { authorization: `Bearer ${env.HOSTINGER_API_TOKEN}`, "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({ username: env.HOSTINGER_USUARIO, domain: DOMINIO }),
      signal: AbortSignal.timeout(20_000),
    });
    if (!r.ok) throw new Error(`upload-urls: ${r.status}`);
    sesion = await r.json();
  }
  const destino = `${sesion.url.replace(/\/$/, "")}/${nombre}?override=true`;
  const comunes = { "X-Auth": sesion.auth_key, "X-Auth-Rest": sesion.rest_auth_key, "Tus-Resumable": "1.0.0" };
  const tope = 30_000 + Math.ceil(contenido.length / 1024 ** 2) * 15_000;
  const crear = await fetch(destino, { method: "POST", headers: { ...comunes, "Upload-Length": String(contenido.length) }, signal: AbortSignal.timeout(20_000) });
  const enviar = crear.ok
    ? await fetch(destino, { method: "PATCH", headers: { ...comunes, "Upload-Offset": "0", "Content-Type": "application/offset+octet-stream" }, body: new Uint8Array(contenido), signal: AbortSignal.timeout(tope) })
    : crear;
  if (!enviar.ok) {
    sesion = null;
    if (reintento) throw new Error(`subida: ${enviar.status}`);
    return subir(nombre, contenido, true);
  }
  return `https://${DOMINIO}/${nombre}`;
}

// ---------- yt-dlp y ffmpeg ----------
let fallosSeguidos = 0;
let cortado = "";
async function linkNuevo(permalink) {
  try {
    const { stdout } = await ejecutar("yt-dlp", ["-q", "--no-warnings", "-f", "best[ext=mp4]/best", "-O", "%(url)s", "-O", "%(thumbnail)s", permalink], { timeout: 90_000 });
    const [url, portada] = stdout.trim().split(/\r?\n/);
    fallosSeguidos = 0;
    return url ? { url, portada: portada && portada !== "NA" ? portada : null } : null;
  } catch {
    if (++fallosSeguidos >= 5) cortado = "5 fallos seguidos de yt-dlp (posible bloqueo de Instagram)";
    return null;
  }
}
const tmp = mkdtempSync(join(tmpdir(), "achicar-"));
async function achicar(b, limpio) {
  const entrada = join(tmp, `${limpio}.mp4`);
  const salida = join(tmp, `${limpio}-chico.mp4`);
  writeFileSync(entrada, b);
  try {
    const { stdout } = await ejecutar("ffprobe", ["-v", "error", "-show_entries", "stream=codec_type,width,height", "-of", "json", entrada]);
    const j = JSON.parse(stdout);
    const v = j.streams.find((s) => s.codec_type === "video");
    const audio = j.streams.some((s) => s.codec_type === "audio");
    const escala = Number(v?.width) > Number(v?.height) ? "scale=-2:'trunc(min(576,ih)/2)*2'" : "scale='trunc(min(576,iw)/2)*2':-2";
    await ejecutar("ffmpeg", ["-y", "-v", "error", "-i", entrada, "-vf", escala, "-c:v", "libx264", "-preset", "veryfast", "-crf", "26", "-maxrate", "1200k", "-bufsize", "2400k", "-g", "60",
      ...(audio ? ["-c:a", "aac", "-b:a", "96k", "-ac", "2"] : ["-an"]), "-movflags", "+faststart", salida], { timeout: 300_000 });
    return readFileSync(salida);
  } finally {
    rmSync(entrada, { force: true });
    rmSync(salida, { force: true });
  }
}

const hash = (s) => [...s].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7);
const filas = await d1(env.D1_APP_ID, "SELECT publicacion_id, url, bytes FROM videos_copia WHERE bytes > ? AND url LIKE ? ORDER BY bytes DESC", [MB * 1024 ** 2, `https://${DOMINIO}/videos-ig/%`]);
// Los que ffmpeg no logra achicar al menos 15 % (ya están en baja calidad) se anotan y no se vuelven a intentar.
const CLAVE_SIN_MEJORA = `achicar_sin_mejora_${PARTE}`;
const guardado = (await d1(env.D1_APP_ID, "SELECT valor FROM ia_config WHERE clave = ?", [CLAVE_SIN_MEJORA]))[0];
const sinMejora = new Set(guardado ? JSON.parse(String(guardado.valor)) : []);
const cola = filas.filter((f) => hash(String(f.publicacion_id)) % PARTES === PARTE && !sinMejora.has(String(f.publicacion_id))).slice(0, MAX);
console.log(`Videos de más de ${MB} MB: ${filas.length} · parte ${PARTE + 1}/${PARTES}: ${cola.length} · de a ${A_LA_VEZ}, ${MINUTOS} min`);
const est = { achicados: 0, yaLivianos: 0, errores: 0, mbAntes: 0, mbDespues: 0, primerError: "" };

async function uno(f) {
  const nombre = new URL(f.url).pathname.slice(1);
  const limpio = nombre.split("/").pop().replace(/\.mp4$/, "");
  const r = await fetch(f.url, { signal: AbortSignal.timeout(180_000) });
  if (!r.ok) throw new Error(`descarga ${r.status}`);
  const b = Buffer.from(await r.arrayBuffer());
  const c = await achicar(b, limpio);
  if (!(c.length > 0 && c.length < b.length * 0.85)) {
    est.yaLivianos++;
    sinMejora.add(String(f.publicacion_id));
    return;
  }
  await subir(nombre, c);
  await d1(env.D1_APP_ID, "UPDATE videos_copia SET bytes = ? WHERE publicacion_id = ?", [c.length, f.publicacion_id]);
  est.achicados++;
  est.mbAntes += b.length / 1024 ** 2;
  est.mbDespues += c.length / 1024 ** 2;
}

let i = 0;
await Promise.all(
  Array.from({ length: Math.max(1, Math.min(A_LA_VEZ, cola.length)) }, async () => {
    while (i < cola.length && Date.now() - t0 < MINUTOS * 60_000) {
      const f = cola[i++];
      for (let intento = 0; intento < 3; intento++) {
        try {
          await uno(f);
          break;
        } catch (e) {
          if (intento === 2) {
            est.errores++;
            est.primerError ||= e instanceof Error ? e.message : String(e);
            // Falla 3 veces seguidas (404 en Hostinger o archivo que ffmpeg no lee): no se reintenta en cada tanda.
            sinMejora.add(String(f.publicacion_id));
            console.log(`ERROR ${f.publicacion_id} ${f.url} · ${(e instanceof Error ? e.message : String(e)).slice(0, 120)}`);
          } else await espera(5_000 * (intento + 1));
        }
      }
    }
  }),
);
rmSync(tmp, { recursive: true, force: true });
await d1(env.D1_APP_ID, "INSERT INTO ia_config (clave, valor, actualizado_en) VALUES (?, ?, ?) ON CONFLICT (clave) DO UPDATE SET valor = excluded.valor, actualizado_en = excluded.actualizado_en", [CLAVE_SIN_MEJORA, JSON.stringify([...sinMejora]), new Date().toISOString()]);
console.log(`\nListo en ${Math.round((Date.now() - t0) / 60000)} min: ${JSON.stringify({ ...est, mbAntes: Math.round(est.mbAntes), mbDespues: Math.round(est.mbDespues), quedan: cola.length - i })}`);
