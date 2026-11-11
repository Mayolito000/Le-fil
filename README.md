# Le Fil

Fil d'actualité en direct, personnel : une page web et un petit serveur hébergés gratuitement sur Cloudflare Workers.

## Comment ça marche

1. Le **Releveur** (`src/releveur.js`, un Durable Object avec sa base SQLite) lit tous les flux en continu, même quand aucune page n'est ouverte : toutes les 30 s à 5 min selon le rang du flux, sans jamais aller plus vite que ce que le média autorise, et en demandant seulement s'il y a du changement.
2. Chaque dépêche nouvelle est gardée 48 h et **poussée aussitôt** aux pages ouvertes (WebSocket `/direct`).
3. Une page qui s'ouvre récupère d'abord ce qu'elle a manqué (`/fil?depuis=…`), puis reste branchée.
4. Si le Releveur ne répond pas, la page relève elle-même les flux à travers le relais `/rss`, comme avant la version 19.
5. **Notifications** (version 20) : après chaque arrivée de dépêches, le Releveur repère les infos majeures avec la même méthode que la page (`src/majeures.js`, réglages synchronisés : seuil, plafond, médias coupés, sujets ignorés) et prévient les appareils abonnés par Web Push (`src/webpush.js`), même Le Fil fermé. La nuit (23 h – 7 h), seulement l'urgent, si l'appareil l'a demandé. Les clés de notification sont créées par le Releveur et gardées dans sa base.

Le délai entre la publication d'un article et son arrivée dépend surtout du média : son flux RSS est souvent mis à jour quelques minutes après la mise en ligne. La fenêtre Sources montre ce délai médian pour chaque média.

## Organisation

| Fichier | Rôle |
| --- | --- |
| `flux.json` | **La liste des flux** (un par média ou par rubrique). C'est le seul fichier à modifier pour ajouter ou retirer un média. |
| `public/index.html` | La page : affichage, relevés, détection des infos majeures, sujets suivis, synchronisation. |
| `public/sw.js` | Service worker : appli installable, ouverture immédiate, lecture hors connexion. |
| `public/manifest.webmanifest`, `public/icon-*.png` | Nom et icônes de l'appli. |
| `public/le-fil-modele.apkg` | Modèle de cartes Anki. |
| `src/worker.js` | Aiguillage : sert la page, relaie `/fil` et `/direct` vers le Releveur, lit un flux à la demande (`/rss`, sujets suivis et secours), l'heure des articles (`/date`), synchronise les appareils (`/sync`). |
| `src/releveur.js` | Le Releveur : relève en continu, garde 48 h de dépêches, pousse les nouveautés. |
| `src/majeures.js` | Repérage des infos majeures côté serveur (recopie de la méthode de la page). |
| `src/webpush.js` | Notifications push : chiffrement (RFC 8291) et signature VAPID (RFC 8292), sans bibliothèque. |
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

## Offre gratuite de Cloudflare

Tout tient dans l'offre gratuite : environ 9 000 passages du Releveur par jour (limite : 100 000 requêtes), quelques millisecondes de calcul par passage, environ 20 000 écritures par jour dans sa base (limite : 100 000), quelques Mo de stockage (limite : 5 Go). Une tâche planifiée vérifie toutes les 10 minutes que la relève tourne.

## Revenir en arrière

Cloudflare garde toutes les versions mises en ligne : tableau de bord > Workers & Pages > le-fil > Déploiements, puis « Restaurer » sur la version voulue.

## Secrets

Jamais dans le code. À régler une fois dans Cloudflare (Worker > Paramètres > Variables et secrets), ou avec `npx wrangler secret put NOM` :

- `SYNC_KEY` : clé personnelle de synchronisation entre appareils (celle du lien `?cle=…`) ;
- `NTFY_TOPIC` : sujet ntfy des notifications sur téléphone (facultatif).

## Limite connue

Google Actualités refuse presque toutes les requêtes venant des serveurs Cloudflare. Les médias sans flux RSS à eux (AFP, Reuters, Associated Press, Les Échos, La Voix du Nord, Contexte, La Revue des médias, NHK World, Focus Taiwan, The Wire, Het Nieuwsblad) peuvent donc manquer, ainsi que le classement « À la une » de Google.
