// Revisión del contenido de los videos verticales elegidos (11/11/2026, dueño: «JW Bradley pone una imagen por delante
// de un video buenísimo» y «Ness muestra un video horizontal pero el 2do es vertical»). El archivo dice 9:16, pero:
//   - «franjas»: es un video horizontal con barras negras arriba y abajo (Ness) → cuenta como apaisado;
//   - «foto»: es una foto quieta hecha video, unos segundos sin movimiento (JW Bradley) → cuenta como apaisado.
// En los dos casos pasa a vertical = 0 en videos_elegidos: el feed lo pone al final de la tarjeta (detrás de los reels
// de verdad y de las fotos). Lee sólo los primeros 8 s del video copiado en Hostinger (no toca Instagram).
// Los revisados se anotan en R2 (control/revision-contenido-<parte>.json) para no repetirlos.
// Uso: node revisar-contenido.mjs [--partes 4 --parte k] [--minutos 45] [--max N] [--simular] [--ids id1,id2]
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const ejecutar = promisify(execFile);
const arg = (n, def) => {
  const i = process.argv.indexOf(n);
  return i > 0 ? process.argv[i + 1] : def;
};
const PARTES = Number(arg("--partes", 1)), PARTE = Number(arg("--parte", 0)), MINUTOS = Number(arg("--minutos", 45)), MAX = Number(arg("--max", Infinity));
const SIMULAR = process.argv.includes("--simular");
const IDS = arg("--ids", "")?.split(",").filter(Boolean) ?? [];
const env = process.env;
for (const k of ["CLOUDFLARE_API_TOKEN", "CLOUDFLARE_ACCOUNT_ID", "D1_APP_ID"]) if (!env[k]) throw new Error(`Falta el secreto ${k}`);
const t0 = Date.now();
const espera = (ms) => new Promise((ok) => setTimeout(ok, ms));
const CF = `https://api.cloudflare.com/client/v4/accounts/${env.CLOUDFLARE_ACCOUNT_ID}`;
const aut = { authorization: `Bearer ${env.CLOUDFLARE_API_TOKEN}` };

async function d1(sql, params = [], intento = 0) {
  const r = await fetch(`${CF}/d1/database/${env.D1_APP_ID}/query`, { method: "POST", headers: { ...aut, "content-type": "application/json" }, body: JSON.stringify({ sql, params }), signal: AbortSignal.timeout(60_000) });
  const j = await r.json().catch(() => null);
  if (!r.ok || !j?.success) {
    const m = `D1 ${r.status} ${j?.errors?.map((e) => e.message).join("; ") ?? ""}`;
    if ((r.status === 429 || /overloaded/i.test(m)) && intento < 4) {
      await espera([3_000, 8_000, 15_000, 30_000][intento]);
      return d1(sql, params, intento + 1);
    }
    throw new Error(m);
  }
  return j.result[0].results;
}
const CONTROL = `${CF}/r2/buckets/tenedor-media/objects/control/revision-contenido-${PARTE}.json`;
async function leerHechos() {
  const r = await fetch(CONTROL, { headers: aut });
  return r.ok ? new Set(await r.json().catch(() => [])) : new Set();
}
async function guardarHechos(s) {
  if (SIMULAR) return;
  await fetch(CONTROL, { method: "PUT", headers: { ...aut, "content-type": "application/json" }, body: JSON.stringify([...s]) });
}

const hash = (s) => [...s].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7);

