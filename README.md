# Le Fil

Fil d'actualité en direct, personnel : une page web et un petit relais hébergés gratuitement sur Cloudflare Workers.

## Organisation

| Fichier | Rôle |
| --- | --- |
| `flux.json` | **La liste des flux** (un par média ou par rubrique). C'est le seul fichier à modifier pour ajouter ou retirer un média. |
| `public/index.html` | La page : affichage, relevés, détection des infos majeures, sujets suivis, synchronisation. |
| `public/sw.js` | Service worker : appli installable, ouverture immédiate, lecture hors connexion. |
| `public/manifest.webmanifest`, `public/icon-*.png` | Nom et icônes de l'appli. |
| `public/le-fil-modele.apkg` | Modèle de cartes Anki. |
| `src/worker.js` | Le relais : lit les flux à la place du navigateur (`/rss`), l'heure des articles (`/date`), synchronise les appareils (`/sync`). |
| `src/hotes.js` | Sites que le relais a le droit de lire. **Généré** à partir de `flux.json`, ne pas modifier à la main. |
| `outils/construire.py` | Reporte `flux.json` dans la page et régénère `src/hotes.js`. |
| `wrangler.jsonc` | Configuration Cloudflare (nom du Worker, base D1 de synchronisation). |

## Champs d'un flux (`flux.json`)

- `n` nom du média, `u` adresse du flux, `r` rubrique par défaut, `l` langue ;
- `t` rythme de relevé : 1 = 1 min, 2 = 3 min, 3 = 5 min, 4 = 10 min ;
- `b` adresse de secours (Google Actualités) si le flux du média est bloqué ;
- `q` plafond de dépêches par 24 h (pour les flux très bavards) ;
- `g` + `sites` requête Google Actualités groupée, pour les médias sans flux à eux ;
- `v: "velo"`, `cy`, `pays` : presse vélo de la vue Cyclisme.

## Mettre en ligne

```
npm install
npm run deployer-test   # version de test : le-fil-test.<sous-domaine>.workers.dev
npm run deployer        # le vrai site : le-fil.<sous-domaine>.workers.dev
```

Il faut un jeton d'API Cloudflare (modèle « Modifier les Workers Cloudflare ») dans la variable `CLOUDFLARE_API_TOKEN`.

## Revenir en arrière

Cloudflare garde toutes les versions mises en ligne : tableau de bord > Workers & Pages > le-fil > Déploiements, puis « Restaurer » sur la version voulue.

## Secrets

Jamais dans le code. À régler une fois dans Cloudflare (Worker > Paramètres > Variables et secrets), ou avec `npx wrangler secret put NOM` :

- `SYNC_KEY` : clé personnelle de synchronisation entre appareils (celle du lien `?cle=…`) ;
- `NTFY_TOPIC` : sujet ntfy des notifications sur téléphone (facultatif).

## Limite connue

Google Actualités refuse presque toutes les requêtes venant des serveurs Cloudflare. Les médias sans flux RSS à eux (AFP, Reuters, Associated Press, Les Échos, La Voix du Nord, Contexte, La Revue des médias, NHK World, Focus Taiwan, The Wire, Het Nieuwsblad) peuvent donc manquer, ainsi que le classement « À la une » de Google.
