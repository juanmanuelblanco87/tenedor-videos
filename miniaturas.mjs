// Miniaturas de 160 px en R2 (13/11, dueño: «las miniaturas de la ficha tardan muchísimo»). Las fotos copiadas a R2
// (fotos-ig/, fotos-gm/) se servían enteras (promedio ~290 KB) para un cuadrito de 64 px: con 4G y 10-16 por ficha se
// comían la conexión. Este script arma `<nombre>-160.jpg` al lado de cada una (≈5 KB) y rehace las portadas «chicas»
// (portadas-ig/*-160.jpg) que en realidad son grandes. La app pide la chica y, si no existe, la grande (img-mini.tsx).
// Corre en GitHub Actions (.github/workflows/cf-miniaturas.yml), nunca en la PC (regla del dueño: nada masivo desde su
// red). Lee y escribe por la API de R2 (clase B / clase A: dentro del gratis). Saltea lo ya hecho: se puede cortar y
// volver a correr. Corta a los 20 errores seguidos.
//
// Uso:  node miniaturas.mjs [--max 500] [--paralelo 8]   (copia del script de tenedor-cf-ig: este repo público tiene minutos sin tope)
// Variables: CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID.
import { parseArgs } from "node:util";
import sharp from "sharp";
const TOPE_CHICA = 20_000;
function claveChica(clave) {
  if (/^portadas-ig\/.+-160\.jpg$/.test(clave)) return clave;
  return clave.replace(/\.(jpe?g|png|webp)$/i, "-160.jpg");
}
function necesitaChica(clave, tamanos) {
  if (/^portadas-ig\//.test(clave)) return /-160\.jpg$/.test(clave) && (tamanos.get(clave) ?? 0) > TOPE_CHICA && tamanos.has(clave.replace(/-160\.jpg$/, ".jpg"));
  if (!/^(fotos-ig|fotos-gm)\/.+\.(jpe?g|png|webp)$/i.test(clave) || /-160\.jpg$/.test(clave)) return false;
  return !tamanos.has(claveChica(clave));
}


const { values: a } = parseArgs({ options: { max: { type: "string", default: "0" }, paralelo: { type: "string", default: "8" } } });
const MAX = Number(a.max) || Infinity;
const PARALELO = Math.max(1, Math.min(16, Number(a.paralelo) || 8));
const cuenta = process.env.CLOUDFLARE_ACCOUNT_ID;
const token = process.env.CLOUDFLARE_API_TOKEN;
if (!cuenta || !token) throw new Error("faltan CLOUDFLARE_API_TOKEN / CLOUDFLARE_ACCOUNT_ID");
const API = `https://api.cloudflare.com/client/v4/accounts/${cuenta}/r2/buckets/tenedor-media/objects`;
const auth = { authorization: `Bearer ${token}` };
const ruta = (k) => `${API}/${k.split("/").map(encodeURIComponent).join("/")}`;

async function listar(prefijo) {
  const salida = [];
  let cursor = "";
  for (;;) {
    const r = await fetch(`${API}?per_page=1000&prefix=${prefijo}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`, { headers: auth });
    const j = await r.json();
    if (!j.success) throw new Error(`listar ${prefijo}: HTTP ${r.status}`);
    salida.push(...(j.result ?? []));
    cursor = j.result_info?.cursor ?? "";
    if (!cursor || String(j.result_info?.is_truncated) === "false") break;
  }
  return salida;
}

const objetos = [...(await listar("fotos-ig/")), ...(await listar("fotos-gm/")), ...(await listar("portadas-ig/"))];
const tamanos = new Map(objetos.map((o) => [o.key, o.size]));
const tareas = objetos.filter((o) => necesitaChica(o.key, tamanos)).slice(0, MAX);
console.log(`objetos ${objetos.length} · por hacer ${tareas.length}`);

let hechas = 0;
let errores = 0;
let seguidos = 0;
let ahorro = 0;
const cola = [...tareas];
async function trabajador() {
  for (;;) {
    if (seguidos >= 20) return;
    const o = cola.shift();
    if (!o) return;
    try {
      // Se baja por la dirección pública (el Worker de medios lee R2): la API de Cloudflare tiene tope de pedidos por
      // minuto y bajar + subir por ella dejaba la tarea en ~55 por minuto. Así la API se usa sólo para subir.
      const r = await fetch(`https://media.tenedor.com.ar/${o.key.split("/").map(encodeURIComponent).join("/")}`, { signal: AbortSignal.timeout(60_000) });
      if (!r.ok) throw new Error(`bajar HTTP ${r.status}`);
      const original = Buffer.from(await r.arrayBuffer());
      const chica = await sharp(original).rotate().resize({ width: 160, withoutEnlargement: true }).jpeg({ quality: 72, mozjpeg: true }).toBuffer();
      const s = await fetch(ruta(claveChica(o.key)), { method: "PUT", headers: { ...auth, "content-type": "image/jpeg" }, body: new Uint8Array(chica), signal: AbortSignal.timeout(60_000) });
      if (s.status === 429) {
        cola.push(o);
        await new Promise((ok) => setTimeout(ok, 20_000));
        continue;
      }
      if (!s.ok) throw new Error(`subir HTTP ${s.status}`);
      hechas++;
      seguidos = 0;
      ahorro += Math.max(0, original.length - chica.length);
      if (hechas % 500 === 0) console.log(`${hechas}/${tareas.length} · errores ${errores}`);
    } catch (e) {
      errores++;
      seguidos++;
      console.log(`error ${o.key}: ${String(e).slice(0, 120)}`);
    }
  }
}
await Promise.all(Array.from({ length: PARALELO }, trabajador));
console.log(`Listo: ${hechas} hechas · ${errores} errores · ${Math.round(ahorro / 1e6)} MB menos por ver cada una una vez`);
if (seguidos >= 20) process.exit(1);
