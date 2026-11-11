// Repérage des infos majeures et des sujets suivis (code commun à la page et au serveur).
import {test} from "node:test";
import assert from "node:assert/strict";
import {analyser, wordsOf, capsOf, norm, cleLien, parseTerms, matchAlts, versItem} from "../src/majeures.js";

const NOW = Date.parse("2026-11-11T12:00:00Z");
const item = (src, title, minutes, lien) => ({t: NOW - minutes * 60e3, src, title, nt: norm(title), n: norm(title), words: wordsOf(title), caps: capsOf(title),
  link: lien || `https://${src.replace(/\W/g, "").toLowerCase()}.fr/${encodeURIComponent(title).slice(0, 40)}`, bulk: false, spe: false, id: "t:" + norm(title)});
// Bruit de fond : 60 dépêches sans rapport entre elles (mots tous différents), pour que les mots de l'événement soient rares
const mot = n => "terme" + n.toString(36) + "q";
const FOND = Array.from({length: 60}, (_, i) => item("Média " + (i % 9), `Information ${mot(i)} ${mot(i + 100)} ${mot(i + 200)}`, 30 + i * 10));
const PREFS = {maj: true, majMin: 6, majCap: 10};

test("un séisme repris par 7 médias en 3 h est une info majeure, marquée grave", () => {
  const medias = ["Le Monde", "franceinfo", "Le Figaro", "Libération", "BFMTV", "France 24", "RFI"];
  const evt = medias.map((m, i) => item(m, `Séisme de magnitude 7,4 au Japon : au moins ${20 + i} morts à Kumamoto`, 150 - i * 20));
  const {events} = analyser([...FOND, ...evt], PREFS, NOW);
  assert.equal(events.length, 1);
  assert.equal(events[0].n, 7);
  assert.ok(events[0].peak >= 6);
  assert.ok(events[0].grave);
  assert.match(events[0].why.join(" "), /médias en moins de 3 h/);
});

test("trois médias seulement : majeure seulement si trois rédactions la mettent à la une", () => {
  const evt = ["Le Monde", "L'Express", "20 Minutes"].map((m, i) => item(m, `Budget 2027 : le gouvernement Lecornu engage le 49.3 à l'Assemblée`, 60 - i * 10));
  assert.equal(analyser([...FOND, ...evt], PREFS, NOW).events.length, 0);
  const unes = new Map(evt.map(it => [cleLien(it.link), new Set([it.src])]));
  const {events} = analyser([...FOND, ...evt], PREFS, NOW, {unes});
  assert.equal(events.length, 1);
  assert.equal(events[0].unes, 3);
  assert.match(events[0].why.join(" "), /à la une de 3 rédactions/);
});

test("un sujet ignoré n'est plus annoncé, le seuil est respecté", () => {
  const medias = ["Le Monde", "franceinfo", "Le Figaro", "Libération", "BFMTV"];
  const evt = medias.map((m, i) => item(m, `Grève des contrôleurs aériens : Orly et Roissy paralysés`, 100 - i * 10));
  assert.equal(analyser([...FOND, ...evt], PREFS, NOW).events.length, 0, "5 médias < seuil de 6");
  const {events} = analyser([...FOND, ...evt], {...PREFS, majMin: 5}, NOW);
  assert.equal(events.length, 1);
  const ign = {...PREFS, majMin: 5, ignSig: [{w: events[0].sig, at: NOW - 3600e3}]};
  assert.equal(analyser([...FOND, ...evt], ign, NOW).events.length, 0);
});

test("sujets suivis : tous les mots d'un groupe, pluriels et étoile", () => {
  const alts = parseTerms('procès Sarkozy, "Kamel Daoud", condamn*');
  assert.ok(matchAlts(alts, norm("Le procès de Nicolas Sarkozy reprend")));
  assert.ok(matchAlts(alts, norm("L'écrivain Kamel Daoud condamné")));
  assert.ok(matchAlts(alts, norm("Trois prévenus condamnés à Lyon")));
  assert.ok(!matchAlts(alts, norm("Sarkozy en visite à Lyon")));
});

test("versItem : média d'une requête groupée, heure plausible", () => {
  const f = {n: "Presse (via Google)", g: true, l: "fr", sites: {"lesechos.fr": {n: "Les Échos", r: "Économie", l: "fr"}}};
  const it = versItem(f, {t: "Le CAC 40 recule - Les Échos", l: "https://news.google.com/x", so: "Les Échos", su: "https://www.lesechos.fr", d: NOW - 60e3, v: NOW});
  assert.equal(it.src, "Les Échos");
  assert.equal(it.title, "Le CAC 40 recule");
  assert.equal(it.t, NOW - 60e3);
  assert.equal(versItem({n: "X", l: "fr"}, {t: "Sans date", l: "https://x.fr/a", d: null, b: 1, v: NOW}), null, "sans date au tout premier relevé : écarté");
});
