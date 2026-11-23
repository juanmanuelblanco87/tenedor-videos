// Promos automáticas · etapa 2 · LECTOR de las páginas de Club La Nación y Clarín 365 (docs/promos-automaticas-roberto.md
// §1.2). PURO y SIN IMPORTS a propósito: el mismo archivo se copia tal cual al repo público `tenedor-videos`
// (promos-clubes-lector.ts) y lo corre el lector de GitHub Actions con `node --experimental-strip-types`. Si se cambia
// acá, se copia allá (y al revés): el test «la copia del Action es idéntica» lo controla cuando las dos carpetas están.
// Sólo TypeScript que se pueda borrar (sin enum, namespace ni parámetros de propiedad).
//
// Qué se lee (sólo datos PÚBLICOS de la ficha de cada comercio, nunca logos ni imágenes):
//  - Club La Nación: el JSON `window.__PRELOADED_STATE__` de la ficha `/beneficios/gastronomia/<sub>/<slug>` (nombre,
//    subcategoría, Instagram, beneficio %, días, planes, vigencia y CANTIDAD de sucursales). Nunca búsquedas `?q=`
//    (robots.txt las prohíbe) ni el mapa de sucursales (es una API interna).
//  - Clarín 365: el payload de Nuxt `window.__NUXT__=(function(a,b,…){…}(…))` de `/<categoria>/<sub>/<slug>`: días,
//    tarjeta (Classic / Plus), beneficio y CADA sucursal con dirección y coordenadas. El payload es JavaScript: se lee
//    con un intérprete MÍNIMO de literales (cadenas, números, arreglos, objetos, nombres y asignaciones `x[i]=…` /
//    `x.y=…`), sin eval ni Function: código ajeno nunca se ejecuta.

export type FuenteClub = "club_la_nacion" | "clarin_365";

export type SucursalClub = { nombre: string; direccion: string; barrio: string; provincia: string; lat: number | null; lng: number | null };

export type BeneficioClub = {
  /** Id del beneficio en la fuente (estable mientras no lo renueven). */
  id: string;
  /** Porcentaje de descuento (1-100) o null si no es un porcentaje («2x1», «$5.000»…: no se importa). */
  valor: number | null;
  /** Texto del beneficio como lo publica la fuente («20%», «15% de descuento…»), recortado. */
  texto: string;
  /** 0 = lunes … 6 = domingo; vacío = todos los días. null = no se entienden (no se importa). */
  dias: number[] | null;
  /** Planes o tarjetas del club que lo tienen («Classic», «Premium», «Black», «Plus»). */
  planes: string[];
  /** AAAA-MM-DD (hora de Buenos Aires) o null si la fuente no lo publica. */
  desde: string | null;
  hasta: string | null;
  /** Club La Nación: cuántas sucursales adhieren según el club (null si no lo dice). */
  sucursales: number | null;
  /** Presencial / online («Online» o tienda online: no es consumo en el lugar, no se importa). */
  online: boolean;
  legales: string;
  /**
   * Clarín 365 (Roberto r1, 23/11): índices en FichaClub.sucursales de las sucursales donde vale ESTE beneficio (cada
   * tarjeta trae las suyas: en SushiClub el 2x1 vale en 20 de 31). null = la fuente no lo dice por beneficio (La Nación).
   */
  enSucursales?: number[] | null;
};

export type FichaClub = {
  fuente: FuenteClub;
  /** Slug de la ficha en la fuente (clave estable del comercio). */
  slug: string;
  link: string;
  comercio: string;
  subcategoria: string;
  /** Cuenta de Instagram (minúsculas, sin @) si la fuente la publica. */
  instagram: string | null;
  beneficios: BeneficioClub[];
  /** Clarín 365: cada sucursal con dirección y coordenadas. Club La Nación: vacío (sólo da la cantidad). */
  sucursales: SucursalClub[];
};

export const HOST_CLUB: Record<FuenteClub, string> = { club_la_nacion: "club.lanacion.com.ar", clarin_365: "365.clarin.com" };

