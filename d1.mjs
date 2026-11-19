// D1 con topes para los workflows de este repo (18/11/2026, infra ágil etapa 5: docs/infra-agil-y-admin-roberto.md
// §3.5 en tenedor-cf-ig). Antes cada script tenía su propio d1() y barría tablas enteras (a-r2 directos: 295 k filas
// por llamada, 450 llamadas en 2 días). Reglas:
//   · ninguna consulta debería leer más de 50 k filas (MAX_POR_LLAMADA): si pasa, queda en el log con «[topes]»;
//   · cada corrida tiene un tope de filas leídas (--tope-filas, por defecto 30.000): agotado() avisa para cortar;
//   · los barridos no corren en las horas pico de la app (11 a 15 y 19 a 24, hora de Buenos Aires): salirSiPico();
//   · la lista de trabajo la arma UNA sola máquina (job «cola» del workflow) y la deja en R2 (control/colas/, que el
//     Worker de medios no sirve); las partes la leen de ahí en vez de repetir la consulta cada una.
// Las lecturas salen de meta.rows_read de la API de D1 (la misma cifra que suma GraphQL).
import { appendFileSync } from "node:fs";

const env = process.env;
export const MAX_POR_LLAMADA = 50_000;
const argNum = (n, d) => {
  const i = process.argv.indexOf(n);
  return i > 0 ? Number(process.argv[i + 1]) : d;
};
export const TOPE_FILAS = argNum("--tope-filas", 30_000);
export const lecturas = { filas: 0, llamadas: 0, mayor: 0, escritas: 0 };
const espera = (ms) => new Promise((ok) => setTimeout(ok, ms));

// Condiciones LITERALES de los índices parciales de la migración app 0036 (si cambian acá, cambian allá).
export const COLA_PUBLICACIONES = "plataforma = 'instagram' AND (media_url LIKE '%cdninstagram%' OR media_url LIKE '%fbcdn%')";
export const COLA_FOTOS_REALES = "fuente LIKE 'instagram%' AND (url LIKE '%cdninstagram%' OR url LIKE '%fbcdn%')";
export const NO_VENCE = "2100-01-01T00:00:00.000Z";
export const HOSTINGER_VIDEOS = "url LIKE 'https://datos.tenedor.com.ar/videos-ig/%'";

/**
 * Una consulta a D1 por la API REST. Reintenta ante 429 / overloaded / corte de red (3, 8, 15 y 30 s).
 * Devuelve { filas, cambios, leidas }.
 */
export async function d1Base(base, sql, params = [], intento = 0) {
  const r = await fetch(`https://api.cloudflare.com/client/v4/accounts/${env.CLOUDFLARE_ACCOUNT_ID}/d1/database/${base}/query`, {
    method: "POST",
    headers: { authorization: `Bearer ${env.CLOUDFLARE_API_TOKEN}`, "content-type": "application/json" },
    body: JSON.stringify({ sql, params }),
    signal: AbortSignal.timeout(60_000),
  }).catch((e) => ({ ok: false, status: String(e?.name ?? e), json: async () => null }));
  const j = await r.json().catch(() => null);
  if (!r.ok || !j?.success) {
    const m = `D1 ${r.status} ${j?.errors?.map((e) => e.message).join("; ") ?? ""}`;
    if ((r.status === 429 || /overloaded|Timeout|fetch failed|TypeError/i.test(m)) && intento < 4) {
      await espera([3_000, 8_000, 15_000, 30_000][intento]);
      return d1Base(base, sql, params, intento + 1);
    }
    throw new Error(m);
  }
  const res = j.result?.[0] ?? {};
  const leidas = Number(res.meta?.rows_read ?? 0);
  lecturas.filas += leidas;
  lecturas.escritas += Number(res.meta?.rows_written ?? 0);
  lecturas.llamadas++;
  lecturas.mayor = Math.max(lecturas.mayor, leidas);
  if (leidas > MAX_POR_LLAMADA) console.log(`[topes] una consulta leyó ${leidas} filas (más de ${MAX_POR_LLAMADA}): ${sql.replace(/\s+/g, " ").slice(0, 140)}`);
  return { filas: res.results ?? [], cambios: Number(res.meta?.changes ?? 0), leidas };
}

/** Atajo para la base de la app (D1_APP_ID): devuelve las filas. */
export const consultar = async (sql, params = []) => (await d1Base(env.D1_APP_ID, sql, params)).filas;

/** ¿Se pasó el tope de filas leídas de esta corrida? */
export const agotado = (tope = TOPE_FILAS) => lecturas.filas >= tope;
export const resumenLecturas = () => `D1: ${lecturas.filas} filas leídas en ${lecturas.llamadas} consultas (la mayor ${lecturas.mayor}), ${lecturas.escritas} escritas`;

