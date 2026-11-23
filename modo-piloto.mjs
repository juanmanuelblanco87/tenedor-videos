// Piloto MODO (16/11/2026, PRUEBA INTERNA, no publica nada): lee las promos públicas de modo.com.ar/promos, se queda con
// las de gastronomía y mide cuántas se emparejan con nuestros locales. Los RESULTADOS NUNCA se commitean: salen como
// artifact CIFRADO (el repo es público y sus artifacts los puede bajar cualquiera); se abren con el modo «descifrar».
//
// Reglas: respeta robots.txt (se lee primero y se chequea cada ruta), user-agent honesto, como mucho 1 pedido cada 2 s,
// ante 403 / 429 / captcha corta la fuente (deja bloqueo.json y las partes siguientes no piden nada). No usa la API de
// MODO (/api/ está prohibida) ni el mapa de sucursales (map-handler, es API interna de su web).
//
// Modos:
//   node modo-piloto.mjs leer --parte 1 --partes 4 --previos prev --salida salida
//       La parte 1 baja robots + sitemap y arma lista.json (los slugs a leer); todas leen su tramo de la lista.
//   node modo-piloto.mjs emparejar --previos prev --salida salida
//       Junta las partes, lee nuestros locales UNA vez (sólo lectura, de a 5.000 por id) y empareja.
// Variables (sólo emparejar): CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID, D1_APP_ID.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import zlib from "node:zlib";
import { Bloqueo, PAUSA_MS, bancosDe, crearPedidor, diasTexto, esGastro, hastaLegales, norm, parsearPromo, prioridadSlug } from "./modo-lector.mjs";

const UA = "TenedorBot/0.1 (prueba interna)";
const BASE = "https://www.modo.com.ar";
const HOY = new Date().toISOString().slice(0, 10);
const args = Object.fromEntries(process.argv.slice(3).map((a, i, l) => (a.startsWith("--") ? [a.slice(2), l[i + 1]] : null)).filter(Boolean));
const modo = process.argv[2];
const SALIDA = args.salida ?? "salida";
const PREVIOS = args.previos ?? "prev";
fs.mkdirSync(SALIDA, { recursive: true });
const espera = (ms) => new Promise((r) => setTimeout(r, ms));
const leerJson = (f, d = null) => (fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, "utf8")) : d);
const escribir = (f, x) => fs.writeFileSync(path.join(SALIDA, f), typeof x === "string" ? x : JSON.stringify(x, null, 1));
// Busca un archivo en las carpetas de artifacts previos (download-artifact deja una subcarpeta por artifact).
function buscarPrevios(nombre) {
  const out = [];
  const recorrer = (d) => {
    if (!fs.existsSync(d)) return;
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) recorrer(p);
      else if (e.name === nombre || (nombre instanceof RegExp && nombre.test(e.name))) out.push(p);
    }
  };
  recorrer(PREVIOS);
  return out;
}

