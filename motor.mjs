// Motor de videos de Tenedor (repositorio público aparte, 06/11/2026: los minutos de GitHub de un repo público no se
// cuentan). Recupera los videos de Instagram cuyo link firmado ya venció: yt-dlp (sin sesión) consigue un link nuevo
// por el permalink, ffmpeg lo achica (576 px, ~1,2 Mbps, faststart) y se sube a Hostinger (videos-ig/<id>.mp4, la misma
// carpeta que usa la app) + su portada; se anota en videos_copia (D1). Los que no se pueden pasan a la cola de Meta
// (pedidos_completitud, tipo video_instagram). Sin dependencias: Node 22 + yt-dlp + ffmpeg.
// Claves (secretos del repo): CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID, D1_APP_ID, D1_FONDO_ID, HOSTINGER_API_TOKEN,
// HOSTINGER_USUARIO. Uso: node motor.mjs [--minutos 330] [--a-la-vez 4] [--por-local 2] [--max N]
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
const MINUTOS = arg("--minutos", 330);
const A_LA_VEZ = arg("--a-la-vez", 4);
const POR_LOCAL = arg("--por-local", 2);
const MAX = arg("--max", Infinity);
const PARTES = arg("--partes", 1);
const PARTE = arg("--parte", 0);
const ESPERA_CORTE_MIN = arg("--espera-corte", 120);
const MAX_ARCHIVO = 60 * 1024 ** 2;
const env = process.env;
for (const k of ["CLOUDFLARE_API_TOKEN", "CLOUDFLARE_ACCOUNT_ID", "D1_APP_ID", "D1_FONDO_ID", "HOSTINGER_API_TOKEN", "HOSTINGER_USUARIO"])
  if (!env[k]) throw new Error(`Falta el secreto ${k}`);
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
const tmp = mkdtempSync(join(tmpdir(), "videos-"));
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
    const c = readFileSync(salida);
    return c.length > 0 && c.length < b.length * 0.85 ? c : b;
  } catch {
    return b;
  } finally {
    rmSync(entrada, { force: true });
    rmSync(salida, { force: true });
  }
}

// ---------- Guardián: si esta parte cortó por bloqueo hace menos de 2 h, no corre (07/11: relanzar a los 30 min
// daba 0 copiados). El motor se programa cada hora y sale solo si todavía no toca. ----------
const CLAVE_CORTE = `motor_videos_corte_${PARTE}_de_${PARTES}`;
const corte = (await d1(env.D1_APP_ID, "SELECT valor FROM ia_config WHERE clave = ?", [CLAVE_CORTE]))[0];
const ultimoCorte = corte ? Date.parse(JSON.parse(String(corte.valor)).en ?? "") : NaN;
if (Number.isFinite(ultimoCorte) && Date.now() - ultimoCorte < ESPERA_CORTE_MIN * 60_000) {
  console.log(`Parte ${PARTE + 1}/${PARTES}: cortó por bloqueo hace ${Math.round((Date.now() - ultimoCorte) / 60000)} min; espera ${ESPERA_CORTE_MIN} min. Nada que hacer.`);
  process.exit(0);
}

