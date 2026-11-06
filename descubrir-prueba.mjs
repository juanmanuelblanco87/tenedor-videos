// Prueba (sólo lee): ¿la página pública de perfil de Instagram devuelve las publicaciones recientes (con sus videos)
// sin sesión, desde GitHub? Para el motor que suma links de videos nuevos a la cola (dueño 06/11/2026).
// Toma N cuentas de comercios S/A y cuenta cuántas responden y cuántos videos traen. No escribe nada.
const env = process.env;
const N = Number(process.argv[2] ?? 20);
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
const cuentas = await d1(`SELECT DISTINCT lower(ltrim(r.instagram, '@')) AS u FROM restaurantes r JOIN locales_prioridad lp ON lp.restaurante_id = r.id
  WHERE lp.nivel IN ('S','A') AND coalesce(r.instagram,'') <> '' AND r.estado <> 'cerrado' ORDER BY random() LIMIT ${Math.min(100, N)}`);
let ok = 0, videos = 0, mal = 0, seguidos = 0;
for (const { u } of cuentas) {
  const r = await fetch(`https://i.instagram.com/api/v1/users/web_profile_info/?username=${encodeURIComponent(u)}`, {
    headers: { "x-ig-app-id": "936619743392459", "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130 Safari/537.36", accept: "*/*" },
  }).catch(() => null);
  const j = r?.ok ? await r.json().catch(() => null) : null;
  const ed = j?.data?.user?.edge_owner_to_timeline_media?.edges ?? null;
  if (ed) {
    ok++;
    seguidos = 0;
    const v = ed.filter((e) => e.node?.is_video).length;
    videos += v;
    console.log(`OK   ${u.slice(0, 3)}… ${ed.length} publicaciones, ${v} videos`);
  } else {
    mal++;
    seguidos++;
    console.log(`MAL  ${u.slice(0, 3)}… http ${r?.status ?? "error"}`);
    if (seguidos >= 4) {
      console.log("4 fallos seguidos: corto (posible bloqueo)");
      break;
    }
  }
  await new Promise((x) => setTimeout(x, 4000));
}
console.log(`RESULTADO ok=${ok} mal=${mal} videos=${videos} de ${cuentas.length} cuentas`);
