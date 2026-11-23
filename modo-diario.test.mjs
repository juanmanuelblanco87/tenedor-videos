// Pruebas del lector diario de MODO (node --test modo-diario.test.mjs). Nunca salen a internet: MODO y el Worker son
// falsos. Ejercitan las funciones reales: elegir (qué se lee y el TOPE por corrida), procesar (bajas) y correr (de punta a
// punta: no lee si está apagado, respeta el tope, corta ante 429, guarda la cola si el Worker no recibe).
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { correr, elegir, estadoVacio, hoyAR, leerEstado, procesar, rotaHoy, sumarDias } from "./modo-diario.mjs";
import { parsearPromo } from "./modo-lector.mjs";

const HOY = hoyAR();
const ficha = (slug, o = {}) => {
  const datos = {
    promotion: {
      card: { type: o.tipo ?? "cashback", content: { row: [{ text: o.comercio ?? "Kojin Omakase" }, { text: o.beneficio ?? "30% de reintegro" }] } },
      promotion: { id: 1, title: o.titulo ?? "Kojin Omakase con Macro", name: "", description: o.descripcion ?? "Restaurante", where: o.comercio ?? "Kojin Omakase", status: o.estado ?? "active", calculated_status: "running", days_of_week: "LMXJVSD", start_date: sumarDias(HOY, -5), stop_date: o.hasta ?? sumarDias(HOY, 30) },
      sections: { tyc: { contents: [{ title: "Legales", description: "Promoción de Banco Macro pagando con MODO." }] } },
      meta: { search_tags: o.tags ?? ["gastronomia"] },
      trigger_params: { credit_list: ["visa"], debit_list: [] },
    },
  };
  return `<html><script>self.__next_f.push([1,${JSON.stringify(`5:${JSON.stringify(datos)}\n`)}])</script></html>`;
};
const sitemap = (slugs) => `<urlset>${slugs.map((s) => `<url><loc>https://www.modo.com.ar/promos/${s}</loc></url>`).join("")}</urlset>`;
const muchos = (n, pre = "promo") => Array.from({ length: n }, (_, i) => `${pre}-${i}-nov26`);

function modoFalso(paginas, { robots = "User-agent: *\nDisallow: /api/\n", slugs } = {}) {
  const pedidos = [];
  const fetchModo = async (url) => {
    pedidos.push(url);
    const ruta = new URL(url).pathname;
    let cuerpo;
    if (ruta === "/robots.txt") cuerpo = robots;
    else if (ruta === "/promos/sitemap.xml") cuerpo = sitemap(slugs ?? Object.keys(paginas));
    else cuerpo = paginas[ruta.replace("/promos/", "")];
    const status = typeof cuerpo === "number" ? cuerpo : cuerpo === undefined ? 404 : 200;
    return { status, text: async () => (typeof cuerpo === "string" ? cuerpo : "") };
  };
  return { fetchModo, pedidos };
}
function workerFalso({ leer = true, falla = false } = {}) {
  const llegaron = { promos: [], bajas: [], cierres: [], gets: 0 };
  const fetchWorker = async (_url, init) => {
    const json = async (x) => x;
    if (init.method === "GET") {
      llegaron.gets++;
      return { status: 200, json: () => json({ ok: true, leer, motivo: leer ? null : "«Lectura diaria de MODO» está apagada en Ajustes" }) };
    }
    const c = JSON.parse(init.body);
    if (c.cierre) {
      llegaron.cierres.push(c.cierre);
      return { status: 200, json: () => json({ ok: true, dia: { lector: { vencidasPorFecha: 0 } } }) };
    }
    if (falla) return { status: 500, json: () => json({ ok: false, error: "D1 caída" }) };
    assert.equal(c.origen, "diario");
    assert.ok(c.promos.length <= 10);
    for (const p of c.promos) assert.equal(p.candidatos, undefined, "el lector nunca manda candidatos");
    llegaron.promos.push(...c.promos);
    llegaron.bajas.push(...c.bajas);
    return { status: 200, json: () => json({ ok: true, nuevas: c.promos.length, seguras: 0, dudosas: 0, msBase: 10 }) };
  };
  return { fetchWorker, llegaron };
}
const tmp = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), "modo-")), "estado.json");
// Siempre en horario abierto (03:30 AR) para que el Worker reciba.
const madrugada = () => Date.parse(`${HOY}T06:30:00Z`);
const base = (o) => ({ base: "https://tenedor.test", secreto: "x", pausaMs: 0, minSitemap: 1, ahora: madrugada, log: () => {}, ...o });

