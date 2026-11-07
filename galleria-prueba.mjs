// Prueba (sólo lee): ¿gallery-dl consigue el link del video de reels vencidos, sin sesión, desde GitHub?
import { execFile } from "node:child_process";
import { promisify } from "node:util";
const ejecutar = promisify(execFile);
const env = process.env;
const r = await fetch(`https://api.cloudflare.com/client/v4/accounts/${env.CLOUDFLARE_ACCOUNT_ID}/d1/database/${env.D1_APP_ID}/query`, {
  method: "POST",
  headers: { authorization: `Bearer ${env.CLOUDFLARE_API_TOKEN}`, "content-type": "application/json" },
  body: JSON.stringify({ sql: `SELECT p.permalink FROM publicaciones p WHERE p.tipo='video' AND p.plataforma='instagram' AND NOT p.oculta AND p.permalink LIKE 'https://www.instagram.com/%' AND p.vence_en <= strftime('%Y-%m-%dT%H:%M:%fZ','now') AND NOT EXISTS (SELECT 1 FROM videos_copia c WHERE c.publicacion_id=p.id) ORDER BY random() LIMIT 20` }),
});
const filas = (await r.json()).result[0].results;
let ok = 0, mal = 0;
for (const { permalink } of filas) {
  try {
    const { stdout } = await ejecutar("gallery-dl", ["-g", permalink], { timeout: 60_000 });
    const mp4 = stdout.split(/\r?\n/).find((l) => /\.mp4|video/.test(l));
    if (mp4) { ok++; console.log(`OK   ${permalink.slice(-12)}`); } else { mal++; console.log(`SIN  ${permalink.slice(-12)} ${stdout.slice(0, 80)}`); }
  } catch (e) {
    mal++;
    console.log(`MAL  ${permalink.slice(-12)} ${String(e.stderr ?? e).trim().split("\n").pop()?.slice(0, 140)}`);
  }
  await new Promise((x) => setTimeout(x, 4000));
}
console.log(`RESULTADO gallery-dl ok=${ok} mal=${mal} de ${filas.length}`);
