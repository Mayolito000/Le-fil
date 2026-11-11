// La page et le service worker se chargent sans erreur de syntaxe ; le code commun y est bien recopié.
import {test} from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";

const page = readFileSync(new URL("../public/index.html", import.meta.url), "utf8");

test("script de la page sans erreur de syntaxe", () => {
  const scripts = page.match(/<script>([\s\S]*?)<\/script>/g);
  assert.ok(scripts && scripts.length);
  new Function(scripts[scripts.length - 1].replace(/<\/?script>/g, ""));
});

test("service worker sans erreur de syntaxe", () => {
  new Function(readFileSync(new URL("../public/sw.js", import.meta.url), "utf8"));
});

test("le code commun (src/majeures.js) est recopié dans la page", () => {
  const module = readFileSync(new URL("../src/majeures.js", import.meta.url), "utf8");
  const commun = /^\/\/ <partage>.*?$([\s\S]*?)^\/\/ <\/partage>$/m.exec(module)[1].replace(/^export /gm, "").trim();
  assert.ok(page.includes(commun), "lancer python3 outils/construire.py");
});

test("liste des flux valide : adresses uniques, rangs et pages d'accueil", () => {
  const flux = JSON.parse(readFileSync(new URL("../flux.json", import.meta.url), "utf8"));
  const urls = flux.map(f => f.u);
  assert.equal(new Set(urls).size, urls.length, "flux en double");
  for (const f of flux) {
    assert.match(f.u, /^https:\/\//, f.n);
    assert.ok([1, 2, 3, 4].includes(f.t), f.n);
  }
  assert.ok(flux.filter(f => f.pa).length >= 3, "au moins 3 pages d'accueil");
});

test("chaque flux a une rubrique que la page connaît", () => {
  const flux = JSON.parse(readFileSync(new URL("../flux.json", import.meta.url), "utf8"));
  const rubs = new Set([...JSON.parse(/^const RUBS = (\[.*\]);$/m.exec(page)[1]), "Cyclisme"]);
  for (const f of flux) {
    assert.ok(rubs.has(f.r), `${f.n} : rubrique inconnue « ${f.r} »`);
    for (const s of Object.values(f.sites || {})) assert.ok(rubs.has(s.r), `${s.n} : rubrique inconnue « ${s.r} »`);
    assert.ok(["fr", "en", "es", "it", "de", "nl"].includes(f.l), `${f.n} : langue « ${f.l} »`);
    if (f.q !== undefined) assert.ok(Number.isInteger(f.q) && f.q > 0, `${f.n} : plafond`);
  }
});
