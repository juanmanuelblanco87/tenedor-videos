// Copia de medios a Cloudflare R2 (12/11/2026, dueño: «aplicá los arreglos de velocidad, vamos con los 5»). Bucket
// `tenedor-media`, servido por media.tenedor.com.ar (src/cf/medios.ts de la app), con la MISMA ruta que en Hostinger.
// Corre en GitHub Actions (a-r2.yml), nunca en la PC. Cuatro fases, cada una con su tope por corrida:
//   --portadas N  portadas-ig/<id>.jpg y <id>-160.jpg de los videos con copia (Hostinger → R2)
//   --fotos N     fotos-ig/… de fotos_reales y publicaciones (Hostinger → R2)
//   --videos N    videos-ig/… de videos_copia que faltan en R2 o cambiaron de tamaño (achicar.mjs) (Hostinger → R2)
//   --directos N  elegidos visibles SIN copia cuyo video todavía es el link firmado de Instagram: si el link sigue vivo
//                 se baja, se achica como achicar.mjs (480 px, 0,8 Mbps, faststart), se sube a R2 videos-ig/<id>.mp4 y
//                 se anota en videos_copia con la URL de media.tenedor.com.ar (el disco de Hostinger está al tope; el
//                 disparador de videos_copia deja la publicación «no vence», igual que la copia propia de siempre). Su
//                 portada se sube a R2 y a Hostinger (la app todavía la arma con datos.tenedor.com.ar/portadas-ig/).
//                 Si Instagram niega el archivo o el link venció, se saltea (no se rodea) y queda anotado en ia_config
//                 «r2_directos_vencidos» para que lo renueve el lector de anonyig.
// Reglas del dueño: de a uno contra Hostinger, con pausa; 429/503 de Hostinger = frenar (sigue la próxima corrida);
// 3 errores seguidos = cortar la fase; nada de notificaciones (sale siempre con 0: un rojo de GitHub manda mail).
// Lo ya copiado se saltea comparando con el listado de R2: se puede cortar y volver a correr.
// Uso: node a-r2.mjs [--portadas 0] [--fotos 0] [--videos 0] [--directos 0] [--minutos 100] [--noche-x 3]
// (--noche-x multiplica los topes de --videos de 00 a 08 h de Argentina, cuando pesa menos sobre Hostinger.)
import { execFile } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const ejecutar = promisify(execFile);
const arg = (n, def) => {
  const i = process.argv.indexOf(n);
  return i > 0 ? Number(process.argv[i + 1]) : def;
};
const env = process.env;
for (const k of ["CLOUDFLARE_API_TOKEN", "CLOUDFLARE_ACCOUNT_ID", "D1_APP_ID"]) if (!env[k]) throw new Error(`Falta el secreto ${k}`);
const MINUTOS = arg("--minutos", 100);
const horaAR = (new Date().getUTCHours() + 21) % 24;
const NOCHE = horaAR < 8;
const TOPE = {
  portadas: arg("--portadas", 0),
  fotos: arg("--fotos", 0),
  videos: Math.round(arg("--videos", 0) * (NOCHE ? arg("--noche-x", 1) : 1)),
  directos: arg("--directos", 0),
};
const DOMINIO = env.HOSTINGER_DOMINIO || "datos.tenedor.com.ar";
const ORIGEN = `https://${DOMINIO}/`;
const MEDIA = "https://media.tenedor.com.ar/";
const BUCKET = "tenedor-media";
const R2 = `https://api.cloudflare.com/client/v4/accounts/${env.CLOUDFLARE_ACCOUNT_ID}/r2/buckets/${BUCKET}/objects`;
const auth = { authorization: `Bearer ${env.CLOUDFLARE_API_TOKEN}` };
const t0 = Date.now();
const quedaTiempo = () => Date.now() - t0 < MINUTOS * 60_000;
const espera = (ms) => new Promise((ok) => setTimeout(ok, ms));
const clave = (url) => {
  if (!url || !String(url).startsWith(ORIGEN)) return null;
  const k = decodeURIComponent(String(url).slice(ORIGEN.length).split("?")[0]);
  return /^[a-z0-9._/-]+$/i.test(k) && !k.includes("..") ? k : null;
};