// ---------- cifrado: el repo es PÚBLICO y sus artifacts y logs los puede bajar cualquiera con cuenta de GitHub ----------
// Entre partes: AES-256-GCM con clave derivada de un secreto del repo (sólo los jobs la conocen).
// Resultado final: AES-256-GCM con clave al azar, envuelta con la clave PÚBLICA de abajo (RSA-OAEP). La privada está sólo
// en la PC del dueño (Analisis\modo-piloto), nunca en el repo. Los logs sólo muestran números.
const CLAVE_PUBLICA = `-----BEGIN PUBLIC KEY-----
MIIBojANBgkqhkiG9w0BAQEFAAOCAY8AMIIBigKCAYEAkPCwfucgmLUSEb/F1S8o
TjN64SgsiMdKoQpOoAP2VcBTrCflqwBSt+RB0hYLJVQ33B/MuqubbiXs5D2G7mZl
UZvqNvWTm/+Riltdhuqm/hDonJHOHCASTUvuEsl5ZQpISUPXAWVm4tCGjHEf08Ng
xlUm0iwQH5G4caWsUA+JXR6pgJSuXrAVoFfdnJKOdGrAs77WsY7IF+oatIQ6q3LY
LvJKU/SChgrpXPBCl41LANaqm1H5hZIazO2a1Y/+w45DSRWge15zRKk5tKsEt/Hw
e5HPWOYFg643wupATsqbdDPEpegFxHseva18CggRHlghKUyJem9rWKAJ6hl5+kxZ
UajU4MF3gOKl9gO0RyJe34DT36lA/RcNV7pDLb+1SMhZ79eqwNthbuCqgLMghl4F
8A2nbjFGdKf8X4xuILqRs0CQkcSWQ7Ay3ezYrswsFdloUnb+McuhnPOYswvE26vv
8j2QScuM/3FaAYAty/0VXaBbeD0+dmbMu6Qr+QUnmfNbAgMBAAE=
-----END PUBLIC KEY-----`;
const CIFRAR = !process.env.SIN_CIFRAR;
const claveInterna = () => {
  if (!process.env.CLOUDFLARE_API_TOKEN) throw new Error("falta CLOUDFLARE_API_TOKEN para cifrar lo intermedio");
  return crypto.createHmac("sha256", process.env.CLOUDFLARE_API_TOKEN).update("modo-piloto-intermedio").digest();
};
function aes(clave, datos) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv("aes-256-gcm", clave, iv);
  const enc = Buffer.concat([c.update(datos), c.final()]);
  return { iv: iv.toString("base64"), tag: c.getAuthTag().toString("base64"), datos: enc.toString("base64") };
}
function desaes(clave, o) {
  const d = crypto.createDecipheriv("aes-256-gcm", clave, Buffer.from(o.iv, "base64"));
  d.setAuthTag(Buffer.from(o.tag, "base64"));
  return Buffer.concat([d.update(Buffer.from(o.datos, "base64")), d.final()]);
}
// Empaqueta todos los archivos de SALIDA en uno cifrado y borra los sueltos.
function sellar(nombre, final) {
  if (!CIFRAR) return;
  const archivos = fs.readdirSync(SALIDA).filter((f) => !f.endsWith(".enc"));
  const paquete = zlib.gzipSync(JSON.stringify(Object.fromEntries(archivos.map((f) => [f, fs.readFileSync(path.join(SALIDA, f), "utf8")]))));
  let sobre;
  if (final) {
    const k = crypto.randomBytes(32);
    sobre = { v: 1, tipo: "final", clave: crypto.publicEncrypt({ key: CLAVE_PUBLICA, oaepHash: "sha256" }, k).toString("base64"), ...aes(k, paquete) };
  } else sobre = { v: 1, tipo: "interno", ...aes(claveInterna(), paquete) };
  fs.writeFileSync(path.join(SALIDA, nombre), JSON.stringify(sobre));
  for (const f of archivos) fs.unlinkSync(path.join(SALIDA, f));
}
// Abre los paquetes internos de partes previas en una carpeta local del runner (no se sube).
function abrirPrevios() {
  for (const f of buscarPrevios(/\.enc$/)) {
    const sobre = leerJson(f);
    if (sobre.tipo !== "interno") continue;
    const dir = path.join(path.dirname(f), "_abierto-" + path.basename(f, ".enc"));
    fs.mkdirSync(dir, { recursive: true });
    for (const [n, t] of Object.entries(JSON.parse(zlib.gunzipSync(desaes(claveInterna(), sobre)).toString("utf8")))) fs.writeFileSync(path.join(dir, n), t);
  }
}
function descifrar() {
  const sobre = leerJson(args.entrada);
  const k = crypto.privateDecrypt({ key: fs.readFileSync(args.clave, "utf8"), oaepHash: "sha256" }, Buffer.from(sobre.clave, "base64"));
  for (const [n, t] of Object.entries(JSON.parse(zlib.gunzipSync(desaes(k, sobre)).toString("utf8")))) fs.writeFileSync(path.join(SALIDA, n), t);
  console.log("descifrado en", SALIDA);
}

