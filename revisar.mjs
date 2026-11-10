// Revisor de videos con IA instalable y gratuita (09/11/2026, dueño: «el revisor de videos tiene que ser una IA
// instalable gratuita, buscá la mejor opción»). Corre en las máquinas de GitHub (repo público: sin costo) con Ollama
// y LFM3-VL 2B: en la prueba con cuadros reales acertó 6 de 8 a 4,7 s por imagen (Gemma 4 E4B: 4/8 a 13,5 s; Qwen3-VL
// 4B no respondió). Por cada video ELEGIDO con copia propia que no tenga revisión (tabla videos_revision):
//   1. el texto de la publicación: si dice claramente que es de otra cosa (curso, sorteo de otra marca, política…) → afuera;
//   2. si no, dos cuadros (segundos 3 y 9, a 256 px): si los dos son ajenos → afuera.
// Afuera = publicacion oculta + fuera de elegidos. Todo queda en videos_revision (se puede volver atrás).
// Orden: S, A+ (ia_config nivel_a_mas), A, B. Uso: node revisar.mjs --partes N --parte k [--minutos 300] [--modelo lfm3-vl:2b]
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFileSync, rmSync, existsSync } from "node:fs";
const ejecutar = promisify(execFile);
const env = process.env;
const arg = (n, d) => { const i = process.argv.indexOf(n); return i > 0 ? process.argv[i + 1] : d; };
const PARTES = Number(arg("--partes", 1)), PARTE = Number(arg("--parte", 0)), MINUTOS = Number(arg("--minutos", 300));
const MODELO = arg("--modelo", "lfm3-vl:2b");
// 09/11, segunda prueba: el modelo de 2B aprobaba por texto promos de viajes o de muebles. El texto lo juzga Gemma 4 E4B
// (razona mejor) y un video sólo se aprueba si la IMAGEN muestra algo gastronómico.
const MODELO_TEXTO = arg("--modelo-texto", "gemma4:e4b");
const t0 = Date.now();

async function d1(sql, params = []) {
  for (let i = 0; i < 4; i++) {
    const r = await fetch(`https://api.cloudflare.com/client/v4/accounts/${env.CLOUDFLARE_ACCOUNT_ID}/d1/database/${env.D1_APP_ID}/query`, {
      method: "POST",
      headers: { authorization: `Bearer ${env.CLOUDFLARE_API_TOKEN}`, "content-type": "application/json" },
      body: JSON.stringify({ sql, params }),
    }).catch(() => null);
    const j = await r?.json().catch(() => null);
    if (j?.success) return j.result[0].results;
    await new Promise((ok) => setTimeout(ok, 3000 * (i + 1)));
  }
  throw new Error("D1 no responde");
}
async function ollama(sistema, texto, imagen, modelo = MODELO) {
  const r = await fetch("http://127.0.0.1:11434/api/chat", {
    method: "POST",
    body: JSON.stringify({ model: modelo, stream: false, format: "json", think: false, options: { temperature: 0, num_predict: 100 }, messages: [{ role: "system", content: sistema }, { role: "user", content: texto, ...(imagen ? { images: [imagen] } : {}) }] }),
    signal: AbortSignal.timeout(120_000),
  });
  const j = await r.json();
  try {
    return JSON.parse(j.message?.content ?? "{}");
  } catch {
    return {};
  }
}

const TEXTO =
  'Clasificás publicaciones de Instagram de un comercio gastronómico de Argentina para un feed de «dónde comer». Respondé SOLO JSON {"gastro": true|false|null, "confianza": 0..1, "que": "breve"}. gastro = true si trata de su comida, bebidas, el local, su equipo, una promo, o un evento del comercio donde se come o se toma algo. false si trata de otra cosa: cursos, talleres o terapias que no son de cocina, sorteos o publicidad de otra marca, política, noticias, mascotas, bebés, frases, obras o mudanzas, eventos sin comida. null si el texto no alcanza para saber.';
const IMAGEN =
  'Mirás un cuadro de un video publicado por un comercio gastronómico. Respondé SOLO JSON {"gastro": true|false, "confianza": 0..1, "que": "breve"}. gastro = true si muestra comida, bebida, el local o su fachada, su cocina, gente comiendo, brindando o atendiendo, o un cartel/promo del comercio. false si es algo ajeno (animales, naturaleza, una clase o terapia, noticias, deportes, publicidad de otra marca, bebés, obras en construcción, memes).';

async function cuadro(url, seg) {
  const salida = `/tmp/cuadro-${PARTE}-${seg}.jpg`;
  rmSync(salida, { force: true });
  await ejecutar("ffmpeg", ["-y", "-v", "error", "-ss", String(seg), "-i", url, "-frames:v", "1", "-vf", "scale=256:-2", salida], { timeout: 60_000 }).catch(() => null);
  if (!existsSync(salida)) return null;
  const j = await ollama(IMAGEN, "¿Qué muestra?", readFileSync(salida).toString("base64"));
  return { gastro: typeof j.gastro === "boolean" ? j.gastro : null, conf: Number(j.confianza ?? 0), que: String(j.que ?? "") };
}