// ---------- D1 por la API REST (reintenta si la base está sobrecargada) ----------
async function d1(sql, params = [], base = env.D1_APP_ID, intento = 0) {
  const r = await fetch(`https://api.cloudflare.com/client/v4/accounts/${env.CLOUDFLARE_ACCOUNT_ID}/d1/database/${base}/query`, {
    method: "POST",
    headers: { ...auth, "content-type": "application/json" },
    body: JSON.stringify({ sql, params }),
    signal: AbortSignal.timeout(60_000),
  });
  const j = await r.json().catch(() => null);
  if (!r.ok || !j?.success) {
    const m = `D1 ${r.status} ${j?.errors?.map((e) => e.message).join("; ") ?? ""}`;
    if ((r.status === 429 || /overloaded/i.test(m)) && intento < 4) {
      await espera([3_000, 8_000, 15_000, 30_000][intento]);
      return d1(sql, params, base, intento + 1);
    }
    throw new Error(m);
  }
  return j.result?.[0]?.results ?? [];
}

// ---------- R2 por la API REST ----------
async function listarR2(prefijo) {
  const m = new Map();
  let cursor = "";
  for (;;) {
    const r = await fetch(`${R2}?per_page=1000&prefix=${prefijo}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`, { headers: auth, signal: AbortSignal.timeout(60_000) });
    const j = await r.json();
    if (!j.success) throw new Error(`listar R2 ${prefijo}: ${j.errors?.map((e) => e.message).join("; ")}`);
    for (const o of j.result ?? []) m.set(o.key, o.size);
    cursor = j.result_info?.cursor ?? "";
    if (!cursor || String(j.result_info?.is_truncated) === "false") break;
  }
  return m;
}
async function subirR2(k, cuerpo, tipo) {
  const p = await fetch(`${R2}/${k.split("/").map(encodeURIComponent).join("/")}`, {
    method: "PUT",
    headers: { ...auth, "content-type": tipo },
    body: cuerpo,
    signal: AbortSignal.timeout(180_000),
  });
  if (!p.ok) throw new Error(`R2 ${p.status} ${(await p.text()).slice(0, 200)}`);
}