/** Tope de lo que se mira de una página (2 MB, como el chequeo de F27) y del intérprete. */
const MAX_HTML = 2_000_000;
const MAX_PASOS = 400_000;

// ---------- URLs: qué fichas son de gastronomía con consumo en el lugar ----------

/**
 * Club La Nación: `/beneficios/gastronomia/<sub>/<slug>`. Fuera: vinotecas, tiendas gourmet y delivery (sin consumo en el
 * lugar). Devuelve el slug o null.
 */
export function slugLaNacion(url: string): string | null {
  const m = /^https:\/\/club\.lanacion\.com\.ar\/beneficios\/gastronomia\/([a-z0-9-]+)\/([A-Za-z0-9-]+)$/.exec(url.trim());
  if (!m || ["vinotecas", "tiendas-gourmet", "delivery"].includes(m[1])) return null;
  return `${m[1]}/${m[2]}`;
}
/** Clarín 365: `/gastronomia/<sub>/<slug>` y `/heladerias/heladerias/<slug>`. Fuera: compras gastronómicas y vinotecas. */
export function slugClarin(url: string): string | null {
  const m = /^https:\/\/365\.clarin\.com\/(gastronomia|heladerias)\/([a-z0-9-]+)\/([A-Za-z0-9-]+)$/.exec(url.trim());
  if (!m || ["compras-gastronomicas", "vinotecas"].includes(m[2])) return null;
  return `${m[1]}/${m[2]}/${m[3]}`;
}
export const linkDeSlug = (fuente: FuenteClub, slug: string) =>
  fuente === "club_la_nacion" ? `https://club.lanacion.com.ar/beneficios/gastronomia/${slug}` : `https://365.clarin.com/${slug}`;

/** Las URL `<loc>` de un sitemap (sin interpretar nada más). */
export function urlsDeSitemap(xml: string): string[] {
  return [...xml.slice(0, MAX_HTML * 2).matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/g)].map((m) => m[1].replace(/&amp;/g, "&"));
}

// ---------- utilidades ----------

const DIAS_EN: Record<string, number> = { monday: 0, tuesday: 1, wednesday: 2, thursday: 3, friday: 4, saturday: 5, sunday: 6 };
const DIAS_365: Record<string, number> = { LU: 0, MA: 1, MI: 2, JU: 3, VI: 4, SA: 5, DO: 6 };
const texto = (v: unknown, max = 300) => (typeof v === "string" ? v.replace(/\s+/g, " ").trim().slice(0, max) : "");
const esObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const lista = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);

/** Días → 0..6 ordenados; los 7 = [] (todos); alguno que no se entiende = null. */
function diasDe(codigos: unknown[], mapa: Record<string, number>): number[] | null {
  const d = new Set<number>();
  for (const c of codigos) {
    const k = typeof c === "string" ? c.trim() : "";
    if (!Object.hasOwn(mapa, k)) return null;
    d.add(mapa[k]);
  }
  if (!d.size) return null;
  return d.size === 7 ? [] : [...d].sort((a, b) => a - b);
}

/** «20%», «15», «20 % de descuento» → 20. Otra cosa (2x1, $) → null. */
export function porcentaje(t: unknown): number | null {
  const s = typeof t === "number" ? String(t) : typeof t === "string" ? t : "";
  const m = /^\s*(\d{1,3})(?:[.,]0+)?\s*%?\s*$/.exec(s) ?? /^\s*(\d{1,3})\s*%/.exec(s);
  const n = m ? Number(m[1]) : NaN;
  return Number.isInteger(n) && n >= 1 && n <= 100 ? n : null;
}

