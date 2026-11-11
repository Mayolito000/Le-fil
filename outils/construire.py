"""Construit Le Fil à partir de ses sources uniques :
  - flux.json -> constante FEEDS de public/index.html, et src/hotes.js (domaines que le relais peut lire) ;
  - src/majeures.js (zone <partage>) -> recopiée dans public/index.html, pour que la page et le serveur
    repèrent les infos majeures et les sujets suivis exactement de la même façon.

Usage, depuis le dossier du projet :
  python3 outils/construire.py             met à jour les fichiers générés
  python3 outils/construire.py --verifier  échoue si un fichier généré n'est pas à jour (tests automatiques)
"""
import sys
import json
import os
import re
from urllib.parse import urlparse, unquote

ICI = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
chemin = lambda *p: os.path.join(ICI, *p)

# Domaines d'articles qui ne se déduisent pas de l'adresse du flux (flux hébergés ailleurs, etc.).
ARTICLES_EN_PLUS = {"bbci.co.uk", "bbc.com", "euronews.com", "leparisien.fr", "mercopress.com", "rtbf.be",
                    "feedburner.com", "directvelo.com", "scroll.in", "lequipe.fr", "nytimes.com"}
PREFIXES = ("www.", "feeds.", "rss.", "dwh.", "en.", "fr.")


def domaine(hote):
    for p in PREFIXES:
        if hote.startswith(p):
            return hote[len(p):]
    return hote


def main():
    flux = json.load(open(chemin("flux.json"), encoding="utf-8"))
    hotes, articles = set(), set(ARTICLES_EN_PLUS)
    for f in flux:
        for u in (f["u"], f.get("b")):
            if u:
                hotes.add(urlparse(u).hostname)
        if not f.get("g"):
            articles.add(domaine(urlparse(f["u"]).hostname))
            m = re.search(r"site:([\w.-]+)", unquote(f.get("b") or ""))
            if m:
                articles.add(m.group(1))
    hotes.discard(None)

    page_chemin = chemin("public", "index.html")
    page_avant = open(page_chemin, encoding="utf-8").read()
    ligne = "const FEEDS = " + json.dumps(flux, ensure_ascii=False, separators=(",", ":")) + ";"
    page, n = re.subn(r"^const FEEDS = \[.*\];$", lambda m: ligne, page_avant, count=1, flags=re.M)
    assert n == 1, "constante FEEDS introuvable dans public/index.html"

    # Code commun : la zone <partage> de src/majeures.js, sans les « export »
    module = open(chemin("src", "majeures.js"), encoding="utf-8").read()
    m = re.search(r"^// <partage>.*?$(.*?)^// </partage>$", module, flags=re.M | re.S)
    assert m, "zone <partage> introuvable dans src/majeures.js"
    commun = re.sub(r"^export ", "", m.group(1).strip("\n"), flags=re.M)
    page, n = re.subn(r"^// <partage majeures\.js>[^\n]*$.*?^// </partage>$",
                      lambda _: "// <partage majeures.js> (recopié de src/majeures.js par outils/construire.py : ne pas modifier ici)\n" + commun + "\n// </partage>",
                      page, count=1, flags=re.M | re.S)
    assert n == 1, "repères <partage majeures.js> introuvables dans public/index.html"

    hotes_js = ("// Fichier généré par outils/construire.py à partir de flux.json : ne pas modifier à la main.\n"
                "// Sites dont le relais peut lire les flux.\n"
                "export const ALLOWED_HOSTS = new Set(" + json.dumps(sorted(hotes)) + ");\n"
                "// Sites dont le relais peut ouvrir une page d'article, uniquement pour y lire l'heure de publication.\n"
                "export const ARTICLE_DOMAINS = " + json.dumps(sorted(articles)) + ";\n")
    hotes_chemin = chemin("src", "hotes.js")
    hotes_avant = open(hotes_chemin, encoding="utf-8").read() if os.path.exists(hotes_chemin) else ""

    if "--verifier" in sys.argv:
        perimes = [nom for nom, avant, apres in (("public/index.html", page_avant, page), ("src/hotes.js", hotes_avant, hotes_js)) if avant != apres]
        if perimes:
            sys.exit("Fichiers générés pas à jour : " + ", ".join(perimes) + " (lancer python3 outils/construire.py)")
        print("Fichiers générés à jour.")
        return
    open(page_chemin, "w", encoding="utf-8").write(page)
    open(hotes_chemin, "w", encoding="utf-8").write(hotes_js)
    print(f"{len(flux)} flux ({sum(1 for f in flux if f.get('g'))} via Google, {sum(1 for f in flux if f.get('pa'))} pages d'accueil), {len(hotes)} sites de flux, {len(articles)} domaines d'articles")


if __name__ == "__main__":
    main()
