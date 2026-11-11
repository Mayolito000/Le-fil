/*
 * LE FIL · Releveur (Durable Object avec base SQLite, offre gratuite de Cloudflare)
 * --------------------------------------------------------------------------------
 * Relève tous les flux de flux.json en continu, même quand aucune page n'est ouverte :
 *   - chaque flux est relu toutes les 30 s à 5 min selon son rang (t), jamais plus souvent que
 *     ce que le média autorise (Cache-Control), et en demandant seulement s'il a changé (ETag) ;
 *   - toute dépêche nouvelle (ou dont le titre change) est gardée 48 h dans la table « entrees » ;
 *   - elle est aussitôt poussée aux pages ouvertes (WebSocket), qui la montrent dans la seconde.
 * Une page qui s'ouvre récupère d'un coup ce qu'elle a manqué (/fil?depuis=…).
 *
 * Limites de l'offre gratuite respectées : au plus 30 flux par passage (50 sous-requêtes permises),
 * un passage toutes les 10 s au plus, peu d'écritures (on n'écrit que ce qui change).
 */
import {DurableObject} from "cloudflare:workers";
import FLUX from "../flux.json";
import {versItem, marquerLots, analyser} from "./majeures.js";
import {envoyer, endpointValide, nouvellesCles} from "./webpush.js";

const UA = "Mozilla/5.0 (compatible; LeFil/1.0; lecteur RSS personnel)";
const RYTHME = {1: 30e3, 2: 60e3, 3: 120e3, 4: 300e3};   // délai entre deux lectures d'un flux, selon son rang t
const RYTHME_GOOGLE = 600e3;                              // Google Actualités refuse presque toujours : on insiste peu
const MAX_PAR_PASSAGE = 30;
const SIMULTANES = 6;
const PAS_MIN = 10e3;                                     // au plus un passage toutes les 10 s
const GARDE = 48 * 3600e3;
const MAX_ENTREES = 100;                                  // entrées lues par flux
const PARMI = new Map(FLUX.map(f => [f.u, f]));

// Variable RELEVE = "non" (version de test au repos) : le Releveur ne relève rien et ne répond pas,
// la page relève alors elle-même les flux. Évite que deux serveurs lisent les mêmes médias en double.
const actif = env => !env || env.RELEVE !== "non";
const rythme = f => f.g ? RYTHME_GOOGLE : (RYTHME[f.t] || 120e3);
const cp = n => { try { return String.fromCodePoint(n); } catch (e) { return ""; } };
const xml = s => !s ? "" : s.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, (m, c) => c.replace(/&/g, "\u0000"))
  .replace(/&#x([0-9a-f]+);/gi, (m, n) => cp(parseInt(n, 16))).replace(/&#(\d+);/g, (m, n) => cp(+n))
  .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, "&")
  .replace(/\u0000/g, "&");
const sansBalises = s => s.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
const coupe = (s, n) => s.length > n ? s.slice(0, n) : s;

