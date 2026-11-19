// Salida temprana de procesar-subida.yml (19/11): ¿hay algo para procesar? UNA consulta por el índice subidas_estado
// (estado, creado_en) de tenedor-app: alguna «recibida», o alguna «procesando» trabada de más de 1 h (procesar-subida.mjs
// la devuelve a la cola). Sin dependencias (fetch de Node): corre antes de instalar nada, así el schedule cada 10 min
// cuesta segundos cuando la cola está vacía. Si D1 no contesta, dice que sí (mejor una corrida de más que una subida
// trabada). R4 (repo público): no imprime ids ni datos, sólo «hay=0/1».
import { appendFileSync } from "node:fs";

const env = process.env;
const haceUnaHora = new Date(Date.now() - 60 * 60_000).toISOString();
let hay = 1;
try {
  const r = await fetch(`https://api.cloudflare.com/client/v4/accounts/${env.CLOUDFLARE_ACCOUNT_ID}/d1/database/${env.D1_APP_ID}/query`, {
    method: "POST",
    headers: { authorization: `Bearer ${env.CLOUDFLARE_API_TOKEN}`, "content-type": "application/json" },
    body: JSON.stringify({
      sql: "SELECT EXISTS (SELECT 1 FROM subidas WHERE estado = 'recibida') OR EXISTS (SELECT 1 FROM subidas WHERE estado = 'procesando' AND actualizado_en < ?) AS hay",
      params: [haceUnaHora],
    }),
    signal: AbortSignal.timeout(20_000),
  });
  const j = await r.json();
  if (r.ok && j?.success) hay = Number(j.result?.[0]?.results?.[0]?.hay ?? 1) ? 1 : 0;
  else console.log(`hay-subidas: D1 ${r.status}, se procesa por las dudas`);
} catch {
  console.log("hay-subidas: D1 no contestó, se procesa por las dudas");
}
console.log(`hay-subidas: hay=${hay}`);
if (env.GITHUB_OUTPUT) appendFileSync(env.GITHUB_OUTPUT, `hay=${hay}\n`);
