// Prueba 2 (SÓLO LEE, 09/11/2026): dumpor.io (picuki y greatfon redirigen ahí) arma el perfil con Phoenix LiveView (por
// websocket), así que un fetch no trae las publicaciones. Acá se abre con Chromium sin pantalla desde GitHub (no la red
// del dueño): N cuentas, se espera a que cargue, se juntan los códigos de reels/publicaciones y se prueba yt-dlp con 3.
// Uso: node espejos-navegador.mjs [cuentas=20]
import { chromium } from "playwright";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
const ejecutar = promisify(execFile);
const env = process.env;
const N = Number(process.argv[2] ?? 20);
async function d1(sql, params = []) {
  const r = await fetch(`https://api.cloudflare.com/client/v4/accounts/${env.CLOUDFLARE_ACCOUNT_ID}/d1/database/${env.D1_APP_ID}/query`, {
    method: "POST",
    headers: { authorization: `Bearer ${env.CLOUDFLARE_API_TOKEN}`, "content-type": "application/json" },
    body: JSON.stringify({ sql, params }),
  });
  const j = await r.json();
  if (!j.success) throw new Error(JSON.stringify(j.errors));
  return j.result[0].results;
}
const cuentas = (
  await d1(
    `SELECT lower(ltrim(r.instagram,'@')) AS u FROM restaurantes r WHERE r.creado_en > '2026-11-07' AND coalesce(r.instagram,'') <> '' AND r.estado <> 'cerrado'
     AND NOT EXISTS (SELECT 1 FROM publicaciones p WHERE p.restaurante_id = r.id) ORDER BY random() LIMIT ?`,
    [N],
  )
).map((x) => x.u);
const nav = await chromium.launch();
const p = await nav.newPage({ locale: "es-AR" });
let conCodigos = 0, codigos = 0, conReels = 0;
const muestra = [];
for (const u of cuentas) {
  const t0 = Date.now();
  await p.goto(`https://dumpor.io/v/${u}`, { waitUntil: "domcontentloaded", timeout: 45_000 }).catch(() => {});
  await p.waitForTimeout(9000);
  await p.evaluate(() => window.scrollBy(0, 3000)).catch(() => {});
  await p.waitForTimeout(3000);
  const html = await p.content().catch(() => "");
  const cods = [...new Set([...html.matchAll(/(?:instagram\.com\/(?:p|reel)\/|\/(?:p|reel|post|media)\/)([A-Za-z0-9_-]{10,12})/g)].map((m) => m[1]))];
  const reels = (html.match(/reel|video|\.mp4/gi) ?? []).length;
  const mp4 = [...new Set(html.match(/https:[^"' ]+\.mp4[^"' ]*/g) ?? [])].length;
  if (process.env.VER) { const txt = await p.evaluate(() => document.body.innerText).catch(() => ""); const hrefs = await p.$eval("a[href]", (as) => as.map((a) => a.getAttribute("href"))).catch(() => []); console.log("TEXTO:", txt.replace(/s+/g, " ").slice(0, 900)); console.log("LINKS:", [...new Set(hrefs)].slice(0, 40).join(" ")); }
  if (cods.length) (conCodigos++, (codigos += cods.length), muestra.push(...cods.slice(0, 1)));
  if (mp4) conReels++;
  console.log(`${u}: ${cods.length} códigos · ${mp4} mp4 directos · menciones video ${reels} · ${Math.round((Date.now() - t0) / 1000)} s · ${(await p.title().catch(() => "")).slice(0, 60)}`);
}
await nav.close();
console.log(`\nCon códigos: ${conCodigos}/${cuentas.length} (total ${codigos}) · con mp4 directos: ${conReels}/${cuentas.length}`);
let bajan = 0;
for (const c of muestra.slice(0, 3)) {
  try {
    const { stdout } = await ejecutar("yt-dlp", ["--no-warnings", "--skip-download", "--print", "%(ext)s %(duration)s", `https://www.instagram.com/reel/${c}/`], { timeout: 60_000 });
    if (stdout.trim()) bajan++;
  } catch {}
}
console.log(`yt-dlp: ${bajan}/${Math.min(3, muestra.length)} bajables`);