/** ISO con hora («2027-01-01T02:59:59.999Z») → la fecha en Buenos Aires (UTC−3). */
function fechaBA(iso: unknown): string | null {
  if (typeof iso !== "string") return null;
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? new Date(ms - 3 * 3_600_000).toISOString().slice(0, 10) : null;
}
/** «dd/mm/aaaa» → «aaaa-mm-dd». */
function fechaDMA(t: unknown): string | null {
  const m = typeof t === "string" ? /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(t.trim()) : null;
  if (!m) return null;
  const f = `${m[3]}-${m[2]}-${m[1]}`;
  return Number.isFinite(Date.parse(`${f}T12:00:00Z`)) ? f : null;
}

/** Cuenta de Instagram de una URL o texto («https://www.instagram.com/almacendepizzas/» → «almacendepizzas»). */
export function cuentaInstagram(t: unknown): string | null {
  const s = typeof t === "string" ? t.trim() : "";
  const m = /instagram\.com\/([A-Za-z0-9._]{2,30})/i.exec(s) ?? /^@?([A-Za-z0-9._]{2,30})$/.exec(s);
  const c = m?.[1].toLowerCase().replace(/\.+$/, "") ?? null;
  return c && !["p", "reel", "explore", "accounts", "stories"].includes(c) ? c : null;
}

