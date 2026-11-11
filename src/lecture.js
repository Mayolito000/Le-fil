/*
 * LE FIL · lecture des flux (fonctions pures, testées par tests/lecture.test.mjs)
 */
const cp = n => { try { return String.fromCodePoint(n); } catch (e) { return ""; } };
/* Texte XML -> texte : CDATA gardés tels quels, entités XML décodées. */
export const xml = s => !s ? "" : s.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, (m, c) => c.replace(/&/g, "\u0000"))
  .replace(/&#x([0-9a-f]+);/gi, (m, n) => cp(parseInt(n, 16))).replace(/&#(\d+);/g, (m, n) => cp(+n))
  .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, "&")
  .replace(/\u0000/g, "&");
export const sansBalises = s => s.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
const coupe = (s, n) => s.length > n ? s.slice(0, n) : s;

/* Octets -> texte, selon le charset annoncé par le serveur ou par le prologue XML. */
export function decoder(buf, ct) {
  let cs = (/charset=["']?([\w-]+)/i.exec(ct || "") || [])[1];
  if (!cs) cs = (/encoding=["']([\w-]+)["']/i.exec(new TextDecoder("latin1").decode(buf.slice(0, 300))) || [])[1];
  try { return new TextDecoder(cs || "utf-8").decode(buf); } catch (e) { return new TextDecoder("utf-8").decode(buf); }
}

const BALISE = {};
const balise = n => BALISE[n] || (BALISE[n] = new RegExp("<" + n + "\\b[^>]*>([\\s\\S]*?)</" + n + ">", "i"));
/* Lecture tolérante d'un flux RSS, RDF ou Atom : titre (t), lien (l), date (d), chapô (s), source Google (so, su). */
export function lire(texte, max, brut) {
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
    if (brut) e.r = coupe(xml(get("description")), 6000);   // « À la une » de Google : la grappe d'articles liés
    out.push(e);
  }
  return out;
}

export async function empreinte(buf) {
  const h = new Uint8Array(await crypto.subtle.digest("SHA-1", buf));
  return [...h].map(x => x.toString(16).padStart(2, "0")).join("");
}
export function explique(statut, google) {
  if (google && (statut === 503 || statut === 429)) return `Google Actualités refuse le relais pour l'instant (${statut})`;
  return "Le média a répondu " + statut;
}

/* Heure de Paris : {h, m, jour: "AAAA-MM-JJ"}. */
const FMT_PARIS = new Intl.DateTimeFormat("en-CA", {timeZone: "Europe/Paris", year: "numeric", month: "2-digit", day: "2-digit", hour: "numeric", minute: "numeric", hourCycle: "h23"});
export function paris(t) {
  const p = Object.fromEntries(FMT_PARIS.formatToParts(t).map(x => [x.type, x.value]));
  return {h: Number(p.hour), m: Number(p.minute), jour: `${p.year}-${p.month}-${p.day}`};
}
