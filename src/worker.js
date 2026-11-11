/*
 * LE FIL · relais Cloudflare Worker (version 18)
 * ----------------------------------------------
 * La page, le service worker, les icônes, le manifeste et le modèle Anki sont des fichiers du dossier
 * public/, intégrés au Worker au moment de la mise en ligne (règles « rules » de wrangler.jsonc).
 * Le Worker sert ces fichiers, et répond aux adresses suivantes :
 *   /fil et /direct  dépêches relevées en continu par le Releveur (src/releveur.js) : rattrapage, puis direct ;
 *   /push/…      notifications sur le téléphone (infos majeures repérées par le Releveur, même page fermée) ;
 *   /rss?url=…   va chercher un flux RSS à la place du navigateur (sujets suivis, secours si le Releveur est indisponible) ;
 *   /date?url=…  lit l'heure de publication d'un article dans sa page ;
 *   /sync        synchronisation entre appareils (base D1 « DB », clé personnelle) ;
 *   /sante       vérification que le relais répond ;
 *   /notif-test et /veille : notifications ntfy, réservées à qui connaît la clé.
 *
 * Il ne relaie que les domaines de src/hotes.js (générés à partir de flux.json) : impossible de
 * s'en servir pour lire n'importe quel site. Il s'identifie toujours comme Le Fil, lecteur RSS.
 *
 * Secrets (Cloudflare > Worker > Paramètres > Variables et secrets), jamais écrits dans le code :
 *   SYNC_KEY   clé personnelle de synchronisation ;
 *   NTFY_TOPIC sujet ntfy des notifications sur téléphone (facultatif).
 */
import {ALLOWED_HOSTS, ARTICLE_DOMAINS} from "./hotes.js";
export {Releveur} from "./releveur.js";
import PAGE from "../public/index.html";
import SW from "../public/sw.js";
import MANIFEST from "../public/manifest.webmanifest";
import ICON_180 from "../public/icon-180.png";
import ICON_192 from "../public/icon-192.png";
import ICON_512 from "../public/icon-512.png";
import ANKI_MODEL from "../public/le-fil-modele.apkg";

const SECURITE = {"x-content-type-options": "nosniff", "referrer-policy": "no-referrer", "x-robots-tag": "noindex, nofollow"};
// Fichiers servis tels quels : [contenu, type, cache-control, en-têtes en plus]
const FICHIERS = {
  "/": [PAGE, "text/html; charset=utf-8", "no-cache"],
  "/index.html": [PAGE, "text/html; charset=utf-8", "no-cache"],
  "/sw.js": [SW, "text/javascript; charset=utf-8", "no-cache"],
  "/manifest.webmanifest": [MANIFEST, "application/manifest+json; charset=utf-8", "max-age=86400"],
  "/icon-180.png": [ICON_180, "image/png", "max-age=604800"],
  "/icon-192.png": [ICON_192, "image/png", "max-age=604800"],
  "/icon-512.png": [ICON_512, "image/png", "max-age=604800"],
  "/le-fil-modele.apkg": [ANKI_MODEL, "application/octet-stream", "max-age=86400", {"content-disposition": 'attachment; filename="le-fil-modele.apkg"'}],
};
function fichier(chemin) {
  const [corps, type, cache, plus] = FICHIERS[chemin];
  return new Response(corps, {headers: {"content-type": type, "cache-control": cache, ...SECURITE, ...(plus || {})}});
}

const USER_AGENT = "Mozilla/5.0 (compatible; LeFil/1.0; lecteur RSS personnel)";