// ---------- Hostinger (sólo para la portada de los directos; API de archivos, TUS) ----------
let sesion = null;
async function subirHostinger(nombre, contenido, reintento = false) {
  if (!env.HOSTINGER_API_TOKEN || !env.HOSTINGER_USUARIO) return;
  for (let intento = 0; !sesion; intento++) {
    const r = await fetch("https://developers.hostinger.com/api/hosting/v1/files/upload-urls", {
      method: "POST",
      headers: { authorization: `Bearer ${env.HOSTINGER_API_TOKEN}`, "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({ username: env.HOSTINGER_USUARIO, domain: DOMINIO }),
      signal: AbortSignal.timeout(20_000),
    }).catch((e) => ({ ok: false, status: String(e?.name ?? e) }));
    if (r.ok) sesion = await r.json();
    else if (intento >= 2) throw new Error(`upload-urls: ${r.status}`);
    else await espera(5_000 * 2 ** intento);
  }
  const destino = `${sesion.url.replace(/\/$/, "")}/${nombre}?override=true`;
  const comunes = { "X-Auth": sesion.auth_key, "X-Auth-Rest": sesion.rest_auth_key, "Tus-Resumable": "1.0.0" };
  const crear = await fetch(destino, { method: "POST", headers: { ...comunes, "Upload-Length": String(contenido.length) }, signal: AbortSignal.timeout(20_000) });
  const enviar = crear.ok
    ? await fetch(destino, { method: "PATCH", headers: { ...comunes, "Upload-Offset": "0", "Content-Type": "application/offset+octet-stream" }, body: new Uint8Array(contenido), signal: AbortSignal.timeout(60_000) })
    : crear;
  if (!enviar.ok) {
    sesion = null;
    if (reintento) throw new Error(`subida Hostinger: ${enviar.status}`);
    return subirHostinger(nombre, contenido, true);
  }
}

// ---------- Fase genérica Hostinger → R2 (de a uno, con pausa) ----------
let hostingerFrenado = "";
const resumen = {};
async function copiarDeHostinger(nombre, items, pausaMs) {
  const est = (resumen[nombre] = { pendientes: items.length, copiados: 0, faltan_en_hostinger: 0, errores: 0, gb: 0, corte: "" });
  let seguidos = 0;
  for (const it of items) {
    if (hostingerFrenado) {
      est.corte = `Hostinger frenado (${hostingerFrenado})`;
      break;
    }
    if (!quedaTiempo()) {
      est.corte = "tiempo";
      break;
    }
    try {
      const r = await fetch(ORIGEN + it.k, { signal: AbortSignal.timeout(120_000) });
      if (r.status === 404) {
        est.faltan_en_hostinger++;
        await r.body?.cancel();
        continue;
      }
      if (r.status === 429 || r.status === 503 || r.status === 508) {
        hostingerFrenado = `${r.status} en ${it.k}`;
        est.corte = `Hostinger ${r.status}: freno, sigue la próxima corrida`;
        break;
      }
      if (!r.ok) throw new Error(`Hostinger ${r.status}`);
      const cuerpo = new Uint8Array(await r.arrayBuffer());
      await subirR2(it.k, cuerpo, r.headers.get("content-type") ?? (it.k.endsWith(".mp4") ? "video/mp4" : "image/jpeg"));
      est.copiados++;
      est.gb += cuerpo.length / 1e9;
      seguidos = 0;
      if (est.copiados % 200 === 0) console.log(`  ${nombre}: ${est.copiados} copiados, ${est.gb.toFixed(2)} GB, ${Math.round((Date.now() - t0) / 1000)} s`);
    } catch (e) {
      est.errores++;
      console.log(`  error ${it.k}: ${e instanceof Error ? e.message : e}`);
      if (++seguidos >= 3) {
        est.corte = "3 errores seguidos (regla de operación)";
        break;
      }
    }
    await espera(pausaMs);
  }
  est.gb = Number(est.gb.toFixed(3));
  console.log(`${nombre}: ${JSON.stringify(est)}`);
}

// ---------- 1) Portadas ----------
if (TOPE.portadas > 0) {
  const enR2 = await listarR2("portadas-ig/");
  const ids = (await d1("SELECT publicacion_id AS id FROM videos_copia ORDER BY copiado_en DESC")).map((x) => String(x.id).replace(/[^\w-]/g, ""));
  const items = ids.flatMap((id) => [`portadas-ig/${id}.jpg`, `portadas-ig/${id}-160.jpg`]).filter((k) => !enR2.has(k)).map((k) => ({ k }));
  console.log(`Portadas: en R2 ${enR2.size}, faltan ${items.length} (de ${ids.length * 2})`);
  await copiarDeHostinger("portadas", items.slice(0, TOPE.portadas), 150);
}

// ---------- 2) Fotos de Instagram ----------
if (TOPE.fotos > 0 && quedaTiempo()) {
  const enR2 = await listarR2("fotos-ig/");
  const urls = await d1(
    `SELECT url AS u FROM fotos_reales WHERE url LIKE ? UNION SELECT media_url FROM publicaciones WHERE media_url LIKE ? UNION SELECT portada_url FROM publicaciones WHERE portada_url LIKE ?`,
    [`${ORIGEN}fotos-ig/%`, `${ORIGEN}fotos-ig/%`, `${ORIGEN}fotos-ig/%`],
  );
  const ks = [...new Set(urls.map((x) => clave(x.u)).filter(Boolean))];
  const items = ks.filter((k) => !enR2.has(k)).map((k) => ({ k }));
  console.log(`Fotos IG: en R2 ${enR2.size}, faltan ${items.length} (de ${ks.length})`);
  await copiarDeHostinger("fotos", items.slice(0, TOPE.fotos), 150);
}

// ---------- 3) Videos ya copiados en Hostinger ----------
if (TOPE.videos > 0 && quedaTiempo()) {
  const enR2 = await listarR2("videos-ig/");
  const filas = await d1("SELECT url, bytes FROM videos_copia WHERE url LIKE ? ORDER BY copiado_en DESC", [`${ORIGEN}videos-ig/%`]);
  // Falta o cambió de tamaño (achicar.mjs lo reemplazó en Hostinger con el mismo nombre y actualizó bytes).
  const items = filas.map((f) => ({ k: clave(f.url), b: Number(f.bytes) })).filter((x) => x.k && enR2.get(x.k) !== x.b);
  const gbFaltan = items.reduce((s, x) => s + (x.b || 0), 0) / 1e9;
  console.log(`Videos: en R2 ${enR2.size}, faltan ${items.length} (~${gbFaltan.toFixed(1)} GB) de ${filas.length} · tope ${TOPE.videos}${NOCHE ? " (noche)" : ""}`);
  await copiarDeHostinger("videos", items.slice(0, TOPE.videos), 300);
}

// ---------- 4) Directos de Instagram → R2 ----------
const tmp = mkdtempSync(join(tmpdir(), "a-r2-"));
async function achicar(b, limpio) {
  // Igual que achicar.mjs / motor.mjs (480 px, crf 28, 0,8 Mbps, faststart). Si no mejora 15 %, queda el original.
  const entrada = join(tmp, `${limpio}.mp4`);
  const salida = join(tmp, `${limpio}-chico.mp4`);
  writeFileSync(entrada, b);
  try {
    const { stdout } = await ejecutar("ffprobe", ["-v", "error", "-show_entries", "stream=codec_type,width,height", "-of", "json", entrada]);
    const j = JSON.parse(stdout);
    const v = j.streams.find((s) => s.codec_type === "video");
    const audio = j.streams.some((s) => s.codec_type === "audio");
    const escala = Number(v?.width) > Number(v?.height) ? "scale=-2:'trunc(min(480,ih)/2)*2'" : "scale='trunc(min(480,iw)/2)*2':-2";
    await ejecutar("ffmpeg", ["-y", "-v", "error", "-i", entrada, "-vf", escala, "-c:v", "libx264", "-preset", "veryfast", "-crf", "28", "-maxrate", "800k", "-bufsize", "1600k", "-g", "60",
      ...(audio ? ["-c:a", "aac", "-b:a", "96k", "-ac", "2"] : ["-an"]), "-movflags", "+faststart", salida], { timeout: 300_000 });
    const c = readFileSync(salida);
    return c.length > 0 && c.length < b.length * 0.85 ? c : b;
  } catch {
    return b;
  } finally {
    rmSync(entrada, { force: true });
    rmSync(salida, { force: true });
  }
}

if (TOPE.directos > 0 && quedaTiempo()) {
  const MAX_ARCHIVO = 60 * 1024 ** 2;
  const filas = await d1(
    `SELECT p.id, p.restaurante_id, p.media_url, p.portada_url, p.vence_en, coalesce(lp.nivel,'C') AS nivel FROM videos_elegidos e
     JOIN publicaciones p ON p.id = e.publicacion_id LEFT JOIN locales_prioridad lp ON lp.restaurante_id = p.restaurante_id
     WHERE p.tipo = 'video' AND p.plataforma = 'instagram' AND e.publicacion_id NOT LIKE 'tv-%'
       AND (p.oculta = 0 OR p.id IN (SELECT publicacion_id FROM videos_revision WHERE accion = 'pendiente'))
       AND NOT EXISTS (SELECT 1 FROM videos_copia c WHERE c.publicacion_id = p.id)
     -- primero los visibles; después los que esperan revisión (el revisor necesita la copia)
     ORDER BY p.oculta, CASE lp.nivel WHEN 'S' THEN 0 WHEN 'A' THEN 1 WHEN 'B' THEN 2 ELSE 3 END, lp.puntaje DESC, e.orden`,
  );
  const limite = Date.now() + 10 * 60_000;
  const vivo = (p) => p.media_url && p.vence_en && Date.parse(p.vence_en) > limite && p.vence_en < "2099";
  const vivos = filas.filter(vivo);
  const vencidos = new Set(filas.filter((p) => !vivo(p)).map((p) => String(p.restaurante_id)));
  const est = (resumen.directos = { sin_copia: filas.length, link_vivo: vivos.length, copiados: 0, negados_o_vencidos: 0, grandes: 0, errores: 0, mb_antes: 0, mb_despues: 0, corte: "" });
  console.log(`Directos: ${filas.length} elegidos visibles sin copia · ${vivos.length} con link vivo · tope ${TOPE.directos}`);
  let seguidos = 0;
  let i = 0;
  const cola = vivos.slice(0, TOPE.directos);
  async function uno(p) {
    const limpio = String(p.id).replace(/[^\w-]/g, "");
    const r = await fetch(String(p.media_url), { signal: AbortSignal.timeout(120_000) });
    if (r.status === 429) {
      est.corte = "Instagram 429: freno, sigue la próxima corrida";
      return;
    }
    if (r.status === 403 || r.status === 404 || r.status === 410) {
      // Link vencido o negado: no se rodea; queda para el lector de anonyig.
      await r.body?.cancel();
      est.negados_o_vencidos++;
      vencidos.add(String(p.restaurante_id));
      return;
    }
    if (!r.ok) throw new Error(`Instagram ${r.status}`);
    const b = Buffer.from(await r.arrayBuffer());
    if (b.length > MAX_ARCHIVO) {
      est.grandes++;
      return;
    }
    const final = await achicar(b, limpio);
    const k = `videos-ig/${limpio}.mp4`;
    await subirR2(k, final, "video/mp4");
    if (p.portada_url) {
      const img = await fetch(String(p.portada_url), { signal: AbortSignal.timeout(20_000) })
        .then((x) => (x.ok && x.headers.get("content-type")?.startsWith("image/") ? x.arrayBuffer() : null))
        .catch(() => null);
      if (img) {
        const jpg = Buffer.from(img);
        for (const n of [`portadas-ig/${limpio}.jpg`, `portadas-ig/${limpio}-160.jpg`]) {
          await subirR2(n, jpg, "image/jpeg").catch(() => null);
          await subirHostinger(n, jpg).catch(() => null);
        }
      }
    }
    await d1(
      "INSERT INTO videos_copia (publicacion_id, restaurante_id, url, bytes, copiado_en) VALUES (?, ?, ?, ?, ?) ON CONFLICT (publicacion_id) DO UPDATE SET url = excluded.url, bytes = excluded.bytes, copiado_en = excluded.copiado_en",
      [p.id, p.restaurante_id, MEDIA + k, final.length, new Date().toISOString()],
    );
    est.copiados++;
    est.mb_antes += b.length / 1024 ** 2;
    est.mb_despues += final.length / 1024 ** 2;
  }
  await Promise.all(
    Array.from({ length: Math.min(2, cola.length) }, async () => {
      while (i < cola.length && !est.corte && quedaTiempo()) {
        const p = cola[i++];
        try {
          await uno(p);
          seguidos = 0;
        } catch (e) {
          est.errores++;
          console.log(`  error ${p.id}: ${e instanceof Error ? e.message : e}`);
          if (++seguidos >= 3) est.corte = "3 errores seguidos (regla de operación)";
        }
        if (est.copiados && est.copiados % 50 === 0) console.log(`  directos: ${est.copiados} copiados · ${Math.round((Date.now() - t0) / 60000)} min`);
        await espera(500);
      }
    }),
  );
  est.mb_antes = Math.round(est.mb_antes);
  est.mb_despues = Math.round(est.mb_despues);
  est.restaurantes_para_anonyig = vencidos.size;
  // Marca para el lector de anonyig (los comercios con videos elegidos cuyo link venció o Instagram negó).
  await d1("INSERT INTO ia_config (clave, valor, actualizado_en) VALUES (?, ?, ?) ON CONFLICT (clave) DO UPDATE SET valor = excluded.valor, actualizado_en = excluded.actualizado_en", [
    "r2_directos_vencidos",
    JSON.stringify({ en: new Date().toISOString(), restaurantes: [...vencidos] }),
    new Date().toISOString(),
  ]);
  console.log(`directos: ${JSON.stringify(est)}`);
}
rmSync(tmp, { recursive: true, force: true });
console.log(`\nListo en ${Math.round((Date.now() - t0) / 60000)} min: ${JSON.stringify(resumen)}`);
