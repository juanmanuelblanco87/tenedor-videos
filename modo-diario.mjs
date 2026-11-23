// Lectura diaria de MODO (23/11/2026, promos automáticas etapa 2; diseño: docs/promos-automaticas-roberto.md §1.1-1.3 del
// repo privado). Corre en GitHub Actions (.github/workflows/modo-diario.yml y modo-completa.yml): NUNCA desde la red del
// dueño. Lee el sitemap y las fichas /promos/{slug} de MODO (nunca /api/ ni map-handler), 1 pedido cada 2,1 s, respeta
// robots.txt antes de cada vuelta y corta ante 403 / 429 / captcha. Manda lo de gastronomía a NUESTRO Worker
// (POST /api/cron/promos-sugeridas, secreto IMPORTADOR_SECRET), de a 10 promos por pedido y esperando cada respuesta.
//
// Qué lee cada día (con un TOPE de pedidos por corrida; lo que no entra queda para mañana):
//   1. las de gastronomía que conocíamos y ya no están en el sitemap (para confirmar la baja);
//   2. las de gastronomía que vencen hoy o mañana (¿la renovaron?);
//   3. los slugs NUEVOS del sitemap (2026 primero, después sin año; los de 2020-2025 van a salteo sin leerlos);
//   4. 1/7 de las de gastronomía vigentes, en rotación (cada una se relee una vez por semana).
// Las vencidas por fecha se dan de baja SIN pedir nada. Los slugs ya vistos que no son de gastronomía quedan en una lista
// de salteo (estado-modo/estado.json, en el cache del Action: son slugs y fechas públicas de MODO, nada nuestro).
// Lo leído que el Worker no pudo recibir (apagado, error, horario) queda en una cola dentro del mismo estado.
//
// Antes de pedir UNA sola página a MODO pregunta al Worker (GET) si puede: interruptores de Ajustes («Lectura diaria de
// MODO» y «Chequeo de la cucarda») y si la fuente está frenada. Apagado = no lee nada.
// Logs y resumen del Action: SÓLO números (el repo es público).
//
// Uso:
//   node modo-diario.mjs diario   [--tope 250]
//   node modo-diario.mjs completa [--tope 4800] [--inicio AAAA-MM-DD]   (primera vuelta completa, de noche, en partes)
//   node modo-diario.mjs muestra  --slugs a,b,c   (prueba: lee sólo esos slugs, sin estado ni Worker, imprime lo leído)
// Variables: TENEDOR_BASE (https://tenedor.com.ar), IMPORTADOR_SECRET, ESTADO_MODO (estado-modo/estado.json).
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { BASE_MODO, Bloqueo, ProhibidoPorRobots, aPromoFuente, crearPedidor, esGastro, prioridadSlug, sigueActiva, slugsDelSitemap, parsearPromo } from "./modo-lector.mjs";

export const UA = "TenedorBot/1.0";
export const TOPE_DIARIO = 250;
export const TOPE_COMPLETA = 5000;
/** Promos por pedido al Worker (MAX_POR_TANDA de la ingesta) y bajas por pedido. */
export const POR_TANDA = 10;
export const BAJAS_POR_TANDA = 100;
/** Errores seguidos (no 403/429, que cortan al primero) antes de cortar. */
const ERRORES_SEGUIDOS = 10;
/** Tope de la cola de lo leído sin mandar (si el Worker no recibe por días, no crece sin fin). */
const MAX_COLA = 3000;
/** Si la base tarda más que esto en una tanda (msBase del Worker), se corta y sigue mañana (doc §1.1). */
const MS_BASE_MAX = Number(process.env.MS_BASE_MAX ?? 5000);

