// Revisión del contenido de los videos verticales elegidos (11/11/2026, dueño: «JW Bradley pone una imagen por delante
// de un video buenísimo» y «Ness muestra un video horizontal pero el 2do es vertical»). El archivo dice 9:16, pero:
//   - «franjas»: es un video horizontal con barras negras arriba y abajo (Ness) → cuenta como apaisado;
//   - «foto»: es una foto quieta hecha video, unos segundos sin movimiento (JW Bradley) → cuenta como apaisado.
// En los dos casos (y si se ve horizontal) cuenta como NO vertical: el feed lo pone al final de la tarjeta (detrás de los
// reels de verdad y de las fotos). Lee sólo los primeros 8 s del video copiado en Hostinger (no toca Instagram).
// 18/11/2026 (motor de videos verticales, paso 2; diseño v3 §V1, Roberto r3): ya NO escribe videos_elegidos (su único
// escritor es ordenarGuardados, en tenedor/src/lib/seleccion-videos.ts). Guarda el veredicto en video_medida con fuente
// «contenido» (motivo franjas / foto / horizontal, vertical 0): manda sobre el MP4 9:16, así que el «franjas» ya no
// vuelve a vertical en la vuelta siguiente de ordenarGuardados (la regresión de antes). Requiere la migración app 0030.
// Los revisados se anotan en R2 (control/revision-contenido-<parte>.json) para no repetirlos.
// --repasar (C7, recuperar los «foto quieta» que se perdieron): revisa también los ya anotados; no toca la lista de R2.
// Va en tandas con --max y fuera del horario pico de la app (antecedente de la base saturada del 31/10).
// Uso: node revisar-contenido.mjs [--partes 4 --parte k] [--minutos 45] [--max N] [--simular] [--repasar] [--ids id1,id2]
// 18/11/2026 (infra ágil, etapa 5: topes a D1): antes cada parte leía videos_elegidos × videos_copia entera (72 k filas
// por llamada) cada 3 horas. Ahora la lista la arma UNA máquina (--armar-cola, job «cola» de revisar-contenido.yml)
// recorriendo videos_elegidos por clave en tramos de 1.000 (≈2 k filas por llamada) y la deja en R2; las partes la leen
// de ahí. Corre una vez por día, fuera de las horas pico de la app.
import { appendFileSync } from "node:fs";
import { agotado, consultar, guardarCola, guardarCursor, leerCola, leerCursor, resumenLecturas, salirSiPico } from "./d1.mjs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const ejecutar = promisify(execFile);
const arg = (n, def) => {
  const i = process.argv.indexOf(n);
  return i > 0 ? process.argv[i + 1] : def;
};
const PARTES = Number(arg("--partes", 1)), PARTE = Number(arg("--parte", 0)), MINUTOS = Number(arg("--minutos", 45)), MAX = Number(arg("--max", Infinity));
const SIMULAR = process.argv.includes("--simular");
const REPASAR = process.argv.includes("--repasar");
const IDS = arg("--ids", "")?.split(",").filter(Boolean) ?? [];
const env = process.env;
for (const k of ["CLOUDFLARE_API_TOKEN", "CLOUDFLARE_ACCOUNT_ID", "D1_APP_ID"]) if (!env[k]) throw new Error(`Falta el secreto ${k}`);
const t0 = Date.now();
const espera = (ms) => new Promise((ok) => setTimeout(ok, ms));
const CF = `https://api.cloudflare.com/client/v4/accounts/${env.CLOUDFLARE_ACCOUNT_ID}`;
const aut = { authorization: `Bearer ${env.CLOUDFLARE_API_TOKEN}` };

