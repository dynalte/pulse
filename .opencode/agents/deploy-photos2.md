---
description: Déploie Pulse (messagerie) sur photos2 (build PWA + API PHP + vérifications)
mode: subagent
permission:
  bash: allow
  edit: allow
  read: allow
---

Tu déploies l'application **Pulse** (projet `messagerie`) sur le serveur photos2
(`root@photos2.dynaspirit.com`, alias SSH `photos2` si configuré).

Cibles serveur (volume Docker PHP `/srv/web/photos` → `/var/www/html`) :
- **Front PWA** (dist/) → `/srv/web/photos/pulse/`
  → https://photos2.dynaspirit.com/pulse/
- **API PHP** → `/srv/web/photos/api-messagerie.php`
  → https://photos2.dynaspirit.com/api-messagerie.php
- **Données** (créées par l'API, ne jamais écraser) :
  - `/srv/web/photos/data/messagerie.sqlite`
  - `/srv/web/photos/data/messagerie-media/`
  - protégées par `/srv/web/photos/data/.htaccess` (`Require all denied`)
- Conteneur PHP : `php-php-1` (Apache + mod_php 8.3, docroot `/var/www/html`).
  Le PHP CLI n'existe pas sur l'hôte : toujours linter avec
  `docker exec php-php-1 php -l /var/www/html/api-messagerie.php`.

Étapes obligatoires, dans l'ordre :

1. `npm run build` depuis la racine du projet. Stop si le build échoue.
2. `ssh root@photos2.dynaspirit.com "mkdir -p /srv/web/photos/pulse"`
3. `scp -r dist/* root@photos2.dynaspirit.com:/srv/web/photos/pulse/`
4. `scp api/api-messagerie.php root@photos2.dynaspirit.com:/srv/web/photos/api-messagerie.php`
   `scp scripts/reset-password.php root@photos2.dynaspirit.com:/srv/web/photos/pulse-reset.php`
5. Vérification serveur (une seule commande SSH) :
   ```sh
   ssh root@photos2.dynaspirit.com "
     ls -l --time-style=long-iso /srv/web/photos/api-messagerie.php /srv/web/photos/pulse/index.html
     docker exec php-php-1 php -l /var/www/html/api-messagerie.php
     curl -sk -o /dev/null -w 'API ping: %{http_code}\n' 'https://photos2.dynaspirit.com/api-messagerie.php?action=ping'
     curl -sk -o /dev/null -w 'Web pulse: %{http_code}\n' 'https://photos2.dynaspirit.com/pulse/'
     curl -sk -o /dev/null -w 'Manifest: %{http_code}\n' 'https://photos2.dynaspirit.com/pulse/manifest.webmanifest'
     curl -sk -o /dev/null -w 'Service worker: %{http_code}\n' 'https://photos2.dynaspirit.com/pulse/sw.js'
     curl -sk -o /dev/null -w 'DB protégée: %{http_code}\n' 'https://photos2.dynaspirit.com/data/messagerie.sqlite'
     curl -sk -o /dev/null -w 'Reset script web (doit être 404): %{http_code}\n' 'https://photos2.dynaspirit.com/pulse-reset.php'
   "
   ```
   Attendu : `API ping: 200`, `Web pulse: 200`, `Manifest: 200`, `Service worker: 200`,
   `DB protégée: 403`, `Reset script web: 404`, et `No syntax errors detected` pour `php -l`.
6. Résume : dates/heures des fichiers déployés, résultat `php -l` et codes HTTP.

Premier déploiement / administration :
- La première fois (base absente), l'app permet de créer le compte admin via l'écran
  de configuration. Pour sécuriser immédiatement une instance publique, provisionner
  l'admin via l'API puis demander à l'utilisateur de changer e-mail + mot de passe :
  ```sh
  curl -sk -X POST 'https://photos2.dynaspirit.com/api-messagerie.php?action=bootstrap' \
    -H 'Content-Type: application/json' \
    -d '{"name":"Administrateur","email":"admin@pulse.local","username":"admin","password":"<mot-de-passe-fort>"}'
  ```
- Ne jamais réinitialiser la base ni supprimer `data/messagerie.sqlite` sans demande explicite.
- Réinitialisation de mot de passe (secours, après déploiement) :
  ```sh
  ssh root@photos2.dynaspirit.com \
    "docker exec php-php-1 php /var/www/html/pulse-reset.php <login-ou-email> <nouveau-mot-de-passe>"
  ```
  Le script révoque toutes les sessions du compte. Il est copié par `npm run deploy:api`.
- Ne commit jamais. Ne touche jamais aux autres applications du dossier `photos`.

Note : le front est en hash routing (`#/…`), donc aucun rewrite serveur n'est nécessaire
pour `/pulse/`. L'URL API par défaut de l'app est la racine du domaine
(`/api-messagerie.php`), ce qui correspond à ce déploiement.

État de l'instance au 29/10/2026 : déployée sous `/pulse/`, compte administrateur
provisionné, base `/srv/web/photos/data/messagerie.sqlite` non vide.
Ne pas relancer `bootstrap` (répondrait 403) ni supprimer la base sans demande explicite.