const aMasFila = (await d1("SELECT valor FROM ia_config WHERE clave = 'nivel_a_mas'"))[0];
const aMas = new Set(aMasFila ? JSON.parse(String(aMasFila.valor)).ids : []);
const filas = await d1(
  `SELECT e.publicacion_id AS id, e.restaurante_id AS rid, coalesce(lp.nivel,'C') AS nivel, coalesce(lp.puntaje,0) AS puntaje, c.url, substr(coalesce(p.texto,''),1,700) AS texto, r.nombre
   FROM videos_elegidos e JOIN videos_copia c ON c.publicacion_id = e.publicacion_id JOIN publicaciones p ON p.id = e.publicacion_id
   JOIN restaurantes r ON r.id = e.restaurante_id LEFT JOIN locales_prioridad lp ON lp.restaurante_id = e.restaurante_id
   WHERE r.estado <> 'cerrado' AND (
     (p.oculta = 0 AND NOT EXISTS (SELECT 1 FROM videos_revision v WHERE v.publicacion_id = e.publicacion_id))
     -- 10/11 (dueño): los videos nuevos entran ocultos («pendiente») y recién se muestran si la revisión los aprueba.
     OR EXISTS (SELECT 1 FROM videos_revision v WHERE v.publicacion_id = e.publicacion_id AND v.accion = 'pendiente'))`,
);
const hash = (s) => [...s].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7);
const rango = (x) => (x.nivel === "S" ? 0 : aMas.has(String(x.rid)) ? 1 : x.nivel === "A" ? 2 : x.nivel === "B" ? 3 : 4);
const cola = filas.filter((x) => hash(String(x.id)) % PARTES === PARTE).sort((a, b) => rango(a) - rango(b) || Number(b.puntaje) - Number(a.puntaje));
console.log(`Sin revisar: ${filas.length} · parte ${PARTE + 1}/${PARTES}: ${cola.length} · modelo ${MODELO}`);

const est = { revisados: 0, ok: 0, afueraTexto: 0, afueraImagen: 0, dudosos: 0, errores: 0 };
async function anotar(v, gastro, como, que, accion) {
  await d1("INSERT OR REPLACE INTO videos_revision (publicacion_id, restaurante_id, gastro, como, que, modelo, accion) VALUES (?, ?, ?, ?, ?, ?, ?)", [String(v.id), String(v.rid), gastro === null ? null : gastro ? 1 : 0, como, que.slice(0, 200), MODELO, accion]);
}
async function afuera(v, como, que) {
  await d1("UPDATE publicaciones SET oculta = 1 WHERE id = ?", [String(v.id)]);
  await d1("DELETE FROM videos_elegidos WHERE publicacion_id = ?", [String(v.id)]);
  await anotar(v, false, como, que, "oculta");
  console.log(`✗ ${v.nombre} [${como}]: ${que}`);
}
let seguidos = 0;
for (const v of cola) {
  if (Date.now() - t0 > MINUTOS * 60_000) break;
  try {
    const texto = String(v.texto ?? "").trim();
    let txt = null;
    if (texto.length >= 25) {
      const j = await ollama(TEXTO, `Comercio: «${v.nombre}».
Texto de la publicación: ${texto}`, null, MODELO_TEXTO);
      txt = { gastro: typeof j.gastro === "boolean" ? j.gastro : null, conf: Number(j.confianza ?? 0), que: String(j.que ?? "") };
    }
    if (txt?.gastro === false && txt.conf >= 0.8) {
      await afuera(v, "texto", txt.que);
      est.afueraTexto++;
    } else {
      const a = await cuadro(String(v.url), 3);
      const b = a?.gastro !== true ? await cuadro(String(v.url), 9) : null;
      const imagenSi = a?.gastro === true || b?.gastro === true;
      const imagenNo = a?.gastro === false && (b === null || b.gastro === false);
      if (imagenSi) {
        await d1("UPDATE publicaciones SET oculta = 0 WHERE id = ? AND id IN (SELECT publicacion_id FROM videos_revision WHERE accion = 'pendiente')", [String(v.id)]);
        await anotar(v, true, "imagen", a?.gastro ? a.que : (b?.que ?? ""), "ok");
        est.ok++;
      } else if (imagenNo && txt?.gastro !== true) {
        await afuera(v, "imagen", `${a?.que ?? ""} | ${b?.que ?? ""}`);
        est.afueraImagen++;
      } else {
        // 10/11 (dueño: «los que no coinciden o dudosos salen; esto libera cupo para traer nuevos que vuelven a ser
        // analizados»): el dudoso también sale (su lugar en el tope del comercio queda libre para otro video).
        await afuera(v, "dudoso", `${a?.que ?? "sin cuadro"} | ${b?.que ?? ""} | texto: ${txt?.que ?? "-"}`);
        est.dudosos++;
      }
    }
    est.revisados++;
    seguidos = 0;
  } catch (e) {
    est.errores++;
    console.log(`error ${v.id}: ${String(e).slice(0, 120)}`);
    if (++seguidos >= 5) break;
  }
  if (est.revisados % 50 === 0) console.log(`[avance ${est.revisados}/${cola.length}] ${JSON.stringify(est)} · ${Math.round((Date.now() - t0) / 60000)} min`);
}
console.log(`Listo: ${JSON.stringify(est)}`);
