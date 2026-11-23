// Promos de clubes · qué lee el lector en cada vuelta (puro, con test: promos-clubes-plan.test.mts). Roberto r1 (23/11):
// mismo criterio que la lectura diaria de MODO (modo-diario.mjs, planDelDia):
//  - DESAPARECIDAS: fichas de gastronomía que conocíamos y ya no están en el sitemap. Se re-leen para CONFIRMAR la baja
//    (sólo un 404/410 es baja; un 200 con datos vuelve a mandarse como ficha).
//  - SITEMAP PARCIAL: si trae menos del 80 % de los slugs que conocemos, no es que el club los sacó: el sitemap vino
//    cortado. Entonces no se buscan desaparecidas (ni se dan bajas) y se avisa. Con pocos conocidos no se mide.
export const MIN_CONOCIDOS_PARCIAL = 20;

export type Plan = { desaparecidas: string[]; leer: string[]; parcial: { presentes: number; conocidos: number } | null };

/** aceptarSitemap (sólo a mano, vuelta completa): el club achicó el sitemap de verdad → se mide igual y hay bajas. */
export function planClubes(enSitemap: string[], conocidos: string[], modo: "completo" | "nuevos", maxFichas = 400, aceptarSitemap = false): Plan {
  const sitemap = new Set(enSitemap);
  const vistos = new Set(conocidos);
  const presentes = conocidos.filter((s) => sitemap.has(s)).length;
  const parcial = !aceptarSitemap && conocidos.length >= MIN_CONOCIDOS_PARCIAL && presentes < 0.8 * conocidos.length;
  const desaparecidas = parcial ? [] : conocidos.filter((s) => !sitemap.has(s)).sort();
  const leer = (modo === "nuevos" ? enSitemap.filter((s) => !vistos.has(s)) : enSitemap).slice(0, maxFichas);
  return { desaparecidas, leer, parcial: parcial ? { presentes, conocidos: conocidos.length } : null };
}
