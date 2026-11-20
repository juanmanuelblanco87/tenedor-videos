// Medida de los videos nuevos (19/11/2026 noche, re-mediciones de Tenedor: 3.130 videos visibles del día sin medida;
// la medición sólo corría a mano desde la PC, tenedor-cf-ig/scripts/cf/remedir-verticales.mts --sin-medida). Sin medida,
// un video horizontal puede abrir la tarjeta del feed (orden-ficha-calculo.ts lo trata como desconocido).
// Corre sola (medir-videos.yml, cada 2 h) y mide con ffprobe:
//   A) los que entraron a NUESTRA copia (videos_copia) desde la última vuelta: cursor por copiado_en en ia_config
//      («medir_videos_cursor»), de a TANDA, salteando los que ya tienen medida;
//   B) los visibles que todavía apuntan al link de Instagram (sin copia): por el índice parcial publicaciones_cola_copia
//      (condición literal COLA_PUBLICACIONES), mientras el link no venció.
// Guarda en video_medida con fuente «mp4» (la misma que remedir-verticales.mts): ordenarGuardados la toma en su próxima
// vuelta con la precedencia de siempre (un «franjas» de contenido sigue mandando). Nunca escribe videos_elegidos.
// Topes (d1.mjs): consultas cortas con LIMIT, tope de filas por corrida y fuera de las horas pico de la app.
// Uso: node medir-videos.mjs [--max 3000] [--paralelo 6] [--prueba] [--forzar]
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { agotado, consultar, COLA_PUBLICACIONES, guardarCursor, leerCursor, resumenLecturas, salirSiPico } from "./d1.mjs";

const exec = promisify(execFile);
const argNum = (n, d) => {
  const i = process.argv.indexOf(n);
  return i > 0 ? Number(process.argv[i + 1]) : d;
};
const MAX = argNum("--max", 3000);
const PARALELO = argNum("--paralelo", 6);
const PRUEBA = process.argv.includes("--prueba");
const TANDA = 500;
const CURSOR = "medir_videos_cursor";

/** Vertical: alto/ancho ≥ 1,5 (la misma regla que esVertical de src/lib/seleccion-videos-calculo.ts). */
export const esVertical = (ancho, alto) => Boolean(ancho && alto && alto / ancho >= 1.5);

/** Ancho y alto como se VEN (con la rotación de la pista), o null. */
export function medidasDeFfprobe(salida) {
  const s = (salida?.streams ?? [])[0];
  if (!s?.width || !s?.height) return null;
  const rot = Number(s.tags?.rotate ?? (s.side_data_list ?? []).find((d) => d.rotation !== undefined)?.rotation ?? 0);
  const girado = Math.abs(rot) % 180 === 90;
  return girado ? { ancho: s.height, alto: s.width } : { ancho: s.width, alto: s.height };
}

async function medir(url) {
  try {
    const { stdout } = await exec(
      "ffprobe",
      ["-v", "error", "-rw_timeout", "20000000", "-select_streams", "v:0", "-show_entries", "stream=width,height:stream_tags=rotate:stream_side_data=rotation", "-of", "json", url],
      { timeout: 45_000, maxBuffer: 1 << 20 },
    );
    return medidasDeFfprobe(JSON.parse(stdout));
  } catch {
    return null;
  }
}

/** De esos ids, los que ya tienen medida (por la clave primaria de video_medida). */
async function yaMedidos(ids) {
  if (!ids.length) return new Set();
  const filas = await consultar(
    "SELECT DISTINCT publicacion_id FROM video_medida WHERE publicacion_id IN (SELECT value FROM json_each(?)) AND (vertical IS NOT NULL OR ancho IS NOT NULL)",
    [JSON.stringify(ids)],
  );
  return new Set(filas.map((f) => String(f.publicacion_id)));
}

