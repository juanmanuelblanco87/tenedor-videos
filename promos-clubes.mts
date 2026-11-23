// Promos automáticas · etapa 2 · LECTOR de Club La Nación y Clarín 365 (docs/promos-automaticas-roberto.md §1.1-1.2 del
// repo privado). Lee SÓLO datos públicos de las fichas de gastronomía de cada club y los manda a NUESTRO Worker
// (POST /api/cron/promos-clubes) de a 5 fichas, esperando cada respuesta. Nunca toca la base: el emparejamiento y el
// chequeo los hace el Worker. Logs: SÓLO NÚMEROS (el repo es público). No se suben artifacts.
//
// Reglas (iguales al piloto de MODO):
//  - robots.txt de la fuente ANTES de cada vuelta; si prohíbe el sitemap o las fichas → la fuente queda FRENADA (no lee
//    nada y sale con código 3). Club La Nación: nunca búsquedas `?q=` ni el mapa de sucursales. Clarín 365 no tiene
//    robots.txt (404 = sin reglas), pero se respeta igual el ritmo y los cortes.
//  - 1 pedido cada 2,1 s; ante 403 / 429 / captcha se CORTA la fuente (sin reintentos).
//  - User-agent genérico «TenedorBot/1.0», sin datos del dueño.
//  - Tope de pedidos por corrida (--max-pedidos, por defecto 180).
//
// Uso:
//   node --experimental-strip-types promos-clubes.mts --fuente club_la_nacion --modo completo|nuevos [--vistos vistos] [--seco] [--max-fichas N]
// Variables (sólo si no es --seco): PROMOS_INGESTA_URL (https://…/api/cron/promos-clubes) e IMPORTADOR_SECRET.
// --vistos: carpeta con <fuente>.json (slugs ya leídos; la guarda el cache del Action). «nuevos» lee sólo los que no están.
import fs from "node:fs";
import path from "node:path";
import { HOST_CLUB, leerFichaClub, slugClarin, slugLaNacion, urlsDeSitemap, type FichaClub, type FuenteClub } from "./promos-clubes-lector.ts";

const UA = "TenedorBot/1.0";
const PAUSA_MS = 2_100;
const TANDA = 5;
const PAUSA_TANDA_MS = 1_000;

const args: Record<string, string> = {};
for (let i = 2; i < process.argv.length; i++) {
  const a = process.argv[i];
  if (!a.startsWith("--")) continue;
  const sig = process.argv[i + 1];
  if (sig && !sig.startsWith("--")) {
    args[a.slice(2)] = sig;
    i++;
  } else args[a.slice(2)] = "si";
}
const FUENTE = args.fuente as FuenteClub;
if (FUENTE !== "club_la_nacion" && FUENTE !== "clarin_365") throw new Error("--fuente club_la_nacion | clarin_365");
const MODO = args.modo === "nuevos" ? "nuevos" : "completo";
const SECO = args.seco === "si";
const MAX_PEDIDOS = Math.max(5, Math.min(400, Number(args["max-pedidos"] ?? 180)));
const MAX_FICHAS = Math.max(1, Math.min(400, Number(args["max-fichas"] ?? 400)));
/** Si la base tarda más que esto en una tanda, se corta y sigue mañana (doc §1.1). */
const MS_BASE_MAX = Number(args["ms-base-max"] ?? 2_000);
const VISTOS = args.vistos ?? "vistos";
const BASE = `https://${HOST_CLUB[FUENTE]}`;
const SITEMAP = FUENTE === "club_la_nacion" ? `${BASE}/sitemap-cuentas.xml` : `${BASE}/sitemap.xml`;
const slugDe = FUENTE === "club_la_nacion" ? slugLaNacion : slugClarin;

const espera = (ms: number) => new Promise((r) => setTimeout(r, ms));
const cuenta = { pedidos: 0, sitemap: 0, gastronomia: 0, aLeer: 0, leidas: 0, sinDatos: 0, beneficios: 0, noEncontradas: 0, enviadas: 0, tandas: 0, seguras: 0, dudosas: 0, descartadas: 0, escritas: 0 };
const fin = (codigo: number, motivo: string) => {
  console.log(JSON.stringify({ fuente: FUENTE, modo: MODO, motivo, ...cuenta }));
  process.exit(codigo);
};

