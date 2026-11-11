// Lecture des flux : RSS, Atom, CDATA, entités, source Google, encodage, heure de Paris.
import {test} from "node:test";
import assert from "node:assert/strict";
import {lire, decoder, xml, paris} from "../src/lecture.js";

test("RSS : titre, lien, date, chapô, CDATA et entités", () => {
  const rss = `<?xml version="1.0"?><rss><channel><title>Le Média</title>
    <item><title><![CDATA[Grève : la SNCF & la RATP <b>perturbées</b>]]></title><link>https://exemple.fr/a?xtor=RSS</link>
      <pubDate>Wed, 11 Nov 2026 08:30:00 +0100</pubDate><description>&lt;p&gt;Trafic très perturbé&lt;/p&gt;</description></item>
    <item><title>Sans lien</title></item>
    <item><title>L&#8217;Assemblée vote le budget</title><guid>https://exemple.fr/b</guid></item>
  </channel></rss>`;
  const e = lire(rss, 10);
  assert.equal(e.length, 2);
  assert.equal(e[0].t, "Grève : la SNCF & la RATP perturbées");
  assert.equal(e[0].l, "https://exemple.fr/a?xtor=RSS");
  assert.equal(e[0].d, Date.parse("2026-11-11T07:30:00Z"));
  assert.equal(e[0].s, "Trafic très perturbé");
  assert.equal(e[1].t, "L’Assemblée vote le budget");
  assert.equal(e[1].l, "https://exemple.fr/b");
  assert.equal(e[1].d, null);
});

test("Atom : lien rel=alternate, date updated", () => {
  const atom = `<feed xmlns="http://www.w3.org/2005/Atom"><entry><title>Un titre</title>
    <link rel="self" href="https://exemple.fr/self"/><link rel="alternate" href="https://exemple.fr/article"/>
    <updated>2026-11-11T09:00:00Z</updated><summary>Résumé</summary></entry></feed>`;
  const [e] = lire(atom, 10);
  assert.equal(e.l, "https://exemple.fr/article");
  assert.equal(e.d, Date.parse("2026-11-11T09:00:00Z"));
});

test("Google Actualités : média d'origine et grappe brute", () => {
  const g = `<rss><channel><item><title>Un fait - Le Monde</title><link>https://news.google.com/rss/articles/x</link>
    <source url="https://www.lemonde.fr">Le Monde</source><description>&lt;ol&gt;&lt;li&gt;lié&lt;/li&gt;&lt;/ol&gt;</description></item></channel></rss>`;
  const [e] = lire(g, 10, true);
  assert.equal(e.so, "Le Monde");
  assert.equal(e.su, "https://www.lemonde.fr");
  assert.match(e.r, /<li>lié<\/li>/);
});

test("encodage annoncé par le prologue XML", () => {
  const latin = Buffer.from('<?xml version="1.0" encoding="ISO-8859-1"?><rss><item><title>caf\xe9</title></rss>', "latin1");
  assert.match(decoder(latin.buffer.slice(latin.byteOffset, latin.byteOffset + latin.length), "application/xml"), /café/);
  assert.equal(xml("a &amp; b &lt;c&gt; <![CDATA[&amp;]]>"), "a & b <c> &amp;");
});

test("heure de Paris", () => {
  assert.deepEqual(paris(Date.parse("2026-11-11T06:35:00Z")), {h: 7, m: 35, jour: "2026-11-11"});
  assert.deepEqual(paris(Date.parse("2026-07-01T22:10:00Z")), {h: 0, m: 10, jour: "2026-07-02"});
});
