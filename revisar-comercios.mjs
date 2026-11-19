// Revisor de COMERCIOS con IA instalable gratis (10/11/2026, dueño: «OK para pasar al mismo sistema la revisión»).
// Corre en máquinas de GitHub con Ollama + Gemma 4 E4B. Casos que lo motivaron: Maxiconsumo (mayorista), Paul French
// Gallery (muebles), «Full Moon Walk at Iguazú Falls» (excursión) como S/A, y Refugio Spegazzini con @solopatagonia.
// Por comercio S/A (después B) sin revisión (tabla comercios_revision):
//   1. ¿es un lugar para comer o tomar algo? «no» con confianza ≥ 0,85 y sin palabra gastronómica en el nombre →
//      fuera_de_rubro_en (deja de verse; se revierte vaciando el campo);
//   2. ¿su Instagram es suyo? «no» con confianza ≥ 0,85 y sin palabra propia del nombre en la cuenta → se saca la cuenta,
//      se ocultan sus publicaciones en ese comercio y salen de elegidos.
// Uso: node revisar-comercios.mjs --partes N --parte k [--minutos 300] [--niveles S,A] [--modelo gemma4:e4b]
// 18/11/2026 (infra ágil, etapa 5: topes a D1): antes cada una de las 12 partes leía la cola con una consulta de 82 k
// filas. Ahora la arma UNA máquina (--armar-cola, job «cola» de revisar-comercios.yml) recorriendo locales_prioridad por
// nivel en tramos de 500 por clave (índice locales_prioridad_nivel), y la deja en R2; las partes la leen de ahí. No corre
// en las horas pico de la app (11 a 15 y 19 a 24 h de Buenos Aires) y, si entra en el pico, corta.
import { appendFileSync } from "node:fs";
import { agotado, consultar, enPico, guardarCola, guardarCursor, leerCola, leerCursor, resumenLecturas, salirSiPico } from "./d1.mjs";
const env = process.env;
const arg = (n, d) => { const i = process.argv.indexOf(n); return i > 0 ? process.argv[i + 1] : d; };
const PARTES = Number(arg("--partes", 1)), PARTE = Number(arg("--parte", 0)), MINUTOS = Number(arg("--minutos", 300));
const NIVELES = arg("--niveles", "S,A").split(",");
const MODELO = arg("--modelo", "gemma4:e4b");
const t0 = Date.now();