// ---------- robots.txt (grupo de TenedorBot o «*»; regla más larga gana, Allow gana empates) ----------
function parsearRobots(txt: string): (ruta: string) => boolean {
  const grupos: { uas: string[]; reglas: { allow: boolean; ruta: string }[] }[] = [];
  let actual: (typeof grupos)[number] | null = null;
  let ultimoFueUA = false;
  for (const crudo of txt.split(/\r?\n/)) {
    const linea = crudo.replace(/#.*/, "").trim();
    const m = /^([A-Za-z-]+)\s*:\s*(.*)$/.exec(linea);
    if (!m) continue;
    const k = m[1].toLowerCase();
    const v = m[2].trim();
    if (k === "user-agent") {
      if (!ultimoFueUA) grupos.push((actual = { uas: [], reglas: [] }));
      actual!.uas.push(v.toLowerCase());
      ultimoFueUA = true;
    } else {
      ultimoFueUA = false;
      if (actual && (k === "allow" || k === "disallow")) actual.reglas.push({ allow: k === "allow", ruta: v });
    }
  }
  const mio = grupos.filter((g) => g.uas.some((u) => u !== "*" && "tenedorbot".startsWith(u)));
  const reglas = (mio.length ? mio : grupos.filter((g) => g.uas.includes("*"))).flatMap((g) => g.reglas);
  const aRe = (r: string) => new RegExp("^" + r.replace(/[.+?^{}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\\\$$|\$$/, "$"));
  return (ruta) => {
    let mejor: { allow: boolean; ruta: string } | null = null;
    for (const r of reglas) {
      if (!r.ruta) continue;
      if (aRe(r.ruta).test(ruta) && (!mejor || r.ruta.length > mejor.ruta.length || (r.ruta.length === mejor.ruta.length && r.allow))) mejor = r;
    }
    return !mejor || mejor.allow;
  };
}

// ---------- pedidos con ritmo, tope y corte ----------
let ultimo = 0;
let permitido: (ruta: string) => boolean = () => true;
async function pedir(url: string): Promise<{ status: number; texto: string }> {
  const u = new URL(url);
  if (u.host !== HOST_CLUB[FUENTE]) throw new Error("host ajeno");
  if (u.search) throw new Error("nunca búsquedas ni parámetros");
  if (!permitido(u.pathname)) fin(3, "robots.txt prohíbe lo que leemos: fuente frenada");
  if (cuenta.pedidos >= MAX_PEDIDOS) fin(0, "tope de pedidos de la corrida");
  const falta = ultimo + PAUSA_MS - Date.now();
  if (falta > 0) await espera(falta);
  ultimo = Date.now();
  cuenta.pedidos++;
  const r = await fetch(url, { headers: { "user-agent": UA, "accept-language": "es-AR,es" }, redirect: "manual", signal: AbortSignal.timeout(30_000) });
  if (r.status === 403 || r.status === 429) fin(2, `HTTP ${r.status}: corte (no se insiste)`);
  const texto = r.status >= 200 && r.status < 300 ? (await r.text()).slice(0, 2_000_000) : "";
  if (/captcha|cf-challenge|are you a robot|unusual traffic|cf-chl-/i.test(texto.slice(0, 5000))) fin(2, "captcha: corte (no se insiste)");
  return { status: r.status, texto };
}

// ---------- envío al Worker ----------
const URL_INGESTA = process.env.PROMOS_INGESTA_URL ?? "";
const SECRETO = process.env.IMPORTADOR_SECRET ?? "";
/** Los slugs cuentan como leídos recién cuando el Worker los recibió (si está apagado o falla, mañana se vuelven a leer). */
let alRecibir: (lote: FichaClub[]) => void = () => {};
async function enviar(lote: FichaClub[]): Promise<void> {
  if (!lote.length) return;
  if (SECO) return alRecibir(lote);
  const r = await fetch(URL_INGESTA, { method: "POST", headers: { authorization: `Bearer ${SECRETO}`, "content-type": "application/json" }, body: JSON.stringify({ fichas: lote }), signal: AbortSignal.timeout(280_000) });
  const j = (await r.json().catch(() => ({}))) as Record<string, unknown>;
  if (r.status === 409 && j.apagado) fin(0, "la fuente está apagada en Ajustes del Worker");
  if (!r.ok || j.ok !== true) fin(1, `el Worker respondió ${r.status}`);
  cuenta.tandas++;
  cuenta.enviadas += lote.length;
  alRecibir(lote);
  cuenta.seguras += Number(j.seguras ?? 0);
  cuenta.dudosas += Number(j.dudosas ?? 0);
  cuenta.escritas += Number(j.escritas ?? 0);
  cuenta.descartadas += Object.values((j.descartadas ?? {}) as Record<string, number>).reduce((a, b) => a + Number(b), 0);
  if (Number(j.msBase ?? 0) > MS_BASE_MAX) fin(0, "la base tardó de más en una tanda: corte, sigue mañana");
  await espera(PAUSA_TANDA_MS);
}

// ---------- vuelta ----------
if (!SECO && (!/^https:\/\//.test(URL_INGESTA) || !SECRETO)) throw new Error("faltan PROMOS_INGESTA_URL (https) e IMPORTADOR_SECRET (o --seco)");

const robots = await pedir(`${BASE}/robots.txt`);
permitido = robots.status >= 200 && robots.status < 300 ? parsearRobots(robots.texto) : robots.status === 404 || robots.status === 410 ? () => true : (fin(1, `robots.txt respondió ${robots.status}: no se lee hoy`) as never);

const sitemap = await pedir(SITEMAP);
if (sitemap.status !== 200) fin(1, `el sitemap respondió ${sitemap.status}`);
const urls = urlsDeSitemap(sitemap.texto);
cuenta.sitemap = urls.length;
const slugs = [...new Set(urls.map((u) => slugDe(u)).filter((s): s is string => Boolean(s)))].sort();
cuenta.gastronomia = slugs.length;
// Si robots.txt prohíbe alguna ficha de gastronomía, la fuente queda frenada (no se elige qué leer y qué no).
if (slugs.some((s) => !permitido(new URL(FUENTE === "club_la_nacion" ? `${BASE}/beneficios/gastronomia/${s}` : `${BASE}/${s}`).pathname))) fin(3, "robots.txt prohíbe fichas de gastronomía: fuente frenada");

fs.mkdirSync(VISTOS, { recursive: true });
const archivoVistos = path.join(VISTOS, `${FUENTE}.json`);
const vistos = new Set<string>(fs.existsSync(archivoVistos) ? (JSON.parse(fs.readFileSync(archivoVistos, "utf8")) as string[]) : []);
alRecibir = (lote) => {
  for (const f of lote) vistos.add(f.slug);
  fs.writeFileSync(archivoVistos, JSON.stringify([...vistos].sort()));
};
const aLeer = (MODO === "nuevos" ? slugs.filter((s) => !vistos.has(s)) : slugs).slice(0, MAX_FICHAS);
cuenta.aLeer = aLeer.length;

let lote: FichaClub[] = [];
/** Sólo para pruebas en la PC (--salida archivo.json): nunca en el Action (repo público). */
const todas: FichaClub[] = [];
for (const slug of aLeer) {
  const link = FUENTE === "club_la_nacion" ? `${BASE}/beneficios/gastronomia/${slug}` : `${BASE}/${slug}`;
  const r = await pedir(link);
  if (r.status === 404 || r.status === 410) {
    cuenta.noEncontradas++;
    continue;
  }
  if (r.status !== 200) continue;
  cuenta.leidas++;
  let ficha: FichaClub | null = null;
  try {
    ficha = leerFichaClub(FUENTE, r.texto, slug);
  } catch {
    ficha = null;
  }
  if (!ficha) {
    cuenta.sinDatos++;
    continue;
  }
  cuenta.beneficios += ficha.beneficios.length;
  lote.push(ficha);
  if (args.salida) todas.push(ficha);
  if (lote.length >= TANDA) {
    await enviar(lote);
    lote = [];
  }
}
await enviar(lote);
if (args.salida) fs.writeFileSync(args.salida, JSON.stringify(todas, null, 1));
fin(0, SECO ? "vuelta completa (seco: no se mandó nada)" : "vuelta completa");