const cuenta = { medidos: 0, verticales: 0, horizontales: 0, sin_medida: 0 };
async function medirLista(lista) {
  let i = 0;
  const trabajar = async () => {
    for (;;) {
      const x = lista[i++];
      if (!x) return;
      const m = await medir(x.url);
      if (!m) {
        cuenta.sin_medida++;
        continue;
      }
      const v = esVertical(m.ancho, m.alto);
      cuenta.medidos++;
      v ? cuenta.verticales++ : cuenta.horizontales++;
      if (!PRUEBA)
        await consultar(
          `INSERT INTO video_medida (publicacion_id, fuente, ancho, alto, vertical, motivo, medido_en) VALUES (?, 'mp4', ?, ?, ?, '', strftime('%Y-%m-%dT%H:%M:%fZ','now'))
           ON CONFLICT (publicacion_id, fuente) DO UPDATE SET ancho = excluded.ancho, alto = excluded.alto, vertical = excluded.vertical, medido_en = excluded.medido_en`,
          [x.id, m.ancho, m.alto, v ? 1 : 0],
        );
    }
  };
  await Promise.all(Array.from({ length: PARALELO }, trabajar));
}

salirSiPico("medir-videos");

// A) Copias nuevas desde la última vuelta. Sin el índice videos_copia_copiado_en (migración app 0045) cada tanda
// recorrería las ~46.000 copias: entonces sólo corre B. La primera vez arranca 3 días atrás (lo anterior lo midió
// remedir-verticales.mts el 19/11).
const hayIndice = (await consultar("SELECT 1 FROM sqlite_master WHERE type = 'index' AND name = 'videos_copia_copiado_en'")).length > 0;
if (!hayIndice) console.log("medir-videos: falta el índice videos_copia_copiado_en (migración app 0045): sólo los links directos (B).");
const cursor = hayIndice ? await leerCursor(CURSOR) : {};
let desde = typeof cursor.copiado_en === "string" ? cursor.copiado_en : new Date(Date.now() - 3 * 86_400_000).toISOString();
let hechos = 0;
while (hayIndice && hechos < MAX && !agotado()) {
  const tanda = await consultar("SELECT publicacion_id AS id, url, copiado_en FROM videos_copia WHERE copiado_en > ? AND publicacion_id NOT LIKE 'tv-%' ORDER BY copiado_en LIMIT ?", [desde, TANDA]);
  if (!tanda.length) break;
  const medidos = await yaMedidos(tanda.map((t) => String(t.id)));
  const lista = tanda.filter((t) => !medidos.has(String(t.id))).map((t) => ({ id: String(t.id), url: String(t.url).replace("https://datos.tenedor.com.ar/", "https://media.tenedor.com.ar/") }));
  await medirLista(lista);
  hechos += lista.length;
  desde = String(tanda[tanda.length - 1].copiado_en);
  if (!PRUEBA) await guardarCursor(CURSOR, { copiado_en: desde });
  if (tanda.length < TANDA) break;
}

// B) Visibles con el link de Instagram todavía (sin copia), mientras no venció.
if (hechos < MAX && !agotado()) {
  const ahora = new Date(Date.now() + 10 * 60_000).toISOString();
  const directos = await consultar(
    `SELECT id, media_url AS url FROM publicaciones WHERE ${COLA_PUBLICACIONES} AND vence_en > ? AND tipo = 'video' AND oculta = 0 AND id NOT LIKE 'tv-%' ORDER BY vence_en, id LIMIT ?`,
    [ahora, Math.min(TANDA * 4, MAX - hechos)],
  );
  const medidos = new Set();
  for (let i = 0; i < directos.length; i += TANDA) for (const id of await yaMedidos(directos.slice(i, i + TANDA).map((d) => String(d.id)))) medidos.add(id);
  await medirLista(directos.filter((d) => !medidos.has(String(d.id))).map((d) => ({ id: String(d.id), url: String(d.url) })));
}

console.log(`medir-videos${PRUEBA ? " (prueba, sin escribir)" : ""}: ${JSON.stringify(cuenta)} · cursor ${desde || "(inicio)"} · ${resumenLecturas()}`);