// ---------- La cola ----------
const pendientesMeta = new Set(
  (await d1(env.D1_FONDO_ID, "SELECT DISTINCT restaurante_id FROM pedidos_completitud WHERE tipo = 'video_instagram' AND estado = 'pendiente'")).map((x) => String(x.restaurante_id)),
);
const filas = await d1(
  env.D1_APP_ID,
  `SELECT p.id, p.restaurante_id, p.permalink, (p.id IN (SELECT publicacion_id FROM videos_elegidos)) AS eleg FROM publicaciones p LEFT JOIN locales_prioridad lp ON lp.restaurante_id = p.restaurante_id
   WHERE p.tipo = 'video' AND p.plataforma = 'instagram' AND NOT p.oculta AND p.permalink LIKE 'https://www.instagram.com/%'
     AND (p.vence_en <= strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '+20 minutes')
          -- 08/11: también los ELEGIDOS sin copia aunque figuren vigentes (su link de descarga ya no anda y la copia del
          -- Worker los saltea como «vencidos» hasta que Meta lo renueve; yt-dlp baja por el permalink).
          OR p.id IN (SELECT publicacion_id FROM videos_elegidos))
     AND NOT EXISTS (SELECT 1 FROM videos_copia c WHERE c.publicacion_id = p.id)
   ORDER BY CASE lp.nivel WHEN 'S' THEN 0 WHEN 'A' THEN 1 ELSE 2 END, lp.puntaje DESC, p.publicado_en DESC`,
);
// 07/11 (dueño: «armá las mejoras del motor»): primero UN video de cada comercio que todavía no tiene ninguno (cada
// video suma un comercio con video), después el resto, hasta POR_LOCAL. Y la lista se reparte entre varias máquinas
// (--partes N --parte k, por comercio): cada una tiene su IP y Instagram corta por IP.
const conCopia = new Set((await d1(env.D1_APP_ID, "SELECT DISTINCT restaurante_id FROM videos_copia")).map((x) => String(x.restaurante_id)));
const hash = (s) => [...s].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7);
const porLocal = new Map();
const elegibles = filas
  .filter((x) => !pendientesMeta.has(String(x.restaurante_id)))
  .filter((x) => hash(String(x.restaurante_id)) % PARTES === PARTE)
  .map((x) => {
    const k = String(x.restaurante_id);
    porLocal.set(k, (porLocal.get(k) ?? 0) + 1);
    return { ...x, n: porLocal.get(k) + (conCopia.has(k) ? 1 : 0) };
  })
  // Los ELEGIDOS (los que muestra la app, hasta 3 por comercio) no tienen tope por comercio (08/11).
  .filter((x) => x.n <= POR_LOCAL || Number(x.eleg) === 1);
const cola = [...elegibles.filter((x) => x.n === 1), ...elegibles.filter((x) => x.n > 1 && Number(x.eleg) === 1), ...elegibles.filter((x) => x.n > 1 && Number(x.eleg) !== 1)].slice(0, MAX);
console.log(`Videos vencidos sin copia: ${filas.length} · parte ${PARTE + 1}/${PARTES}: ${cola.length} (${elegibles.filter((x) => x.n === 1).length} de comercios sin ningún video primero; hasta ${POR_LOCAL} por comercio, de a ${A_LA_VEZ}, ${MINUTOS} min)`);

const est = { copiados: 0, sinLink: 0, grandes: 0, errores: 0, mbAntes: 0, mbDespues: 0, primerError: "" };
const fallidos = new Set();
const ultimosSinLink = []; // si corta por bloqueo, los últimos «sin link» son el bloqueo, no videos borrados
const copiados = new Set();

async function copiar(p) {
  const limpio = String(p.id).replace(/[^\w-]/g, "");
  const nuevo = await linkNuevo(String(p.permalink));
  await espera(4_000); // 06/11: con 2 s Instagram cortó a los ~490 pedidos
  if (!nuevo) {
    est.sinLink++;
    fallidos.add(String(p.restaurante_id));
    ultimosSinLink.push(String(p.restaurante_id));
    if (ultimosSinLink.length > 6) ultimosSinLink.shift();
    return true;
  }
  ultimosSinLink.length = 0;
  const r = await fetch(nuevo.url, { signal: AbortSignal.timeout(120_000) });
  if (!r.ok) throw new Error(`descarga ${r.status}`);
  const b = Buffer.from(await r.arrayBuffer());
  if (b.length > MAX_ARCHIVO) {
    est.grandes++;
    return true;
  }
  const final = await achicar(b, limpio);
  const url = await subir(`videos-ig/${limpio}.mp4`, final);
  if (nuevo.portada) {
    const img = await fetch(nuevo.portada, { signal: AbortSignal.timeout(20_000) }).then((x) => (x.ok ? x.arrayBuffer() : null)).catch(() => null);
    if (img) {
      await subir(`portadas-ig/${limpio}.jpg`, Buffer.from(img)).catch(() => "");
      await subir(`portadas-ig/${limpio}-160.jpg`, Buffer.from(img)).catch(() => "");
    }
  }
  // El disparador de videos_copia deja la publicación con vence_en 2100 («no vence»): el nivel de imagen la cuenta solo.
  await d1(
    env.D1_APP_ID,
    "INSERT INTO videos_copia (publicacion_id, restaurante_id, url, bytes, copiado_en) VALUES (?, ?, ?, ?, ?) ON CONFLICT (publicacion_id) DO UPDATE SET url = excluded.url, bytes = excluded.bytes, copiado_en = excluded.copiado_en",
    [p.id, p.restaurante_id, url, final.length, new Date().toISOString()],
  );
  est.copiados++;
  est.mbAntes += b.length / 1024 ** 2;
  est.mbDespues += final.length / 1024 ** 2;
  copiados.add(String(p.restaurante_id));
  return true;
}

