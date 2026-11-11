/*
 * LE FIL · repérage des infos majeures et des sujets suivis, commun à la page et au serveur
 * -----------------------------------------------------------------------------------------
 * Sans IA. Regroupement des titres qui parlent du même événement (mots en commun, pondérés par leur
 * rareté sur 48 h), puis sélection : repris par N médias différents en 3 h (réglage « seuil » de la page),
 * ou 4 médias dont 2 emploient un mot grave, ou titré ALERTE/URGENT par 2 médias, ou à la une de
 * 3 rédactions (pages d'accueil de Le Monde, franceinfo, L'Express, L'Obs, 20 Minutes).
 *
 * La zone <partage> est le code de la page (public/index.html) : outils/construire.py l'y recopie,
 * si bien que la vue « Infos majeures » et les notifications du serveur décident toujours pareil.
 */
export const norm = s => (s || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/œ/g, "oe").replace(/æ/g, "ae");
export const tkey = s => norm(s).replace(/[^a-z0-9 ]/g, "").replace(/\s+/g, " ").trim().slice(0, 140);
export const escRe = s => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// <partage> — début du code commun : outils/construire.py le recopie tel quel dans public/index.html.
// Ne pas y utiliser de nom déjà pris par la page.
const HOT_WINDOW = 3 * 3600e3, BASE_WINDOW = 24 * 3600e3, MEMOIRE_ANALYSE = 48 * 3600e3;
const UNE_TOP = 3;
const STOP = new Set(("les des une uns du de la le et en au aux pour par sur dans avec sans sous vers chez plus moins tres tout tous toute toutes son ses sa leur leurs nos notre vos votre mon mes ton tes cet cette ces qui que quoi dont mais donc car pas ete etre avoir avait fait faire font peut doit selon apres avant depuis pendant contre entre ainsi alors aussi encore deja jamais toujours comment pourquoi quand quel quelle quels quelles direct video photo info exclusif live replay podcast chronique edito tribune analyse entretien interview recit temoignage reportage carte graphique quiz annee jour semaine mois heure lundi mardi mercredi jeudi vendredi samedi dimanche janvier fevrier mars avril juin juillet aout septembre octobre novembre decembre franceinfo figaro parisien liberation euronews france24 the and for with from that this what how why into over after will say said about more than have has are was were their been his her they you our your not but can who when where which would could should one two three premier premiere deux trois nouveau nouvelle grand grande gros fin debut hier aujourd demain soir matin veut face fois cela ceci elle ils elles nous etait sera seront selon voici voila faut ancien ancienne dont suivez suivre")
  .split(" "));
const GRAVE = /\b(attentats?|attaques? terroristes?|terroris\w*|fusillades?|tueries?|explosions?|prises? d.otages?|seismes?|tremblements? de terre|tsunamis?|eruptions?|ouragans?|cyclones?|typhons?|crash|catastrophe aerienne|deraill\w*|effondrements?|assassin\w*|coup d.etat|etat d.urgence|vigilance rouge|alerte rouge|plan blanc|demission\w*|dissolution|censure adoptee|gouvernement renverse|est morte?|est decedee?|deces|mort de|meurt|s.est eteinte?|necrologie|cessez-le-feu|invasion|attaque nucleaire|pandemie|epidemie|emeutes?|inondations?|disparition de|condamn\w*|requi\w*|prison|emprisonnement|ineligib\w*|relaxe\w*|mise? en examen|garde a vue|perquisition\w*|verdict|coupable|ecroue\w*|inculpe\w*|limoge\w*|remaniement|antisemit\w*|agressions? sexuelles?|viols?|corruption|detournements? de fonds|emplois? fictifs?|financement illegal|enquete ouverte|ouvre une enquete|ouverture d.une enquete)\b/;
// Titres d'attente (« réquisitions attendues », « suivez… ») : le mot grave n'y décrit pas un fait accompli.
const ANTICIP = /\b(attendue?s?|avant les?|avant la|suivez|a quoi s.attendre|ce qu.il faut savoir|pourrai(t|ent)|risque(nt)?)\b/;
const URGENT_STRICT = s => /^\s*(ALERTE|URGENT|FLASH|BREAKING)\b/.test(s) || /^\s*(alerte info|flash info|breaking news)\b/i.test(s);

