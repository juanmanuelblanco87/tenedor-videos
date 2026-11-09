// Prueba (SÓLO LEE, 09/11/2026, dueño: «inspeccionemos B… vamos con B»): sitios espejo públicos de Instagram como fuente
// de links de reels SIN la API de Meta (cupo al 90 %). Toma N cuentas de comercios con Instagram que todavía no leímos,
// pide su perfil a cada espejo y cuenta: responde (HTTP 200, sin desafío anti-bots), cuántos códigos de publicación trae
// (/p/ o /reel/) y, para 3 de ellos, si yt-dlp baja el video. No escribe nada en la base.
// Uso: node espejos-prueba.mjs [cuentas=20]
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
    `SELECT lower(ltrim(r.instagram,'@')) AS u FROM restaurantes r
     WHERE r.creado_en > '2026-11-07' AND coalesce(r.instagram,'') <> '' AND r.estado <> 'cerrado'
       AND NOT EXISTS (SELECT 1 FROM publicaciones p WHERE p.restaurante_id = r.id)
     ORDER BY random() LIMIT ?`,
    [N],
  )
).map((x) => x.u);
console.log(`Cuentas: ${cuentas.join(", ")}\n`);

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36";
const ESPEJOS = {
  imginn: (u) => `https://imginn.com/${u}/`,
  picuki: (u) => `https://www.picuki.com/profile/${u}`,
  greatfon: (u) => `https://greatfon.io/v/${u}`,
  dumpor: (u) => `https://dumpor.io/v/${u}`,
  anonyig: (u) => `https://anonyig.com/es/${u}/`,
  pixwox: (u) => `https://www.pixwox.com/profile/${u}/`,
  insta_stories_viewer: (u) => `https://insta-stories-viewer.com/${u}/`,
  ig_publico: (u) => `https://www.instagram.com/${u}/`, // referencia: el perfil público de Instagram
};
const DESAFIO = /cf-browser-verification|challenge-platform|Just a moment|captcha|Access denied|Attention Required/i;
const resumen = {};
const muestras = {};
for (const [nombre, url] of Object.entries(ESPEJOS)) {
  const r = (resumen[nombre] = { ok: 0, desafio: 0, error: 0, conCodigos: 0, codigos: 0 });
  for (const u of cuentas) {
    try {
      const resp = await fetch(url(u), { headers: { "user-agent": UA, "accept-language": "es-AR,es;q=0.9" }, signal: AbortSignal.timeout(20_000), redirect: "follow" });
      const html = await resp.text();
      if (!resp.ok) {
        r.error++;
        continue;
      }
      if (DESAFIO.test(html.slice(0, 20_000))) {
        r.desafio++;
        continue;
      }
      r.ok++;
      // Códigos de publicación de Instagram (11 caracteres) en links /p/ /reel/ o en rutas del espejo.
      const cods = [...new Set([...html.matchAll(/(?:instagram\.com\/(?:p|reel)\/|\/(?:p|reel|post|media)\/)([A-Za-z0-9_-]{10,12})/g)].map((m) => m[1]))];
      if (cods.length) {
        r.conCodigos++;
        r.codigos += cods.length;
        (muestras[nombre] ??= []).push(...cods.slice(0, 2));
      }
    } catch {
      r.error++;
    }
    await new Promise((ok) => setTimeout(ok, 1500));
  }
  console.log(`${nombre}: ${JSON.stringify(r)}`);
}

// ¿yt-dlp baja los reels encontrados? (3 por espejo que trajo códigos)
console.log("\nyt-dlp sobre códigos encontrados:");
for (const [nombre, cods] of Object.entries(muestras)) {
  let bajan = 0;
  const prueba = cods.slice(0, 3);
  for (const c of prueba) {
    try {
      const { stdout } = await ejecutar("yt-dlp", ["--no-warnings", "--skip-download", "--print", "%(ext)s %(duration)s", `https://www.instagram.com/reel/${c}/`], { timeout: 60_000 });
      if (stdout.trim()) bajan++;
    } catch {}
  }
  console.log(`${nombre}: ${bajan}/${prueba.length} con video bajable (${prueba.join(", ")})`);
}