async function conReintentos(p) {
  for (let i = 0; i < 3; i++) {
    try {
      return await copiar(p);
    } catch (e) {
      if (i === 2) {
        est.errores++;
        const m = e instanceof Error ? e.message : String(e);
        est.primerError ||= m;
        // Un corte de red (07/11: 14 «fetch failed» seguidos en una parte) no es «sin link»: no va a la cola de Meta y
        // queda para la próxima corrida.
        if (!/fetch failed|ECONN|ETIMEDOUT|EAI_AGAIN|socket|aborted|timeout|tiempo agotado|\b(429|5\d\d)\b/i.test(m)) fallidos.add(String(p.restaurante_id));
      } else await espera(5_000 * (i + 1));
    }
  }
}

let i = 0;
let hechos = 0;
await Promise.all(
  Array.from({ length: Math.max(1, Math.min(A_LA_VEZ, cola.length)) }, async () => {
    while (i < cola.length && !cortado && Date.now() - t0 < MINUTOS * 60_000) {
      await conReintentos(cola[i++]);
      if (++hechos % 50 === 0) console.log(`[${hechos}/${cola.length}] ${JSON.stringify({ ...est, mbAntes: Math.round(est.mbAntes), mbDespues: Math.round(est.mbDespues) })} · ${Math.round((Date.now() - t0) / 60000)} min`);
    }
  }),
);

// Los que no se pudieron → pedido a la cola de Meta (dueño 06/11: «los que fallan van a la cola»).
if (cortado) for (const id of ultimosSinLink) fallidos.delete(id);
const aCola = [...fallidos].filter((id) => !copiados.has(id));
for (let k = 0; k < aCola.length; k += 200)
  await d1(
    env.D1_FONDO_ID,
    "INSERT INTO pedidos_completitud (restaurante_id, tipo, estado, creado_en, pedido_por) SELECT value, 'video_instagram', 'pendiente', ?, 'yt-dlp-fallo' FROM json_each(?) WHERE NOT EXISTS (SELECT 1 FROM pedidos_completitud q WHERE q.restaurante_id = value AND q.tipo = 'video_instagram' AND q.estado = 'pendiente')",
    [new Date().toISOString(), JSON.stringify(aCola.slice(k, k + 200))],
  );
rmSync(tmp, { recursive: true, force: true });
if (cortado) {
  console.log(`CORTÓ: ${cortado}`);
  await d1(env.D1_APP_ID, "INSERT INTO ia_config (clave, valor, actualizado_en) VALUES (?, ?, ?) ON CONFLICT (clave) DO UPDATE SET valor = excluded.valor, actualizado_en = excluded.actualizado_en", [CLAVE_CORTE, JSON.stringify({ en: new Date().toISOString(), copiados: est.copiados }), new Date().toISOString()]);
}
console.log(`\nListo en ${Math.round((Date.now() - t0) / 60000)} min: ${JSON.stringify({ ...est, mbAntes: Math.round(est.mbAntes), mbDespues: Math.round(est.mbDespues), comercios: copiados.size, aLaColaDeMeta: aCola.length })}`);
