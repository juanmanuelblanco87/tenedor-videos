// Prueba 3 (SÓLO LEE, 09/11/2026): anonyig.com con un navegador real (Chromium sin pantalla) desde GitHub, usando la página
// como la usa una persona: escribe el usuario, espera y lee los links de video que muestra. NO se arma la firma de su API a
// mano (sería saltear su protección): si el sitio bloquea o pide verificación, la prueba lo cuenta y sigue.
// Uso: node anonyig-prueba.mjs [cuentas=20]
import { chromium } from "playwright";
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
const ctx = await nav.newContext({ locale: "es-AR", userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36" });
const p = await ctx.newPage();
const est = { conVideos: 0, videos: 0, sinNada: 0, bloqueo: 0, privadas: 0 };
for (const u of cuentas) {
  try {
    await p.goto("https://anonyig.com/es1/", { waitUntil: "domcontentloaded", timeout: 45_000 });
    if (/Just a moment|Un momento|Verifica/i.test(await p.title())) {
      est.bloqueo++;
      console.log(`${u}: verificación anti-bots`);
      continue;
    }
    const i = p.locator('input[type="text"]').first();
    await i.fill(u);
    await i.press("Enter");
    await p.waitForTimeout(10_000);
    const r = await p.evaluate(() => ({
      mp4: [...new Set([...document.querySelectorAll("a[href]")].map((a) => a.href).filter((h) => /\.mp4/.test(decodeURIComponent(h))))].length,
      fotos: document.querySelectorAll('img[src*="media.anonyig.com"]').length,
      texto: document.body.innerText.slice(0, 2000),
    }));
    if (/privad|private/i.test(r.texto)) est.privadas++;
    if (r.mp4) (est.conVideos++, (est.videos += r.mp4));
    else est.sinNada++;
    console.log(`${u}: ${r.mp4} videos · ${r.fotos} imágenes`);
  } catch (e) {
    console.log(`${u}: error ${String(e).slice(0, 80)}`);
  }
  await p.waitForTimeout(3000);
}
await nav.close();
console.log(`\nResultado: ${JSON.stringify(est)} de ${cuentas.length} cuentas`);