function text(body, status) {
  return new Response(body, {
    status,
    headers: {"content-type": "text/plain; charset=utf-8", "cache-control": "no-store"},
  });
}
function json(obj, status) {
  return new Response(JSON.stringify(obj), {
    status: status || 200,
    headers: {"content-type": "application/json; charset=utf-8", "cache-control": "no-store"},
  });
}
function sameKey(a, b) {                     // comparaison en temps constant
  if (typeof a !== "string" || typeof b !== "string" || !b || a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}
const keyOf = request => request.headers.get("x-lefil-cle") || new URL(request.url).searchParams.get("cle") || "";

/* ================== RELAIS DES FLUX ================== */
async function relay(target) {
  let url;
  try {
    url = new URL(target || "");
  } catch (e) {
    return text("Adresse de flux invalide", 400);
  }
  if (url.protocol !== "https:" || !ALLOWED_HOSTS.has(url.hostname)) {
    return text("Domaine non autorisé par le relais", 403);
  }
  let upstream;
  try {
    upstream = await fetch(url.toString(), {
      headers: {
        "user-agent": USER_AGENT,
        "accept": "application/rss+xml, application/atom+xml, application/xml;q=0.9, text/xml;q=0.9, */*;q=0.5",
        "accept-language": "fr-FR,fr;q=0.9,en;q=0.6",
      },
      redirect: "follow",
      signal: AbortSignal.timeout(12000),
    });
  } catch (e) {
    const why = e && e.name === "TimeoutError" ? "délai dépassé" : "connexion impossible";
    return text("Le média ne répond pas (" + why + ")", 504);
  }
  if (!upstream.ok) {
    // Google Actualités refuse la plupart des requêtes venant des serveurs Cloudflare : on le dit clairement.
    if (url.hostname === "news.google.com" && (upstream.status === 503 || upstream.status === 429)) {
      return text("Google Actualités refuse le relais pour l'instant (" + upstream.status + ")", 502);
    }
    return text("Le média a répondu " + upstream.status, 502);
  }
  return new Response(upstream.body, {
    status: 200,
    headers: {
      "content-type": upstream.headers.get("content-type") || "application/xml",
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
    },
  });
}

/* ================== HEURE DE PUBLICATION D'UN ARTICLE ==================
 * Lit l'heure dans la page (article:published_time ou datePublished), sans renvoyer la page.
 * Lecture limitée au début du document. */
const DATE_PATTERNS = [
  /<meta[^>]+property=["']article:published_time["'][^>]*content=["']([^"']+)["']/i,
  /<meta[^>]+content=["']([^"']+)["'][^>]*property=["']article:published_time["']/i,
  /"datePublished"\s*:\s*"([^"]+)"/,
  /<meta[^>]+itemprop=["']datePublished["'][^>]*content=["']([^"']+)["']/i,
];
async function articleDate(target) {
  let url;
  try { url = new URL(target || ""); } catch (e) { return text("Adresse invalide", 400); }
  const host = url.hostname;
  if (url.protocol !== "https:" || !ARTICLE_DOMAINS.some(d => host === d || host.endsWith("." + d))) {
    return text("Domaine non autorisé par le relais", 403);
  }
  let res;
  try {
    res = await fetch(url.toString(), {
      headers: {"user-agent": USER_AGENT, "accept": "text/html", "accept-language": "fr-FR,fr;q=0.9"},
      redirect: "follow", signal: AbortSignal.timeout(10000),
    });
  } catch (e) {
    return text("Le média ne répond pas", 504);
  }
  if (!res.ok || !res.body) return text("Le média a répondu " + res.status, 502);
  const reader = res.body.getReader(), dec = new TextDecoder();
  let buf = "", read = 0, found = null;
  while (read < 300000) {
    const {done, value} = await reader.read();
    if (done) break;
    read += value.length;
    buf = buf.slice(-400) + dec.decode(value, {stream: true});
    for (const re of DATE_PATTERNS) { const m = re.exec(buf); if (m) { found = m[1]; break; } }
    if (found) break;
  }
  try { await reader.cancel(); } catch (e) {}
  const t = found ? Date.parse(found) : NaN;
  return new Response(JSON.stringify({date: Number.isFinite(t) ? new Date(t).toISOString() : null}), {
    headers: {"content-type": "application/json; charset=utf-8", "cache-control": "max-age=86400"},
  });
}

/* ================== SYNCHRONISATION ENTRE APPAREILS ==================
 * Base D1 reliée au Worker sous le nom « DB ». Une table de documents (réglages, un par sujet suivi,
 * un par journée d'infos majeures, lectures), chacun avec un numéro de révision. Une écriture n'est
 * acceptée que si l'appareil connaissait la dernière révision du document ; sinon il reçoit la version
 * à jour, la fusionne avec la sienne et renvoie. Accès réservé à la clé SYNC_KEY (en-tête x-lefil-cle). */
let syncTableReady = false;
async function sync(request, env) {
  if (!env.SYNC_KEY) return text("Clé de synchronisation absente du Worker : ajoute le secret SYNC_KEY", 503);
  if (!sameKey(request.headers.get("x-lefil-cle") || "", env.SYNC_KEY)) return text("Clé de synchronisation refusée", 401);
  const db = env.DB;
  if (!db) return text("Base D1 non reliée au Worker : ajoute la liaison « DB » dans Cloudflare (onglet Bindings)", 503);
  try {
    if (!syncTableReady) {
      await db.prepare("CREATE TABLE IF NOT EXISTS lefil_sync (k TEXT PRIMARY KEY, v TEXT NOT NULL, rev INTEGER NOT NULL)").run();
      syncTableReady = true;
    }
    if (request.method === "GET") {
      const since = Math.max(0, Number(new URL(request.url).searchParams.get("depuis")) || 0);
      const [rows, top] = await db.batch([
        db.prepare("SELECT k, v, rev FROM lefil_sync WHERE rev > ? ORDER BY rev").bind(since),
        db.prepare("SELECT COALESCE(MAX(rev), 0) AS m FROM lefil_sync"),
      ]);
      return json({rev: (top.results[0] || {m: 0}).m, docs: rows.results});
    }
    if (request.method !== "POST") return text("Méthode non prise en charge", 405);
    const raw = await request.text();
    if (raw.length > 4000000) return text("Envoi trop volumineux", 413);
    let body;
    try { body = JSON.parse(raw); } catch (e) { return text("Envoi illisible", 400); }
    const docs = (Array.isArray(body.docs) ? body.docs : []).filter(d => d && typeof d.k === "string" && d.k.length <= 80
      && typeof d.v === "string" && d.v.length <= 1500000).slice(0, 40);
    if (!docs.length) return json({docs: []});
    // Écriture conditionnelle : insérée si nouvelle, remplacée seulement si la révision de base est la bonne.
    const upsert = "INSERT INTO lefil_sync (k, v, rev) VALUES (?, ?, (SELECT COALESCE(MAX(rev), 0) + 1 FROM lefil_sync)) "
      + "ON CONFLICT(k) DO UPDATE SET v = excluded.v, rev = excluded.rev WHERE lefil_sync.rev = ? RETURNING rev";
    const res = await db.batch(docs.map(d => db.prepare(upsert).bind(d.k, d.v, Math.max(0, Number(d.base) || 0))));
    const out = docs.map((d, i) => {
      const r = res[i].results && res[i].results[0];
      return r ? {k: d.k, ok: true, rev: r.rev} : {k: d.k, ok: false};
    });
    const refused = out.filter(o => !o.ok);
    if (refused.length) {                       // un autre appareil est passé avant : on renvoie sa version
      const cur = await db.batch(refused.map(o => db.prepare("SELECT v, rev FROM lefil_sync WHERE k = ?").bind(o.k)));
      refused.forEach((o, i) => { const row = cur[i].results[0]; if (row) { o.v = row.v; o.rev = row.rev; } });
    }
    return json({docs: out});
  } catch (e) {
    return text("Erreur de la base D1 : " + String(e && e.message || e).slice(0, 160), 500);
  }
}

/* ================== VEILLE ET NOTIFICATIONS (téléphone, facultatif) ==================
 * Si une tâche planifiée (« Cron Trigger », toutes les 5 minutes) est ajoutée dans Cloudflare, le relais regarde :
 *   - les 3 premiers sujets « À la une » de Google Actualités France ;
 *   - les titres commençant par ALERTE ou URGENT chez BFMTV et franceinfo.
 * Chaque sujet nouveau est envoyé une seule fois sur le téléphone, via l'appli gratuite ntfy (sujet NTFY_TOPIC).
 * La liste de ce qui a déjà été envoyé est relue chez ntfy (12 dernières heures) : pas de base à créer. */
const UNE_URL = "https://news.google.com/rss?hl=fr&gl=FR&ceid=FR:fr";
const ALERT_FEEDS = [["BFMTV", "https://www.bfmtv.com/rss/news-24-7/"], ["franceinfo", "https://www.franceinfo.fr/titres.rss"]];
const PUSH_TOP = 3;            // les 3 premiers sujets « À la une »
const PUSH_MAX_12H = 8;        // au plus 8 notifications « à la une » par tranche de 12 h
const NUIT = [23, 7];          // pas de notification « à la une » entre 23 h et 7 h (les ALERTE passent toujours)
const MOTS_VIDES = new Set("les des une pour par sur dans avec sans sous vers chez plus tout tous toute cette ces qui que quoi dont mais donc pas etre avoir fait faire selon apres avant depuis contre entre alors aussi encore comment pourquoi quand direct video info apres leur leurs elle ils nous".split(" "));

const decodeEnt = s => s.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
  .replace(/&#(\d+);/g, (m, n) => String.fromCharCode(+n)).replace(/&#x([0-9a-f]+);/gi, (m, n) => String.fromCharCode(parseInt(n, 16)))
  .replace(/&quot;/g, '"').replace(/&apos;|&#39;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&");
const stripTags = s => s.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
function tokens(title) {
  const out = new Set();
  for (let w of title.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, " ").split(" ")) {
    if (w.length < 4 || MOTS_VIDES.has(w) || /^\d+$/.test(w)) continue;
    out.add(w.slice(0, 5));
  }
  return out;
}
function items(xml, max) {
  const out = [], re = /<item\b[\s\S]*?<\/item>/gi;
  let m;
  while ((m = re.exec(xml)) && out.length < max) {
    const b = m[0], get = n => { const r = new RegExp("<" + n + "\\b[^>]*>([\\s\\S]*?)</" + n + ">", "i").exec(b); return r ? decodeEnt(r[1]).trim() : ""; };
    let title = stripTags(get("title"));
    const src = stripTags(get("source"));
    if (src && title.endsWith(" - " + src)) title = title.slice(0, -(src.length + 3));
    const desc = get("description");
    const lies = [...desc.matchAll(/<a\b[^>]*>([\s\S]*?)<\/a>/gi)].map(x => stripTags(x[1]));
    out.push({title, link: stripTags(get("link")), src, date: Date.parse(get("pubDate")), lies});
  }
  return out;
}
async function fetchText(u) {
  try {
    const r = await fetch(u, {headers: {"user-agent": USER_AGENT}, signal: AbortSignal.timeout(10000)});
    return r.ok ? await r.text() : "";
  } catch (e) { return ""; }
}
function heureParis(now) {
  const part = new Intl.DateTimeFormat("en-GB", {timeZone: "Europe/Paris", hour: "numeric", hourCycle: "h23"}).formatToParts(now).find(x => x.type === "hour");
  return part ? Number(part.value) : 12;
}

async function veille(env, opts = {}) {
  const topic = env.NTFY_TOPIC;
  if (!topic) return {erreur: "sujet ntfy absent : ajoute le secret NTFY_TOPIC"};
  const now = opts.now || Date.now();
  // 1. Ce qui a déjà été envoyé (12 h), relu chez ntfy.
  const hist = (await fetchText(`https://ntfy.sh/${topic}/json?poll=1&since=12h`)).split("\n")
    .map(l => { try { return JSON.parse(l); } catch (e) { return null; } }).filter(x => x && x.event === "message");
  const deja = hist.map(x => tokens((x.message || "").split("\n")[0]));
  const nbUne = hist.filter(x => !/^Urgent/.test(x.title || "")).length;
  const connu = cand => deja.some(d => {
    let n = 0; for (const w of d) if (cand.has(w)) n++;
    return n >= 2 && n / Math.max(1, d.size) >= 0.4;
  });
  const envois = [];
  // 2. ALERTE / URGENT chez BFMTV et franceinfo (dernière heure), toujours transmis.
  for (const [nom, u] of ALERT_FEEDS) {
    for (const it of items(await fetchText(u), 20)) {
      if (!/^\s*(ALERTE|URGENT)\b/i.test(it.title) || !(now - it.date < 3600e3)) continue;
      const sig = tokens(it.title);
      if (connu(sig)) continue;
      envois.push({titre: "Urgent · " + nom, texte: it.title, lien: it.link, prio: 5, sig});
      deja.push(sig);
    }
  }
  // 3. Les 3 premiers sujets « À la une » de Google Actualités.
  const h = heureParis(now), nuit = h >= NUIT[0] || h < NUIT[1];
  if (!nuit && nbUne < PUSH_MAX_12H) {
    const une = items(await fetchText(UNE_URL), PUSH_TOP);
    une.forEach((it, i) => {
      const sig = tokens([it.title, ...it.lies].join(" "));
      if (connu(sig) || nbUne + envois.filter(e => e.prio < 5).length >= PUSH_MAX_12H) return;
      envois.push({titre: `Info majeure · ${i === 0 ? "1er" : i + 1 + "e"} sujet à la une`, texte: it.title + (it.src ? "\n" + it.src : ""), lien: it.link, prio: 4, sig});
      deja.push(tokens(it.title));
    });
  }
  // 4. Envoi (au plus 3 par passage).
  const faits = [];
  for (const e of envois.slice(0, 3)) {
    if (opts.essai) { faits.push(e); continue; }
    try {
      const r = await fetch("https://ntfy.sh/", {method: "POST", headers: {"content-type": "application/json"},
        body: JSON.stringify({topic, title: e.titre, message: e.texte, click: e.lien, priority: e.prio, tags: [e.prio === 5 ? "rotating_light" : "newspaper"]})});
      if (r.ok) faits.push(e);
    } catch (err) {}
  }
  return {deja_envoyes_12h: hist.length, nuit, envoyes: faits.map(e => ({titre: e.titre, texte: e.texte}))};
}

/* ================== AIGUILLAGE ================== */
// Un seul Releveur, installé en Europe de l'Ouest (près des médias et de toi).
const releveur = env => env.RELEVEUR.get(env.RELEVEUR.idFromName("fil"), {locationHint: "weur"});

export default {
  // Tâche planifiée (toutes les 10 min) : vérifie seulement que la relève continue de tourner.
  // La veille ntfy (fonction veille plus haut) n'est pas branchée : il faudrait l'ajouter ici.
  async scheduled(event, env, ctx) {
    ctx.waitUntil(releveur(env).fetch("https://releveur/reveil"));
  },

  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/sync") return sync(request, env);
    if (url.pathname === "/fil" || url.pathname === "/direct") return releveur(env).fetch(request);
    // Notifications push : clé publique pour s'abonner, puis abonnement, essai, désabonnement
    if (url.pathname.startsWith("/push/")) return releveur(env).fetch(request);
    if (request.method !== "GET" && request.method !== "HEAD") {
      return text("Méthode non prise en charge", 405);
    }
    if (Object.hasOwn(FICHIERS, url.pathname)) return fichier(url.pathname);
    switch (url.pathname) {
      case "/rss":
        return relay(url.searchParams.get("url"));
      case "/date":
        return articleDate(url.searchParams.get("url"));
      case "/sante":
        return text("Relais du Fil : OK", 200);
      case "/notif-test": {
        // Réservé à qui connaît la clé : sinon n'importe qui pourrait faire sonner le téléphone.
        if (!sameKey(keyOf(request), env.SYNC_KEY)) return text("Clé requise", 401);
        if (!env.NTFY_TOPIC) return text("Sujet ntfy absent : ajoute le secret NTFY_TOPIC", 503);
        const r = await fetch("https://ntfy.sh/", {method: "POST", headers: {"content-type": "application/json"},
          body: JSON.stringify({topic: env.NTFY_TOPIC, title: "Le Fil", message: "Notifications activées : tu recevras ici les infos majeures.", tags: ["white_check_mark"]})}).catch(() => null);
        return text(r && r.ok ? "Notification de test envoyée. Regarde ton téléphone." : "Envoi impossible : ntfy ne répond pas.", r && r.ok ? 200 : 502);
      }
      case "/veille":
        // Montre ce que la veille enverrait maintenant, sans rien envoyer (réservé à qui connaît la clé).
        if (!sameKey(keyOf(request), env.SYNC_KEY)) return text("Clé requise", 401);
        return new Response(JSON.stringify(await veille(env, {essai: true}), null, 1), {headers: {"content-type": "application/json; charset=utf-8", "cache-control": "no-store"}});
      default:
        return text("Introuvable", 404);
    }
  },
};