function decoder(buf, ct) {
  let cs = (/charset=["']?([\w-]+)/i.exec(ct || "") || [])[1];
  if (!cs) cs = (/encoding=["']([\w-]+)["']/i.exec(new TextDecoder("latin1").decode(buf.slice(0, 300))) || [])[1];
  try { return new TextDecoder(cs || "utf-8").decode(buf); } catch (e) { return new TextDecoder("utf-8").decode(buf); }
}

const BALISE = {};
const balise = n => BALISE[n] || (BALISE[n] = new RegExp("<" + n + "\\b[^>]*>([\\s\\S]*?)</" + n + ">", "i"));
/* Lecture tolérante d'un flux RSS, RDF ou Atom : titre, lien, date, chapô, source (Google). */
function lire(texte, max, brut) {
  const out = [], re = /<(item|entry)\b[\s\S]*?<\/\1>/gi;
  let m;
  while ((m = re.exec(texte)) && out.length < max) {
    const b = m[0], get = n => { const r = balise(n).exec(b); return r ? r[1] : ""; };
    let lien = xml(get("link")).trim();
    if (!/^https?:\/\//i.test(lien)) {
      lien = "";
      for (const t of b.match(/<link\b[^>]*>/gi) || []) {
        const href = (/href=["']([^"']+)["']/i.exec(t) || [])[1], rel = (/rel=["']([^"']+)["']/i.exec(t) || [])[1];
        if (href && (!rel || rel === "alternate")) { lien = xml(href); break; }
      }
    }
    if (!lien) { const g = xml(get("feedburner:origLink") || get("guid") || get("id")).trim(); if (/^https?:\/\//i.test(g)) lien = g; }
    const titre = coupe(sansBalises(xml(get("title"))), 400);
    if (!titre || !lien) continue;
    const d = Date.parse(xml(get("pubDate") || get("dc:date") || get("published") || get("updated")).trim());
    const desc = get("description") || get("summary") || get("content:encoded") || get("content");
    const e = {t: titre, l: lien, d: Number.isFinite(d) ? d : null, s: coupe(sansBalises(xml(desc)), 300)};
    const src = /<source\b([^>]*)>([\s\S]*?)<\/source>/i.exec(b);
    if (src) { e.so = sansBalises(xml(src[2])); const u = (/url=["']([^"']+)["']/i.exec(src[1]) || [])[1]; if (u) e.su = xml(u); }
    if (brut) e.r = coupe(xml(get("description")), 6000);   // « À la une » : la grappe d'articles liés
    out.push(e);
  }
  return out;
}

async function empreinte(buf) {
  const h = new Uint8Array(await crypto.subtle.digest("SHA-1", buf));
  return [...h].map(x => x.toString(16).padStart(2, "0")).join("");
}
function explique(statut, google) {
  if (google && (statut === 503 || statut === 429)) return `Google Actualités refuse le relais pour l'instant (${statut})`;
  return "Le média a répondu " + statut;
}
function heureParis(t) {
  const p = new Intl.DateTimeFormat("en-GB", {timeZone: "Europe/Paris", hour: "numeric", hourCycle: "h23"}).formatToParts(t).find(x => x.type === "hour");
  return p ? Number(p.value) : 12;
}
const json = (o, status) => new Response(JSON.stringify(o), {status: status || 200, headers: {"content-type": "application/json; charset=utf-8", "cache-control": "no-store"}});
const mediane = a => { if (!a || !a.length) return null; const s = a.slice().sort((x, y) => x - y); return s[s.length >> 1]; };

export class Releveur extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.cache = new Map();                          // clés connues de chaque flux (copie en mémoire)
    this.signes = new Map();                         // dernier état envoyé de chaque flux (ok / échec)
    this.dernierEnvoi = 0;
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair("ping", "pong"));
    ctx.blockConcurrencyWhile(async () => {
      this.sql.exec("CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT NOT NULL)");
      this.sql.exec("CREATE TABLE IF NOT EXISTS cles (u TEXT PRIMARY KEY, v TEXT NOT NULL)");
      this.sql.exec("CREATE TABLE IF NOT EXISTS entrees (seq INTEGER PRIMARY KEY AUTOINCREMENT, u TEXT NOT NULL, vu INTEGER NOT NULL, l TEXT NOT NULL, d TEXT NOT NULL)");
      this.sql.exec("CREATE TABLE IF NOT EXISTS abonnes (endpoint TEXT PRIMARY KEY, j TEXT NOT NULL)");
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
    const dus = FLUX.filter(f => (this.st(f.u).n || 0) <= now)
      .sort((a, b) => (this.st(a.u).n || 0) - (this.st(b.u).n || 0)).slice(0, MAX_PAR_PASSAGE);
    const nouv = [], snaps = {}, lus = [];
    let i = 0;
    const travailleur = async () => { while (i < dus.length) { const f = dus[i++]; lus.push(f.u); await this.relever(f, nouv, snaps); } };
    await Promise.all(Array.from({length: SIMULTANES}, travailleur));
    let seq = 0;
    if (nouv.length) {
      for (const [u, e] of nouv) this.sql.exec("INSERT INTO entrees (u, vu, l, d) VALUES (?, ?, ?, ?)", u, e.v, e.l, JSON.stringify(e));
      seq = this.seqMax();
      if (this.items) for (const [u, e] of nouv) this.ajouterItem(u, e);
      this.aAnalyser = true;
    }
    // Infos majeures : au plus une analyse par minute, et seulement s'il y a du nouveau
    if (this.aAnalyser && now - (this.derniereAnalyse || 0) >= 60e3) {
      this.aAnalyser = false; this.derniereAnalyse = now;
      try { await this.infosMajeures(now); } catch (e) { console.error("infos majeures", e && e.stack || String(e)); }
    }
    if (now - (this.etat.purge || 0) > 3600e3) {        // une fois par heure : on oublie ce qui a plus de 48 h
      this.sql.exec("DELETE FROM entrees WHERE vu < ?", now - GARDE);
      for (const u of Object.keys(this.etat.flux)) if (!PARMI.has(u)) delete this.etat.flux[u];   // flux retirés de la liste
      this.etat.purge = now;
    }
    // L'état des flux (échéances, empreintes) n'est enregistré que toutes les 5 minutes : la limite gratuite
    // compte les écritures, et perdre quelques minutes d'état ne fait que relire les flux une fois de plus.
    if (now - this.sauve > 300e3) { this.sauver(); this.sauve = now; }
    if (!lus.length) return;
    // On n'écrit aux pages ouvertes que s'il y a du nouveau (dépêches, ou un flux qui tombe ou revient),
    // et sinon au plus toutes les 2 minutes : batterie et forfait du téléphone ménagés.
    const bascules = lus.filter(u => { const x = this.etat.flux[u], sig = x.st + "|" + (x.err || ""); const avant = this.signes.get(u); this.signes.set(u, sig); return avant !== sig; });
    if (!nouv.length && !Object.keys(snaps).length && !bascules.length && now - this.dernierEnvoi < 120e3) return;
    this.dernierEnvoi = now;
    const msg = {type: "nouv", epoch: this.etat.epoch, seq: seq || this.seqMax(), nouv, snaps, flux: this.etats(lus), passe: now};
    const texte = JSON.stringify(msg);
    for (const ws of this.ctx.getWebSockets()) { try { ws.send(texte); } catch (e) {} }
  }

  async relever(f, nouv, snaps) {
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
    s.st = "ok"; s.err = ""; s.fails = 0; s.at = Date.now();
    s.n = s.at + Math.max(iv, s.ma || 0) * (0.9 + Math.random() * 0.2);
  }

  /* ---------- Infos majeures et notifications push ---------- */
  chargerItems() {
    if (this.items) return;
    this.items = []; this.vus = new Map();
    for (const r of this.sql.exec("SELECT u, d FROM entrees ORDER BY seq").toArray()) this.ajouterItem(r.u, JSON.parse(r.d));
  }
  ajouterItem(u, e) {
    const it = versItem(PARMI.get(u), e);
    if (!it || this.vus.has(it.ku) || this.vus.has(it.id)) return;
    this.vus.set(it.ku, it); this.vus.set(it.id, it); this.items.push(it);
  }
  // Réglages des infos majeures (seuil, plafond, médias coupés, sujets ignorés) : ceux que la page
  // synchronise entre tes appareils (base D1, document « prefs »), relus toutes les 10 minutes.
  async reglages() {
    if (this.reg && Date.now() - this.reg.at < 600e3) return this.reg.p;
    let p = {maj: true, majMin: 6, majCap: 10, muted: [], fr: false, ignSig: []};
    try { const r = await this.env.DB.prepare("SELECT v FROM lefil_sync WHERE k = 'prefs'").first(); if (r) p = {...p, ...JSON.parse(r.v)}; } catch (e) {}
    this.reg = {at: Date.now(), p};
    return p;
  }
  async infosMajeures(now) {
    this.chargerItems();
    if (this.items.length && now - this.items[0].t > GARDE + 3600e3) {          // ménage : plus de 48 h
      this.items = this.items.filter(i => now - i.t <= GARDE);
      this.vus = new Map(); for (const i of this.items) { this.vus.set(i.ku, i); this.vus.set(i.id, i); }
    }
    marquerLots(this.items);
    const prefs = await this.reglages();
    const evs = analyser(this.items, prefs, now);
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
    if (nouveaux.length) { await this.pousser(nouveaux.slice(0, 2), now); this.sauver(); this.sauve = now; }
  }
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
  async pousser(evs, now) {
    const abos = this.abonnes(); if (!abos.length) return;
    const cles = await this.clesVapid();
    const h = heureParis(now), nuit = h >= 23 || h < 7;
    for (const ev of evs) {
      const message = {titre: ev.urgent ? "Le Fil · urgent" : `Le Fil · info majeure (${ev.n} médias)`,
        texte: `${ev.rep.title}\n${ev.rep.src} · ${ev.why.join(", ")}`, lien: ev.rep.link, tag: "maj-" + ev.sig.join("-")};
      const fort = ev.urgent || (ev.grave && ev.peak >= 6);
      for (const a of abos) {
        if (a.nuit && nuit && !fort) continue;      // la nuit, seulement l'urgent
        a.envois = (a.envois || []).filter(t => now - t < 864e5);
        if (a.envois.length >= 20) continue;          // garde-fou : 20 notifications par 24 h au plus
        const st = await envoyer(a, message, cles, this.env.SITE || "https://le-fil.workers.dev").catch(() => 0);
        if (st === 404 || st === 410) { this.sql.exec("DELETE FROM abonnes WHERE endpoint = ?", a.endpoint); a.parti = true; continue; }
        if (st >= 200 && st < 300) { a.envois.push(now); this.garderAbonne(a); }
        else console.error("push refusé", st, new URL(a.endpoint).hostname);
      }
      // journal des dernières infos majeures annoncées (montré dans la fenêtre Alertes)
      (this.etat.envoyes = (this.etat.envoyes || []).slice(-9)).push({t: now, titre: ev.rep.title, src: ev.rep.src, n: ev.n, lien: ev.rep.link});
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
      this.garderAbonne({endpoint: sub.endpoint, keys: {p256dh: sub.keys.p256dh, auth: sub.keys.auth}, nuit: q.nuit !== false,
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

  /* ---------- Rattrapage : tout ce qu'une page a manqué ---------- */
  rattrapage(depuis, epoque) {
    const complet = epoque !== this.etat.epoch;
    const rows = this.sql.exec("SELECT seq, u, l, d FROM entrees WHERE seq > ? ORDER BY seq", complet ? 0 : Math.max(0, Number(depuis) || 0)).toArray();
    const dernier = new Map();                        // une seule version par article : la plus récente
    for (const r of rows) dernier.set(r.u + "\n" + r.l, r);
    const nouv = [...dernier.values()].sort((a, b) => a.seq - b.seq).map(r => `[${JSON.stringify(r.u)},${r.d}]`);
    const snaps = {};
    for (const f of FLUX) if (f.une) { const c = this.cles(f.u); if (c.snap) snaps[f.u] = c.snap; }
    const seq = rows.length ? rows[rows.length - 1].seq : this.seqMax();
    return `{"type":"fil","epoch":${JSON.stringify(this.etat.epoch)},"complet":${complet},"seq":${Math.max(seq, complet ? 0 : Number(depuis) || 0)},`
      + `"flux":${JSON.stringify(this.etats())},"snaps":${JSON.stringify(snaps)},"nouv":[${nouv.join(",")}]}`;
  }

  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname.startsWith("/push/")) return this.gererPush(request, url);
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
    return new Response("ok");                        // /reveil : vérifie seulement que la relève tourne
  }
  async webSocketMessage(ws, message) {
    let q; try { q = JSON.parse(message); } catch (e) { return; }
    if (q && "depuis" in q) ws.send(this.rattrapage(q.depuis, q.epoque || ""));
  }
  async webSocketClose(ws, code) { try { ws.close(code, "fin"); } catch (e) {} }
}