describe("elegir: qué se lee hoy", () => {
  it("TOPE por corrida: nunca más de tope - 2 fichas (robots y sitemap cuentan); el resto queda para mañana", () => {
    const slugs = muchos(500);
    const r = elegir({ estado: estadoVacio(), slugs, hoy: HOY, tope: 250 });
    assert.equal(r.leer.length, 248);
    assert.equal(r.quedan, 252);
  });
  it("orden: desaparecidas, las que vencen mañana, nuevas (2026 antes que sin año), rotación; 2020-2025 a salteo sin leer", () => {
    const estado = estadoVacio();
    estado.slugs["vieja-gastro"] = { g: 1, h: sumarDias(HOY, 30), l: HOY };
    estado.slugs["vence-manana"] = { g: 1, h: sumarDias(HOY, 1), l: HOY };
    estado.slugs["vencida"] = { g: 1, h: sumarDias(HOY, -1), l: HOY };
    estado.slugs["no-gastro"] = { g: 0, l: HOY };
    estado.slugs["no-gastro-ida"] = { g: 0, l: HOY };
    const slugs = ["vence-manana", "vencida", "no-gastro", "promo-25off-mar25", "promo-sin-anio", "promo-ene26", "promo-oct23"];
    const r = elegir({ estado, slugs, hoy: HOY, tope: 100 });
    assert.deepEqual(r.leer, ["vieja-gastro", "vence-manana", "promo-ene26", "promo-sin-anio"]);
    assert.deepEqual(r.bajasSinPedir, ["vencida"]);
    // Roberto r1: vencida que NO se leyó el día anterior al fin (corrida cortada): se relee, no es baja sin pedir.
    const e2 = estadoVacio();
    e2.slugs["vencida-sin-leer"] = { g: 1, h: sumarDias(HOY, -1), l: sumarDias(HOY, -10) };
    const r2 = elegir({ estado: e2, slugs: ["vencida-sin-leer"], hoy: HOY, tope: 100 });
    assert.deepEqual(r2.bajasSinPedir, []);
    assert.deepEqual(r2.leer, ["vencida-sin-leer"]);
    assert.deepEqual(r.saltear, ["promo-25off-mar25", "promo-oct23"]);
    assert.deepEqual(r.olvidar, ["no-gastro-ida"]);
  });
  it("rotación: cada vigente se relee UNA vez cada 7 días", () => {
    const estado = estadoVacio();
    const slugs = muchos(70, "g");
    for (const s of slugs) estado.slugs[s] = { g: 1, h: sumarDias(HOY, 60), l: HOY };
    const veces = new Map(slugs.map((s) => [s, 0]));
    for (let d = 0; d < 7; d++) for (const s of elegir({ estado, slugs, hoy: sumarDias(HOY, d), tope: 1000 }).leer) veces.set(s, veces.get(s) + 1);
    assert.ok([...veces.values()].every((n) => n === 1));
    assert.equal(rotaHoy(slugs[0], HOY), rotaHoy(slugs[0], sumarDias(HOY, 7)));
  });
  it("completa: relee todas las de gastronomía leídas antes del inicio, no las no gastronómicas", () => {
    const estado = estadoVacio();
    estado.slugs.a = { g: 1, h: sumarDias(HOY, 30), l: sumarDias(HOY, -3) };
    estado.slugs.b = { g: 1, h: sumarDias(HOY, 30), l: HOY };
    estado.slugs.c = { g: 0, l: sumarDias(HOY, -3) };
    assert.deepEqual(elegir({ estado, slugs: ["a", "b", "c", "d"], hoy: HOY, tope: 100, modo: "completa", inicio: HOY }).leer, ["d", "a"]);
  });
});

