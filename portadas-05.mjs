// Regenera las portadas propias de los videos con copia (12/11/2026, dueño: «y regenerá las portadas luego»).
// Cada portada pasa a ser el cuadro de los 0,5 s de NUESTRA copia del video (portada.mjs), que es donde el feed arranca
// el video la primera vez. Las que venían de Instagram (miniatura o tapa armada) no coinciden y al arrancar el video se
// veía un salto. Por cada video de videos_copia:
//   1. saca el cuadro de 0,5 s de la copia que se reproduce (media.tenedor.com.ar/videos-ig/…; ffmpeg pide sólo el comienzo);
//   2. lo compara con la portada que hay en R2 (diferencia media en gris; ≤ 3 = la misma imagen);
//   3. si falta o difiere, sube portadas-ig/<id>.jpg y <id>-160.jpg a R2 (misma ruta). Hostinger no se toca: el Worker de
//      medios sirve R2 primero (Hostinger sólo si falta en R2).
// La app tiene que subir la versión de la portada (?v=3, y que la caché del borde la tenga en cuenta) DESPUÉS de que esto
// termine; si no, los teléfonos y el borde siguen con la vieja hasta 30 días.
// Avance en ia_config «portadas_05» (cursor por publicacion_id): se puede cortar y volver a correr.
// Reglas del dueño: corre en GitHub Actions, nunca en la PC; tandas con pausa; 3 errores seguidos = corta (y no se vuelve a
// lanzar sola); sin notificaciones (sale siempre con 0). Escribe «quedan=<n>» en $GITHUB_OUTPUT para encadenar.
// Uso: node portadas-05.mjs [--max 3000] [--a-la-vez 4] [--pausa 150] [--minutos 100] [--prueba]  (--prueba: no sube ni avanza)
import { createHash, createHmac } from "node:crypto";
import { appendFileSync } from "node:fs";
import { diferencia, portadaDeVideo } from "./portada.mjs";

const arg = (n, def) => {
  const i = process.argv.indexOf(n);
  return i > 0 ? Number(process.argv[i + 1]) : def;
};
const env = process.env;
for (const k of ["CLOUDFLARE_API_TOKEN", "CLOUDFLARE_ACCOUNT_ID", "D1_APP_ID", "R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY", "R2_ENDPOINT"])
  if (!env[k]) throw new Error(`Falta el secreto ${k}`);
const MAX = arg("--max", 3000);
const A_LA_VEZ = arg("--a-la-vez", 4);
const PAUSA = arg("--pausa", 150);
const MINUTOS = arg("--minutos", 100);
const PRUEBA = process.argv.includes("--prueba");
const BUCKET = "tenedor-media";
const MEDIA = "https://media.tenedor.com.ar/";
const CLAVE_AVANCE = "portadas_05";
const t0 = Date.now();
const quedaTiempo = () => Date.now() - t0 < MINUTOS * 60_000;
const espera = (ms) => new Promise((ok) => setTimeout(ok, ms));
const limpio = (id) => String(id).replace(/[^\w-]/g, "");

// ---------- D1 (API REST) ----------
async function d1(sql, params = [], intento = 0) {
  const r = await fetch(`https://api.cloudflare.com/client/v4/accounts/${env.CLOUDFLARE_ACCOUNT_ID}/d1/database/${env.D1_APP_ID}/query`, {
    method: "POST",
    headers: { authorization: `Bearer ${env.CLOUDFLARE_API_TOKEN}`, "content-type": "application/json" },
    body: JSON.stringify({ sql, params }),
    signal: AbortSignal.timeout(60_000),
  }).catch((e) => ({ ok: false, status: String(e?.name ?? e), json: async () => null }));
  const j = await r.json().catch(() => null);
  if (!r.ok || !j?.success) {
    if (intento < 4) {
      await espera([3_000, 8_000, 15_000, 30_000][intento]);
      return d1(sql, params, intento + 1);
    }
    throw new Error(`D1 ${r.status} ${j?.errors?.map((e) => e.message).join("; ") ?? ""}`);
  }
  return j.result?.[0]?.results ?? [];
}

