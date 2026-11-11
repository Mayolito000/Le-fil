/*
 * LE FIL · Releveur (Durable Object avec base SQLite, offre gratuite de Cloudflare)
 * --------------------------------------------------------------------------------
 * Relève tous les flux de flux.json en continu, même quand aucune page n'est ouverte :
 *   - chaque flux est relu toutes les 30 s à 5 min selon son rang (t), jamais plus souvent que
 *     ce que le média autorise (Cache-Control), et en demandant seulement s'il a changé (ETag) ;
 *   - toute dépêche nouvelle (ou dont le titre change) est gardée 30 jours dans la table « entrees »
 *     (les pages n'en reçoivent que les 48 dernières heures ; les 30 jours servent à la recherche) ;
 *   - elle est aussitôt poussée aux pages ouvertes (WebSocket), qui la montrent dans la seconde ;
 *   - les pages d'accueil des rédactions (flux « pa ») disent quels sujets sont « à la une ».
 * Il prévient aussi les téléphones abonnés (Web Push) : infos majeures, nouveaux articles des sujets
 * suivis et des mots-clés, point du matin à 7 h 30, et panne de la relève (vérifiée toutes les 10 min).
 *
 * Limites de l'offre gratuite respectées : au plus 30 flux par passage (50 sous-requêtes permises),
 * un passage toutes les 10 s au plus, peu d'écritures (on n'écrit que ce qui change).
 */
import {DurableObject} from "cloudflare:workers";
import FLUX from "../flux.json";
import {versItem, marquerLots, analyser, parseTerms, matchAlts, norm, escRe, cleLien} from "./majeures.js";
import {envoyer, endpointValide, nouvellesCles} from "./webpush.js";
import {decoder, lire, empreinte, explique, paris} from "./lecture.js";

const UA = "Mozilla/5.0 (compatible; LeFil/1.0; lecteur RSS personnel)";
const RYTHME = {1: 30e3, 2: 60e3, 3: 120e3, 4: 300e3};   // délai entre deux lectures d'un flux, selon son rang t
const RYTHME_GOOGLE = 600e3;                              // Google Actualités refuse presque toujours : on insiste peu
const MAX_PAR_PASSAGE = 30;
const SIMULTANES = 6;
const PAS_MIN = 10e3;                                     // au plus un passage toutes les 10 s
const GARDE = 48 * 3600e3;                                // ce que reçoivent les pages et ce qu'analyse le repérage
const MEMOIRE = 30 * 864e5;                               // ce que garde la base (recherche)
const MAX_ENTREES = 100;                                  // entrées lues par flux
const PANNE = 30 * 60e3;                                  // relève en panne : rien lu depuis 30 min
const PARMI = new Map(FLUX.map(f => [f.u, f]));

// Variable RELEVE = "non" (version de test au repos) : le Releveur ne relève rien et ne répond pas,
// la page relève alors elle-même les flux. Évite que deux serveurs lisent les mêmes médias en double.
const actif = env => !env || env.RELEVE !== "non";
const rythme = f => f.g ? RYTHME_GOOGLE : (RYTHME[f.t] || 120e3);
const json = (o, status) => new Response(JSON.stringify(o), {status: status || 200, headers: {"content-type": "application/json; charset=utf-8", "cache-control": "no-store"}});
const mediane = a => { if (!a || !a.length) return null; const s = a.slice().sort((x, y) => x - y); return s[s.length >> 1]; };
const nomSource = (f, e) => f ? (f.sites && e.so ? e.so : f.n) : "";
const texteRecherche = (f, e) => norm((e.t || "") + " " + nomSource(f, e));
const pluriel = (n, mot) => `${n} ${mot}${n > 1 ? "s" : ""}`;