describe("procesar: bajas y salteo", () => {
  it("404: baja si era de gastronomía; si no, se olvida", () => {
    assert.ok(procesar({ slug: "x", status: 404, html: "", conocido: { g: 1 }, hoy: HOY }).baja);
    assert.equal(procesar({ slug: "x", status: 404, html: "", conocido: { g: 0 }, hoy: HOY }).baja, undefined);
  });
  it("activa de gastronomía: se manda con los datos públicos, sin candidatos; terminada o vencida: baja", () => {
    const a = procesar({ slug: "k", status: 200, html: ficha("k"), conocido: null, hoy: HOY });
    assert.equal(a.promo.comercio, "Kojin Omakase");
    assert.deepEqual(a.promo.bancos, ["Macro"]);
    assert.equal(a.promo.dias, "todos");
    assert.equal(a.promo.candidatos, undefined);
    assert.equal(a.estado.g, 1);
    assert.ok(procesar({ slug: "k", status: 200, html: ficha("k", { estado: "inactive" }), conocido: { g: 1 }, hoy: HOY }).baja);
    assert.ok(procesar({ slug: "k", status: 200, html: ficha("k", { hasta: sumarDias(HOY, -1) }), conocido: { g: 1 }, hoy: HOY }).baja);
  });
  it("no gastronómica: a salteo; ficha sin datos: error (no cambia nada)", () => {
    assert.deepEqual(procesar({ slug: "n", status: 200, html: ficha("n", { comercio: "Farmacia Central", titulo: "Farmacia Central con Macro", descripcion: "farmacia", tags: [] }), conocido: null, hoy: HOY }).estado, { g: 0, l: HOY });
    assert.ok(procesar({ slug: "n", status: 200, html: "<html></html>", conocido: null, hoy: HOY }).error);
    // Roberto r1: una ficha sin estado (MODO cambió el formato) es error, no baja.
    const sinEstado = procesar({ slug: "k", status: 200, html: ficha("k", { estado: "" }), conocido: { g: 1 }, hoy: HOY });
    assert.ok(sinEstado.error);
    assert.equal(sinEstado.baja, undefined);
    assert.ok(parsearPromo(ficha("k"), "k"));
  });
});