// ---------- modo LEER (robots, ritmo, lectura de la ficha y filtros: modo-lector.mjs, compartido con modo-diario.mjs) ----------
const lector = crearPedidor({ ua: UA, pausaMs: PAUSA_MS });
async function leer() {
  const parte = Number(args.parte ?? 1), partes = Number(args.partes ?? 1);
  if (CIFRAR) abrirPrevios();
  if (buscarPrevios("bloqueo.json").length) {
    console.log("Una parte anterior encontró bloqueo: esta parte no pide nada.");
    escribir(`parte-${parte}.json`, { parte, salteada: "bloqueo previo", promos: [] });
    sellar(`parte-${parte}.enc`, false);
    return;
  }
  const robots = await lector.pedir(`${BASE}/robots.txt`);
  lector.robots(robots.texto);
  for (const r of ["/promos", "/promos/sitemap.xml", "/promos/30off-parrillalaemilia-4-macroselecta-nov26"]) if (!lector.permitido(r)) throw new Error(`robots.txt prohíbe ${r}: no se sigue`);
  if (lector.permitido("/api/promos")) console.log("ojo: robots.txt ya no prohíbe /api/ (igual no se usa)");
  let lista = leerJson(buscarPrevios("lista.json")[0]);
  if (!lista) {
    const sm = await lector.pedir(`${BASE}/promos/sitemap.xml`);
    const slugs = [...new Set([...sm.texto.matchAll(/<loc>https:\/\/www\.modo\.com\.ar\/promos\/([^<\/?#]+)<\/loc>/g)].map((m) => m[1]))];
    const porPrio = { 0: [], 1: [], 2: [], 9: [] };
    for (const s of slugs) porPrio[prioridadSlug(s)].push(s);
    // muestra fija (determinística) de 300 slugs de 2025
    const muestra25 = porPrio[2].filter((s, i) => i % Math.max(1, Math.floor(porPrio[2].length / 300)) === 0).slice(0, 300);
    lista = { fecha: new Date().toISOString(), total_sitemap: slugs.length, por_prioridad: Object.fromEntries(Object.entries(porPrio).map(([k, v]) => [k, v.length])), muestra_2025: muestra25.length, slugs: [...porPrio[0], ...porPrio[1], ...muestra25] };
    lista.prioridad_de = Object.fromEntries(lista.slugs.map((s) => [s, prioridadSlug(s)]));
  }
  escribir("lista.json", lista);
  const tramo = Math.ceil(lista.slugs.length / partes);
  const mios = lista.slugs.slice((parte - 1) * tramo, parte * tramo);
  console.log(`Parte ${parte}/${partes}: ${mios.length} páginas de ${lista.slugs.length} (sitemap: ${lista.total_sitemap})`);
  const promos = [];
  const errores = [];
  let seguidos = 0, bloqueo = null;
  const t0 = Date.now();
  for (const [i, slug] of mios.entries()) {
    try {
      const r = await lector.pedir(`${BASE}/promos/${slug}`);
      if (r.status !== 200) { errores.push({ slug, status: r.status }); if (++seguidos >= 25) { bloqueo = `25 errores seguidos (último HTTP ${r.status})`; break; } continue; }
      const p = parsearPromo(r.texto, slug);
      if (!p) { errores.push({ slug, status: "sin datos" }); continue; }
      seguidos = 0;
      p.prioridad_slug = prioridadSlug(slug);
      p.gastro = esGastro(p);
      // Sólo guardamos completo lo gastronómico; del resto, lo mínimo para contar vigencia.
      promos.push(p.gastro ? p : { slug, estado: p.estado, estado_calculado: p.estado_calculado, desde: p.desde, hasta: p.hasta, prioridad_slug: p.prioridad_slug, gastro: "" });
    } catch (e) {
      if (e instanceof Bloqueo) { bloqueo = e.message; break; }
      errores.push({ slug, status: String(e.message).slice(0, 120) });
      if (++seguidos >= 25) { bloqueo = `25 errores seguidos (${e.message})`; break; }
    }
    if (i % 200 === 0) console.log(`${i}/${mios.length} · ${promos.filter((p) => p.gastro).length} gastro · ${((Date.now() - t0) / 60000).toFixed(1)} min`);
  }
  if (bloqueo) { console.log("CORTE:", bloqueo); escribir("bloqueo.json", { parte, motivo: bloqueo, fecha: new Date().toISOString() }); }
  escribir(`parte-${parte}.json`, { parte, pedidos: lector.pedidos, leidas: promos.length, errores, bloqueo, minutos: (Date.now() - t0) / 60000, promos });
  console.log(`Parte ${parte} lista: ${promos.length} leídas, ${promos.filter((p) => p.gastro).length} gastro, ${errores.length} errores, ${lector.pedidos} pedidos.`);
  sellar(`parte-${parte}.enc`, false);
}

// ---------- modo EMPAREJAR ----------
async function d1(sql, params = []) {
  const e = process.env;
  const r = await fetch(`https://api.cloudflare.com/client/v4/accounts/${e.CLOUDFLARE_ACCOUNT_ID}/d1/database/${e.D1_APP_ID}/query`, {
    method: "POST",
    headers: { authorization: `Bearer ${e.CLOUDFLARE_API_TOKEN}`, "content-type": "application/json" },
    body: JSON.stringify({ sql, params }),
  });
  const j = await r.json();
  if (!j.success) throw new Error(JSON.stringify(j.errors));
  return j.result[0].results;
}
async function nuestrosLocales() {
  if (process.env.LOCALES_PRUEBA) return leerJson(process.env.LOCALES_PRUEBA); // prueba local, sin base
  const todos = [];
  let ultimo = "";
  for (;;) {
    // Una sola consulta paginada por id, sólo lectura, con pausa entre páginas (base de producción).
    const filas = await d1(
      `SELECT id, nombre, barrio, ciudad, provincia, lat, lng, instagram FROM restaurantes WHERE estado <> 'cerrado' AND coalesce(estado_vida,'') <> 'cerrado' AND fuera_de_rubro_en IS NULL AND id > ? ORDER BY id LIMIT 5000`,
      [ultimo],
    );
    todos.push(...filas);
    console.log(`locales: ${todos.length}`);
    if (filas.length < 5000) break;
    ultimo = filas.at(-1).id;
    await espera(4000);
  }
  return todos;
}
const VACIAS = new Set("la el los las de del y e the da di do los club casa sucursal suc nivel".split(" "));
const RUBRO = new Set("restaurante restaurantes restaurant resto restos restobar bar bares parrilla parrillas cafe cafes cafeteria coffee pizzeria pizzerias pizza pizzas cerveceria heladeria helados sushi bodegon grill bistro cocina comedor rotiseria hamburgueseria burger burgers confiteria panaderia pasteleria trattoria cantina bodega vinoteca empanadas pastas food gastronomia gastronomico gastronomicos adheridos adherido adheridas locales comercios todos todas otros".split(" "));
const limpiarComercio = (s) => norm(String(s).replace(/\bnivel\s*\d+\b/gi, " ").replace(/\b\d+\s*%.*$/, " ").replace(/\bcon (banco )?\w+( \w+)?$/i, " "));
const nucleo = (n) => n.split(" ").filter((w) => w && !VACIAS.has(w) && !RUBRO.has(w)).join(" ");
const compacto = (n) => n.replace(/ /g, "");
function emparejarUno(nombrePromo, textoUbic, idx) {
  const n = limpiarComercio(nombrePromo);
  const nuc = nucleo(n);
  if (!nuc || nuc.length < 3) return { clase: "generica", motivo: "sin comercio concreto", nombre: n };
  const porId = new Map();
  const suma = (lista, tipo) => (lista ?? []).forEach((l) => { if (!porId.has(l.id) || tipo === "instagram") porId.set(l.id, { l, tipo }); });
  suma(idx.exacto.get(n), "nombre");
  suma(idx.compacto.get(compacto(n)), "nombre");
  suma(idx.ig.get(compacto(n)), "instagram");
  suma(idx.ig.get(compacto(nuc)), "instagram");
  if (compacto(nuc).length >= 5) suma(idx.nucleo.get(nuc), "nucleo");
  const cands = [...porId.values()];
  if (!cands.length) return { clase: "sin_emparejar", nombre: n, nucleo: nuc };
  // El nombre del comercio no cuenta como ubicación («Café Martínez» no prueba que esté en Martínez).
  const ubic = [norm(nombrePromo), n].reduce((t, x) => (x ? t.split(` ${x} `).join(" ") : t), ` ${norm(textoUbic)} `);
  const enTexto = (s) => { const x = norm(s); return x.length >= 4 && !/^(centro|capital|norte|sur|este|oeste)$/.test(x) && ubic.includes(` ${x} `); };
  const conUbic = cands.filter(({ l }) => enTexto(l.barrio) || enTexto(l.ciudad));
  const fuertes = cands.filter((c) => c.tipo !== "nucleo");
  const ids = (xs) => xs.map(({ l, tipo }) => ({ id: l.id, nombre: l.nombre, barrio: l.barrio, ciudad: l.ciudad, provincia: l.provincia, instagram: l.instagram, tipo }));
  const distintivo = compacto(nuc).length >= 6;
  if (conUbic.length && conUbic.length <= 5 && conUbic.some((c) => c.tipo !== "nucleo")) return { clase: "segura", motivo: "nombre + barrio/ciudad en el texto de la promo", nombre: n, locales: ids(conUbic) };
  const porIg = cands.filter((c) => c.tipo === "instagram");
  if (porIg.length === 1 && distintivo) return { clase: "segura", motivo: "el nombre del comercio es la cuenta de Instagram del local", nombre: n, locales: ids(porIg) };
  if (fuertes.length === 1 && distintivo) return { clase: "dudosa", motivo: "nombre igual a un solo local, sin ubicación para confirmar", nombre: n, locales: ids(fuertes) };
  if (fuertes.length > 1) return { clase: "dudosa", motivo: `nombre repetido o cadena (${fuertes.length} locales)`, nombre: n, locales: ids(fuertes.slice(0, 40)), n_locales: fuertes.length };
  return { clase: "dudosa", motivo: fuertes.length ? "nombre corto o genérico" : "sólo coincide el núcleo del nombre", nombre: n, locales: ids(cands.slice(0, 40)), n_locales: cands.length };
}
const csv = (filas) => {
  const cols = Object.keys(filas[0] ?? {});
  const q = (v) => { const s = Array.isArray(v) ? v.join("|") : v == null ? "" : String(v); return /[",\n;]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
  return [cols.join(","), ...filas.map((f) => cols.map((c) => q(f[c])).join(","))].join("\n");
};
async function emparejar() {
  if (CIFRAR) abrirPrevios();
  const partes = buscarPrevios(/^parte-\d+\.json$/).map((f) => leerJson(f)).sort((a, b) => a.parte - b.parte);
  const lista = leerJson(buscarPrevios("lista.json")[0], {});
  const bloqueos = buscarPrevios("bloqueo.json").map((f) => leerJson(f));
  const todas = partes.flatMap((p) => p.promos);
  const vista = new Map(); for (const p of todas) vista.set(p.slug, p);
  const promos = [...vista.values()];
  const vigente = (p) => p.estado_calculado === "running" || (p.estado === "active" && p.desde <= HOY && p.hasta >= HOY);
  const gastro = promos.filter((p) => p.gastro);
  const gastroVig = gastro.filter(vigente);
  console.log(`promos leídas ${promos.length}, gastro ${gastro.length}, gastro vigentes ${gastroVig.length}`);

  const locales = await nuestrosLocales();
  const idx = { exacto: new Map(), compacto: new Map(), nucleo: new Map(), ig: new Map() };
  const meter = (m, k, l) => { if (!k) return; if (!m.has(k)) m.set(k, []); m.get(k).push(l); };
  for (const l of locales) {
    const n = norm(l.nombre);
    meter(idx.exacto, n, l); meter(idx.compacto, compacto(n), l);
    const nu = nucleo(n); if (compacto(nu).length >= 5) meter(idx.nucleo, nu, l);
    const ig = String(l.instagram ?? "").toLowerCase().replace(/^@/, "").replace(/[^a-z0-9]/g, "");
    if (ig.length >= 5) meter(idx.ig, ig, l);
  }
  const filas = [];
  for (const p of gastroVig) {
    const nombres = String(p.comercio || p.titulo).split(/\s*[;|\/]\s*|\s*,\s*/).filter(Boolean).slice(0, 10);
    const textoUbic = [p.titulo, p.descripcion, p.cuerpo, p.legales].join(" ");
    const res = nombres.map((n) => emparejarUno(n, textoUbic, idx));
    const orden = { segura: 0, dudosa: 1, sin_emparejar: 2, generica: 3 };
    const mejor = res.sort((a, b) => orden[a.clase] - orden[b.clase])[0];
    const hl = hastaLegales(p.legales);
    filas.push({
      slug: p.slug, url: p.url, comercio: p.comercio, titulo: p.titulo, beneficio: p.beneficio, tipo: p.tipo,
      bancos: bancosDe(p), credito: p.credito, debito: p.debito, medio: p.medio, dias: diasTexto(p.dias), horario: p.horario,
      desde: p.desde, hasta: p.hasta, hasta_ld: p.hasta_ld, hasta_legales: hl, tope: p.tope, cuotas: p.cuotas, gastro: p.gastro,
      clase: mejor.clase, motivo: mejor.motivo ?? "", nombre_normalizado: mejor.nombre, n_locales: mejor.n_locales ?? mejor.locales?.length ?? 0,
      locales: (mejor.locales ?? []).map((l) => `${l.id}:${l.nombre} (${[l.barrio, l.ciudad].filter(Boolean).join(", ")})`),
    });
  }
  const cuenta = (xs, f) => xs.reduce((a, x) => ((a[f(x)] = (a[f(x)] ?? 0) + 1), a), {});
  const idsDe = (clases) => new Set(filas.filter((f) => clases.includes(f.clase)).flatMap((f) => f.locales.map((s) => s.split(":")[0])));
  const dias = (a, b) => Math.round((Date.parse(b) - Date.parse(a)) / 864e5);
  const resumen = {
    fecha: new Date().toISOString(),
    sitemap_total: lista.total_sitemap, sitemap_por_prioridad: lista.por_prioridad, paginas_a_leer: lista.slugs?.length,
    pedidos_modo: partes.reduce((a, p) => a + (p.pedidos ?? 0), 0), errores: partes.reduce((a, p) => a + (p.errores?.length ?? 0), 0), bloqueos,
    minutos_lectura: Math.round(partes.reduce((a, p) => a + (p.minutos ?? 0), 0)),
    promos_leidas: promos.length, estados: cuenta(promos, (p) => p.estado_calculado || p.estado || "?"),
    vigentes_todas: promos.filter(vigente).length,
    gastro_leidas: gastro.length, gastro_vigentes: gastroVig.length, gastro_vigentes_fuerte: gastroVig.filter((p) => p.gastro === "fuerte").length,
    muestra_2025: { leidas: promos.filter((p) => p.prioridad_slug === 2).length, vigentes: promos.filter((p) => p.prioridad_slug === 2 && vigente(p)).length },
    locales_tenedor: locales.length,
    clases: cuenta(filas, (f) => f.clase),
    clases_fuerte: cuenta(filas.filter((f) => f.gastro === "fuerte"), (f) => f.clase),
    motivos_dudosa: cuenta(filas.filter((f) => f.clase === "dudosa"), (f) => f.motivo.replace(/\(\d+ locales\)/, "(n)")),
    locales_cubiertos_seguro: idsDe(["segura"]).size,
    locales_cubiertos_seguro_o_dudoso: idsDe(["segura", "dudosa"]).size,
    bancos: cuenta(filas.flatMap((f) => (f.bancos.length ? f.bancos : ["(sin detectar)"]).map((b) => ({ b }))), (x) => x.b),
    vigencia: {
      vencen_en_7_dias: filas.filter((f) => f.hasta && dias(HOY, f.hasta) <= 7).length,
      vencen_en_30_dias: filas.filter((f) => f.hasta && dias(HOY, f.hasta) <= 30).length,
      empezaron_ultimos_30_dias: filas.filter((f) => f.desde && dias(f.desde, HOY) <= 30).length,
      mediana_dias_restantes: (() => { const d = filas.filter((f) => f.hasta).map((f) => dias(HOY, f.hasta)).sort((a, b) => a - b); return d[Math.floor(d.length / 2)] ?? null; })(),
      legales_contradicen_fecha: filas.filter((f) => f.hasta_legales && f.hasta && f.hasta_legales !== f.hasta).length,
      legales_mas_corta: filas.filter((f) => f.hasta_legales && f.hasta && f.hasta_legales < f.hasta).length,
      ld_distinto: filas.filter((f) => f.hasta_ld && f.hasta && f.hasta_ld !== f.hasta).length,
    },
    comercios_repetidos_top: Object.entries(cuenta(filas, (f) => f.nombre_normalizado)).sort((a, b) => b[1] - a[1]).slice(0, 25),
  };
  escribir("resumen.json", resumen);
  escribir("promos-gastro.json", gastro);
  if (filas.length) escribir("emparejamiento.csv", csv(filas));
  escribir("emparejamiento.json", filas);
  // En el log (público) sólo números: nada de nombres de comercios ni de locales.
  const { comercios_repetidos_top, ...numeros } = resumen;
  console.log(JSON.stringify(numeros, null, 1));
  sellar("resultados.enc", true);
}

if (modo === "leer") await leer();
else if (modo === "emparejar") await emparejar();
else if (modo === "descifrar") descifrar();
else if (modo === "probar") { // prueba local del lector sobre un HTML ya bajado (no pide nada)
  const p = parsearPromo(fs.readFileSync(process.argv[3], "utf8"), path.basename(process.argv[3], ".html"));
  if (args.json) { p.gastro = esGastro(p); p.prioridad_slug = 0; p.estado_calculado = "running"; fs.writeFileSync(args.json, JSON.stringify(p)); }
  else console.log({ ...p, legales: p.legales.slice(0, 200), gastro: esGastro(p), bancos: bancosDe(p), hasta_legales: hastaLegales(p.legales) });
}
else { console.error("uso: node modo-piloto.mjs leer|emparejar ..."); process.exit(1); }
