// Portada propia de un video (12/11/2026, dueño: «regenerá las portadas»). SIEMPRE el cuadro de los 0,5 s de NUESTRA copia
// (la que se reproduce), nunca la miniatura de Instagram: el feed arranca el video en ese mismo cuadro la primera vez
// (SEGUNDO_PORTADA en src/lib/portada-propia.ts de la app), así el paso de la portada al video no se nota. La miniatura
// de Instagram suele ser otro cuadro o una tapa armada: al arrancar se veía un salto («va para atrás y avanza rápido»).
// Mismos tamaños que scripts/cf/portadas-videos.mts de la app: <id>.jpg 720 px (póster) y <id>-160.jpg (tira de la ficha).
import { execFile } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const ejecutar = promisify(execFile);
/** Segundo del cuadro: tiene que ser el mismo que SEGUNDO_PORTADA de la app. */
export const SEGUNDO_PORTADA = 0.5;

/**
 * Saca las dos portadas del video `entrada` (archivo local o URL https; con una URL ffmpeg pide sólo el comienzo).
 * Devuelve { grande, chica } (JPEG). Con videos de menos de un segundo usa el primer cuadro.
 */
export async function portadaDeVideo(entrada) {
  const dir = mkdtempSync(join(tmpdir(), "portada-"));
  const g = join(dir, "g.jpg");
  const c = join(dir, "c.jpg");
  const sacar = (ss) =>
    ejecutar(
      "ffmpeg",
      ["-v", "error", "-y", ...(ss ? ["-ss", String(ss)] : []), "-i", entrada, "-filter_complex", "[0:v]split=2[a][b];[a]scale=720:-2[g];[b]scale=160:-2[c]",
        "-map", "[g]", "-frames:v", "1", "-q:v", "4", g, "-map", "[c]", "-frames:v", "1", "-q:v", "5", c],
      { timeout: 120_000 },
    );
  try {
    await sacar(SEGUNDO_PORTADA);
    let grande = leer(g);
    let chica = leer(c);
    // Video más corto que 0,5 s: ffmpeg no saca nada; se usa el primer cuadro (la app tampoco salta en esos).
    if (!grande || !chica) {
      await sacar(0);
      grande = leer(g);
      chica = leer(c);
    }
    if (!grande || !chica) throw new Error("ffmpeg no sacó el cuadro");
    return { grande, chica };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function leer(f) {
  try {
    const b = readFileSync(f);
    return b.length ? b : null;
  } catch {
    return null;
  }
}

/** Diferencia media (0–255) entre dos imágenes en gris a 24×42: ≤ 3 es la misma imagen recomprimida. */
export async function diferencia(a, b) {
  const gris = async (buf) => {
    const dir = mkdtempSync(join(tmpdir(), "dif-"));
    const f = join(dir, "x.jpg");
    try {
      writeFileSync(f, buf);
      const { stdout } = await ejecutar("ffmpeg", ["-v", "error", "-i", f, "-vf", "scale=24:42,format=gray", "-frames:v", "1", "-f", "rawvideo", "-"], { encoding: "buffer", maxBuffer: 1e6, timeout: 30_000 });
      return stdout;
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };
  // Una portada vieja que ffmpeg no lee (dañada, otro formato) cuenta como distinta: se reemplaza.
  const [x, y] = await Promise.all([gris(a).catch(() => Buffer.alloc(0)), gris(b).catch(() => Buffer.alloc(0))]);
  if (x.length !== y.length || !x.length) return 255;
  let s = 0;
  for (let i = 0; i < x.length; i++) s += Math.abs(x[i] - y[i]);
  return Math.round((s / x.length) * 10) / 10;
}
