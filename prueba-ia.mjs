// Compara modelos de visión locales (Ollama) sobre cuadros reales: ¿es gastronómico? Uso: node bench.mjs <modelo> [<modelo>...]
import { readFileSync, readdirSync } from "node:fs";
const dir = "prueba-ia/";
const esperado = { "ig-scDfcXK40utmC": false, "ig-scDc1N5YIAmDb": false, "ig-scDaBQjdKDIvS": false, "ig-scDfZ_Ec9xkOr": false };
const SIS = 'Mirás un cuadro de un video publicado por un comercio gastronómico. Respondé SOLO JSON {"gastro": true|false, "confianza": 0..1, "que": "breve"}. gastro = true si muestra comida, bebida, el local o su fachada, su cocina, gente comiendo, brindando o atendiendo, o un cartel/promo del comercio. false si es algo ajeno (animales, naturaleza, una clase o terapia, noticias, deportes, publicidad de otra marca, bebés, obras en construcción, memes).';
for (const modelo of process.argv.slice(2)) {
  let bien = 0, total = 0, ms = 0;
  for (const f of readdirSync(dir).filter((x) => x.endsWith(".jpg"))) {
    const id = f.replace(/\.jpg$/, "");
    const t0 = Date.now();
    const r = await fetch("http://127.0.0.1:11434/api/chat", { method: "POST", body: JSON.stringify({ model: modelo, stream: false, format: "json", think: false, options: { temperature: 0, num_predict: 80 }, messages: [{ role: "system", content: SIS }, { role: "user", content: "¿Qué muestra?", images: [readFileSync(dir + f).toString("base64")] }] }) }).then((x) => x.json()).catch((e) => ({ error: String(e) }));
    const dt = Date.now() - t0;
    ms += dt;
    let j = {};
    try { j = JSON.parse(r.message?.content ?? "{}"); } catch {}
    const esp = esperado[id] ?? true;
    total++;
    if (j.gastro === esp) bien++;
    console.log(`${modelo} · ${id} · ${j.gastro} (esperado ${esp}) · ${(dt / 1000).toFixed(1)} s · ${String(j.que ?? r.error ?? "").slice(0, 70)}`);
  }
  console.log(`== ${modelo}: ${bien}/${total} bien · ${(ms / total / 1000).toFixed(1)} s por imagen\n`);
}
