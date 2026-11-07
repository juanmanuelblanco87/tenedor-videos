// Verificación de las copias de videos en Hostinger (07/11/2026, dueño: «¿cuántos videos tienen 404 en Hostinger?»).
// SÓLO LECTURA: lee videos_copia de D1 y hace HEAD a cada link (de a pocos, para no gatillar el freno de LiteSpeed).
// Deja la lista en el registro y en verificar-404.txt (artefacto). No toca la base.
// Uso: node verificar.mjs [--a-la-vez 4]
import { writeFileSync } from "node:fs";
const env = process.env;
for (const k of ["CLOUDFLARE_API_TOKEN", "CLOUDFLARE_ACCOUNT_ID", "D1_APP_ID"]) if (!env[k]) throw new Error(`Falta el secreto ${k}`);
const i0 = process.argv.indexOf("--a-la-vez");
const A_LA_VEZ = i0 > 0 ? Number(process.argv[i0 + 1]) : 4;
const espera = (ms) => new Promise((ok) => setTimeout(ok, ms));
async function d1(sql) {
  const r = await fetch(`https://api.cloudflare.com/client/v4/accounts/${env.CLOUDFLARE_ACCOUNT_ID}/d1/database/${env.D1_APP_ID}/query`, {
    method: "POST",
    headers: { authorization: `Bearer ${env.CLOUDFLARE_API_TOKEN}`, "content-type": "application/json" },
    body: JSON.stringify({ sql }),
  });
  const j = await r.json();
  if (!j.success) throw new Error(JSON.stringify(j.errors));
  return j.result[0].results;
}
const filas = await d1("SELECT c.publicacion_id, c.restaurante_id, c.url, c.bytes, c.copiado_en, r.nombre FROM videos_copia c LEFT JOIN restaurantes r ON r.id = c.restaurante_id");
console.log(`Copias a revisar: ${filas.length}`);
const est = { ok: 0, f404: 0, otros: 0, error: 0 };
const malos = [];
async function estado(url) {
  for (let intento = 0; intento < 4; intento++) {
    try {
      const r = await fetch(url, { method: "HEAD", signal: AbortSignal.timeout(30_000) });
      if (r.status === 429 || r.status >= 500) { await espera(5_000 * (intento + 1)); continue; }
      return r.status;
    } catch { await espera(3_000); }
  }
  return 0;
}
let i = 0;
await Promise.all(Array.from({ length: A_LA_VEZ }, async () => {
  while (i < filas.length) {
    const f = filas[i++];
    const s = await estado(f.url);
    if (s === 200) est.ok++;
    else {
      if (s === 404) est.f404++; else if (s === 0) est.error++; else est.otros++;
      malos.push({ s, ...f });
    }
    if (i % 1000 === 0) console.log(`[avance] ${i}/${filas.length} ${JSON.stringify(est)}`);
    await espera(150);
  }
}));
writeFileSync("verificar-404.txt", malos.map((m) => [m.s, m.publicacion_id, m.restaurante_id, m.nombre, m.bytes, m.copiado_en, m.url].join("\t")).join("\n"));
for (const m of malos.slice(0, 40)) console.log(`MAL ${m.s} ${m.publicacion_id} «${m.nombre}» copiado ${m.copiado_en}`);
console.log(`Listo: ${JSON.stringify(est)}`);
