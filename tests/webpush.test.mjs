// Notifications : le message chiffré par le serveur se déchiffre comme dans le navigateur (RFC 8291), signature VAPID valide.
import {test} from "node:test";
import assert from "node:assert/strict";
import {chiffrer, vapid, b64u, deb64u, endpointValide, nouvellesCles} from "../src/webpush.js";

const subtle = crypto.subtle, enc = s => new TextEncoder().encode(s);
const concat = (...p) => { const o = new Uint8Array(p.reduce((n, x) => n + x.length, 0)); let i = 0; for (const x of p) { o.set(x, i); i += x.length; } return o; };
const hmac = async (k, d) => new Uint8Array(await subtle.sign("HMAC", await subtle.importKey("raw", k, {name: "HMAC", hash: "SHA-256"}, false, ["sign"]), d));

test("chiffrement aes128gcm déchiffré par le « navigateur »", async () => {
  const ua = await subtle.generateKey({name: "ECDH", namedCurve: "P-256"}, true, ["deriveBits"]);
  const uaPub = new Uint8Array(await subtle.exportKey("raw", ua.publicKey)), auth = crypto.getRandomValues(new Uint8Array(16));
  const message = JSON.stringify({titre: "Info majeure · 7 médias", texte: "Séisme au Japon", lien: "https://exemple.fr/a"});
  const corps = await chiffrer(message, b64u(uaPub), b64u(auth));
  const sel = corps.slice(0, 16), idlen = corps[20], asPub = corps.slice(21, 21 + idlen), ct = corps.slice(21 + idlen);
  assert.equal(new DataView(corps.buffer).getUint32(16), 4096);
  const asCle = await subtle.importKey("raw", asPub, {name: "ECDH", namedCurve: "P-256"}, false, []);
  const ecdh = new Uint8Array(await subtle.deriveBits({name: "ECDH", public: asCle}, ua.privateKey, 256));
  const prk = await hmac(sel, await hmac(await hmac(auth, ecdh), concat(enc("WebPush: info\0"), uaPub, asPub, [1])));
  const cek = (await hmac(prk, concat(enc("Content-Encoding: aes128gcm\0"), [1]))).slice(0, 16);
  const nonce = (await hmac(prk, concat(enc("Content-Encoding: nonce\0"), [1]))).slice(0, 12);
  const clair = new Uint8Array(await subtle.decrypt({name: "AES-GCM", iv: nonce}, await subtle.importKey("raw", cek, "AES-GCM", false, ["decrypt"]), ct));
  assert.equal(clair[clair.length - 1], 2);
  assert.equal(new TextDecoder().decode(clair.slice(0, -1)), message);
});

test("signature VAPID vérifiable avec la clé publique", async () => {
  const cles = JSON.parse(JSON.stringify(await nouvellesCles()));
  const h = await vapid("https://fcm.googleapis.com/fcm/send/abc", cles, "https://le-fil.exemple.dev");
  const [, t, k] = /^vapid t=([^,]+), k=(.+)$/.exec(h);
  const [a, b, sig] = t.split(".");
  const pub = await subtle.importKey("raw", deb64u(k), {name: "ECDSA", namedCurve: "P-256"}, false, ["verify"]);
  assert.ok(await subtle.verify({name: "ECDSA", hash: "SHA-256"}, pub, deb64u(sig), enc(a + "." + b)));
  assert.equal(JSON.parse(new TextDecoder().decode(deb64u(b))).aud, "https://fcm.googleapis.com");
});

test("on n'envoie qu'aux services de push des navigateurs", () => {
  assert.ok(endpointValide("https://fcm.googleapis.com/fcm/send/x"));
  assert.ok(endpointValide("https://web.push.apple.com/x"));
  assert.ok(!endpointValide("https://exemple.com/x"));
  assert.ok(!endpointValide("http://fcm.googleapis.com/x"));
});