describe("correr: de punta a punta (MODO y Worker falsos)", () => {
  it("apagado en Ajustes: no se pide NADA a MODO", async () => {
    const m = modoFalso({ k: ficha("k") });
    const w = workerFalso({ leer: false });
    const r = await correr(base({ tope: 250, archivoEstado: tmp(), fetchModo: m.fetchModo, fetchWorker: w.fetchWorker }));
    assert.equal(m.pedidos.length, 0);
    assert.match(r.corte, /apagada/);
  });
  it("respeta el tope, manda de a 10, guarda el estado y al día siguiente sólo lee lo nuevo", async () => {
    const paginas = Object.fromEntries(muchos(30).map((s) => [s, ficha(s)]));
    const archivo = tmp();
    const m = modoFalso(paginas);
    const w = workerFalso();
    const r = await correr(base({ modo: "completa", tope: 22, archivoEstado: archivo, fetchModo: m.fetchModo, fetchWorker: w.fetchWorker }));
    assert.ok(m.pedidos.length <= 22);
    assert.equal(r.leidas, 20);
    assert.equal(r.quedan, 10);
    assert.equal(w.llegaron.promos.length, 20);
    assert.equal(w.llegaron.cierres.length, 1);
    assert.equal(Object.keys(leerEstado(archivo).slugs).length, 20);
    // Día siguiente (mismo sitemap): las 10 que faltaban + la rotación (≈ 1/7 de las 20), nunca las 20 otra vez.
    const m2 = modoFalso(paginas);
    const r2 = await correr(base({ tope: 250, archivoEstado: archivo, fetchModo: m2.fetchModo, fetchWorker: workerFalso().fetchWorker, ahora: () => madrugada() + 86_400_000 }));
    assert.equal(r2.nuevas, 10);
    assert.ok(r2.leidas < 20);
  });
  it("429 de MODO: corta al primero, no insiste, y lo leído hasta ahí se manda igual", async () => {
    const slugs = muchos(5);
    const paginas = { [slugs[0]]: ficha(slugs[0]), [slugs[1]]: 429, [slugs[2]]: ficha(slugs[2]) };
    const m = modoFalso(paginas, { slugs: [...slugs, ...muchos(100, "relleno")] });
    const w = workerFalso();
    const r = await correr(base({ modo: "completa", tope: 250, archivoEstado: tmp(), fetchModo: m.fetchModo, fetchWorker: w.fetchWorker }));
    assert.match(r.corte, /429/);
    assert.equal(m.pedidos.length, 4);
    assert.equal(w.llegaron.promos.length, 1);
    assert.match(w.llegaron.cierres[0].corte, /429/);
  });
  it("robots.txt que prohíbe las fichas: corta sin leer ninguna y el cierre lo dice (el Worker frena la fuente)", async () => {
    const m = modoFalso({ k: ficha("k") }, { robots: "User-agent: *\nDisallow: /promos/\n" });
    const w = workerFalso();
    const r = await correr(base({ modo: "completa", tope: 250, archivoEstado: tmp(), fetchModo: m.fetchModo, fetchWorker: w.fetchWorker }));
    assert.match(r.corte, /^robots/);
    assert.equal(m.pedidos.length, 1);
    assert.match(w.llegaron.cierres[0].corte, /^robots/);
  });
  it("si el Worker no recibe, lo leído queda en la cola y sale primero en la próxima corrida (sin volver a pedirlo a MODO)", async () => {
    const paginas = Object.fromEntries(muchos(105).map((s) => [s, ficha(s)]));
    const archivo = tmp();
    const r = await correr(base({ modo: "completa", tope: 15, archivoEstado: archivo, fetchModo: modoFalso(paginas).fetchModo, fetchWorker: workerFalso({ falla: true }).fetchWorker }));
    assert.match(r.corte, /Worker/);
    const enCola = leerEstado(archivo).cola.length;
    assert.ok(enCola >= 10);
    const w = workerFalso();
    await correr(base({ tope: 2, archivoEstado: archivo, fetchModo: modoFalso(paginas).fetchModo, fetchWorker: w.fetchWorker }));
    assert.equal(w.llegaron.promos.length, enCola);
    assert.equal(leerEstado(archivo).cola.length, 0);
  });
  it("bajas: la de gastronomía que dio 404 y la vencida por fecha llegan al Worker como bajas", async () => {
    const archivo = tmp();
    const estado = estadoVacio();
    estado.slugs["se-fue"] = { g: 1, h: sumarDias(HOY, 30), l: HOY };
    estado.slugs["vencio"] = { g: 1, h: sumarDias(HOY, -2), l: HOY };
    fs.writeFileSync(archivo, JSON.stringify(estado));
    const w = workerFalso();
    await correr(base({ tope: 250, archivoEstado: archivo, fetchModo: modoFalso({}, { slugs: muchos(100, "otra") }).fetchModo, fetchWorker: w.fetchWorker }));
    assert.deepEqual(w.llegaron.bajas.map((b) => b.slug).sort(), ["se-fue", "vencio"]);
    assert.equal(leerEstado(archivo).slugs["se-fue"], undefined);
  });
});