/**
 * Sin los índices de la migración app 0036, las consultas nuevas recorrerían tablas enteras (peor que antes): el script
 * no corre y lo dice en el log. Lee sqlite_master (unos cientos de filas).
 */
export async function exigirIndices(nombres, quien) {
  const hay = new Set((await consultar("SELECT name FROM sqlite_master WHERE type = 'index' AND name IN (SELECT value FROM json_each(?))", [JSON.stringify(nombres)])).map((x) => x.name));
  const faltan = nombres.filter((n) => !hay.has(n));
  if (!faltan.length) return;
  console.log(`${quien}: faltan los índices ${faltan.join(", ")} (migración app 0036_colas_workflows). No corre para no barrer tablas enteras.`);
  if (env.GITHUB_OUTPUT) appendFileSync(env.GITHUB_OUTPUT, "quedan=0\nitems=0\n");
  process.exit(0);
}

// ---------- Horario ----------
export const horaAR = (d = new Date()) => (d.getUTCHours() + 21) % 24;
/** Picos de uso de la app: 11 a 15 y 19 a 24, hora de Buenos Aires (UTC−3, sin horario de verano). */
export const enPico = (d = new Date()) => {
  const h = horaAR(d);
  return (h >= 11 && h < 15) || h >= 19;
};
/** Sale con 0 si es hora pico (salvo --forzar). Escribe quedan=0 para que la cadena del workflow no se relance. */
export function salirSiPico(nombre) {
  if (process.argv.includes("--forzar") || !enPico()) return;
  console.log(`${nombre}: hora pico de la app (11 a 15 y 19 a 24 h de Buenos Aires, ahora ${horaAR()} h). No corre; sigue fuera del pico.`);
  if (env.GITHUB_OUTPUT) appendFileSync(env.GITHUB_OUTPUT, "quedan=0\n");
  process.exit(0);
}

// ---------- Colas en R2 (control/colas/<nombre>.json, privado: el Worker de medios sólo sirve sus carpetas) ----------
const R2_CONTROL = () => `https://api.cloudflare.com/client/v4/accounts/${env.CLOUDFLARE_ACCOUNT_ID}/r2/buckets/tenedor-media/objects/control/colas`;
/** La guarda el job «cola» (una sola máquina por corrida). `corrida` = GITHUB_RUN_ID, para no leer una cola vieja. */
export async function guardarCola(nombre, items, extra = {}) {
  const cuerpo = JSON.stringify({ corrida: env.GITHUB_RUN_ID ?? "local", armada_en: new Date().toISOString(), lecturas: { ...lecturas }, ...extra, items });
  for (let i = 0; i < 4; i++) {
    const r = await fetch(`${R2_CONTROL()}/${nombre}.json`, { method: "PUT", headers: { authorization: `Bearer ${env.CLOUDFLARE_API_TOKEN}`, "content-type": "application/json" }, body: cuerpo, signal: AbortSignal.timeout(60_000) }).catch(() => null);
    if (r?.ok) return;
    await espera(5_000 * (i + 1));
  }
  throw new Error(`no se pudo guardar la cola ${nombre} en R2`);
}
/** La leen las partes. Si la cola no es de esta corrida (o no está), devuelve null: la parte no hace nada. */
export async function leerCola(nombre) {
  const r = await fetch(`${R2_CONTROL()}/${nombre}.json`, { headers: { authorization: `Bearer ${env.CLOUDFLARE_API_TOKEN}` }, signal: AbortSignal.timeout(60_000) }).catch(() => null);
  if (!r?.ok) return null;
  const j = await r.json().catch(() => null);
  if (!j || (env.GITHUB_RUN_ID && j.corrida !== env.GITHUB_RUN_ID)) return null;
  return j;
}

// ---------- Cursor de un barrido largo (ia_config, una fila por barrido) ----------
export async function leerCursor(clave) {
  const f = (await consultar("SELECT valor FROM ia_config WHERE clave = ?", [clave]))[0];
  try {
    return f ? JSON.parse(String(f.valor)) : {};
  } catch {
    return {};
  }
}
export async function guardarCursor(clave, valor) {
  const ahora = new Date().toISOString();
  await consultar("INSERT INTO ia_config (clave, valor, actualizado_en) VALUES (?, ?, ?) ON CONFLICT (clave) DO UPDATE SET valor = excluded.valor, actualizado_en = excluded.actualizado_en", [
    clave,
    JSON.stringify({ ...valor, en: ahora }),
    ahora,
  ]);
}

export const hash = (s) => [...String(s)].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7);