export class Releveur extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.cache = new Map();                          // clés connues de chaque flux (copie en mémoire)
    this.signes = new Map();                         // dernier état envoyé de chaque flux (ok / échec)
    this.dernierEnvoi = 0;
    this.aVerifier = [];                             // nouvelles dépêches à comparer aux sujets suivis et mots-clés
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair("ping", "pong"));
    ctx.blockConcurrencyWhile(async () => {
      this.sql.exec("CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT NOT NULL)");
      this.sql.exec("CREATE TABLE IF NOT EXISTS cles (u TEXT PRIMARY KEY, v TEXT NOT NULL)");
      this.sql.exec("CREATE TABLE IF NOT EXISTS entrees (seq INTEGER PRIMARY KEY AUTOINCREMENT, u TEXT NOT NULL, vu INTEGER NOT NULL, l TEXT NOT NULL, d TEXT NOT NULL)");
      this.sql.exec("CREATE TABLE IF NOT EXISTS abonnes (endpoint TEXT PRIMARY KEY, j TEXT NOT NULL)");
      // index sur l'heure de réception : ménage, rattrapage et chargement ne lisent que les lignes utiles
      this.sql.exec("CREATE INDEX IF NOT EXISTS entrees_vu ON entrees(vu)");
      // Version 21 : texte de recherche (titre et média, sans accents) pour chercher sur 30 jours
      const colonnes = this.sql.exec("PRAGMA table_info(entrees)").toArray().map(c => c.name);
      if (!colonnes.includes("n")) {
        this.sql.exec("ALTER TABLE entrees ADD COLUMN n TEXT");
        for (const r of this.sql.exec("SELECT seq, u, d FROM entrees").toArray()) {
          const e = JSON.parse(r.d);
          this.sql.exec("UPDATE entrees SET n = ? WHERE seq = ?", texteRecherche(PARMI.get(r.u), e), r.seq);
        }
      }
      const row = this.sql.exec("SELECT v FROM meta WHERE k = 'etat'").toArray()[0];
      this.etat = row ? JSON.parse(row.v) : {epoch: crypto.randomUUID().slice(0, 8), flux: {}, purge: 0};
      if (!row) this.sauver();
      this.sauve = Date.now();
      if (actif(env) && !(await ctx.storage.getAlarm())) await ctx.storage.setAlarm(Date.now() + 1000);
    });
  }

  sauver() { this.sql.exec("INSERT OR REPLACE INTO meta (k, v) VALUES ('etat', ?)", JSON.stringify(this.etat)); }
  st(u) { return this.etat.flux[u] || (this.etat.flux[u] = {n: 0, st: "wait", fails: 0}); }
  // Dépêches déjà vues d'un flux : clé « lien + titre » (certains flux, comme L'Équipe, donnent le même
  // lien à plusieurs articles ; un titre qui change sur le même lien compte comme une nouveauté).
  cles(u) {
    if (!this.cache.has(u)) {
      const row = this.sql.exec("SELECT v FROM cles WHERE u = ?", u).toArray()[0];
      const c = row ? JSON.parse(row.v) : {k: {}, snap: null};
      for (const [k, x] of Object.entries(c.k)) if (typeof x[0] === "string") { delete c.k[k]; c.k[k + "\n" + x[0]] = [x[1]]; }   // ancien format (clé = lien)
      this.cache.set(u, c);
    }
    return this.cache.get(u);
  }
  seqMax() { return (this.sql.exec("SELECT COALESCE(MAX(seq), 0) AS m FROM entrees").toArray()[0] || {m: 0}).m; }
  etats(liste) {
    const out = {};
    for (const u of liste || Object.keys(this.etat.flux)) {
      const s = this.etat.flux[u]; if (!s || !PARMI.has(u)) continue;
      out[u] = {st: s.st, at: s.at || 0, err: s.err || "", cnt: s.cnt || 0, iv: Math.max(rythme(PARMI.get(u)), s.ma || 0), dm: mediane(s.dl)};
    }
    return out;
  }
  // Pages d'accueil des rédactions : liens qu'elles mettent en avant en ce moment
  pagesUne(liste) {
    const out = {};
    for (const f of FLUX) if (f.pa && (!liste || liste.includes(f.u))) { const s = this.etat.flux[f.u]; if (s && s.pa) out[f.u] = s.pa; }
    return out;
  }
  unes() {
    const m = new Map();
    for (const f of FLUX) {
      const s = this.etat.flux[f.u];
      if (!f.pa || !s || !s.pa || s.st !== "ok") continue;
      for (const l of s.pa) { const k = cleLien(l); if (!m.has(k)) m.set(k, new Set()); m.get(k).add(f.n); }
    }
    return m;
  }

  /* ---------- Un passage : lit les flux arrivés à échéance ---------- */
  async alarm() {
    if (!actif(this.env)) return;                    // au repos : on ne reprogramme rien
    try { await this.passage(); }
    catch (e) { console.error("passage", e && e.stack || String(e)); }
    finally {
      const now = Date.now(), prochain = Math.min(...FLUX.map(f => this.st(f.u).n || 0));
      await this.ctx.storage.setAlarm(Math.max(now + PAS_MIN, Math.min(prochain, now + 60e3)));
    }
  }

  async passage() {
    const now = Date.now();
    this.etat.dernierPassage = now;
    const dus = FLUX.filter(f => (this.st(f.u).n || 0) <= now)
      .sort((a, b) => (this.st(a.u).n || 0) - (this.st(b.u).n || 0)).slice(0, MAX_PAR_PASSAGE);
    const nouv = [], snaps = {}, pa = {}, lus = [];
    let i = 0;
    const travailleur = async () => { while (i < dus.length) { const f = dus[i++]; lus.push(f.u); await this.relever(f, nouv, snaps, pa); } };
    await Promise.all(Array.from({length: SIMULTANES}, travailleur));
    let seq = 0;
    if (nouv.length) {
      for (const [u, e] of nouv) this.sql.exec("INSERT INTO entrees (u, vu, l, d, n) VALUES (?, ?, ?, ?, ?)", u, e.v, e.l, JSON.stringify(e), texteRecherche(PARMI.get(u), e));
      seq = this.seqMax();
      if (this.items) for (const [u, e] of nouv) this.ajouterItem(u, e);
      for (const [u, e] of nouv) if (!e.b) { const it = versItem(PARMI.get(u), e); if (it && now - it.t < 3 * 3600e3) this.aVerifier.push(it); }
      if (this.aVerifier.length > 500) this.aVerifier.splice(0, this.aVerifier.length - 500);
      this.aAnalyser = true;
    }
    if (Object.keys(pa).length) this.aAnalyser = true;
    // Infos majeures, sujets suivis, mots-clés : au plus une analyse par minute, et seulement s'il y a du nouveau
    if (this.aAnalyser && now - (this.derniereAnalyse || 0) >= 60e3) {
      this.aAnalyser = false; this.derniereAnalyse = now;
      try { await this.infosMajeures(now); } catch (e) { console.error("infos majeures", e && e.stack || String(e)); }
    }
    try { await this.pointDuMatin(now); } catch (e) { console.error("point du matin", e && e.stack || String(e)); }
    if (now - (this.etat.purge || 0) > 3600e3) {        // une fois par heure : on oublie ce qui a plus de 30 jours
      this.sql.exec("DELETE FROM entrees WHERE vu < ?", now - MEMOIRE);
      for (const u of Object.keys(this.etat.flux)) if (!PARMI.has(u)) delete this.etat.flux[u];   // flux retirés de la liste
      this.etat.purge = now;
    }
    // L'état des flux (échéances, empreintes) n'est enregistré que toutes les 5 minutes : la limite gratuite
    // compte les écritures, et perdre quelques minutes d'état ne fait que relire les flux une fois de plus.
    if (now - this.sauve > 300e3) { this.sauver(); this.sauve = now; }
    if (!lus.length) return;
    // On n'écrit aux pages ouvertes que s'il y a du nouveau (dépêches, pages d'accueil, ou un flux qui tombe
    // ou revient), et sinon au plus toutes les 2 minutes : batterie et forfait du téléphone ménagés.
    const bascules = lus.filter(u => { const x = this.etat.flux[u], sig = x.st + "|" + (x.err || ""); const avant = this.signes.get(u); this.signes.set(u, sig); return avant !== sig; });
    if (!nouv.length && !Object.keys(snaps).length && !Object.keys(pa).length && !bascules.length && now - this.dernierEnvoi < 120e3) return;
    this.dernierEnvoi = now;
    const msg = {type: "nouv", epoch: this.etat.epoch, seq: seq || this.seqMax(), nouv, snaps, pa, flux: this.etats(lus), passe: now};
    const texte = JSON.stringify(msg);
    for (const ws of this.ctx.getWebSockets()) { try { ws.send(texte); } catch (e) {} }
  }

  async relever(f, nouv, snaps, pa) {
    const s = this.st(f.u), iv = rythme(f), debut = Date.now();
    try {
      const h = {"user-agent": UA, "accept": "application/rss+xml, application/atom+xml, application/xml;q=0.9, text/xml;q=0.9, */*;q=0.5",
        "accept-language": "fr-FR,fr;q=0.9,en;q=0.6"};
      if (s.et) h["if-none-match"] = s.et;
      if (s.lm) h["if-modified-since"] = s.lm;
      const r = await fetch(f.u, {headers: h, redirect: "follow", signal: AbortSignal.timeout(10000)});
      const ma = Number((/max-age=(\d+)/.exec(r.headers.get("cache-control") || "") || [])[1]);
      s.ma = Number.isFinite(ma) ? Math.min(300e3, ma * 1e3) : 0;
      if (r.status === 304) { await r.body?.cancel(); this.reussi(s, iv); return; }
      if (!r.ok) { await r.body?.cancel(); throw new Error(explique(r.status, f.g)); }
      s.et = r.headers.get("etag") || ""; s.lm = r.headers.get("last-modified") || "";
      const buf = await r.arrayBuffer(), h1 = await empreinte(buf);
      if (h1 === s.h) { this.reussi(s, iv); return; }
      const texte = decoder(buf, r.headers.get("content-type"));
      const entrees = lire(texte, MAX_ENTREES, f.une);
      if (!entrees.length && !/<(rss|feed|rdf)\b/i.test(texte)) throw new Error("réponse illisible : le site renvoie une page au lieu d'un flux");
      s.h = h1; s.cnt = entrees.length;
      const c = this.cles(f.u), vu = Date.now(), base = !s.base, mini = vu - GARDE;
      if (f.pa) {                                      // page d'accueil : ce qu'elle met en avant (dernières 24 h)
        const liens = entrees.filter(e => !e.d || vu - e.d < 24 * 3600e3).map(e => e.l).slice(0, 60);
        if (JSON.stringify(liens) !== JSON.stringify(s.pa || [])) { s.pa = liens; pa[f.u] = liens; }
      }
      let change = false;
      const liens = new Set(Object.keys(c.k).map(k => k.slice(0, k.indexOf("\n"))));
      for (const e of entrees) {
        const cle = e.l + "\n" + e.t;
        if (c.k[cle]) continue;                          // déjà vue
        c.k[cle] = [vu]; change = true;
        e.v = vu; if (base) e.b = 1;
        // délai de publication : seulement pour un article jamais vu (pas un titre mis à jour)
        if (!base && !liens.has(e.l) && e.d && vu - e.d >= 0 && vu - e.d < 6 * 3600e3) (s.dl = (s.dl || []).slice(-14)).push(vu - e.d);
        liens.add(e.l);
        if (!f.une) nouv.push([f.u, e]);
      }
      if (f.une && change) { c.snap = entrees; snaps[f.u] = entrees; }
      if (change) {
        for (const [k, x] of Object.entries(c.k)) if (x[0] < mini) delete c.k[k];
        this.sql.exec("INSERT OR REPLACE INTO cles (u, v) VALUES (?, ?)", f.u, JSON.stringify(c));
      }
      s.base = true;
      this.reussi(s, iv);
    } catch (e) {
      s.st = "err"; s.fails = (s.fails || 0) + 1; s.at = Date.now();
      s.err = e && e.name === "TimeoutError" ? "délai dépassé" : String(e && e.message || e).slice(0, 140);
      s.n = debut + iv * Math.min(2 ** s.fails, 8) * (0.9 + Math.random() * 0.2);
    }
  }
  reussi(s, iv) {
    s.st = "ok"; s.err = ""; s.fails = 0; s.at = s.ok = Date.now();
    s.n = s.at + Math.max(iv, s.ma || 0) * (0.9 + Math.random() * 0.2);
  }

  /* ---------- Repérage : infos majeures, sujets suivis, mots-clés ---------- */
  chargerItems() {
    if (this.items) return;
    this.items = []; this.vus = new Map();
    for (const r of this.sql.exec("SELECT u, d FROM entrees WHERE vu > ? ORDER BY seq", Date.now() - GARDE).toArray()) this.ajouterItem(r.u, JSON.parse(r.d));
  }
  ajouterItem(u, e) {
    const it = versItem(PARMI.get(u), e);
    if (!it || this.vus.has(it.ku) || this.vus.has(it.id)) return;
    this.vus.set(it.ku, it); this.vus.set(it.id, it); this.items.push(it);
  }
  // Réglages (seuil, plafond, médias coupés, sujets ignorés, mots-clés) et sujets suivis : ceux que la page
  // synchronise entre tes appareils (base D1), relus toutes les 10 minutes.
  async reglages() {
    if (this.reg && Date.now() - this.reg.at < 600e3) return this.reg;
    let p = {maj: true, majMin: 6, majCap: 10, muted: [], fr: false, ignSig: [], alerts: ""}, suivis = [];
    try {
      const rows = (await this.env.DB.prepare("SELECT k, v FROM lefil_sync WHERE k = 'prefs' OR k LIKE 'suivi:%'").all()).results || [];
      for (const r of rows) {
        const d = JSON.parse(r.v);
        if (r.k === "prefs") p = {...p, ...d};
        else if (!d.del && d.q) suivis.push({id: d.id, name: d.name || d.q, alts: parseTerms(d.q)});
      }
    } catch (e) {}
    const mots = String(p.alerts || "").split(/[,;\n]+/).map(s => s.trim()).filter(Boolean)
      .map(k => ({k, re: new RegExp("(^|[^a-z0-9])" + escRe(norm(k)) + "(?=[^a-z0-9]|$)")}));
    this.reg = {at: Date.now(), p, suivis: suivis.filter(s => s.alts.length), mots};
    return this.reg;
  }
  async infosMajeures(now) {
    this.chargerItems();
    if (this.items.length && now - this.items[0].t > GARDE + 3600e3) {          // ménage : plus de 48 h
      this.items = this.items.filter(i => now - i.t <= GARDE);
      this.vus = new Map(); for (const i of this.items) { this.vus.set(i.ku, i); this.vus.set(i.id, i); }
    }
    marquerLots(this.items);
    const {p: prefs, suivis, mots} = await this.reglages();
    const evs = analyser(this.items, prefs, now, {unes: this.unes()}).events;
    this.dernieresMajeures = evs;
    const notif = this.etat.notifies || (this.etat.notifies = {});
    const premier = !this.etat.notifInit;             // tout premier passage : ce qui existe déjà n'est pas annoncé
    const nouveaux = [];
    for (const ev of evs) {
      const deja = ev.items.some(i => notif[i.id]);
      for (const i of ev.items) notif[i.id] = notif[i.id] || now;
      const montre = !(prefs.muted || []).includes(ev.rep.src) && (!prefs.fr || ev.rep.lang === "fr");
      if (!deja && !premier && montre && now - ev.last < 3 * 3600e3) nouveaux.push(ev);
    }
    this.etat.notifInit = true;
    this.etat.analyse = {at: now, evenements: evs.length, depeches: this.items.length};
    for (const [k, t] of Object.entries(notif)) if (now - t > GARDE) delete notif[k];
    let envoye = false;
    if (nouveaux.length) { await this.pousserMajeures(nouveaux.slice(0, 2), now); envoye = true; }
    const aVerifier = this.aVerifier.splice(0);
    if (!premier && aVerifier.length && (await this.pousserSuivis(aVerifier, prefs, suivis, mots, now))) envoye = true;
    if (envoye) { this.sauver(); this.sauve = now; }
  }

  /* ---------- Notifications push ---------- */
  // Clés VAPID du serveur : créées au premier besoin, gardées dans sa base (jamais ailleurs)
  async clesVapid() {
    if (this.vapid) return this.vapid;
    const row = this.sql.exec("SELECT v FROM meta WHERE k = 'vapid'").toArray()[0];
    if (row) return (this.vapid = JSON.parse(row.v));
    this.vapid = await nouvellesCles();
    this.sql.exec("INSERT OR REPLACE INTO meta (k, v) VALUES ('vapid', ?)", JSON.stringify(this.vapid));
    return this.vapid;
  }
  abonnes() { return this.sql.exec("SELECT endpoint, j FROM abonnes").toArray().map(r => ({endpoint: r.endpoint, ...JSON.parse(r.j)})); }
  garderAbonne(a) { const {endpoint, ...j} = a; this.sql.exec("INSERT OR REPLACE INTO abonnes (endpoint, j) VALUES (?, ?)", endpoint, JSON.stringify(j)); }
  /* Envoie un message aux appareils choisis par filtre(a) ; nuit : 23 h – 7 h, seulement si fort. */
  async diffuser(message, now, filtre, {fort = false, compte = true} = {}) {
    const abos = this.abonnes().filter(filtre); if (!abos.length) return 0;
    const cles = await this.clesVapid();
    const h = paris(now).h, nuit = h >= 23 || h < 7;
    let n = 0;
    for (const a of abos) {
      if (a.nuit && nuit && !fort) continue;        // la nuit, seulement l'urgent
      a.envois = (a.envois || []).filter(t => now - t < 864e5);
      if (compte && a.envois.length >= 20) continue;  // garde-fou : 20 notifications par 24 h au plus
      const st = await envoyer(a, message, cles, this.env.SITE || "https://le-fil.workers.dev").catch(() => 0);
      if (st === 404 || st === 410) { this.sql.exec("DELETE FROM abonnes WHERE endpoint = ?", a.endpoint); continue; }
      if (st >= 200 && st < 300) { n++; if (compte) { a.envois.push(now); this.garderAbonne(a); } }
      else console.error("push refusé", st, new URL(a.endpoint).hostname);
    }
    return n;
  }
  journal(entree) { (this.etat.envoyes = (this.etat.envoyes || []).slice(-14)).push(entree); }
  async pousserMajeures(evs, now) {
    for (const ev of evs) {
      const message = {titre: ev.urgent ? "Le Fil · urgent" : `Le Fil · info majeure (${ev.n} médias)`,
        texte: `${ev.rep.title}\n${ev.rep.src} · ${ev.why.join(", ")}`, lien: ev.rep.link, tag: "maj-" + ev.sig.join("-")};
      await this.diffuser(message, now, a => a.majeures !== false, {fort: ev.urgent || (ev.grave && ev.peak >= 6)});
      this.journal({t: now, type: "majeure", titre: ev.rep.title, src: ev.rep.src, n: ev.n, lien: ev.rep.link});
    }
  }
  /* Nouveaux articles des sujets suivis (au plus 1 notification toutes les 20 min par sujet) et des mots-clés
     (au plus 1 toutes les 30 min). Même règles de mots que la page ; la presse vélo spécialisée n'y entre pas. */
  async pousserSuivis(nouveaux, prefs, suivis, mots, now) {
    const abos = this.abonnes(); if (!abos.some(a => a.suivis !== false || a.mots)) return false;
    const muted = prefs.muted || [], dernier = this.etat.dernierSignal || (this.etat.dernierSignal = {});
    const vus = new Set(), visibles = nouveaux.filter(it => !it.spe && !muted.includes(it.src) && (!prefs.fr || it.lang === "fr")
      && !vus.has(it.ku) && vus.add(it.ku));
    let envoye = false;
    for (const s of suivis) {
      const hits = visibles.filter(it => matchAlts(s.alts, it.n));
      if (!hits.length || now - (dernier["s:" + s.id] || 0) < 20 * 60e3) continue;
      dernier["s:" + s.id] = now;
      const it = hits[0], autres = hits.length - 1;
      await this.diffuser({titre: `Le Fil · suivi « ${s.name} »`, texte: `${it.title}\n${it.src}${autres ? ` (+ ${pluriel(autres, "autre")})` : ""}`,
        lien: it.link, tag: "suivi-" + s.id}, now, a => a.suivis !== false);
      this.journal({t: now, type: "suivi", titre: it.title, src: it.src, sujet: s.name, lien: it.link});
      envoye = true;
    }
    if (mots.length && now - (dernier.mots || 0) >= 30 * 60e3) {
      const hits = []; for (const it of visibles) { const m = mots.find(x => x.re.test(it.n)); if (m) hits.push({it, k: m.k}); }
      if (hits.length) {
        dernier.mots = now;
        const {it, k} = hits[0], autres = hits.length - 1;
        await this.diffuser({titre: `Le Fil · mot-clé « ${k} »`, texte: `${it.title}\n${it.src}${autres ? ` (+ ${pluriel(autres, "autre")} sur tes mots-clés)` : ""}`,
          lien: it.link, tag: "mots"}, now, a => !!a.mots);
        this.journal({t: now, type: "mot", titre: it.title, src: it.src, sujet: k, lien: it.link});
        envoye = true;
      }
    }
    return envoye;
  }
  /* Point du matin à 7 h 30 (heure de Paris) : les infos majeures de la nuit, en une notification. */
  async pointDuMatin(now) {
    const {h, m, jour} = paris(now);
    if (h !== 7 || m < 30 || this.etat.matin === jour) return;
    this.etat.matin = jour;
    if (!this.abonnes().some(a => a.matin !== false)) { this.sauver(); return; }
    this.chargerItems(); marquerLots(this.items);
    const {p: prefs} = await this.reglages();
    const evs = analyser(this.items, prefs, now, {unes: this.unes()}).events
      .filter(ev => now - ev.last < 9.5 * 3600e3 && !(prefs.muted || []).includes(ev.rep.src));
    const texte = evs.length
      ? evs.slice(0, 4).map(ev => "• " + ev.rep.title).join("\n") + (evs.length > 4 ? `\n+ ${pluriel(evs.length - 4, "autre")}` : "")
      : "Nuit calme : aucune info majeure depuis hier soir.";
    await this.diffuser({titre: evs.length ? `Le Fil · ce matin, ${pluriel(evs.length, "info majeure")}` : "Le Fil · ce matin", texte,
      lien: (this.env.SITE || "") + "/", tag: "matin"}, now, a => a.matin !== false, {compte: false});
    this.journal({t: now, type: "matin", titre: evs.length ? pluriel(evs.length, "info majeure") + " depuis hier soir" : "Nuit calme", src: "", lien: "/"});
    this.sauver(); this.sauve = now;
  }
  /* Toutes les 10 minutes (tâche planifiée) : la relève tourne-t-elle encore ? Sinon, prévenir. */
  async veiller(now) {
    const dernier = Math.max(0, ...Object.values(this.etat.flux).map(s => s.ok || (s.st === "ok" ? s.at || 0 : 0)));
    const enPanne = !dernier || now - dernier > PANNE;
    if (enPanne && !this.etat.enPanne && now - (this.etat.alertePanne || 0) > 6 * 3600e3) {
      this.etat.enPanne = true; this.etat.alertePanne = now;
      const depuis = dernier ? new Date(dernier).toLocaleTimeString("fr-FR", {timeZone: "Europe/Paris", hour: "2-digit", minute: "2-digit"}) : "un moment";
      await this.diffuser({titre: "Le Fil · relève en panne", texte: `Aucun flux lu depuis ${depuis}. Le serveur se relance tout seul ; tu seras prévenu quand ça repart.`,
        lien: (this.env.SITE || "") + "/", tag: "panne"}, now, a => a.pannes !== false, {fort: true, compte: false});
      this.journal({t: now, type: "panne", titre: "Relève en panne", src: "", lien: "/"});
      this.sauver();
    } else if (!enPanne && this.etat.enPanne) {
      this.etat.enPanne = false;
      await this.diffuser({titre: "Le Fil · relève repartie", texte: "Les flux sont de nouveau lus normalement.", lien: (this.env.SITE || "") + "/", tag: "panne"},
        now, a => a.pannes !== false, {compte: false});
      this.journal({t: now, type: "panne", titre: "Relève repartie", src: "", lien: "/"});
      this.sauver();
    }
  }
  async gererPush(request, url) {
    if (url.pathname === "/push/cle") return json({cle: (await this.clesVapid()).publique});
    if (url.pathname === "/push/etat") return json({appareils: this.abonnes().length, analyse: this.etat.analyse || null,
      envoyes: (this.etat.envoyes || []).slice().reverse(), releve: actif(this.env)});
    if (request.method !== "POST") return json({erreur: "POST attendu"}, 405);
    const brut = await request.text();
    if (brut.length > 4000) return json({erreur: "trop long"}, 413);
    let q; try { q = JSON.parse(brut); } catch (e) { return json({erreur: "illisible"}, 400); }
    if (url.pathname === "/push/abonner") {
      const sub = q && q.sub;
      if (!sub || !endpointValide(sub.endpoint) || !sub.keys || !/^[\w-]{80,100}$/.test(sub.keys.p256dh || "") || !/^[\w-]{16,32}$/.test(sub.keys.auth || ""))
        return json({erreur: "abonnement invalide"}, 400);
      const abos = this.abonnes();
      const ancien = abos.find(a => a.endpoint === sub.endpoint);
      if (!ancien && abos.length >= 30) {           // au plus 30 appareils : on oublie le plus ancien
        const vieux = abos.sort((a, b) => a.at - b.at)[0]; this.sql.exec("DELETE FROM abonnes WHERE endpoint = ?", vieux.endpoint);
      }
      const choix = k => q[k] === undefined ? (ancien ? ancien[k] : undefined) : !!q[k];
      this.garderAbonne({endpoint: sub.endpoint, keys: {p256dh: sub.keys.p256dh, auth: sub.keys.auth}, nuit: q.nuit !== false,
        majeures: choix("majeures") !== false, suivis: choix("suivis") !== false, mots: !!choix("mots"), matin: choix("matin") !== false, pannes: choix("pannes") !== false,
        at: ancien ? ancien.at : Date.now(), envois: ancien ? ancien.envois || [] : []});
      return json({ok: true, appareils: Math.min(30, abos.length + (ancien ? 0 : 1))});
    }
    if (url.pathname === "/push/desabonner") {
      this.sql.exec("DELETE FROM abonnes WHERE endpoint = ?", String(q && q.endpoint || ""));
      return json({ok: true});
    }
    if (url.pathname === "/push/essai") {
      const a = this.abonnes().find(x => x.endpoint === (q && q.endpoint));
      if (!a) return json({erreur: "appareil inconnu : réactive les notifications"}, 404);
      const st = await envoyer(a, {titre: "Le Fil", texte: "Les notifications marchent : tu seras prévenu ici des infos majeures, même Le Fil fermé.",
        lien: this.env.SITE || "/", tag: "essai"}, await this.clesVapid(), this.env.SITE || "https://le-fil.workers.dev", {ttl: 600}).catch(e => String(e));
      if (st === 404 || st === 410) this.sql.exec("DELETE FROM abonnes WHERE endpoint = ?", a.endpoint);
      return json({ok: st >= 200 && st < 300, statut: st});
    }
    return json({erreur: "introuvable"}, 404);
  }

  /* ---------- Recherche sur 30 jours ---------- */
  recherche(q, avant) {
    const mots = norm(q).split(/[^a-z0-9]+/).filter(w => w.length >= 2).slice(0, 6);
    if (!mots.length) return json({erreur: "mots trop courts"}, 400);
    const lim = 80, borne = Number(avant) > 0 ? Number(avant) : Number.MAX_SAFE_INTEGER;
    const rows = this.sql.exec(`SELECT seq, u, vu, d FROM entrees WHERE seq < ? AND ${mots.map(() => "n LIKE ?").join(" AND ")} ORDER BY seq DESC LIMIT ${lim}`,
      borne, ...mots.map(w => "%" + w + "%")).toArray();
    const vus = new Set(), resultats = [];
    for (const r of rows) {
      const f = PARMI.get(r.u); if (!f || f.une) continue;
      const e = JSON.parse(r.d), k = cleLien(e.l);
      if (vus.has(k)) continue;
      vus.add(k);
      resultats.push({t: e.t, l: e.l, src: nomSource(f, e), d: Number.isFinite(e.d) && !e.b ? e.d : (e.d || r.vu), s: e.s || ""});
    }
    return json({resultats, avant: rows.length ? rows[rows.length - 1].seq : 0, fin: rows.length < lim,
      depuis: (this.sql.exec("SELECT vu FROM entrees ORDER BY seq LIMIT 1").toArray()[0] || {}).vu || null});
  }

  /* ---------- Rattrapage : ce qu'une page a manqué (48 dernières heures) ---------- */
  rattrapage(depuis, epoque) {
    const complet = epoque !== this.etat.epoch;
    const rows = this.sql.exec("SELECT seq, u, l, d FROM entrees WHERE seq > ? AND vu > ? ORDER BY seq",
      complet ? 0 : Math.max(0, Number(depuis) || 0), Date.now() - GARDE).toArray();
    const dernier = new Map();                        // une seule version par article : la plus récente
    for (const r of rows) dernier.set(r.u + "\n" + r.l, r);
    const nouv = [...dernier.values()].sort((a, b) => a.seq - b.seq).map(r => `[${JSON.stringify(r.u)},${r.d}]`);
    const snaps = {};
    for (const f of FLUX) if (f.une) { const c = this.cles(f.u); if (c.snap) snaps[f.u] = c.snap; }
    const seq = Math.max(rows.length ? rows[rows.length - 1].seq : 0, this.seqMax());
    return `{"type":"fil","epoch":${JSON.stringify(this.etat.epoch)},"complet":${complet},"seq":${Math.max(seq, complet ? 0 : Number(depuis) || 0)},`
      + `"flux":${JSON.stringify(this.etats())},"snaps":${JSON.stringify(snaps)},"pa":${JSON.stringify(this.pagesUne())},"nouv":[${nouv.join(",")}]}`;
  }

  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname.startsWith("/push/")) return this.gererPush(request, url);
    if (url.pathname === "/recherche") return this.recherche(url.searchParams.get("q") || "", url.searchParams.get("avant"));
    if (!actif(this.env)) return new Response("Relève en pause sur cette version", {status: 503});
    if (!(await this.ctx.storage.getAlarm())) await this.ctx.storage.setAlarm(Date.now() + 1000);
    if (url.pathname === "/direct") {
      if (request.headers.get("upgrade") !== "websocket") return new Response("WebSocket attendu", {status: 426});
      const pair = new WebSocketPair();
      this.ctx.acceptWebSocket(pair[1]);
      return new Response(null, {status: 101, webSocket: pair[0]});
    }
    if (url.pathname === "/fil") {
      return new Response(this.rattrapage(url.searchParams.get("depuis"), url.searchParams.get("epoque") || ""), {
        headers: {"content-type": "application/json; charset=utf-8", "cache-control": "no-store"},
      });
    }
    // /reveil (tâche planifiée, toutes les 10 min) : la relève est relancée si besoin, et l'on prévient si elle est en panne
    try { await this.veiller(Date.now()); } catch (e) { console.error("veille", e && e.stack || String(e)); }
    return new Response("ok");
  }
  async webSocketMessage(ws, message) {
    let q; try { q = JSON.parse(message); } catch (e) { return; }
    if (q && "depuis" in q) ws.send(this.rattrapage(q.depuis, q.epoque || ""));
  }
  async webSocketClose(ws, code) { try { ws.close(code, "fin"); } catch (e) {} }
}