const d1 = (sql, params = []) => consultar(sql, params);
const ARMAR_COLA = process.argv.includes("--armar-cola");
salirSiPico(ARMAR_COLA ? "revisar-comercios (cola)" : `revisar-comercios parte ${PARTE + 1}/${PARTES}`);
async function ollama(sistema, texto) {
  const r = await fetch("http://127.0.0.1:11434/api/chat", {
    method: "POST",
    body: JSON.stringify({ model: MODELO, stream: false, format: "json", think: false, options: { temperature: 0, num_predict: 150 }, messages: [{ role: "system", content: sistema }, { role: "user", content: texto }] }),
    signal: AbortSignal.timeout(120_000),
  });
  const j = await r.json();
  try {
    return JSON.parse(j.message?.content ?? "{}");
  } catch {
    return {};
  }
}
const norm = (x) => String(x ?? "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "");
const GASTRO = /\b(cocina|resto|restaurante?|resto|bar|bares|cafe|cafeteria|parrilla|pizzeria|heladeria|cerveceria|bodegon|confiteria|panaderia|rotiseria|bistro|trattoria|sushi|burger|empanadas|grill|asador|cantina|pulperia|wine bar|vinoteca|brasserie|taberna|comedor|pasta|helados|pizza|patisserie|pasteleria)\b/;
const GENERICAS = new Set("bar cafe resto restaurant restaurante parrilla de la el los las y del club casa the oficial arg ar argentina cocina".split(" "));
const comparte = (nombre, otro) => {
  const p = norm(otro).replace(/[^a-z0-9]/g, "");
  return norm(nombre).split(/[^a-z0-9]+/).filter((w) => w.length >= 4 && !GENERICAS.has(w)).some((w) => p.includes(w));
};
const SISTEMA =
  'Decidís si un comercio de Argentina es un lugar gastronómico para una app de «dónde comer»: restaurante, bar, café, cervecería, heladería, pizzería, parrilla, panadería/confitería con consumo, rotisería, food truck, vinoteca-bar o similar. NO lo son: supermercados y mayoristas, almacenes sin consumo, tiendas de muebles/decoración/ropa, hoteles y lodges (salvo su restaurante/bar con nombre propio), excursiones y paseos, museos, gimnasios, empresas, organismos. Las bodegas, fincas y refugios CON restaurante o almuerzo SÍ son gastronómicos; ante la duda, gastro = true. Además, si se da su Instagram, decidí si esa cuenta es DEL comercio (o de su cadena): una cuenta de turismo, de un medio, de una región, de un hotel o grupo, o de otro negocio NO lo es. Respondé SOLO JSON {"gastro": true|false, "confianza": 0..1, "que": "qué es, breve", "ig_suyo": true|false|null, "ig_confianza": 0..1}.';

const NOMBRE_COLA = `revisar-comercios-${NIVELES.join("")}`;
// Si el tope de filas corta (nivel B: ~38 k comercios), el cursor en ia_config hace que la corrida siguiente siga desde ahí.
const CURSOR = `revisar_comercios_cursor_${NIVELES.join("")}`;
async function armarCola() {
  const items = [];
  const cur = await leerCursor(CURSOR);
  let cortada = null;
  for (const nivel of NIVELES.slice(Math.max(0, NIVELES.indexOf(cur.nivel)))) {
    for (let desde = nivel === cur.nivel ? Number(cur.desde ?? 0) : 0; ; ) {
      const filas = await d1(
        `WITH t AS (SELECT rowid AS k, restaurante_id, nivel, puntaje FROM locales_prioridad WHERE nivel = ? AND rowid > ? ORDER BY rowid LIMIT 500)
         SELECT t.k, t.restaurante_id AS id, r.nombre, r.cocina, r.ciudad, t.nivel, t.puntaje, lower(ltrim(r.instagram,'@')) AS ig, r.estado, r.fuera_de_rubro_en AS fdr,
                EXISTS (SELECT 1 FROM comercios_revision c WHERE c.restaurante_id = t.restaurante_id) AS hecha
         FROM t JOIN restaurantes r ON r.id = t.restaurante_id ORDER BY t.k`,
        [nivel, desde],
      );
      items.push(...filas.filter((f) => f.estado !== "cerrado" && f.fdr == null && Number(f.hecha) === 0).map(({ k, estado, fdr, hecha, ...x }) => x));
      if (filas.length < 500) break;
      desde = filas.at(-1).k;
      if (agotado()) {
        cortada = { nivel, desde };
        break;
      }
    }
    if (cortada) break;
  }
  await guardarCursor(CURSOR, cortada ?? { nivel: null, desde: 0, vuelta_completa: true });
  // La biografía de Instagram, sólo de los que quedaron (clave de instagram_perfiles), de a 200.
  for (let i = 0; i < items.length; i += 200) {
    const bios = new Map((await d1(
      `SELECT j.value AS id, substr(coalesce((SELECT f.nombre || ' — ' || coalesce(f.biografia,'') FROM instagram_perfiles f WHERE f.restaurante_id = j.value LIMIT 1),''),1,300) AS bio FROM json_each(?) j`,
      [JSON.stringify(items.slice(i, i + 200).map((x) => x.id))],
    )).map((x) => [String(x.id), x.bio]));
    for (const x of items.slice(i, i + 200)) x.bio = bios.get(String(x.id)) ?? "";
  }
  console.log(`Cola: ${items.length} comercios ${NIVELES.join("/")} sin revisar${cortada ? " (cortada por el tope de filas: sigue la próxima corrida)" : ""} · ${resumenLecturas()}`);
  return items;
}
if (ARMAR_COLA) {
  const items = await armarCola();
  await guardarCola(NOMBRE_COLA, items);
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `items=${items.length}\n`);
  process.exit(0);
}
const guardada = PARTES > 1 ? await leerCola(NOMBRE_COLA) : null;
if (PARTES > 1 && !guardada) {
  console.log("No está la cola de esta corrida en R2 (el job «cola» no la armó): nada que hacer.");
  process.exit(0);
}
const filas = guardada ? guardada.items : await armarCola();
const hash = (s) => [...s].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7);
const cola = filas.filter((x) => hash(String(x.id)) % PARTES === PARTE).sort((a, b) => (a.nivel === "S" ? 0 : 1) - (b.nivel === "S" ? 0 : 1) || Number(b.puntaje) - Number(a.puntaje));
console.log(`Comercios ${NIVELES.join("/")} sin revisar: ${filas.length} · parte ${PARTE + 1}/${PARTES}: ${cola.length} · modelo ${MODELO}`);
const est = { revisados: 0, ok: 0, fuera: 0, igAjenos: 0, errores: 0 };
let seguidos = 0;
for (const r of cola) {
  if (Date.now() - t0 > MINUTOS * 60_000) break;
  if (enPico() && !process.argv.includes("--forzar")) {
    console.log("Entró la hora pico de la app: corto; lo que falta sigue en la próxima corrida.");
    break;
  }
  try {
    const j = await ollama(SISTEMA, `Nombre: «${r.nombre}». Rubro cargado: ${r.cocina ?? "?"}. Ciudad: ${r.ciudad ?? "?"}.${r.ig ? ` Instagram: @${r.ig}.` : ""}${r.bio ? ` Perfil: ${r.bio}` : ""}`);
    const conf = Number(j.confianza ?? 0), igConf = Number(j.ig_confianza ?? 0);
    let accion = "ok";
    if (j.gastro === false && conf >= 0.85 && !GASTRO.test(norm(r.nombre))) {
      accion = "fuera";
      est.fuera++;
      await d1("UPDATE restaurantes SET fuera_de_rubro_en = ? WHERE id = ? AND fuera_de_rubro_en IS NULL", [new Date().toISOString(), String(r.id)]);
      console.log(`✗ ${r.nombre} (${r.nivel}): ${j.que}`);
    } else if (r.ig && j.ig_suyo === false && igConf >= 0.85 && !comparte(r.nombre, `${r.ig} ${r.bio}`)) {
      accion = "ig-ajeno";
      est.igAjenos++;
      const id = String(r.id), u = String(r.ig);
      await d1("UPDATE restaurantes SET instagram = '' WHERE id = ?", [id]);
      await d1("UPDATE publicaciones SET oculta = 1 WHERE restaurante_id = ? AND lower(ltrim(usuario,'@')) = ?", [id, u]);
      await d1("DELETE FROM videos_elegidos WHERE restaurante_id = ? AND publicacion_id IN (SELECT id FROM publicaciones WHERE restaurante_id = ? AND lower(ltrim(usuario,'@')) = ?)", [id, id, u]);
      console.log(`✗ IG @${u} no es de ${r.nombre}`);
    } else est.ok++;
    await d1("INSERT OR REPLACE INTO comercios_revision (restaurante_id, gastro, ig_suyo, que, ig, accion, modelo) VALUES (?, ?, ?, ?, ?, ?, ?)", [
      String(r.id), typeof j.gastro === "boolean" ? (j.gastro ? 1 : 0) : null, typeof j.ig_suyo === "boolean" ? (j.ig_suyo ? 1 : 0) : null, String(j.que ?? "").slice(0, 200), r.ig ?? "", accion, MODELO,
    ]);
    est.revisados++;
    seguidos = 0;
  } catch (e) {
    est.errores++;
    console.log(`error ${r.id}: ${String(e).slice(0, 120)}`);
    if (++seguidos >= 5) break;
  }
  if (est.revisados % 100 === 0) console.log(`[avance ${est.revisados}/${cola.length}] ${JSON.stringify(est)}`);
}
console.log(`Listo: ${JSON.stringify(est)} · ${resumenLecturas()}`);
