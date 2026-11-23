// node --experimental-strip-types --test promos-clubes-plan.test.mts
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { planClubes } from "./promos-clubes-plan.mts";

const n = (k: number, p = "s") => Array.from({ length: k }, (_, i) => `${p}${String(i).padStart(3, "0")}`);

describe("plan del lector de clubes (bajas y sitemap parcial)", () => {
  it("las conocidas que ya no están en el sitemap se re-leen para confirmar la baja", () => {
    const conocidos = n(30);
    const p = planClubes(conocidos.slice(0, 28).concat(["nueva"]), conocidos, "nuevos");
    assert.deepEqual(p.desaparecidas, ["s028", "s029"]);
    assert.deepEqual(p.leer, ["nueva"]);
    assert.equal(p.parcial, null);
  });
  it("sitemap parcial (< 80 % de las conocidas): ninguna baja, y se avisa", () => {
    const conocidos = n(100);
    const p = planClubes(conocidos.slice(0, 79), conocidos, "completo");
    assert.deepEqual(p.desaparecidas, []);
    assert.deepEqual(p.parcial, { presentes: 79, conocidos: 100 });
    assert.equal(p.leer.length, 79);
  });
  it("«aceptar sitemap» (a mano, vuelta completa): el parcial no frena y las desaparecidas se confirman", () => {
    const conocidos = n(100);
    const p = planClubes(conocidos.slice(0, 79), conocidos, "completo", 400, true);
    assert.equal(p.parcial, null);
    assert.equal(p.desaparecidas.length, 21);
  });
  it("con pocas conocidas (estado recién armado) no se mide el parcial", () => {
    const p = planClubes(["a"], ["a", "b", "c"], "nuevos");
    assert.equal(p.parcial, null);
    assert.deepEqual(p.desaparecidas, ["b", "c"]);
  });
});
