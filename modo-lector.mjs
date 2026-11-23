// Lector de MODO compartido (23/11/2026): lo usan el piloto (modo-piloto.mjs) y la lectura diaria (modo-diario.mjs), para
// que las dos lean, filtren y respeten robots.txt EXACTAMENTE igual (REGLA 0: la regla en un solo lugar). Sin efectos al
// importarlo: no lee archivos ni pide nada hasta que se llama a una función.
//
// Reglas: respeta robots.txt (se lee primero y se chequea cada ruta), user-agent genérico, como mucho 1 pedido cada
// 2,1 s, ante 403 / 429 / captcha corta (Bloqueo). No usa la API de MODO (/api/ está prohibida) ni el mapa de sucursales
// (map-handler, es API interna de su web): sólo el sitemap y las fichas /promos/{slug} con sus datos estructurados.

export const BASE_MODO = "https://www.modo.com.ar";
export const PAUSA_MS = 2100;
const espera = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- robots.txt (grupo User-agent: *; regla más larga gana, Allow gana empates) ----------
export function parsearRobots(txt) {
  const grupos = [];
  let actual = null;
  let ultimoFueUA = false;
  for (const crudo of txt.split(/\r?\n/)) {
    const linea = crudo.replace(/#.*/, "").trim();
    if (!linea) continue;
    const m = linea.match(/^([A-Za-z-]+)\s*:\s*(.*)$/);
    if (!m) continue;
    const k = m[1].toLowerCase();
    const v = m[2].trim();
    if (k === "user-agent") {
      if (!ultimoFueUA) grupos.push((actual = { uas: [], reglas: [] }));
      actual.uas.push(v.toLowerCase());
      ultimoFueUA = true;
    } else {
      ultimoFueUA = false;
      if (actual && (k === "allow" || k === "disallow")) actual.reglas.push({ allow: k === "allow", ruta: v });
    }
  }
  const mio = grupos.filter((g) => g.uas.some((u) => u !== "*" && "tenedorbot".startsWith(u)));
  const reglas = (mio.length ? mio : grupos.filter((g) => g.uas.includes("*"))).flatMap((g) => g.reglas);
  const aRe = (r) => new RegExp("^" + r.replace(/[.+?^{}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\\\$$|\$$/, "$"));
  return (ruta) => {
    let mejor = null;
    for (const r of reglas) {
      if (!r.ruta) continue;
      if (aRe(r.ruta).test(ruta) && (!mejor || r.ruta.length > mejor.ruta.length || (r.ruta.length === mejor.ruta.length && r.allow))) mejor = r;
    }
    return !mejor || mejor.allow;
  };
}

// ---------- pedidos con ritmo y corte ante bloqueo ----------
export class Bloqueo extends Error {}
export class ProhibidoPorRobots extends Error {}

/**
 * Un «pedidor» con su ritmo (1 pedido cada `pausaMs`), su robots.txt y su cuenta de pedidos. `tope` = máximo de pedidos
 * (incluidos robots y sitemap): al llegar, no pide más (lanza Bloqueo «tope»). `fetchImpl` lo reemplazan las pruebas.
 */
export function crearPedidor({ ua, pausaMs = PAUSA_MS, tope = Infinity, fetchImpl = fetch } = {}) {
  let ultimo = 0;
  let permitido = () => true;
  const p = {
    pedidos: 0,
    robots(txt) {
      permitido = parsearRobots(txt);
    },
    permitido: (ruta) => permitido(ruta),
    async pedir(url) {
      const u = new URL(url);
      if (!permitido(u.pathname + u.search)) throw new ProhibidoPorRobots(`robots.txt prohíbe ${u.pathname}`);
      if (p.pedidos >= tope) throw new Bloqueo(`tope de ${tope} pedidos por corrida`);
      const falta = ultimo + pausaMs - Date.now();
      if (falta > 0) await espera(falta);
      ultimo = Date.now();
      p.pedidos++;
      const r = await fetchImpl(url, { headers: { "user-agent": ua, "accept-language": "es-AR,es" }, redirect: "follow", signal: AbortSignal.timeout(30_000) });
      if (r.status === 403 || r.status === 429) throw new Bloqueo(`HTTP ${r.status}`);
      const t = await r.text();
      if (/captcha|cf-challenge|are you a robot|unusual traffic/i.test(t.slice(0, 5000))) throw new Bloqueo("captcha");
      return { status: r.status, texto: t };
    },
  };
  return p;
}

/** Los slugs de /promos/sitemap.xml (sin repetidos, en el orden del sitemap). */
export const slugsDelSitemap = (xml) => [...new Set([...xml.matchAll(/<loc>https:\/\/www\.modo\.com\.ar\/promos\/([^<\/?#]+)<\/loc>/g)].map((m) => m[1]))];

// ---------- lectura de una página de promo (payload RSC de Next.js) ----------
function rscDe(html) {
  return [...html.matchAll(/self\.__next_f\.push\(\[1,("(?:[^"\\]|\\.)*")\]\)/g)].map((m) => JSON.parse(m[1])).join("");
}
function objetoDesde(txt, i) {
  // i apunta a "{"; devuelve el JSON balanceado
  let prof = 0, enStr = false, esc = false;
  for (let j = i; j < txt.length; j++) {
    const c = txt[j];
    if (enStr) { if (esc) esc = false; else if (c === "\\") esc = true; else if (c === '"') enStr = false; continue; }
    if (c === '"') enStr = true;
    else if (c === "{") prof++;
    else if (c === "}" && --prof === 0) return JSON.parse(txt.slice(i, j + 1));
  }
  return null;
}
function filaTexto(rsc, id) {
  const m = new RegExp(`(?:^|\\n)${id}:T([0-9a-f]+),`).exec(rsc);
  if (!m) return "";
  const resto = Buffer.from(rsc.slice(m.index + m[0].length), "utf8");
  return resto.subarray(0, parseInt(m[1], 16)).toString("utf8");
}
const sinHtml = (s) => String(s ?? "").replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/\s+/g, " ").trim();
export function parsearPromo(html, slug) {
  const rsc = rscDe(html);
  const k = rsc.indexOf('"promotion":{"card"');
  if (k < 0) return null;
  const o = objetoDesde(rsc, rsc.indexOf("{", k + 11));
  if (!o?.promotion) return null;
  const p = o.promotion;
  const textos = (sec) => (o.sections?.[sec]?.contents ?? []).map((c) => {
    const d = typeof c.description === "string" && /^\$[0-9a-f]+$/.test(c.description) ? filaTexto(rsc, c.description.slice(1)) : c.description;
    return [c.title, sinHtml(d)].filter(Boolean).join(" ");
  }).join(" ");
  const ld = rsc.match(/\\?"validThrough\\?":\\?"(\d{4}-\d{2}-\d{2})/);
  return {
    slug,
    url: `${BASE_MODO}/promos/${slug}`,
    id: p.id,
    titulo: p.title ?? "",
    nombre: p.name ?? "",
    descripcion: p.description ?? "",
    interno: p.short_description ?? "",
    comercio: p.where || o.card?.content?.row?.[0]?.text || "",
    beneficio: (o.card?.content?.row ?? []).slice(1).map((r) => r.text).join(" · "),
    tipo: o.card?.type ?? "",
    tags: o.meta?.search_tags ?? [],
    estado: p.status ?? "",
    estado_calculado: p.calculated_status ?? "",
    dias: p.days_of_week ?? "",
    desde: p.start_date ?? "",
    hasta: p.stop_date ?? "",
    hasta_ld: ld?.[1] ?? "",
    horario: [p.daily_start_time, p.daily_stop_time].filter(Boolean).join("-"),
    medio: p.payment_flow ?? "",
    credito: o.trigger_params?.credit_list ?? [],
    debito: o.trigger_params?.debit_list ?? [],
    tope: o.trigger_params?.cap_amount_period ?? o.trigger_params?.cap_transaction ?? null,
    cuotas: (o.installments ?? []).length,
    cuerpo: textos("header") + " " + textos("body"),
    legales: textos("tyc"),
  };
}

// ---------- normalización y clasificación ----------
export const norm = (s) => String(s ?? "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/&/g, " y ").replace(/[^a-z0-9]+/g, " ").trim();
const GASTRO = /\b(gastro\w*|restaurant\w*|resto|restos|restobar\w*|bar|bares|cafe|cafes|cafeteria\w*|coffee|helader\w*|helados?|parrill\w*|pizz\w*|sushi\w*|cervec\w*|beer\w*|bodegon\w*|hamburgues\w*|burgers?|confiteria\w*|empanad\w*|bistro|grill|trattoria|cantina|comidas?|food\w*|brunch|vermuteria|bakery|pasteleria\w*|panaderia\w*|rotiseria\w*|pastas)\b/;
const NO_GASTRO = /\b(supermercad\w*|hipermercad\w*|farmac\w*|perfumer\w*|combustible|nafta|estacion de servicio|indumentaria|electro\w*|ferreter\w*|jugueter\w*|veterinar\w*|mascotas)\b/;
export function esGastro(p) {
  const fuerte = norm([p.titulo, p.nombre, p.comercio, p.interno, p.slug.replace(/-/g, " "), p.tags.join(" "), p.descripcion].join(" "));
  if (GASTRO.test(fuerte) && !NO_GASTRO.test(norm([p.titulo, p.nombre, p.comercio].join(" ")))) return "fuerte";
  const leg = norm(p.legales);
  if (/\b(rubro gastronom\w*|locales gastronomicos|comercios gastronomicos|restaurantes adheridos|bares y restaurantes)\b/.test(leg) && !/no (aplica|valido|participa)\w* (para |en )?(el )?rubro gastronom/.test(leg)) return "debil";
  return "";
}
const BANCOS = [
  ["Galicia", /galicia/], ["Macro", /\bmacro\b/], ["BBVA", /\bbbva\b|frances/], ["Santander", /santander/], ["ICBC", /\bicbc\b/],
  ["Nación", /\bbna\b|banco (de la )?nacion/], ["Provincia", /banco (de la )?provincia( de buenos aires)?\b(?! de)|\bbapro\b/], ["Ciudad", /banco (de la )?ciudad/],
  ["Supervielle", /supervielle/], ["Comafi", /comafi/], ["Credicoop", /credicoop/], ["Patagonia", /patagonia/], ["Hipotecario", /hipotecario/],
  ["Columbia", /columbia/], ["Bancor", /bancor|banco de (la provincia de )?cordoba/], ["Santa Fe", /banco (de )?santa fe/], ["Entre Ríos", /banco (de )?entre rios/],
  ["San Juan", /banco (de )?san juan/], ["Santa Cruz", /banco (de )?santa cruz/], ["Chubut", /banco (del )?chubut/], ["Corrientes", /banco (de )?corrientes/],
  ["Formosa", /banco (de )?formosa/], ["La Pampa", /banco (de )?la pampa|bancodelapampa/], ["Neuquén", /\bbpn\b|banco provincia (del )?neuquen/], ["Tierra del Fuego", /tierra del fuego/],
  ["La Rioja", /banco rioja/], ["Brubank", /brubank/], ["Openbank", /openbank/], ["Banco del Sol", /banco del sol/], ["BIND", /\bbind\b/], ["Coinag", /coinag/],
  ["Dino", /\bdino\b/], ["Voii", /\bvoii\b/], ["Reba", /\breba\b/], ["Meridian", /meridian/], ["CMF", /\bcmf\b/], ["Mariva", /mariva/], ["Industrial", /banco industrial/],
];
export const bancosDe = (p) => {
  const t = norm([p.titulo, p.descripcion, p.slug.replace(/-/g, " "), p.tags.join(" "), p.legales.slice(0, 800)].join(" "));
  return BANCOS.filter(([, re]) => re.test(t)).map(([n]) => n);
};
const DIAS = { L: "lun", M: "mar", X: "mié", J: "jue", V: "vie", S: "sáb", D: "dom" };
export const diasTexto = (d) => (d === "LMXJVSD" ? "todos" : [...(d || "")].map((c) => DIAS[c] ?? c).join(","));
// La fecha final que dicen los legales («AL 31/03/2027»): para medir si contradice al dato estructurado.
export function hastaLegales(t) {
  const fechas = [...String(t).matchAll(/\b(\d{1,2})\/(\d{1,2})\/(\d{4})\b/g)].map((m) => `${m[3]}-${m[2].padStart(2, "0")}-${m[1].padStart(2, "0")}`);
  return fechas.length ? fechas.sort().at(-1) : "";
}

/** Año del slug («…-nov26» → 26): 0 = 2026 en adelante, 1 = sin año, 2 = 2025, 9 = 2020-2024 (viejas, no se leen). */
export function prioridadSlug(s) {
  const m = s.match(/(ene|feb|mar|abr|may|jun|jul|ago|sep|set|oct|nov|dic)[a-z]*-?(\d{2})(?!\d)/);
  let y = m ? +m[2] : null;
  if (y == null) { const n = s.match(/(?:^|-)(\d{2})(\d{2})(?:-|$)/); if (n && +n[1] >= 20 && +n[1] <= 27) y = +n[1]; }
  if (y == null) return 1; // sin fecha en el slug: puede estar vigente
  if (y >= 26 && y <= 30) return 0; // 2026 en adelante
  if (y === 25) return 2; // 2025
  if (y >= 20 && y <= 24) return 9; // viejas: no se leen
  return 1; // número que no es año (ej. «30off»)
}

/**
 * Lo que se manda a la ingesta del Worker (POST /api/cron/promos-sugeridas): SÓLO datos públicos de la ficha de MODO, en
 * la forma de PromoFuente (src/lib/promos-sugeridas-calculo.ts del repo privado), SIN candidatos: el Worker busca él los
 * locales por nombre (este repo es público y nunca ve nuestra base).
 */
export function aPromoFuente(p) {
  return {
    fuente: "modo",
    slug: p.slug,
    comercio: p.comercio,
    titulo: p.titulo,
    beneficio: p.beneficio,
    tipo: p.tipo,
    bancos: bancosDe(p),
    credito: p.credito,
    debito: p.debito,
    dias: diasTexto(p.dias),
    desde: p.desde,
    hasta: p.hasta,
    hasta_legales: hastaLegales(p.legales) || null,
    tope: p.tope,
    cuotas: p.cuotas,
    legales: String(p.legales ?? "").slice(0, 4000),
  };
}

/** ¿MODO la sigue publicando como activa? (baja: estado distinto de «active» o fecha de fin ya pasada). */
export const sigueActiva = (p, hoy) => p.estado === "active" && !(p.hasta && p.hasta < hoy);