export const hoyAR = (ms = Date.now()) => new Date(ms - 3 * 3_600_000).toISOString().slice(0, 10);
export const sumarDias = (d, n) => new Date(Date.parse(`${d}T12:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
const diaNumero = (d) => Math.round(Date.parse(`${d}T12:00:00Z`) / 86_400_000);
/** FNV-1a: reparte las vigentes en 7 grupos fijos (una vuelta por semana). */
function fnv(t) {
  let h = 0x811c9dc5;
  for (const c of Buffer.from(t, "utf8")) {
    h ^= c;
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h;
}
export const rotaHoy = (slug, hoy) => fnv(slug) % 7 === diaNumero(hoy) % 7;
/** Horario en que el Worker NO recibe (uso alto del sitio: 12-15 y 20-24 h de Argentina, doc §1.1). */
export const horarioCerrado = (ms = Date.now()) => {
  const h = new Date(ms - 3 * 3_600_000).getUTCHours();
  return (h >= 12 && h < 15) || h >= 20;
};

// ---------- estado (cache del Action) ----------
// slugs[slug] = { g: 1|0 (gastronomía o no), h: hasta (sólo gastronomía), l: último día leído }
// cola: promos leídas sin mandar; bajas: { slug: motivo } sin mandar.
export const estadoVacio = () => ({ v: 1, slugs: {}, cola: [], bajas: {} });
export function leerEstado(archivo) {
  try {
    const e = JSON.parse(fs.readFileSync(archivo, "utf8"));
    if (e && e.v === 1 && e.slugs && typeof e.slugs === "object") return { ...estadoVacio(), ...e };
  } catch {}
  return estadoVacio();
}
export function guardarEstado(archivo, e) {
  fs.mkdirSync(path.dirname(archivo), { recursive: true });
  fs.writeFileSync(archivo, JSON.stringify(e));
}

/**
 * Qué se lee hoy (puro: lo prueban modo-diario.test.mjs). Devuelve `leer` (como mucho `tope - 2` slugs: robots.txt y el
 * sitemap también cuentan), `bajasSinPedir` (gastronomía vencida por fecha), `saltear` (nuevos de 2020-2024: a la lista de
 * salteo sin leerlos), `olvidar` (no gastronómicos que ya no están en el sitemap) y `quedan` (lo que no entró en el tope).
 * modo «completa»: además relee TODAS las de gastronomía leídas antes de `inicio` (las demás conocidas no se releen).
 */
export function elegir({ estado, slugs, hoy, tope, modo = "diario", inicio = hoy, incluirViejas = false }) {
  const enSitemap = new Set(slugs);
  const manana = sumarDias(hoy, 1);
  const desaparecidas = [];
  const vencen = [];
  const rotacion = [];
  const bajasSinPedir = [];
  const olvidar = [];
  for (const [slug, e] of Object.entries(estado.slugs)) {
    if (e.g === 1) {
      if (e.h && e.h < hoy) bajasSinPedir.push(slug);
      else if (!enSitemap.has(slug)) desaparecidas.push(slug);
      else if (modo === "completa") {
        if (!e.l || e.l < inicio) rotacion.push(slug);
      } else if (e.h && e.h <= manana) vencen.push(slug);
      else if (rotaHoy(slug, hoy)) rotacion.push(slug);
    } else if (!enSitemap.has(slug)) olvidar.push(slug);
  }
  const nuevos = slugs.filter((s) => !estado.slugs[s]);
  // Viejas = slug de 2025 o de 2020-2024 (23/11: el sitemap tiene 31.825 slugs; 2026 + sin año = 14.330, las «≈ 14.000» del
  // diseño). Van a la lista de salteo sin leerlas: si no, los ≈ 17.500 viejos taparían la rotación durante semanas.
  const vieja = (s) => prioridadSlug(s) === 9 || prioridadSlug(s) === 2;
  const saltear = incluirViejas ? [] : nuevos.filter(vieja);
  const orden = (s) => ({ 0: 0, 1: 1, 2: 2, 9: 3 })[prioridadSlug(s)];
  const aLeerNuevos = nuevos.filter((s) => incluirViejas || !vieja(s)).sort((a, b) => orden(a) - orden(b));
  const todo = [...desaparecidas, ...vencen, ...aLeerNuevos, ...rotacion];
  const cupo = Math.max(0, tope - 2);
  return { leer: todo.slice(0, cupo), quedan: Math.max(0, todo.length - cupo), bajasSinPedir, saltear, olvidar, cuentas: { desaparecidas: desaparecidas.length, vencen: vencen.length, nuevos: aLeerNuevos.length, rotacion: rotacion.length } };
}

/**
 * Lo que pasa con un slug después de pedirlo (puro). Devuelve el cambio de estado y, si corresponde, la promo a mandar o
 * la baja. 404/410: si era de gastronomía, baja; si no, se olvida. Ficha sin datos: error (no cambia nada: mañana se
 * reintenta). Gastronomía activa: se manda. Gastronomía terminada o vencida: baja si la conocíamos; a salteo.
 */
export function procesar({ slug, status, html, conocido, hoy }) {
  if (status === 404 || status === 410) return conocido?.g === 1 ? { baja: "la ficha ya no existe en MODO (404)", estado: null } : { estado: null };
  if (status !== 200) return { error: `HTTP ${status}` };
  const p = parsearPromo(html, slug);
  if (!p) return { error: "ficha sin datos" };
  if (!esGastro(p)) return { estado: { g: 0, l: hoy } };
  if (!sigueActiva(p, hoy)) return conocido?.g === 1 ? { baja: p.estado !== "active" ? "según MODO la promo ya no está activa" : "venció según MODO", estado: { g: 0, l: hoy } } : { estado: { g: 0, l: hoy } };
  return { promo: aPromoFuente(p), estado: { g: 1, h: p.hasta || "", l: hoy } };
}

// ---------- Worker ----------
function worker({ base, secreto, fetchImpl = fetch }) {
  const llamar = async (metodo, cuerpo) => {
    const r = await fetchImpl(`${base}/api/cron/promos-sugeridas`, {
      method: metodo,
      headers: { authorization: `Bearer ${secreto}`, "content-type": "application/json" },
      body: cuerpo ? JSON.stringify(cuerpo) : undefined,
      signal: AbortSignal.timeout(280_000),
    });
    const j = await r.json().catch(() => ({}));
    return { status: r.status, ...j };
  };
  return { estado: () => llamar("GET"), mandar: (cuerpo) => llamar("POST", { origen: "diario", ...cuerpo }) };
}

/** Manda la cola (promos y bajas) de a tandas, una por vez. Corta ante apagado, error, candado ocupado o base lenta. */
export async function vaciarCola(estado, w, suma, { ahora = Date.now } = {}) {
  while (estado.cola.length || Object.keys(estado.bajas).length) {
    if (horarioCerrado(ahora())) return "horario: el Worker no recibe a esta hora";
    const promos = estado.cola.slice(0, POR_TANDA);
    const bajas = Object.entries(estado.bajas).slice(0, BAJAS_POR_TANDA).map(([slug, motivo]) => ({ fuente: "modo", slug, motivo }));
    const r = await w.mandar({ promos, bajas });
    if (r.ok !== true) return r.apagado ? `apagado: ${String(r.apagado).slice(0, 120)}` : `Worker ${r.status}: ${String(r.error ?? "").slice(0, 120)}`;
    estado.cola = estado.cola.slice(promos.length);
    for (const b of bajas) delete estado.bajas[b.slug];
    suma.tandas++;
    for (const k of ["nuevas", "cambiadas", "sinCambios", "niveles", "bajas", "seguras", "dudosas", "sinLeer", "pedidos", "escritas"]) suma[k] += Number(r[k] ?? 0);
    if (Number(r.msBase ?? 0) > MS_BASE_MAX) return `base lenta (${r.msBase} ms en una tanda)`;
    await new Promise((ok) => setTimeout(ok, 1000));
  }
  return null;
}

/** Una corrida. `deps` lo reemplazan las pruebas (fetch de MODO y del Worker, estado, reloj). */
export async function correr({ modo = "diario", tope, inicio, minSitemap = 100, archivoEstado, base, secreto, fetchModo = fetch, fetchWorker = fetch, pausaMs, ahora = Date.now, log = console.log }) {
  const hoy = hoyAR(ahora());
  const r = { modo, hoy, leidas: 0, pedidos: 0, nuevas: 0, gastro: 0, bajas: 0, errores: 0, tope, corte: null, quedan: 0, cola: 0, worker: { tandas: 0, nuevas: 0, cambiadas: 0, sinCambios: 0, niveles: 0, bajas: 0, seguras: 0, dudosas: 0, sinLeer: 0, pedidos: 0, escritas: 0 } };
  const w = worker({ base, secreto, fetchImpl: fetchWorker });
  // 0 · ¿Puede leer? Si no, no se pide NADA a MODO.
  const est = await w.estado().catch((e) => ({ leer: false, motivo: `no se pudo preguntar al Worker (${String(e?.message ?? e).slice(0, 80)})` }));
  if (est.leer !== true) {
    r.corte = `no lee: ${String(est.motivo ?? est.error ?? "apagado").slice(0, 160)}`;
    return r;
  }
  const estado = leerEstado(archivoEstado);
  const pedidor = crearPedidor({ ua: UA, tope, ...(pausaMs != null ? { pausaMs } : {}), fetchImpl: fetchModo });
  // 1 · Lo que quedó sin mandar de ayer, primero.
  const corteCola = await vaciarCola(estado, w, r.worker, { ahora });
  if (corteCola && !corteCola.startsWith("horario")) {
    r.corte = corteCola;
    guardarEstado(archivoEstado, estado);
    r.cola = estado.cola.length;
    return r;
  }
  try {
    // 2 · robots.txt antes de cada vuelta: si prohíbe lo que leemos, se corta (y el Worker frena la fuente).
    const robots = await pedidor.pedir(`${BASE_MODO}/robots.txt`);
    // Sin robots.txt (404) vale todo; si el servidor falla, no se sigue (no se sabe qué permite).
    if (robots.status >= 500) throw new Error(`robots.txt respondió ${robots.status}: no sigo`);
    if (robots.status === 200) pedidor.robots(robots.texto);
    for (const ruta of ["/promos/sitemap.xml", "/promos/30off-parrillalaemilia-4-macroselecta-nov26"]) if (!pedidor.permitido(ruta)) throw new ProhibidoPorRobots(`robots.txt prohíbe ${ruta.startsWith("/promos/sitemap") ? "el sitemap" : "las fichas /promos/"}`);
    const sm = await pedidor.pedir(`${BASE_MODO}/promos/sitemap.xml`);
    const slugs = sm.status === 200 ? slugsDelSitemap(sm.texto) : [];
    if (slugs.length < minSitemap) throw new Error(`sitemap raro (${slugs.length} slugs, HTTP ${sm.status}): no sigo`);
    const plan = elegir({ estado, slugs, hoy, tope, modo, inicio: inicio ?? hoy });
    r.quedan = plan.quedan;
    log(`plan: ${JSON.stringify({ sitemap: slugs.length, ...plan.cuentas, leer: plan.leer.length, quedan: plan.quedan, vencidas: plan.bajasSinPedir.length, saltear: plan.saltear.length })}`);
    for (const s of plan.saltear) estado.slugs[s] = { g: 0, l: hoy };
    for (const s of plan.olvidar) delete estado.slugs[s];
    for (const s of plan.bajasSinPedir) {
      estado.bajas[s] = "venció según la fecha de MODO";
      estado.slugs[s] = { g: 0, l: hoy };
      r.bajas++;
    }
    // 3 · Lectura, de a una, con su ritmo. Se manda a medida que se junta una tanda.
    let seguidos = 0;
    for (const slug of plan.leer) {
      const conocido = estado.slugs[slug];
      let res;
      try {
        const x = await pedidor.pedir(`${BASE_MODO}/promos/${slug}`);
        res = procesar({ slug, status: x.status, html: x.texto, conocido, hoy });
      } catch (e) {
        if (e instanceof Bloqueo || e instanceof ProhibidoPorRobots) throw e;
        res = { error: String(e?.message ?? e).slice(0, 80) };
      }
      if (res.error) {
        r.errores++;
        if (++seguidos >= ERRORES_SEGUIDOS) throw new Bloqueo(`${ERRORES_SEGUIDOS} errores seguidos (${res.error})`);
        continue;
      }
      seguidos = 0;
      r.leidas++;
      if (!conocido) r.nuevas++;
      if (res.estado) estado.slugs[slug] = res.estado;
      else delete estado.slugs[slug];
      if (res.baja) {
        estado.bajas[slug] = res.baja;
        r.bajas++;
      }
      if (res.promo) {
        r.gastro++;
        estado.cola.push(res.promo);
        if (estado.cola.length >= POR_TANDA) {
          const c = await vaciarCola(estado, w, r.worker, { ahora });
          if (c && !c.startsWith("horario")) throw new Error(`corte del Worker: ${c}`);
        }
      }
    }
  } catch (e) {
    r.corte = String(e?.message ?? e).slice(0, 160);
  }
  try {
    // Lo leído (y las bajas) se manda aunque la lectura haya cortado por MODO; si el que cortó fue el Worker, queda en cola.
    if (!r.corte?.startsWith("corte del Worker")) {
      const c = await vaciarCola(estado, w, r.worker, { ahora });
      if (c && !c.startsWith("horario")) r.corte = [r.corte, `corte del Worker: ${c}`].filter(Boolean).join(" · ").slice(0, 160);
    }
  } catch (e) {
    r.corte = [r.corte, `corte del Worker: ${String(e?.message ?? e).slice(0, 80)}`].filter(Boolean).join(" · ").slice(0, 160);
  } finally {
    estado.cola = estado.cola.slice(-MAX_COLA);
    r.cola = estado.cola.length + Object.keys(estado.bajas).length;
    r.pedidos = pedidor.pedidos;
    guardarEstado(archivoEstado, estado);
  }
  // 4 · Cierre: números de la corrida (el Worker da de baja las vencidas por fecha y, si fue robots, frena la fuente).
  const cierre = await w.mandar({ cierre: { corrida: String(process.env.GITHUB_RUN_ID ?? "local"), modo, leidas: r.leidas, pedidos: r.pedidos, nuevas: r.nuevas, gastro: r.gastro, bajas: r.bajas, errores: r.errores, tope, corte: r.corte } }).catch((e) => ({ ok: false, error: String(e?.message ?? e) }));
  if (cierre.ok !== true) log(`cierre: ${cierre.status ?? ""} ${String(cierre.apagado ?? cierre.error ?? "").slice(0, 120)}`);
  else r.vencidasPorFecha = Number(cierre.dia?.lector?.vencidasPorFecha ?? 0);
  return r;
}

/** Resumen de la corrida en Markdown (sólo números) para la pestaña del Action. */
export function resumenMarkdown(r) {
  const w = r.worker;
  const filas = [
    ["Modo", r.modo],
    ["Páginas leídas de MODO", r.leidas],
    ["Pedidos a MODO (con robots y sitemap)", `${r.pedidos} de ${r.tope}`],
    ["Slugs nuevos", r.nuevas],
    ["De gastronomía (mandadas al Worker)", r.gastro],
    ["Nuevas / cambiadas / sin cambios (Worker)", `${w.nuevas} / ${w.cambiadas} / ${w.sinCambios}`],
    ["Otros niveles de una ya guardada", w.niveles],
    ["Bajas (lector + Worker)", `${r.bajas} + ${w.bajas}`],
    ["Sugerencias seguras / dudosas", `${w.seguras} / ${w.dudosas}`],
    ["Páginas que re-leyó el Worker", w.pedidos],
    ["Errores de lectura", r.errores],
    ["Quedan para mañana (tope)", r.quedan],
    ["En cola sin mandar", r.cola],
    ["Corte", r.corte ?? "no"],
  ];
  return ["### Lectura de MODO", "", "| | |", "|---|---|", ...filas.map(([a, b]) => `| ${a} | ${String(b).replace(/\|/g, "/")} |`), ""].join("\n");
}

// ---------- main ----------
async function main() {
  const modo = process.argv[2] ?? "diario";
  const args = Object.fromEntries(process.argv.slice(3).map((a, i, l) => (a.startsWith("--") ? [a.slice(2), l[i + 1]] : null)).filter(Boolean));
  if (modo === "muestra") {
    // Prueba chica (≤ 20 fichas), sin estado ni Worker: lee esos slugs con el mismo ritmo y robots, e imprime lo leído.
    // Sin --slugs: del sitemap, las primeras `--n` (máx. 15) de 2026 cuyo slug parece de gastronomía (robots + sitemap + 15 ≤ 20).
    const pedidor = crearPedidor({ ua: UA, tope: 20 });
    const robots = await pedidor.pedir(`${BASE_MODO}/robots.txt`);
    pedidor.robots(robots.texto);
    let slugs = String(args.slugs ?? "").split(",").filter(Boolean).slice(0, 18);
    if (!slugs.length) {
      const sm = await pedidor.pedir(`${BASE_MODO}/promos/sitemap.xml`);
      const todos = slugsDelSitemap(sm.texto);
      slugs = todos.filter((s) => prioridadSlug(s) === 0 && /parrill|resto|cafe|sushi|burger|pizz|bar-|bodegon|helad|grill|cervec|gastro/.test(s)).slice(0, Math.min(15, Number(args.n ?? 15)));
      console.log(`sitemap: ${todos.length} slugs; muestra: ${slugs.length}`);
    }
    const hoy = hoyAR();
    const salida = [];
    for (const slug of slugs) {
      const x = await pedidor.pedir(`${BASE_MODO}/promos/${slug}`);
      const res = procesar({ slug, status: x.status, html: x.texto, conocido: { g: 1 }, hoy });
      salida.push({ slug, status: x.status, ...(res.promo ? { promo: { ...res.promo, legales: `${res.promo.legales.slice(0, 120)}…` } } : {}), ...(res.baja ? { baja: res.baja } : {}), ...(res.error ? { error: res.error } : {}), gastro: res.estado?.g ?? null });
    }
    console.log(JSON.stringify({ pedidos: pedidor.pedidos, salida }, null, 1));
    return;
  }
  if (modo !== "diario" && modo !== "completa") throw new Error("uso: node modo-diario.mjs diario|completa|muestra …");
  const base = (process.env.TENEDOR_BASE || "https://tenedor.com.ar").replace(/\/$/, "");
  const secreto = process.env.IMPORTADOR_SECRET;
  if (!secreto) {
    console.log("Falta IMPORTADOR_SECRET: no se lee nada.");
    return;
  }
  const tope = Math.max(10, Math.min(Number(args.tope ?? (modo === "completa" ? TOPE_COMPLETA : TOPE_DIARIO)) || TOPE_DIARIO, 6000));
  const r = await correr({ modo, tope, inicio: args.inicio, archivoEstado: process.env.ESTADO_MODO || "estado-modo/estado.json", base, secreto });
  console.log(JSON.stringify(r));
  if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, resumenMarkdown(r));
}
if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) await main();
