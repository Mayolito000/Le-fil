"""Construit Le Fil à partir de la liste unique des flux (flux.json) :
  - remplace la constante FEEDS de public/index.html ;
  - écrit src/hotes.js : domaines que le relais a le droit de lire (flux) et d'ouvrir (heure des articles).

Usage, depuis le dossier du projet : python3 outils/construire.py
"""
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
    page = open(page_chemin, encoding="utf-8").read()
    ligne = "const FEEDS = " + json.dumps(flux, ensure_ascii=False, separators=(",", ":")) + ";"
    page, n = re.subn(r"^const FEEDS = \[.*\];$", lambda m: ligne, page, count=1, flags=re.M)
    assert n == 1, "constante FEEDS introuvable dans public/index.html"
    open(page_chemin, "w", encoding="utf-8").write(page)

    with open(chemin("src", "hotes.js"), "w", encoding="utf-8") as fh:
        fh.write("// Fichier généré par outils/construire.py à partir de flux.json : ne pas modifier à la main.\n")
        fh.write("// Sites dont le relais peut lire les flux.\n")
        fh.write("export const ALLOWED_HOSTS = new Set(" + json.dumps(sorted(hotes)) + ");\n")
        fh.write("// Sites dont le relais peut ouvrir une page d'article, uniquement pour y lire l'heure de publication.\n")
        fh.write("export const ARTICLE_DOMAINS = " + json.dumps(sorted(articles)) + ";\n")
    print(f"{len(flux)} flux ({sum(1 for f in flux if f.get('g'))} via Google), {len(hotes)} sites de flux, {len(articles)} domaines d'articles")


if __name__ == "__main__":
    main()