function wordsOf(title) {
  const out = [];
  for (let w of norm(title).replace(/[^a-z0-9]+/g, " ").split(" ")) {
    if (w.length < 4 || STOP.has(w) || /^\d+$/.test(w)) continue;
    if (w.length > 5) w = w.slice(0, 5);                  // requis, requiert, réquisitions -> « requi »
    if (!out.includes(w)) out.push(w);
    if (out.length >= 12) break;
  }
  return out;
}
/* Mots écrits avec une majuscule en milieu de titre (noms propres), hors début de phrase. */
function capsOf(title) {
  const caps = new Set();
  const toks = title.normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[’']/g, " ").split(/\s+/);
  for (let i = 1; i < toks.length; i++) {
    if (/[:.!?«"“(]$/.test(toks[i - 1])) continue;
    const w = toks[i].replace(/^[^A-Za-z0-9]+/, "");
    if (!/^[A-Z]/.test(w)) continue;
    let k = w.toLowerCase().replace(/[^a-z0-9].*$/, "");
    if (k.length < 4 || STOP.has(k)) continue;
    caps.add(k.length > 5 ? k.slice(0, 5) : k);
  }
  return caps;
}

/* Clé d'un article d'après son lien (sans paramètres de suivi), comme la page. */
const cleLien = l => "u:" + String(l || "").replace(/[?#].*$/, "").replace(/\/$/, "");

/* Infos majeures des dernières 24 h, les plus importantes d'abord (au plus prefs.majCap).
   items : dépêches {t, src, title, nt, words, caps, link, bulk, spe, une?} ;
   opts.unes : Map (lien sans paramètres -> Set des rédactions qui l'ont en page d'accueil) ;
   opts.uneRank : rang « À la une » de Google d'une dépêche (Infinity si inconnu).
   Renvoie {events, idf, clusters}. */
function analyser(items, prefs, now, opts = {}) {
  const uneRank = opts.uneRank || (() => Infinity), unes = opts.unes || new Map();
  const sim = opts.sim || 0.28, merge = opts.merge || 0.4;
  const majMin = prefs.majMin || 6, majCap = prefs.majCap || 10;
  const ignore = sig => (prefs.ignSig || []).some(s => now - s.at < 7 * 864e5 && s.w.filter(w => sig.includes(w)).length >= 2);
  const minT = now - MEMOIRE_ANALYSE, flagFrom = now - BASE_WINDOW;
  // Rareté des mots sur 48 h : « Bardella » ou « Mediapart » pèsent plus que « plainte » ou « France ».
  // La presse vélo spécialisée reste en dehors : elle a sa propre vue.
  const df = new Map(); let N = 0;
  for (const it of items) { if (it.t < minT || it.spe) continue; N++; for (const w of it.words) df.set(w, (df.get(w) || 0) + 1); }
  const idf = new Map();
  for (const [w, c] of df) idf.set(w, Math.log((N + 1) / (c + 1)));
  // Prénoms et mots « collés » : un mot presque toujours suivi du même autre (« Emmanuel » -> « Macron »)
  // n'apporte rien de plus et doublerait le poids d'un nom. On ne garde que le second.
  const follow = new Map(), capN = new Map();
  for (const it of items) {
    if (it.t < minT || it.spe) continue;
    for (const w of it.caps) capN.set(w, (capN.get(w) || 0) + 1);
    for (let i = 0; i + 1 < it.words.length; i++) {
      const a = it.words[i], b = it.words[i + 1];
      let m = follow.get(a); if (!m) follow.set(a, m = new Map());
      m.set(b, (m.get(b) || 0) + 1);
    }
  }
  const isName = w => (capN.get(w) || 0) >= 0.6 * (df.get(w) || 1);
  for (const [a, m] of follow) {
    const c = df.get(a) || 0;
    if (c < 3 || !isName(a)) continue;
    const [b, n] = [...m.entries()].sort((x, y) => y[1] - x[1])[0];
    if (n / c >= 0.7 && isName(b)) idf.set(a, 0);        // prénom presque toujours suivi du même nom
  }
  // Regroupement chronologique autour de noyaux. Un index mot -> noyaux qui le contiennent évite de
  // comparer chaque dépêche à tous les noyaux : seuls ceux qui partagent un mot avec elle peuvent lui ressembler.
  const pool = items.filter(it => it.t >= flagFrom && !it.spe).sort((a, b) => a.t - b.t);
  const clusters = [], parMot = new Map();
  const indexer = (k, w) => { let l = parMot.get(w); if (!l) parMot.set(w, l = []); l.push(k); };
  for (const it of pool) {
    const vec = []; let nn = 0;
    for (const w of it.words) { const v = idf.get(w) || 0; if (v > 0.5) { vec.push([w, v]); nn += v * v; } }
    if (!vec.length) continue;
    nn = Math.sqrt(nn);
    let best = null, bestS = 0, bestK = -1;
    const vus = new Set();
    for (const [w0] of vec) for (const k of parMot.get(w0) || []) {
      if (vus.has(k)) continue;
      vus.add(k);
      const c = clusters[k];
      if (it.t - c.last > 12 * 3600e3) continue;
      let dot = 0;
      for (const [w, v] of vec) { const cw = c.cen.get(w); if (cw) dot += v * cw; }
      if (!dot) continue;
      const sim = dot / (nn * c.norm);
      if (sim > bestS || (sim === bestS && k < bestK)) { bestS = sim; best = c; bestK = k; }   // à égalité, le plus ancien noyau
    }
    if (best && bestS >= sim) {
      best.items.push(it); best.last = it.t;
      for (const [w, v] of vec) { if (!best.cen.has(w)) indexer(bestK, w); best.cen.set(w, (best.cen.get(w) || 0) + v / nn); }
      let s2 = 0; for (const x of best.cen.values()) s2 += x * x;
      best.norm = Math.sqrt(s2);
    } else {
      const k = clusters.length;
      clusters.push({items: [it], cen: new Map(vec.map(([w, v]) => [w, v / nn])), norm: 1, last: it.t});
      for (const [w] of vec) indexer(k, w);
    }
  }
  // Deuxième passe : deux événements dont les noyaux se ressemblent fortement sont le même sujet
  // vu sous deux angles (« Bardella dément » et « la campagne de Marine Le Pen percutée »).
  // Même astuce : seuls les noyaux qui partagent un mot avec A (au fil des fusions) sont comparés.
  clusters.sort((a, b) => b.items.length - a.items.length);
  const ou = new Map();
  clusters.forEach((c, k) => { for (const w of c.cen.keys()) { let l = ou.get(w); if (!l) ou.set(w, l = []); l.push(k); } });
  const cand = new Uint8Array(clusters.length);
  const marquer = (mots, apres) => { for (const w of mots) for (const k of ou.get(w) || []) if (k > apres) cand[k] = 1; };
  for (let i = 0; i < clusters.length; i++) {
    const A = clusters[i]; if (!A || A.items.length < 2) continue;
    cand.fill(0); marquer(A.cen.keys(), i);
    for (let j = i + 1; j < clusters.length; j++) {
      if (!cand[j]) continue;
      const B = clusters[j]; if (!B) continue;
      let dot = 0;
      for (const [w, v] of B.cen) { const x = A.cen.get(w); if (x) dot += v * x; }
      if (dot / (A.norm * B.norm) < merge) continue;
      A.items.push(...B.items); A.last = Math.max(A.last, B.last);
      for (const [w, v] of B.cen) A.cen.set(w, (A.cen.get(w) || 0) + v);
      let s2 = 0; for (const x of A.cen.values()) s2 += x * x;
      A.norm = Math.sqrt(s2);
      clusters[j] = null;
      marquer(B.cen.keys(), j);
    }
  }
  for (let i = clusters.length - 1; i >= 0; i--) if (!clusters[i]) clusters.splice(i, 1);
  // Un article isolé mais « À la une » (souvent un direct au titre fourre-tout) rejoint l'événement
  // le plus proche s'il y en a un, plutôt que d'apparaître comme une info majeure de plus.
  for (let i = clusters.length - 1; i >= 0; i--) {
    const B = clusters[i];
    if (B.items.length !== 1 || uneRank(B.items[0], now) > 10) continue;
    let best = null, bestS = 0;
    for (const A of clusters) {
      if (A === B || A.items.length < 3 || Math.abs(A.last - B.last) > 12 * 3600e3) continue;
      let dot = 0;
      for (const [w, v] of B.cen) { const x = A.cen.get(w); if (x) dot += v * x; }
      const sim = dot / (A.norm * B.norm);
      if (sim > bestS) { bestS = sim; best = A; }
    }
    if (best && bestS >= 0.15) {
      best.items.push(...B.items); best.last = Math.max(best.last, B.last);
      clusters.splice(i, 1);
    }
  }
  // Évaluation de chaque événement.
  const evs = [];
  for (const c of clusters) {
    const list = c.items;
    const une = Math.min(...list.map(i => uneRank(i, now)));
    if (list.length < 2 && une > UNE_TOP) continue;
    const media = new Set(list.map(i => i.src));
    const chrono = list.filter(i => !i.bulk).sort((a, b) => a.t - b.t), win = new Map();
    let peak = 0;
    for (let hi = 0, lo = 0; hi < chrono.length; hi++) {
      win.set(chrono[hi].src, (win.get(chrono[hi].src) || 0) + 1);
      while (chrono[lo].t < chrono[hi].t - HOT_WINDOW) {
        const k = chrono[lo].src, n = win.get(k) - 1;
        if (n) win.set(k, n); else win.delete(k);
        lo++;
      }
      if (win.size > peak) peak = win.size;
    }
    // « À la une » : nombre de rédactions qui mettent ce sujet sur leur page d'accueil en ce moment
    const pagesUne = new Set();
    for (const i of list) { const s = unes.get(cleLien(i.link)); if (s) for (const m of s) pagesUne.add(m); }
    const graveMedia = new Set(list.filter(i => GRAVE.test(i.nt) && !ANTICIP.test(i.nt)).map(i => i.src));
    const urgent = list.some(i => URGENT_STRICT(i.title));
    const ok = une <= UNE_TOP || peak >= majMin || (graveMedia.size >= 2 && peak >= 4)
      || (urgent && media.size >= 2) || (une <= 10 && peak >= 3)
      || (pagesUne.size >= 3 && media.size >= 3);
    if (!ok) continue;
    const top = [...c.cen.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6).map(e => e[0]);
    const sig = top.slice(0, 3);
    if (ignore(sig)) continue;
    const uneList = list.reduce((best, i) => i.une && (i.une.list || []).length > best.length ? i.une.list : best, []);
    for (const x of uneList) if (x.src) media.add(x.src);
    const why = [];
    if (une <= 10) why.push(`${une === 1 ? "1er" : une + "e"} sujet à la une de Google Actualités`);
    if (peak >= 3) why.push(`${peak} médias en moins de 3 h`);
    if (pagesUne.size >= 2) why.push(`à la une de ${pagesUne.size} rédactions`);
    if (graveMedia.size >= 2) why.push("fait grave");
    if (urgent) why.push("titre ALERTE ou URGENT");
    list.sort((a, b) => b.t - a.t);
    // Point de départ : parmi les toutes premières dépêches (3 h après la première), celle qui résume
    // le mieux l'événement ; la toute première est parfois un article d'annonce trop vague.
    const simTo = i => {
      let dot = 0, nn = 0;
      for (const w of i.words) { const v = idf.get(w) || 0; if (v > 0.5) { nn += v * v; const cw = c.cen.get(w); if (cw) dot += v * cw; } }
      return nn ? dot / (Math.sqrt(nn) * c.norm) : 0;
    };
    const early = chrono.filter(i => i.t <= chrono[0].t + HOT_WINDOW).slice(0, 4);
    const origin = early.sort((a, b) => simTo(b) - simTo(a) || a.t - b.t)[0] || list[list.length - 1];
    // Dernier développement : la dépêche la plus récente dont l'heure est fiable.
    const latest = list.find(i => !i.bulk) || list[0];
    evs.push({items: list, media, n: media.size, peak, urgent, une, uneList, why, sig, top, grave: graveMedia.size >= 2,
      unes: pagesUne.size, unesNoms: [...pagesUne],
      rep: latest, origin, first: chrono.length ? chrono[0].t : origin.t, last: latest.t});
  }
  // Classement : ampleur de la reprise, avec un bonus pour la gravité et la présence « à la une ».
  const score = ev => ev.peak + (ev.grave ? 3 : 0) + (ev.urgent ? 5 : 0) + (ev.une <= 10 ? (11 - ev.une) * 0.7 : 0)
    + (ev.unes >= 2 ? ev.unes * 1.5 : 0);
  evs.sort((a, b) => score(b) - score(a) || b.n - a.n || b.last - a.last);
  return {events: evs.slice(0, majCap), idf, clusters};
}

/* Sujets suivis : mots d'un groupe tous présents (pluriels et féminins acceptés, « mot* » pour tout début de mot). */
function termRe(tok) {
  const star = tok.endsWith("*");
  const parts = norm(tok.replace(/\*+$/, "")).split(/[^a-z0-9]+/).filter(Boolean);
  if (!parts.length || (parts.length === 1 && parts[0].length < 2)) return null;
  // Pluriels et féminins acceptés (retraite -> retraites, condamné -> condamnée) ; l'étoile prend tout début de mot.
  return new RegExp("(^|[^a-z0-9])" + parts.map(escRe).join("[^a-z0-9]+") + (star ? "" : "(e?s|x|e)?(?=[^a-z0-9]|$)"));
}
const splitToks = alt => alt.match(/"[^"]+"|«[^»]+»|[^\s"«»]+/g) || [];
const unquote = t => t.replace(/^["«]\s*|\s*["»]$/g, "");
function parseTerms(q) {
  return String(q || "").split(/[,;\n]+/).map(alt => splitToks(alt).map(t => termRe(unquote(t))).filter(Boolean)).filter(a => a.length);
}
const matchAlts = (alts, text) => alts.some(a => a.every(re => re.test(text)));
// Google cherche aussi dans le corps des articles : on exige au moins la moitié des mots d'un groupe dans le titre.
const looseAlts = (alts, text) => alts.some(a => a.filter(re => re.test(text)).length >= Math.ceil(a.length / 2));
// </partage>

/* ---------- Côté serveur seulement ---------- */
const ENTITES = {amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", rsquo: "’", lsquo: "‘", rdquo: "”", ldquo: "“",
  laquo: "«", raquo: "»", hellip: "…", ndash: "–", mdash: "—", eacute: "é", egrave: "è", ecirc: "ê", agrave: "à", ccedil: "ç",
  ocirc: "ô", icirc: "î", ucirc: "û", euml: "ë", iuml: "ï", oelig: "œ", Eacute: "É", Agrave: "À"};
const entites = s => s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, n) => n[0] === "#"
  ? (() => { try { return String.fromCodePoint(n[1].toLowerCase() === "x" ? parseInt(n.slice(2), 16) : +n.slice(1)); } catch (e) { return m; } })()
  : (ENTITES[n] ?? m));

/* Dépêche telle que la voit la détection, à partir d'une entrée du Releveur (e) et de son flux (f). */
export function versItem(f, e) {
  if (!f || f.une || !e || !e.t || !e.l) return null;
  let title = entites(e.t).replace(/\s+/g, " ").trim();
  const so = e.so ? entites(e.so).trim() : "";
  if (f.g && so && title.endsWith(" - " + so)) title = title.slice(0, -(so.length + 3)).trim();
  let src = f.n, lang = f.l;
  if (f.sites) {
    let host = ""; try { host = new URL(e.su || "").hostname.replace(/^www\./, ""); } catch (err) {}
    const m = Object.entries(f.sites).find(([d]) => host && (host === d.split("/")[0] || host.endsWith("." + d.split("/")[0])));
    src = m ? m[1].n : (so || f.n);
    if (m) lang = m[1].l;
  }
  // Heure : celle du flux si elle est plausible, sinon l'heure où le serveur a vu la dépêche
  const v = e.v || Date.now();
  let t = Number.isFinite(e.d) && e.d <= v + 60e3 && e.d > v - MEMOIRE_ANALYSE ? e.d : (e.b ? NaN : v);
  if (!Number.isFinite(t)) return null;
  const sum = e.s ? entites(e.s).replace(/\s+/g, " ").trim() : "";
  return {t, title, link: e.l, src, lang, nt: norm(title), n: norm(title + " " + sum), words: wordsOf(title), caps: capsOf(title),
    spe: f.v === "velo", id: "t:" + tkey(title), ku: "u:" + e.l.replace(/[?#].*$/, "").replace(/\/$/, ""), bulk: false, fl: f.n};
}

/* Un média qui date 5 dépêches ou plus de la même minute les a republiées d'un bloc : ces heures-là
   ne disent pas quand chaque article est sorti (mêmes règles que la page). */
export function marquerLots(items) {
  const per = new Map();
  for (const it of items) { const k = it.src + "|" + Math.floor(it.t / 60e3); per.set(k, (per.get(k) || 0) + 1); }
  for (const it of items) it.bulk = per.get(it.src + "|" + Math.floor(it.t / 60e3)) >= 5;
}

export {HOT_WINDOW, BASE_WINDOW, MEMOIRE_ANALYSE, STOP, GRAVE, URGENT_STRICT, wordsOf, capsOf, cleLien, analyser, termRe, parseTerms, matchAlts, looseAlts};
