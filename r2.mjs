// R2 para los workflows de este repo (20/11/2026, mudanza Hostinger → R2): listar, subir, bajar y borrar objetos de un
// bucket. Antes vivía dentro de a-r2.mjs; ahora lo usan a-r2.mjs, hostinger-a-r2.mjs y respaldo.mjs.
//   · Subida/bajada por la API S3 de R2 si están R2_ACCESS_KEY_ID / R2_SECRET_ACCESS_KEY / R2_ENDPOINT (no cuenta para el
//     límite de 1.200 pedidos cada 5 min de api.cloudflare.com, que comparten D1 y los demás procesos); si no, por la API
//     REST, y ante un 429 espera (30 s, 60 s, 120 s) en vez de insistir: el 12/11 las 4 partes juntas lo tocaron.
//   · Listar va siempre por la API REST (1.000 claves por pedido).
import { createHash, createHmac } from "node:crypto";

const env = process.env;
const espera = (ms) => new Promise((ok) => setTimeout(ok, ms));
const auth = () => ({ authorization: `Bearer ${env.CLOUDFLARE_API_TOKEN}` });
const rest = (bucket) => `https://api.cloudflare.com/client/v4/accounts/${env.CLOUDFLARE_ACCOUNT_ID}/r2/buckets/${bucket}/objects`;
const S3 = env.R2_ACCESS_KEY_ID && env.R2_SECRET_ACCESS_KEY && env.R2_ENDPOINT ? { id: env.R2_ACCESS_KEY_ID, secreto: env.R2_SECRET_ACCESS_KEY, base: env.R2_ENDPOINT.replace(/\/$/, "") } : null;
export const hayS3 = Boolean(S3);

/** Todas las claves de un prefijo → Map(clave → bytes). */
export async function listarR2(prefijo, bucket = "tenedor-media") {
  const m = new Map();
  let cursor = "";
  for (let intento = 0; ; ) {
    const r = await fetch(`${rest(bucket)}?per_page=1000&prefix=${encodeURIComponent(prefijo)}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`, { headers: auth(), signal: AbortSignal.timeout(60_000) }).catch(() => null);
    const j = await r?.json().catch(() => null);
    if (!j?.success) {
      // 10001 «internal error» de Cloudflare (medido el 20/11 listando 60 prefijos seguidos): reintento con espera.
      if (++intento <= 4) {
        await espera(3_000 * intento);
        continue;
      }
      throw new Error(`listar R2 ${prefijo}: ${j?.errors?.map((e) => e.message).join("; ") ?? r?.status}`);
    }
    intento = 0;
    for (const o of j.result ?? []) m.set(o.key, o.size);
    cursor = j.result_info?.cursor ?? "";
    if (!cursor || String(j.result_info?.is_truncated) === "false") break;
  }
  return m;
}

const hmac = (k, d) => createHmac("sha256", k).update(d).digest();
const sha = (d) => createHash("sha256").update(d).digest("hex");
const cod = (x) => encodeURIComponent(x).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
/** Pedido firmado (SigV4) a la API S3 de R2. */
function s3(metodo, bucket, k, cuerpo, tipo) {
  const url = new URL(`${S3.base}/${bucket}/${k.split("/").map(cod).join("/")}`);
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
  return fetch(url, { method: metodo, headers: { ...resto, authorization: `AWS4-HMAC-SHA256 Credential=${S3.id}/${alcance}, SignedHeaders=${firmados}, Signature=${firma}` }, body: cuerpo, signal: AbortSignal.timeout(180_000) });
}

async function conReintentos(pedido, que) {
  for (let intento = 0; ; intento++) {
    const p = await pedido().catch((e) => ({ ok: false, status: String(e?.name ?? e), text: async () => "" }));
    if (p.ok || p.status === 404) return p;
    const st = String(p.status);
    if (intento >= 3 || !/^(429|5\d\d|TimeoutError|TypeError)$/.test(st)) throw new Error(`R2 ${que} ${st} ${(await p.text()).slice(0, 200)}`);
    await espera(st === "429" ? 30_000 * 2 ** intento : 3_000 * (intento + 1));
  }
}

export async function subirR2(k, cuerpo, tipo, bucket = "tenedor-media") {
  await conReintentos(() => (S3 ? s3("PUT", bucket, k, cuerpo, tipo) : fetch(`${rest(bucket)}/${k.split("/").map(encodeURIComponent).join("/")}`, { method: "PUT", headers: { ...auth(), "content-type": tipo }, body: cuerpo, signal: AbortSignal.timeout(180_000) })), `PUT ${k}`);
}

/** Bytes del objeto, o null si no está. */
export async function bajarR2(k, bucket = "tenedor-media") {
  const r = await conReintentos(() => (S3 ? s3("GET", bucket, k) : fetch(`${rest(bucket)}/${k.split("/").map(encodeURIComponent).join("/")}`, { headers: auth(), signal: AbortSignal.timeout(180_000) })), `GET ${k}`);
  if (r.status === 404) return null;
  return Buffer.from(await r.arrayBuffer());
}

export async function borrarR2(k, bucket = "tenedor-media") {
  await conReintentos(() => (S3 ? s3("DELETE", bucket, k) : fetch(`${rest(bucket)}/${k.split("/").map(encodeURIComponent).join("/")}`, { method: "DELETE", headers: auth(), signal: AbortSignal.timeout(60_000) })), `DELETE ${k}`);
}