const d1 = (sql, params = []) => consultar(sql, params);
const ARMAR_COLA = process.argv.includes("--armar-cola");
if (!IDS.length) salirSiPico(ARMAR_COLA ? "revisar-contenido (cola)" : `revisar-contenido parte ${PARTE + 1}/${PARTES}`);
const CONTROL = `${CF}/r2/buckets/tenedor-media/objects/control/revision-contenido-${PARTE}.json`;
async function leerHechos() {
  const r = await fetch(CONTROL, { headers: aut });
  return r.ok ? new Set(await r.json().catch(() => [])) : new Set();
}
async function guardarHechos(s) {
  if (SIMULAR || REPASAR) return;
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

const NOMBRE_COLA = "revisar-contenido";
/**
 * Verticales elegidos con copia, recorriendo videos_elegidos por clave (tramos de 1.000) hasta el tope de filas. Si el
 * tope corta, el cursor (ia_config «revisar_contenido_cursor») hace que la corrida siguiente siga desde ahí.
 */
const CURSOR = "revisar_contenido_cursor";
async function armarCola() {
  const items = [];
  let completo = false;
  for (let k = (await leerCursor(CURSOR)).desde ?? ["", ""]; ; ) {
    const tramo = await d1(
      `WITH t AS (SELECT restaurante_id, publicacion_id, vertical FROM videos_elegidos WHERE (restaurante_id, publicacion_id) > (?, ?) ORDER BY restaurante_id, publicacion_id LIMIT 1000)
       SELECT t.publicacion_id AS id, t.restaurante_id, t.vertical, c.url FROM t LEFT JOIN videos_copia c ON c.publicacion_id = t.publicacion_id AND t.vertical = 1`,
      k,
    );
    items.push(...tramo.filter((f) => Number(f.vertical) === 1 && f.url && !String(f.id).startsWith("tv-")).map(({ vertical, ...x }) => x));
    if (tramo.length < 1000) {
      completo = true;
      break;
    }
    k = [tramo.at(-1).restaurante_id, tramo.at(-1).id];
    if (agotado()) {
      if (!SIMULAR) await guardarCursor(CURSOR, { desde: k });
      break;
    }
  }
  if (completo && !SIMULAR) await guardarCursor(CURSOR, { desde: null, vuelta_completa: true });
  console.log(`Cola: ${items.length} verticales con copia${completo ? "" : " (cortada por el tope de filas: sigue la próxima corrida)"} · ${resumenLecturas()}`);
  return items;
}
if (ARMAR_COLA) {
  const items = await armarCola();
  await guardarCola(NOMBRE_COLA, items);
  if (env.GITHUB_OUTPUT) appendFileSync(env.GITHUB_OUTPUT, `items=${items.length}\n`);
  process.exit(0);
}
const hechos = await leerHechos();
let filas;
if (IDS.length)
  filas = await d1(`SELECT e.publicacion_id id, e.restaurante_id, c.url FROM videos_elegidos e JOIN videos_copia c ON c.publicacion_id = e.publicacion_id WHERE e.publicacion_id IN (SELECT value FROM json_each(?))`, [JSON.stringify(IDS)]);
else if (PARTES > 1) {
  const guardada = await leerCola(NOMBRE_COLA);
  if (!guardada) {
    console.log("No está la cola de esta corrida en R2 (el job «cola» no la armó): nada que hacer.");
    process.exit(0);
  }
  filas = guardada.items;
} else filas = await armarCola();
const mias = filas.filter((f) => IDS.length || (hash(f.id) % PARTES === PARTE && (REPASAR || !hechos.has(f.id))));
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
    if (!SIMULAR)
      await d1(
        `INSERT INTO video_medida (publicacion_id, fuente, ancho, alto, vertical, motivo, medido_en) VALUES (?, 'contenido', ?, ?, 0, ?, strftime('%Y-%m-%dT%H:%M:%fZ','now'))
         ON CONFLICT (publicacion_id, fuente) DO UPDATE SET ancho = excluded.ancho, alto = excluded.alto, vertical = 0, motivo = excluded.motivo, medido_en = excluded.medido_en`,
        [f.id, m.cw, m.ch, m.tipo],
      );
  }
  hechos.add(f.id);
  if (n % 50 === 0) { await guardarHechos(hechos); console.log(`[${n}] ${JSON.stringify(total)}`); }
}
await guardarHechos(hechos);
console.log(`Listo (${n}): ${JSON.stringify(total)}${SIMULAR ? " · simulación, no escribió" : ""}`);
