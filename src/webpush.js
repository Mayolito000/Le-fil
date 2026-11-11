/*
 * LE FIL · notifications push (protocole Web Push standard, sans service tiers)
 * ---------------------------------------------------------------------------
 * Chiffrement du message pour un appareil (RFC 8291, encodage aes128gcm de la RFC 8188) et signature
 * VAPID (RFC 8292) qui prouve au service de push du navigateur (Google, Mozilla, Apple…) que le
 * message vient bien de ton serveur. Rien d'autre que WebCrypto : aucune bibliothèque.
 *
 * Clés VAPID : générées une fois par le serveur lui-même (nouvellesCles) et gardées dans sa base ;
 * la clé privée ne quitte jamais Cloudflare. cles = {prive: JWK, publique: base64url}.
 */
const enc = s => new TextEncoder().encode(s);
export const b64u = buf => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
export const deb64u = s => { s = s.replace(/-/g, "+").replace(/_/g, "/"); return Uint8Array.from(atob(s + "=".repeat((4 - s.length % 4) % 4)), c => c.charCodeAt(0)); };
const concat = (...parts) => { const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0)); let o = 0; for (const p of parts) { out.set(p, o); o += p.length; } return out; };
async function hmac(cle, donnees) {
  const k = await crypto.subtle.importKey("raw", cle, {name: "HMAC", hash: "SHA-256"}, false, ["sign"]);
  return new Uint8Array(await crypto.subtle.sign("HMAC", k, donnees));
}

/* Chiffre le texte pour l'abonnement (clés p256dh et auth fournies par le navigateur). */
export async function chiffrer(texte, p256dh, auth) {
  const uaPub = deb64u(p256dh), secretAuth = deb64u(auth);
  const eph = await crypto.subtle.generateKey({name: "ECDH", namedCurve: "P-256"}, true, ["deriveBits"]);
  const asPub = new Uint8Array(await crypto.subtle.exportKey("raw", eph.publicKey));
  const uaCle = await crypto.subtle.importKey("raw", uaPub, {name: "ECDH", namedCurve: "P-256"}, false, []);
  const ecdh = new Uint8Array(await crypto.subtle.deriveBits({name: "ECDH", public: uaCle}, eph.privateKey, 256));
  const prkCle = await hmac(secretAuth, ecdh);
  const ikm = await hmac(prkCle, concat(enc("WebPush: info\0"), uaPub, asPub, [1]));
  const sel = crypto.getRandomValues(new Uint8Array(16));
  const prk = await hmac(sel, ikm);
  const cek = (await hmac(prk, concat(enc("Content-Encoding: aes128gcm\0"), [1]))).slice(0, 16);
  const nonce = (await hmac(prk, concat(enc("Content-Encoding: nonce\0"), [1]))).slice(0, 12);
  const k = await crypto.subtle.importKey("raw", cek, "AES-GCM", false, ["encrypt"]);
  const chiffre = new Uint8Array(await crypto.subtle.encrypt({name: "AES-GCM", iv: nonce}, k, concat(enc(texte), [2])));
  const entete = new Uint8Array(21); entete.set(sel); new DataView(entete.buffer).setUint32(16, 4096); entete[20] = 65;
  return concat(entete, asPub, chiffre);
}

/* Paire de clés VAPID toute neuve (ECDSA P-256). */
export async function nouvellesCles() {
  const p = await crypto.subtle.generateKey({name: "ECDSA", namedCurve: "P-256"}, true, ["sign", "verify"]);
  const {kty, crv, x, y, d} = await crypto.subtle.exportKey("jwk", p.privateKey);
  return {prive: {kty, crv, x, y, d}, publique: b64u(await crypto.subtle.exportKey("raw", p.publicKey))};
}

/* En-tête Authorization VAPID pour le service de push de cet abonnement. */
export async function vapid(endpoint, cles, sujet) {
  const aud = new URL(endpoint).origin;
  const tete = b64u(enc(JSON.stringify({typ: "JWT", alg: "ES256"})));
  const corps = b64u(enc(JSON.stringify({aud, exp: Math.floor(Date.now() / 1000) + 12 * 3600, sub: sujet})));
  const cle = await crypto.subtle.importKey("jwk", cles.prive, {name: "ECDSA", namedCurve: "P-256"}, false, ["sign"]);
  const sig = await crypto.subtle.sign({name: "ECDSA", hash: "SHA-256"}, cle, enc(tete + "." + corps));
  return `vapid t=${tete}.${corps}.${b64u(sig)}, k=${cles.publique}`;
}

/* Services de push des navigateurs : on n'envoie qu'à eux (jamais à une adresse quelconque). */
const SERVICES = ["fcm.googleapis.com", "android.googleapis.com", "google.com", "updates.push.services.mozilla.com", "push.services.mozilla.com",
  "web.push.apple.com", "notify.windows.com"];
export function endpointValide(u) {
  try { const x = new URL(u); return x.protocol === "https:" && SERVICES.some(d => x.hostname === d || x.hostname.endsWith("." + d)); }
  catch (e) { return false; }
}

/* Envoie un message à un abonnement. Renvoie le statut HTTP du service de push (201 = remis). */
export async function envoyer(abo, message, cles, sujet, opts = {}) {
  const corps = await chiffrer(JSON.stringify(message), abo.keys.p256dh, abo.keys.auth);
  const r = await fetch(abo.endpoint, {
    method: "POST",
    headers: {"content-encoding": "aes128gcm", "content-type": "application/octet-stream", "ttl": String(opts.ttl || 3 * 3600),
      "urgency": opts.urgence || "high", "authorization": await vapid(abo.endpoint, cles, sujet)},
    body: corps,
  });
  try { await r.body?.cancel(); } catch (e) {}
  return r.status;
}