/** Mide los primeros 8 s: recuadro con imagen (cropdetect) y si hay movimiento (freezedetect). */
async function medir(url) {
  const { stderr } = await ejecutar("ffmpeg", ["-v", "info", "-t", "8", "-i", url, "-vf", "cropdetect=24:2:0,freezedetect=n=0.003:d=3", "-an", "-f", "null", "-"], { timeout: 90_000, maxBuffer: 20 * 1024 * 1024 }).catch((e) => ({ stderr: String(e.stderr ?? e) }));
  const dur = Number(stderr.match(/Duration: (\d+):(\d+):([\d.]+)/)?.slice(1).reduce((a, x, i) => a + Number(x) * [3600, 60, 1][i], 0) ?? 0);
  const tam = stderr.match(/Stream #\S+: Video: .*?, (\d{2,5})x(\d{2,5})/);
  if (!tam) return { error: "no se pudo leer" };
  const W = Number(tam[1]), H = Number(tam[2]);
  // El recuadro que más se repite (ignora los cuadros negros de transición, que dan recortes absurdos).
  const cuenta = {};
  for (const m of stderr.matchAll(/crop=(\d+):(\d+):\d+:\d+/g)) if (Number(m[1]) > W * 0.3 && Number(m[2]) > H * 0.1) cuenta[`${m[1]}x${m[2]}`] = (cuenta[`${m[1]}x${m[2]}`] ?? 0) + 1;
  const [cw, ch] = (Object.entries(cuenta).sort((a, b) => b[1] - a[1])[0]?.[0] ?? `${W}x${H}`).split("x").map(Number);
  const congelado = [...stderr.matchAll(/freeze_duration: ([\d.]+)/g)].reduce((a, m) => a + Number(m[1]), 0);
  const abierto = /freeze_start: [\d.]+(?![\s\S]*freeze_end)/.test(stderr); // sigue quieto hasta el final de lo leído
  const leido = Math.min(8, dur || 8);
  const quieto = congelado + (abierto ? leido - Number([...stderr.matchAll(/freeze_start: ([\d.]+)/g)].pop()?.[1] ?? leido) : 0);
  const tipo = H > W && cw >= ch * 0.95 ? "franjas" : quieto >= leido * 0.85 ? "foto" : H < W ? "horizontal" : "vertical";
  return { tipo, W, H, cw, ch, dur, quieto: Math.round(quieto * 10) / 10 };
}

const hechos = await leerHechos();
const filas = IDS.length
  ? await d1(`SELECT e.publicacion_id id, e.restaurante_id, c.url FROM videos_elegidos e JOIN videos_copia c ON c.publicacion_id = e.publicacion_id WHERE e.publicacion_id IN (SELECT value FROM json_each(?))`, [JSON.stringify(IDS)])
  : await d1(`SELECT e.publicacion_id id, e.restaurante_id, c.url FROM videos_elegidos e JOIN videos_copia c ON c.publicacion_id = e.publicacion_id WHERE e.vertical = 1 AND e.publicacion_id NOT LIKE 'tv-%'`);
const mias = filas.filter((f) => IDS.length || (hash(f.id) % PARTES === PARTE && !hechos.has(f.id)));
console.log(`Verticales con copia: ${filas.length} · parte ${PARTE + 1}/${PARTES}: ${mias.length} por revisar (${hechos.size} ya revisados)`);
const total = { vertical: 0, franjas: 0, foto: 0, horizontal: 0, errores: 0 };
let n = 0;
for (const f of mias) {
  if (n >= MAX || Date.now() - t0 > MINUTOS * 60_000) break;
  n++;
  const m = await medir(f.url);
  if (m.error) { total.errores++; console.log(`${f.id}: ${m.error}`); continue; }
  total[m.tipo]++;
  if (m.tipo !== "vertical") {
    console.log(`${f.id} (${f.restaurante_id}): ${m.tipo} · ${m.W}x${m.H} con imagen ${m.cw}x${m.ch} · ${m.quieto}/${Math.min(8, m.dur)} s quieto`);
    if (!SIMULAR) await d1("UPDATE videos_elegidos SET vertical = 0, ancho = ?, alto = ? WHERE publicacion_id = ?", [m.cw, m.ch, f.id]);
  }
  hechos.add(f.id);
  if (n % 50 === 0) { await guardarHechos(hechos); console.log(`[${n}] ${JSON.stringify(total)}`); }
}
await guardarHechos(hechos);
console.log(`Listo (${n}): ${JSON.stringify(total)}${SIMULAR ? " · simulación, no escribió" : ""}`);
