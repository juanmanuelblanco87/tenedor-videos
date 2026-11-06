// Prueba (sólo lee): fuentes gratis de links de videos de comercios S/A, desde GitHub (nunca la red del dueño).
// Bing y DuckDuckGo (HTML, sin clave) con «instagram.com/reel <cuenta>», y perfiles de TikTok con yt-dlp. Cuenta links
// de la cuenta por consulta y si la fuente bloquea (corta a los 3 bloqueos seguidos de cada fuente). No escribe nada.
import { execFile } from "node:child_process";
import { promisify } from "node:util";
const ejecutar = promisify(execFile);
const env = process.env;
const N = Number(process.argv[2] ?? 10);
async function d1(sql) {
  const r = await fetch(`https://api.cloudflare.com/client/v4/accounts/${env.CLOUDFLARE_ACCOUNT_ID}/d1/database/${env.D1_APP_ID}/query`, {
    method: "POST",
    headers: { authorization: `Bearer ${env.CLOUDFLARE_API_TOKEN}`, "content-type": "application/json" },
    body: JSON.stringify({ sql }),
  });
  const j = await r.json();
  if (!j.success) throw new Error(JSON.stringify(j.errors));
  return j.result[0].results;
}
const filas = await d1(`SELECT lower(ltrim(r.instagram,'@')) AS ig, lower(ltrim(coalesce(r.tiktok,''),'@')) AS tt FROM restaurantes r JOIN locales_prioridad lp ON lp.restaurante_id = r.id
  WHERE lp.nivel IN ('S','A') AND coalesce(r.instagram,'') <> '' AND ('${process.argv[3] ?? ""}' <> 'tiktok' OR coalesce(r.tiktok,'') <> '') AND r.estado <> 'cerrado' AND NOT EXISTS (SELECT 1 FROM videos_copia c WHERE c.restaurante_id = r.id)
  ORDER BY random() LIMIT ${Math.min(50, N)}`);
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130 Safari/537.36";
const espera = (ms) => new Promise((x) => setTimeout(x, ms));
const reelsDe = (html, cuenta) => {
  const dec = html.replace(/&amp;/g, "&").replace(/%2F/gi, "/").replace(/%3A/gi, ":");
  const codigos = new Set();
  for (const m of dec.matchAll(/instagram\.com\/(?:([a-z0-9._]+)\/)?reels?\/([A-Za-z0-9_-]{6,})/gi)) if (!m[1] || m[1].toLowerCase() === cuenta) codigos.add(m[2]);
  return codigos.size;
};
const fuentes = {
  bing: async (c) => {
    const r = await fetch(`https://www.bing.com/search?q=${encodeURIComponent(`site:instagram.com/reel ${c}`)}&count=30&setlang=es`, { headers: { "user-agent": UA, "accept-language": "es-AR,es" } });
    return r.ok ? { n: reelsDe(await r.text(), c) } : { bloqueo: r.status };
  },
  ddg: async (c) => {
    if (process.argv[3] === "tiktok") return { n: 0 };
    const r = await fetch(`https://html.duckduckgo.com/html/?q=${encodeURIComponent(`site:instagram.com/reel ${c}`)}`, { headers: { "user-agent": UA } });
    const t = r.ok ? await r.text() : "";
    return r.ok && !/anomaly|captcha/i.test(t) ? { n: reelsDe(t, c) } : { bloqueo: r.status || "captcha" };
  },
};
const tot = {};
for (const k of [...Object.keys(fuentes), "tiktok"]) tot[k] = { conLinks: 0, links: 0, bloqueos: 0, probadas: 0, cortada: false };
for (const f of filas) {
  for (const [k, fn] of Object.entries(fuentes)) {
    const t = tot[k];
    if (t.cortada) continue;
    try {
      const r = await fn(f.ig);
      t.probadas++;
      if (r.bloqueo) {
        if (++t.bloqueos >= 3) t.cortada = true;
        console.log(`${k.padEnd(6)} ${f.ig.slice(0, 4)}… BLOQUEO ${r.bloqueo}`);
      } else {
        t.bloqueos = 0;
        t.links += r.n;
        if (r.n) t.conLinks++;
        console.log(`${k.padEnd(6)} ${f.ig.slice(0, 4)}… ${r.n} reels`);
      }
    } catch (e) {
      console.log(`${k.padEnd(6)} error ${String(e).slice(0, 80)}`);
    }
    await espera(6000);
  }
  if (f.tt && /^[a-z0-9._]{2,30}$/.test(f.tt) && !tot.tiktok.cortada) {
    const t = tot.tiktok;
    t.probadas++;
    try {
      const { stdout } = await ejecutar("yt-dlp", ["-q", "--no-warnings", "--flat-playlist", "--playlist-end", "10", "--print", "url", `https://www.tiktok.com/@${f.tt}`], { timeout: 90_000 });
      const n = stdout.trim().split(/\r?\n/).filter((l) => /\/video\//.test(l)).length;
      t.links += n;
      if (n) t.conLinks++;
      t.bloqueos = 0;
      console.log(`tiktok ${f.tt.slice(0, 4)}… ${n} videos`);
    } catch (e) {
      if (++t.bloqueos >= 3) t.cortada = true;
      console.log(`tiktok ${f.tt.slice(0, 4)}… ERROR ${String(e.stderr ?? e).trim().split("\n").pop()?.slice(0, 120)}`);
    }
    await espera(6000);
  }
}
console.log(`RESULTADO ${JSON.stringify(tot)}`);
