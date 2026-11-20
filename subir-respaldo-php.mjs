// Sube respaldo.php (tenedor-cf-ig/hostinger/respaldo.php) a public_html de datos.tenedor.com.ar por la API de archivos de
// Hostinger (la misma vía que usaban la app y a-r2: upload-urls + TUS), y el secreto en .respaldo-secreto-nuevo.php,
// que respaldo.php mueve fuera de public_html en el primer pedido. 20/11/2026: upload-urls daba 502 desde la PC; esto lo
// reintenta cada hora (subir-respaldo-php.yml) hasta que ande.
//   · Si respaldo.php ya contesta (403/400/500 en JSON y no 404), no sube nada y sale con «listo=si».
//   · Nunca imprime el secreto.
// Uso: node subir-respaldo-php.mjs <ruta de respaldo.php>
// Variables: HOSTINGER_API_TOKEN, HOSTINGER_USUARIO, RESPALDO_SECRET (≥ 32 caracteres).
import { appendFileSync, readFileSync } from "node:fs";

const env = process.env;
const DOMINIO = env.HOSTINGER_DOMINIO || "datos.tenedor.com.ar";
const salida = (listo) => env.GITHUB_OUTPUT && appendFileSync(env.GITHUB_OUTPUT, `listo=${listo}\n`);
for (const k of ["HOSTINGER_API_TOKEN", "HOSTINGER_USUARIO", "RESPALDO_SECRET"]) if (!env[k]) throw new Error(`Falta el secreto ${k}`);
if (env.RESPALDO_SECRET.length < 32 || /['\\]/.test(env.RESPALDO_SECRET)) throw new Error("RESPALDO_SECRET: 32 caracteres o más, sin comillas ni barras invertidas");

async function yaEsta() {
  const r = await fetch(`https://${DOMINIO}/respaldo.php`, { method: "POST", signal: AbortSignal.timeout(20_000) }).catch(() => null);
  const t = r ? await r.text() : "";
  // Publicado: contesta JSON propio («prohibido» con 403 una vez instalado el secreto; «sin configurar» antes).
  return { publicado: Boolean(r && r.status !== 404 && /"error"/.test(t)), instalado: r?.status === 403, estado: r?.status ?? "sin respuesta" };
}

const antes = await yaEsta();
if (antes.publicado && antes.instalado) {
  console.log("respaldo.php ya está publicado y con el secreto instalado: nada que hacer.");
  salida("si");
  process.exit(0);
}

const r = await fetch("https://developers.hostinger.com/api/hosting/v1/files/upload-urls", {
  method: "POST",
  headers: { authorization: `Bearer ${env.HOSTINGER_API_TOKEN}`, "content-type": "application/json", accept: "application/json" },
  body: JSON.stringify({ username: env.HOSTINGER_USUARIO, domain: DOMINIO }),
  signal: AbortSignal.timeout(30_000),
}).catch((e) => ({ ok: false, status: String(e?.name ?? e) }));
if (!r.ok) {
  console.log(`upload-urls: ${r.status} (Hostinger). Sigue la próxima hora.`);
  salida("no");
  process.exit(0);
}
const sesion = await r.json();
async function subir(nombre, contenido) {
  const destino = `${sesion.url.replace(/\/$/, "")}/${nombre}?override=true`;
  const comunes = { "X-Auth": sesion.auth_key, "X-Auth-Rest": sesion.rest_auth_key, "Tus-Resumable": "1.0.0" };
  const crear = await fetch(destino, { method: "POST", headers: { ...comunes, "Upload-Length": String(contenido.length) }, signal: AbortSignal.timeout(30_000) });
  if (!crear.ok) throw new Error(`crear ${nombre}: ${crear.status}`);
  const enviar = await fetch(destino, { method: "PATCH", headers: { ...comunes, "Upload-Offset": "0", "Content-Type": "application/offset+octet-stream" }, body: new Uint8Array(contenido), signal: AbortSignal.timeout(60_000) });
  if (!enviar.ok) throw new Error(`subir ${nombre}: ${enviar.status}`);
}
try {
  if (!antes.publicado) await subir("respaldo.php", readFileSync(process.argv[2]));
  // El secreto va después del PHP: así nunca queda un .php con el secreto sin el script que lo mueve afuera.
  if (!antes.instalado) await subir(".respaldo-secreto-nuevo.php", Buffer.from(`<?php return '${env.RESPALDO_SECRET}';\n`));
} catch (e) {
  console.log(`Hostinger: ${e instanceof Error ? e.message : e}. Sigue la próxima hora.`);
  salida("no");
  process.exit(0);
}
const despues = await yaEsta();
console.log(`respaldo.php: antes ${antes.estado}, ahora ${despues.estado}${despues.instalado ? " · publicado y con secreto" : " · todavía no contesta como se espera"}`);
salida(despues.instalado ? "si" : "no");
