// Revisor de COMERCIOS con IA instalable gratis (10/11/2026, dueño: «OK para pasar al mismo sistema la revisión»).
// Corre en máquinas de GitHub con Ollama + Gemma 4 E4B. Casos que lo motivaron: Maxiconsumo (mayorista), Paul French
// Gallery (muebles), «Full Moon Walk at Iguazú Falls» (excursión) como S/A, y Refugio Spegazzini con @solopatagonia.
// Por comercio S/A (después B) sin revisión (tabla comercios_revision):
//   1. ¿es un lugar para comer o tomar algo? «no» con confianza ≥ 0,85 y sin palabra gastronómica en el nombre →
//      fuera_de_rubro_en (deja de verse; se revierte vaciando el campo);
//   2. ¿su Instagram es suyo? «no» con confianza ≥ 0,85 y sin palabra propia del nombre en la cuenta → se saca la cuenta,
//      se ocultan sus publicaciones en ese comercio y salen de elegidos.
// Uso: node revisar-comercios.mjs --partes N --parte k [--minutos 300] [--niveles S,A] [--modelo gemma4:e4b]
const env = process.env;
const arg = (n, d) => { const i = process.argv.indexOf(n); return i > 0 ? process.argv[i + 1] : d; };
const PARTES = Number(arg("--partes", 1)), PARTE = Number(arg("--parte", 0)), MINUTOS = Number(arg("--minutos", 300));
const NIVELES = arg("--niveles", "S,A").split(",");
const MODELO = arg("--modelo", "gemma4:e4b");
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

const filas = await d1(
  `SELECT r.id, r.nombre, r.cocina, r.ciudad, lp.nivel, lp.puntaje, lower(ltrim(r.instagram,'@')) AS ig,
          substr(coalesce((SELECT f.nombre || ' — ' || coalesce(f.biografia,'') FROM instagram_perfiles f WHERE f.restaurante_id = r.id LIMIT 1),''),1,300) AS bio
   FROM locales_prioridad lp JOIN restaurantes r ON r.id = lp.restaurante_id
   WHERE lp.nivel IN (SELECT value FROM json_each(?)) AND r.estado <> 'cerrado' AND r.fuera_de_rubro_en IS NULL
     AND NOT EXISTS (SELECT 1 FROM comercios_revision c WHERE c.restaurante_id = r.id)`,
  [JSON.stringify(NIVELES)],
);
const hash = (s) => [...s].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7);
const cola = filas.filter((x) => hash(String(x.id)) % PARTES === PARTE).sort((a, b) => (a.nivel === "S" ? 0 : 1) - (b.nivel === "S" ? 0 : 1) || Number(b.puntaje) - Number(a.puntaje));
console.log(`Comercios ${NIVELES.join("/")} sin revisar: ${filas.length} · parte ${PARTE + 1}/${PARTES}: ${cola.length} · modelo ${MODELO}`);
const est = { revisados: 0, ok: 0, fuera: 0, igAjenos: 0, errores: 0 };
let seguidos = 0;
for (const r of cola) {
  if (Date.now() - t0 > MINUTOS * 60_000) break;
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
console.log(`Listo: ${JSON.stringify(est)}`);