describe("Roberto r1: estado vacío y sitemap parcial", () => {
  it("estado vacío en la diaria (cache perdido): no pide NADA a MODO ni gasta el tope; el cierre lo avisa", async () => {
    const m = modoFalso(Object.fromEntries(muchos(200).map((x) => [x, ficha(x)])));
    const w = workerFalso();
    const r = await correr(base({ tope: 250, archivoEstado: tmp(), fetchModo: m.fetchModo, fetchWorker: w.fetchWorker }));
    assert.equal(m.pedidos.length, 0);
    assert.match(r.aviso, /estado vacío.*completa/);
    assert.match(w.llegaron.cierres[0].aviso, /estado vacío/);
  });
  it("sitemap parcial (< 80 % de los conocidos): no olvida slugs, no lee desaparecidas para darlas de baja, y avisa", async () => {
    const archivo = tmp();
    const estado = estadoVacio();
    const conocidos = muchos(200, "c");
    for (const [i, s] of conocidos.entries()) estado.slugs[s] = i < 100 ? { g: 1, h: sumarDias(HOY, 60), l: HOY } : { g: 0, l: HOY };
    fs.writeFileSync(archivo, JSON.stringify(estado));
    // El sitemap trae sólo 150 de los 200 (75 %): faltan 50 de gastronomía.
    const m = modoFalso(Object.fromEntries(conocidos.slice(50).map((s) => [s, ficha(s)])), { slugs: conocidos.slice(50) });
    const w = workerFalso();
    const r = await correr(base({ tope: 250, archivoEstado: archivo, fetchModo: m.fetchModo, fetchWorker: w.fetchWorker }));
    assert.match(r.aviso, /sitemap parcial: trae 50 de 100 slugs de gastronomía/);
    assert.equal(w.llegaron.bajas.length, 0);
    const faltan = new Set(conocidos.slice(0, 50).map((s) => `/promos/${s}`));
    assert.ok(!m.pedidos.some((u) => faltan.has(new URL(u).pathname)), "no lee las que faltan");
    assert.equal(Object.keys(leerEstado(archivo).slugs).length, 200);
    assert.match(w.llegaron.cierres[0].aviso, /sitemap parcial/);
    // Con el 80 % o más es un día normal: las que faltan se leen (404 → baja).
    const normal = elegir({ estado, slugs: conocidos.slice(15), hoy: HOY, tope: 1000 });
    assert.equal(normal.parcial, null);
    assert.equal(normal.cuentas.desaparecidas, 15);
  });
  it("C2 (Roberto r2): el 80 % se mide sólo sobre los de gastronomía, y la completa con «aceptar sitemap» lo ignora una vez", () => {
    const estado = estadoVacio();
    const g = muchos(100, "g");
    const n = muchos(400, "n");
    for (const s of g) estado.slugs[s] = { g: 1, h: sumarDias(HOY, 60), l: HOY };
    for (const s of n) estado.slugs[s] = { g: 0, l: HOY };
    // Se fueron 300 de los 400 no gastronómicos (40 % del total presente) y ninguno de gastronomía: día normal.
    const r = elegir({ estado, slugs: [...g, ...n.slice(300)], hoy: HOY, tope: 1000 });
    assert.equal(r.parcial, null);
    assert.equal(r.olvidar.length, 300);
    // Faltan 30 de gastronomía (70 %): parcial…
    const corto = [...g.slice(30), ...n];
    assert.deepEqual(elegir({ estado, slugs: corto, hoy: HOY, tope: 1000 }).parcial, { presentes: 70, conocidos: 100 });
    // …salvo con «aceptar sitemap» (vuelta completa): se leen las 30 para darlas de baja.
    const aceptado = elegir({ estado, slugs: corto, hoy: HOY, tope: 1000, modo: "completa", inicio: sumarDias(HOY, 1), aceptarSitemap: true });
    assert.equal(aceptado.parcial, null);
    assert.equal(aceptado.cuentas.desaparecidas, 30);
  });
});