/** Distancia en metros entre dos puntos (haversine). */
export function distanciaMetros(a: { lat: number; lng: number }, b: { lat: number; lng: number }): number {
  const r = 6_371_000;
  const rad = (x: number) => (x * Math.PI) / 180;
  const dLat = rad(b.lat - a.lat);
  const dLng = rad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * r * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** Coordenada válida de Argentina (descarta 0,0 y valores cambiados de lugar). */
const coord = (lat: unknown, lng: unknown): { lat: number; lng: number } | null => {
  const a = typeof lat === "string" ? Number(lat) : lat;
  const o = typeof lng === "string" ? Number(lng) : lng;
  if (typeof a !== "number" || typeof o !== "number" || !Number.isFinite(a) || !Number.isFinite(o)) return null;
  return a < -21 && a > -56 && o < -53 && o > -74 ? { lat: a, lng: o } : null;
};

// ---------- JSON balanceado dentro de un <script> ----------

/** Desde el primer «{» después de `marca`, el objeto JSON balanceado (respetando cadenas). */
function jsonDespuesDe(html: string, marca: string): unknown {
  const i = html.indexOf(marca);
  if (i < 0) return null;
  const desde = html.indexOf("{", i + marca.length);
  if (desde < 0) return null;
  let prof = 0;
  let enStr = false;
  let esc = false;
  for (let j = desde; j < html.length && j - desde < MAX_HTML; j++) {
    const c = html[j];
    if (enStr) {
      if (esc) esc = false;
      else if (c === "\\") esc = true;
      else if (c === '"') enStr = false;
      continue;
    }
    if (c === '"') enStr = true;
    else if (c === "{") prof++;
    else if (c === "}" && --prof === 0) {
      try {
        return JSON.parse(html.slice(desde, j + 1));
      } catch {
        return null;
      }
    }
  }
  return null;
}

// ---------- Club La Nación ----------

/** Ficha de Club La Nación → FichaClub, o null si la página no trae los datos de un comercio de gastronomía. */
export function leerLaNacion(html: string, slug: string): FichaClub | null {
  const estado = jsonDespuesDe(html.slice(0, MAX_HTML), "window.__PRELOADED_STATE__");
  const cuenta = esObj(estado) && esObj(estado.accountReducer) ? estado.accountReducer : null;
  if (!cuenta) return null;
  const comercio = texto(cuenta.name, 120);
  const categoria = esObj(cuenta.category) ? texto(cuenta.category.id, 40) : "";
  if (!comercio || categoria !== "gastronomia") return null;
  const redes = lista(cuenta.socialNetworks).filter(esObj);
  const ig = redes.find((r) => texto(r.type, 20).toLowerCase() === "instagram");
  const beneficios: BeneficioClub[] = [];
  const crudos = esObj(cuenta.benefits) ? lista(cuenta.benefits.list) : [];
  for (const b of crudos.filter(esObj).slice(0, 20)) {
    const val = esObj(b.validity) ? b.validity : {};
    const tipoTx = texto(b.transactionType, 30).toLowerCase();
    beneficios.push({
      id: texto(b.id, 60),
      valor: porcentaje(b.type_benefit),
      texto: texto(b.type_benefit, 40),
      dias: diasDe(lista(b.weekdays), DIAS_EN),
      planes: lista(b.program_name).map((p) => texto(p, 20)).filter(Boolean).sort(),
      desde: fechaBA(val.date_from_iso),
      hasta: fechaBA(val.date_to_iso),
      sucursales: Number.isInteger(b.branchesQty) && Number(b.branchesQty) >= 0 ? Number(b.branchesQty) : null,
      online: tipoTx !== "" && tipoTx !== "presencial",
      legales: texto(b.legal, 1500),
    });
  }
  return {
    fuente: "club_la_nacion",
    slug,
    link: linkDeSlug("club_la_nacion", slug),
    comercio,
    subcategoria: esObj(cuenta.subcategory) ? texto(cuenta.subcategory.name, 40) : "",
    instagram: ig ? cuentaInstagram(ig.url) : null,
    beneficios: beneficios.filter((b) => b.id),
    sucursales: [],
  };
}

// ---------- Clarín 365: intérprete mínimo del payload de Nuxt ----------

class ErrorPayload extends Error {}

/** Lee `(function(p1,p2,…){cuerpo}(a1,a2,…))` sin ejecutar nada: sólo literales, nombres y asignaciones. */
export function leerPayloadNuxt(fuente: string): unknown {
  let i = 0;
  let pasos = 0;
  const s = fuente;
  const paso = () => {
    if (++pasos > MAX_PASOS) throw new ErrorPayload("payload demasiado grande");
  };
  const blancos = () => {
    while (i < s.length && /\s/.test(s[i])) i++;
  };
  const ver = (t: string) => {
    blancos();
    return s.startsWith(t, i);
  };
  const tomar = (t: string) => {
    if (!ver(t)) throw new ErrorPayload(`se esperaba «${t}» en ${i}`);
    i += t.length;
  };
  const nombre = (): string => {
    blancos();
    const m = /^[A-Za-z_$][A-Za-z0-9_$]*/.exec(s.slice(i, i + 64));
    if (!m) throw new ErrorPayload(`se esperaba un nombre en ${i}`);
    i += m[0].length;
    return m[0];
  };
  const cadena = (): string => {
    const q = s[i++];
    let out = "";
    while (i < s.length) {
      paso();
      const c = s[i++];
      if (c === q) return out;
      if (c !== "\\") {
        out += c;
        continue;
      }
      const e = s[i++];
      if (e === "u") {
        if (s[i] === "{") {
          const fin = s.indexOf("}", i);
          out += String.fromCodePoint(parseInt(s.slice(i + 1, fin), 16));
          i = fin + 1;
        } else {
          out += String.fromCharCode(parseInt(s.slice(i, i + 4), 16));
          i += 4;
        }
      } else if (e === "x") {
        out += String.fromCharCode(parseInt(s.slice(i, i + 2), 16));
        i += 2;
      } else out += ({ n: "\n", t: "\t", r: "\r", b: "\b", f: "\f", v: "\v", "0": "\0" } as Record<string, string>)[e] ?? e;
    }
    throw new ErrorPayload("cadena sin cerrar");
  };
  const env = new Map<string, unknown>();
  const valor = (): unknown => {
    paso();
    blancos();
    const c = s[i];
    if (c === '"' || c === "'") return cadena();
    if (c === "[") {
      i++;
      const a: unknown[] = [];
      while (!ver("]")) {
        a.push(valor());
        if (ver(",")) i++;
        else break;
      }
      tomar("]");
      return a;
    }
    if (c === "{") {
      i++;
      const o: Record<string, unknown> = Object.create(null);
      while (!ver("}")) {
        blancos();
        const k = s[i] === '"' || s[i] === "'" ? cadena() : /[0-9]/.test(s[i]) ? String(numero()) : nombre();
        tomar(":");
        o[k] = valor();
        if (ver(",")) i++;
        else break;
      }
      tomar("}");
      return o;
    }
    if (c === "-" || c === "." || /[0-9]/.test(c)) return numero();
    const n = nombre();
    if (n === "true") return true;
    if (n === "false") return false;
    if (n === "null") return null;
    if (n === "void") {
      valor();
      return undefined;
    }
    if (n === "Array" && ver("(")) {
      tomar("(");
      const largo = valor();
      tomar(")");
      return new Array(Math.min(10_000, Math.max(0, Number(largo) || 0)));
    }
    return env.get(n);
  };
  const numero = (): number => {
    blancos();
    const m = /^-?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?/.exec(s.slice(i, i + 40));
    if (!m) throw new ErrorPayload(`número inválido en ${i}`);
    i += m[0].length;
    return Number(m[0]);
  };

  // (function(params){
  tomar("(");
  tomar("function");
  tomar("(");
  const params: string[] = [];
  while (!ver(")")) {
    params.push(nombre());
    if (ver(",")) i++;
  }
  tomar(")");
  tomar("{");
  const inicioCuerpo = i;
  // Saltar el cuerpo (balanceando llaves y cadenas) para leer primero los argumentos.
  let prof = 1;
  while (i < s.length && prof > 0) {
    paso();
    const c = s[i];
    if (c === '"' || c === "'") {
      cadena();
      continue;
    }
    if (c === "{") prof++;
    else if (c === "}") prof--;
    i++;
  }
  const finCuerpo = i - 1;
  tomar("(");
  const args: unknown[] = [];
  while (!ver(")")) {
    args.push(valor());
    if (ver(",")) i++;
  }
  params.forEach((p, k) => env.set(p, args[k]));
  // Cuerpo: `x[i]=v;`, `x["k"]=v;`, `x.y=v;` y al final `return v`.
  i = inicioCuerpo;
  while (i < finCuerpo) {
    blancos();
    if (s.startsWith("return", i) && !/[A-Za-z0-9_$]/.test(s[i + 6] ?? "")) {
      i += 6;
      const v = valor();
      blancos();
      if (s[i] === ";") i++;
      blancos();
      // Después del return no puede quedar nada (p. ej. una llamada «x(1)»): no es un payload de datos.
      if (i !== finCuerpo) throw new ErrorPayload(`sobra código después del return en ${i}`);
      return v;
    }
    const base = env.get(nombre());
    let destino: unknown = base;
    let clave: string | null = null;
    for (;;) {
      if (ver("[")) {
        tomar("[");
        const k = valor();
        tomar("]");
        if (clave !== null) destino = (destino as Record<string, unknown>)?.[clave];
        clave = String(k);
      } else if (ver(".")) {
        tomar(".");
        if (clave !== null) destino = (destino as Record<string, unknown>)?.[clave];
        clave = nombre();
      } else break;
    }
    tomar("=");
    const v = valor();
    if (clave === null || !destino || typeof destino !== "object") throw new ErrorPayload(`asignación que no se entiende en ${i}`);
    if (clave === "__proto__" || clave === "constructor" || clave === "prototype") throw new ErrorPayload("clave prohibida");
    (destino as Record<string, unknown>)[clave] = v;
    blancos();
    if (s[i] === ";" || s[i] === ",") i++;
    else if (i < finCuerpo) throw new ErrorPayload(`se esperaba «;» en ${i}`);
  }
  throw new ErrorPayload("el payload no tiene return");
}

/** El texto `(function…(…))` de `window.__NUXT__=` dentro del HTML, o null. */
function payloadNuxtDe(html: string): string | null {
  const marca = "window.__NUXT__=";
  const i = html.indexOf(marca);
  if (i < 0) return null;
  const fin = html.indexOf("</script>", i);
  if (fin < 0) return null;
  return html.slice(i + marca.length, fin).replace(/;\s*$/, "");
}

const PLAN_365: Record<string, string> = { "365": "Classic", "365-plus": "Plus", "365-black": "Black" };

/** Ficha de Clarín 365 → FichaClub, o null si la página no trae los datos de un comercio. */
export function leerClarin(html: string, slug: string): FichaClub | null {
  const p = payloadNuxtDe(html.slice(0, MAX_HTML));
  if (!p) return null;
  let raiz: unknown;
  try {
    raiz = leerPayloadNuxt(p);
  } catch {
    return null;
  }
  const d = esObj(raiz) ? lista(raiz.data)[0] : null;
  if (!esObj(d)) return null;
  const comercio = texto(d.companyName, 120);
  const det = esObj(d.companyDetails) ? d.companyDetails : {};
  if (!comercio) return null;
  const sucursalDe = (x: Record<string, unknown>): SucursalClub => {
    const c = coord(x.lat, x.lon);
    return { nombre: texto(x.name, 120), direccion: texto(x.address, 160), barrio: texto(x.location, 80), provincia: texto(x.province, 60), lat: c?.lat ?? null, lng: c?.lng ?? null };
  };
  // Todas las sucursales del comercio (marcadores por provincia), sin repetir.
  const todas: SucursalClub[] = [];
  const indice = new Map<string, number>();
  const sumar = (x: SucursalClub): number => {
    const k = `${x.direccion}|${x.lat}|${x.lng}`;
    if (!indice.has(k) && todas.length < 500) {
      indice.set(k, todas.length);
      todas.push(x);
    }
    return indice.get(k) ?? -1;
  };
  const marcadores = esObj(d.markers) ? d.markers : esObj(det.branchOffices) ? det.branchOffices : {};
  for (const prov of Object.values(marcadores)) for (const x of lista(esObj(prov) ? prov.provinceBranchOffices : null).filter(esObj)) sumar(sucursalDe(x));
  const beneficios: BeneficioClub[] = [];
  for (const card of lista(d.benefitCards).filter(esObj).slice(0, 20)) {
    // Las sucursales de ESTA tarjeta (sin lista: no se sabe dónde vale → ninguna sucursal la confirma).
    const propias = [...new Set(lista(card.sucursales).filter(esObj).map((x) => sumar(sucursalDe(x))).filter((n) => n >= 0))];
    const b = lista(card.benefit).filter(esObj)[0] ?? {};
    const tipo = texto(b.type, 20);
    // La vigencia es la de la tarjeta del beneficio. OJO (muestra real 23/11): `benefit[].validUntilDate` trae SIEMPRE la
    // fecha del día en que se arma la página (en todas las fichas), no el fin de la promo: no se usa.
    const hastas = [fechaDMA(card.validUntilDate)].filter((f): f is string => Boolean(f));
    beneficios.push({
      id: String(card.id ?? "").slice(0, 60),
      valor: tipo === "percentage" ? porcentaje(b.value) : null,
      texto: tipo === "percentage" ? `${texto(b.value, 10)}%` : texto(b.value, 40),
      dias: diasDe(lista(card.applyDays), DIAS_365),
      planes: lista(card.cardApply).map((c) => PLAN_365[texto(c, 20)] ?? texto(c, 20)).filter(Boolean).sort(),
      desde: null,
      hasta: hastas[0] ?? null,
      sucursales: null,
      online: card.isOnlineStore === true,
      legales: texto(card.termsAndConditions, 1500),
      enSucursales: propias,
    });
  }
  return {
    fuente: "clarin_365",
    slug,
    link: linkDeSlug("clarin_365", slug),
    comercio,
    subcategoria: texto(det.subcategory, 40),
    instagram: null,
    beneficios: beneficios.filter((b) => b.id),
    sucursales: todas,
  };
}

/** La ficha de una fuente, según de qué club es. */
export const leerFichaClub = (fuente: FuenteClub, html: string, slug: string) => (fuente === "club_la_nacion" ? leerLaNacion(html, slug) : leerClarin(html, slug));