// ---------- R2 por la API S3 (no gasta el cupo de api.cloudflare.com) ----------
const S3 = { id: env.R2_ACCESS_KEY_ID, secreto: env.R2_SECRET_ACCESS_KEY, base: env.R2_ENDPOINT.replace(/\/$/, "") };
const hmac = (k, d) => createHmac("sha256", k).update(d).digest();
const sha = (d) => createHash("sha256").update(d).digest("hex");
const cod = (x) => encodeURIComponent(x).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
function s3(metodo, k, cuerpo, tipo) {
  const url = new URL(`${S3.base}/${BUCKET}/${k.split("/").map(cod).join("/")}`);
  const fecha = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
  const dia = fecha.slice(0, 8);
  const h = { ...(tipo ? { "content-type": tipo } : {}), host: url.host, "x-amz-content-sha256": "UNSIGNED-PAYLOAD", "x-amz-date": fecha };
  const firmados = Object.keys(h).sort().join(";");
  const canonico = [metodo, url.pathname, "", ...Object.keys(h).sort().map((x) => `${x}:${h[x]}`), "", firmados, "UNSIGNED-PAYLOAD"].join("\n");
  const alcance = `${dia}/auto/s3/aws4_request`;
  const aFirmar = ["AWS4-HMAC-SHA256", fecha, alcance, sha(canonico)].join("\n");
  const llave = hmac(hmac(hmac(hmac(`AWS4${S3.secreto}`, dia), "auto"), "s3"), "aws4_request");
  const firma = createHmac("sha256", llave).update(aFirmar).digest("hex");
  const { host: _h, ...resto } = h;
  return fetch(url, { method: metodo, headers: { ...resto, authorization: `AWS4-HMAC-SHA256 Credential=${S3.id}/${alcance}, SignedHeaders=${firmados}, Signature=${firma}` }, body: cuerpo, signal: AbortSignal.timeout(60_000) });
}
async function leerR2(k) {
  const r = await s3("GET", k);
  if (r.status === 404) return null;
  if (!r.ok) throw new Error(`R2 GET ${r.status}`);
  return Buffer.from(await r.arrayBuffer());
}
async function subirR2(k, cuerpo) {
  for (let intento = 0; ; intento++) {
    const r = await s3("PUT", k, cuerpo, "image/jpeg").catch((e) => ({ ok: false, status: String(e?.name ?? e), text: async () => "" }));
    if (r.ok) return;
    if (intento >= 3 || !/^(429|5\d\d|TimeoutError|TypeError)$/.test(String(r.status))) throw new Error(`R2 PUT ${r.status}`);
    await espera(r.status === 429 ? 30_000 * 2 ** intento : 3_000 * (intento + 1));
  }
}

// ---------- Videos que ya están en R2 ----------
// Sólo esos (12/11): los demás salen de Hostinger por el Worker, que con 429 hace esperar a los teléfonos. Los que faltan
// quedan contados («sin_r2») y se hacen en otra pasada (--de-nuevo) cuando a-r2 los haya copiado.
async function listarR2(prefijo) {
  const m = new Set();
  let cursor = "";
  for (;;) {
    const r = await fetch(`https://api.cloudflare.com/client/v4/accounts/${env.CLOUDFLARE_ACCOUNT_ID}/r2/buckets/${BUCKET}/objects?per_page=1000&prefix=${prefijo}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`, {
      headers: { authorization: `Bearer ${env.CLOUDFLARE_API_TOKEN}` },
      signal: AbortSignal.timeout(60_000),
    });
    const j = await r.json();
    if (!j.success) throw new Error(`listar R2: ${j.errors?.map((e) => e.message).join("; ")}`);
    for (const o of j.result ?? []) m.add(o.key);
    cursor = j.result_info?.cursor ?? "";
    if (!cursor || String(j.result_info?.is_truncated) === "false") break;
  }
  return m;
}
const videosEnR2 = await listarR2("videos-ig/");

// ---------- Avance ----------
const previo = (await d1("SELECT valor FROM ia_config WHERE clave = ?", [CLAVE_AVANCE]))[0];
const av = previo ? JSON.parse(previo.valor) : { desde: "", revisadas: 0, iguales: 0, casi: 0, distintas: 0, faltaban: 0, sin_video: 0, errores: 0, empezado: new Date().toISOString() };
if (process.argv.includes("--de-nuevo") && av.terminado) {
  // Otra pasada completa (los que estaban sólo en Hostinger ya pasaron a R2): los iguales se saltean sin subir.
  Object.assign(av, { desde: "", revisadas: 0, iguales: 0, casi: 0, distintas: 0, faltaban: 0, sin_video: 0, sin_r2: 0, errores: 0, terminado: null, pasada: (av.pasada ?? 1) + 1 });
}
if (av.terminado) {
  console.log(`Ya terminado (${JSON.stringify(av)}). Para repetir: --de-nuevo.`);
  if (env.GITHUB_OUTPUT) appendFileSync(env.GITHUB_OUTPUT, "quedan=0\n");
  process.exit(0);
}
const total = Number((await d1("SELECT count(*) AS n FROM videos_copia"))[0].n);
const lista = await d1("SELECT publicacion_id AS id, url FROM videos_copia WHERE publicacion_id > ? ORDER BY publicacion_id LIMIT ?", [av.desde ?? "", MAX]);
console.log(`Portadas 0,5 s: ${total} videos con copia; ya revisados ${av.revisadas}; esta tanda ${lista.length}${PRUEBA ? " (PRUEBA: no sube)" : ""}`);

// Las respuestas se procesan en paralelo, pero el cursor sólo avanza hasta el último id con todos los anteriores listos.
const listos = new Array(lista.length).fill(false);
let corte = "";
let seguidos = 0;
let i = 0;
const ejemplos = [];
async function uno(f) {
  const id = limpio(f.id);
  const archivo = String(f.url).split("/videos-ig/")[1]?.split("?")[0];
  if (!archivo) {
    av.sin_video++;
    return;
  }
  if (!videosEnR2.has(`videos-ig/${archivo}`)) {
    av.sin_r2 = (av.sin_r2 ?? 0) + 1;
    return;
  }
  let nuevas;
  try {
    nuevas = await portadaDeVideo(`${MEDIA}videos-ig/${archivo}`);
  } catch (e) {
    // Video que no está o que ffmpeg no puede leer: no corta (como portadas-videos.mts), queda contado.
    const m = String(e?.message ?? e);
    if (/404|Invalid data|moov atom|Server returned 4/i.test(m)) {
      av.sin_video++;
      return;
    }
    throw e;
  }
  const vieja = await leerR2(`portadas-ig/${id}.jpg`);
  const dif = vieja ? await diferencia(vieja, nuevas.grande) : null;
  if (dif === null) av.faltaban++;
  else if (dif <= 3) {
    av.iguales++;
    return;
  } else if (dif <= 12) av.casi++;
  else {
    av.distintas++;
    if (ejemplos.length < 10) ejemplos.push(`${id} (${dif})`);
  }
  if (PRUEBA) return;
  await subirR2(`portadas-ig/${id}.jpg`, nuevas.grande);
  await subirR2(`portadas-ig/${id}-160.jpg`, nuevas.chica);
}
await Promise.all(
  Array.from({ length: Math.max(1, Math.min(A_LA_VEZ, lista.length)) }, async () => {
    while (i < lista.length && !corte) {
      if (!quedaTiempo()) {
        corte = "tiempo";
        break;
      }
      const k = i++;
      try {
        await uno(lista[k]);
        listos[k] = true;
        av.revisadas++;
        seguidos = 0;
      } catch (e) {
        av.errores++;
        listos[k] = true; // queda contado como error y no se repite (la lista sale en el registro)
        console.log(`  error ${lista[k].id}: ${String(e?.message ?? e).slice(0, 160)}`);
        if (++seguidos >= 3) corte = "3 errores seguidos (regla de operación)";
      }
      if (av.revisadas % 250 === 0) console.log(`  ${av.revisadas} revisadas · distintas ${av.distintas} · ${Math.round((Date.now() - t0) / 1000)} s`);
      await espera(PAUSA);
    }
  }),
);
let hasta = -1;
while (hasta + 1 < listos.length && listos[hasta + 1]) hasta++;
if (hasta >= 0 && !PRUEBA) av.desde = String(lista[hasta].id);
const quedan = corte.startsWith("3 errores") ? 0 : Number((await d1("SELECT count(*) AS n FROM videos_copia WHERE publicacion_id > ?", [av.desde ?? ""]))[0].n);
if (!PRUEBA && quedan === 0 && !corte) av.terminado = new Date().toISOString(); // con sin_r2 > 0: repetir con --de-nuevo
av.corte = corte || null;
if (!PRUEBA)
  await d1("INSERT INTO ia_config (clave, valor, actualizado_en) VALUES (?, ?, ?) ON CONFLICT (clave) DO UPDATE SET valor = excluded.valor, actualizado_en = excluded.actualizado_en", [
    CLAVE_AVANCE,
    JSON.stringify(av),
    new Date().toISOString(),
  ]);
const resumen = `Portadas 0,5 s: revisadas ${av.revisadas}/${total} · iguales ${av.iguales} · casi iguales ${av.casi} · DISTINTAS ${av.distintas} · faltaban ${av.faltaban} · sin video ${av.sin_video} · todavía no en R2 ${av.sin_r2 ?? 0} · errores ${av.errores} · quedan ${quedan}${corte ? ` · corte: ${corte}` : ""} (${Math.round((Date.now() - t0) / 60000)} min)`;
console.log(resumen);
if (ejemplos.length) console.log(`  ejemplos de distintas: ${ejemplos.join(", ")}`);
if (env.GITHUB_STEP_SUMMARY) appendFileSync(env.GITHUB_STEP_SUMMARY, `${resumen}\n`);
if (env.GITHUB_OUTPUT) appendFileSync(env.GITHUB_OUTPUT, `quedan=${PRUEBA ? 0 : quedan}\n`);
