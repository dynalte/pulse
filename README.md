# Pulse — messagerie privée (Ionic React PWA + API PHP/SQLite)

Pulse est une messagerie type WhatsApp, pensée pour un cercle privé (famille, amis, petite équipe).
Comptes **sur invitation**, discussions directes et groupes, photos, documents, messages vocaux,
recherche, réactions, accusés de lecture, notifications Web Push et panneau d’administration.

- **Frontend** : Ionic 8 + React 19 + Vite, PWA installable (hash routing, mobile-first).
- **Backend** : un seul fichier PHP (`api/api-messagerie.php`) + SQLite, même esprit que `liste-courses`.
- **Temps réel** : flux SSE (`stream`) avec repli automatique sur le polling `sync`.
- **Design** : thème sombre/clair/système, 4 accents, layout 3 colonnes sur desktop et plein écran sur mobile.

---

## 1. Fonctionnalités

### Comptes & invitations
- **Bootstrap** : au premier lancement, création du **compte administrateur** (le vôtre).
- Ensuite, **inscriptions fermées** : chaque compte est créé avec un **code/lien d’invitation**
  (usage unique ou multiple, nominatif, expiration, rôle membre ou admin).
- Connexion par e-mail **ou** identifiant, mot de passe hashé, sessions révocables.
- Recherche d’utilisateurs (nom, `@identifiant`, e-mail), annuaire des membres.
- **Demandes de contact** : envoi, acceptation, refus, annulation et demandes croisées
  acceptées automatiquement. Les contacts acceptés sont seuls à pouvoir démarrer une
  conversation privée ; les invitations créent un contact direct avec l’invitant.
- Fiche utilisateur : avatar, bio, téléphone, dernière connexion, groupes communs, blocage, message direct.

### Messagerie
- Conversations **directes** et **groupes** (jusqu’à 250 membres), rôles propriétaire/admin/membre.
- Texte, **photos** (compression client + validation serveur), **documents**, **messages vocaux**
  (MediaRecorder, waveform, lecture 1×/1,5×/2×).
- Réponses citées, **réactions emoji**, **édition** (15 min), **suppression pour moi / pour tous**,
  **transfert** vers une ou plusieurs conversations, **messages favoris**.
- Accusés **envoyé / distribué / lu** (info détaillée), indicateur de saisie, présence en ligne.
- **Messages éphémères** 24 h / 7 j / 90 j, mode « seuls les admins écrivent ».
- **Sondages** via une entrée unique : choix simple ou **sondage de dates façon Doodle**
  (plusieurs dates proposées, heures optionnelles, cases à cocher multiples, noms des participants
  et meilleure date mise en avant), résultats en direct, vote modifiable. **Épinglage d’un message**
  avec bandeau en haut du chat,
  **@mentions** surlignées avec filtre « Mentions » et push dédié.
- **Partage de position** ponctuel ou **en direct 15 min / 1 h**, avec arrêt visible par tous.
- Recherche **globale** (conversations, personnes, messages) et **dans une conversation** avec saut au message.
- Brouillons locaux, épinglage, archivage, sourdine, marquage lu, suppression de conversation.
- Blocage d’un contact, confidentialité de la dernière connexion et de la photo de profil.

### Groupes & médias
- Création de groupe avec photo, description, ajout/retrait de membres, promotion admin.
- **Lien d’invitation de groupe** révocable, arrivée sans historique (les nouveaux membres voient les
  messages à partir de leur arrivée).
- Galerie des photos, fichiers et vocaux partagés ; messages favoris.

### Notifications & PWA
- **Web Push** (VAPID + AES-128-GCM, implémentation PHP native, testée par `scripts/test-push.php`).
- Préférences : push on/off, messages privés, groupes, aperçu, son, badge.
- Son local, badge sur l’icône PWA, notification cliquable qui ouvre la bonne conversation.
- **Réponse rapide depuis la notification** (Android/Chrome) : action « Répondre » vers une page
  légère (`reply.html`) et action « Marquer lu », sans session ouverte.
- Installation PWA (Chrome/Edge/Android ; iOS 16.4+ via « Sur l’écran d’accueil »).
- Thèmes sombre/clair/système et 4 couleurs d’accent, mémorisés sur l’appareil.

### Administration
- Statistiques (comptes, en ligne, conversations, messages, médias, stockage).
- Gestion des comptes : promotion/rétrogradation, activation/désactivation (sessions révoquées).
- Gestion de **toutes** les invitations.
- Changement de mot de passe (déconnecte les autres appareils).

### Extras « proches de WhatsApp »
Réactions, réponses, transferts, favoris, édition, suppression, messages éphémères, sourdine,
épinglage, archivage, brouillons, aperçu des médias, galerie, fiches membres, présence/typing,
blocage, confidentialité, recherche, badge PWA, thème clair, accents, panneau admin.

**Non inclus volontairement (roadmap)** : appels audio/vidéo, statuts/stories 24 h, chiffrement
de bout en bout, envoi d’e-mails transactionnels, sauvegarde automatique, mode hors-ligne complet,
FTS5, applications natives Capacitor.

---

## 2. Démarrage rapide

Prérequis :
- Node.js ≥ 20
- PHP ≥ 8.2 avec `pdo_sqlite`, `sqlite3`, `openssl`, `fileinfo`, `mbstring`, `curl` (push), `gd` (redimensionnement images, recommandé)

```sh
npm install

# Terminal 1 — API PHP (port 8110)
npm run api

# Terminal 2 — front Vite (port 8102, proxy /api-messagerie.php vers 8110)
npm run dev
```

Ouvrir <http://localhost:8102>. La première page propose de **créer le compte administrateur**.
L’URL par défaut de l’API est `http://localhost:8102/api-messagerie.php`, proxifiée par Vite.

> `php` doit être dans le PATH. En dev, `npm run api` utilise
> `PHP_CLI_SERVER_WORKERS=4 php -S 127.0.0.1:8110 -t api api/router.php` (le routeur interdit
> l’accès direct à `api/data/`). Les workers sont nécessaires pour que le flux SSE ne bloque
> pas les autres requêtes du serveur intégré.

---

## 3. Déploiement production

### Déploiement actuel sur photos2

L’instance est publiée sur le serveur `photos2` :

- **Web** : https://pulse.dynaspirit.com/
- **API** : https://pulse.dynaspirit.com/api-messagerie.php
- **URL historique** : https://photos2.dynaspirit.com/pulse/ (toujours servie)
- **Données serveur** : `/srv/web/photos/data/messagerie.sqlite` + `data/messagerie-media/`
- **Conteneur PHP** : `php-php-1` (Apache + mod_php 8.3), docroot `/var/www/html`

Le sous-domaine `pulse.dynaspirit.com` est servi à la racine par un vhost Apache
dédié (`/srv/php/pulse-vhost.conf`, monté sur
`/etc/apache2/sites-enabled/pulse.conf` dans le conteneur). Son `DocumentRoot`
pointe sur `/var/www/html/pulse`, et `/api-messagerie.php` est aliasé vers
`/var/www/html/api-messagerie.php` pour partager la même base. Le vhost par
défaut (`photos2.dynaspirit.com`) n’est pas modifié.

Commandes :

```sh
npm run deploy       # build + copie dist/ → /srv/web/photos/pulse/ + API PHP
npm run deploy:web   # front uniquement
npm run deploy:api   # API + script de réinitialisation
```

Le détail opérationnel est aussi conservé dans `.opencode/agents/deploy-photos2.md`
pour les agents de déploiement.

> L’instance `photos2` est déjà initialisée avec un compte administrateur temporaire.
> Se connecter puis modifier **immédiatement** l’e-mail, le nom et le mot de passe dans
> **Réglages** (l’e-mail est modifiable depuis cette version).

### Arborescence type

```
/var/www/pulse/                 ← fichiers du build (dist/)
  index.html
  assets/
  sw.js, manifest.webmanifest, icônes…
  api-messagerie.php            ← copie de api/api-messagerie.php
  data/                         ← créé automatiquement (SQLite + médias)
```

### Étapes

1. `npm run build` puis copier `dist/*` sur le serveur.
2. Copier `api/api-messagerie.php` dans le même dossier (ou à la racine du domaine, selon votre choix).
3. Rendre `data/` inscriptible par PHP (`0770`, utilisateur PHP). Le dossier est créé au 1er appel.
4. Servir **en HTTPS** (obligatoire pour Web Push, micro, caméra et installation PWA).
5. Configurer l’URL de l’API depuis l’écran de connexion (roue « Serveur ») ou les Réglages.
   Par défaut l’app appelle `https://votre-domaine/api-messagerie.php`.
6. Si l’API est sur un autre domaine, garder `Access-Control-Allow-Origin: *` (déjà configuré).
7. **Protéger `data/`** : le fichier `data/.htaccess` est généré automatiquement pour Apache.
   En Nginx, ajouter :
   ```nginx
   location ^~ /data/ { deny all; return 403; }
   ```
   Les médias ne sont servis que par `?action=media_get`, après vérification d’appartenance.
8. Limites d’upload : `api/.user.ini` (`upload_max_filesize=32M`, `post_max_size=34M`).
   Adapter aussi `client_max_body_size` côté Nginx.
9. Sauvegarde : copier `data/` à chaud avec `sqlite3 data/messagerie.sqlite ".backup ..."`,
   ou arrêter brièvement PHP. Les médias sont dans `data/messagerie-media/`.

### Réinitialiser un mot de passe (secours admin)

Si l’administrateur perd son mot de passe, exécuter sur le serveur :

```sh
php scripts/reset-password.php alex nouveau-mot-de-passe
```

Le script révoque toutes les sessions du compte. Il faut un accès shell au serveur.
Sur photos2, le script est déployé à la racine et s’exécute dans le conteneur PHP :

```sh
ssh root@photos2.dynaspirit.com \
  "docker exec php-php-1 php /var/www/html/pulse-reset.php alex nouveau-mot-de-passe"
```

### Variables / constantes utiles (`api/api-messagerie.php`)

| Constante | Défaut | Rôle |
|---|---|---|
| `ALLOW_MEMBER_INVITES` | `true` | Autoriser tous les membres à créer des invitations |
| `MAX_GROUP_MEMBERS` | `250` | Taille maximale d’un groupe |
| `MAX_UPLOAD` | 30 Mo | Taille max d’un fichier |
| `SESSION_TTL` | 1 an | Durée de validité d’une session |
| `VAPID_SUBJECT` | `mailto:admin@pulse.local` | Sujet VAPID (remplacé automatiquement par `https://<hôte>` côté push) |

Après modification, aucun redémarrage n’est nécessaire (PHP est relu à chaque requête),
sauf pour `.user.ini` (redémarrer PHP-FPM).

### Nginx — exemple

```nginx
server {
  listen 443 ssl http2;
  server_name pulse.example.com;
  root /var/www/pulse;
  index index.html;

  location / { try_files $uri $uri/ /index.html; }
  location ^~ /data/ { deny all; return 403; }
  location ~ \.php$ {
    include fastcgi_params;
    fastcgi_param SCRIPT_FILENAME $document_root$fastcgi_script_name;
    fastcgi_pass unix:/run/php/php8.3-fpm.sock;
  }
  client_max_body_size 34m;
}
```

Avec le routage en **hash** (`/#/chat/12`), aucun rewrite particulier n’est nécessaire
hors le fallback `index.html`.

---

## 4. Temps réel : SSE, avec polling de secours

Le serveur pousse les changements par **Server-Sent Events** (`?action=stream`) ; le polling
`sync` reste actif comme filet de sécurité si le flux tombe.

- `stream?conversationId=…` quand une conversation est ouverte (messages, réactions, saisie,
  présence, accusés de lecture), et `stream` global pour la liste, les badges et les notifications ;
- le serveur vérifie l’état toutes les **700 ms** et n’émet un événement que si quelque chose
  a changé (empreinte légère sur `messages`, `conversations`, `typing`, `read_states`, présence) ;
- la connexion est volontairement **courte (~20 s)** puis renouvelée automatiquement par le client :
  cela reste compatible avec Apache/mod_php, les proxys et les limites d’exécution PHP ;
- commentaire `: ping` toutes les 10 s pour maintenir la connexion et détecter les coupures ;
- le polling de secours passe à **15 s** quand le flux est actif (au lieu de 2,5 s / 6 s quand il
  est indisponible), et un tick immédiat est déclenché à la reconnexion ;
- `visibilitychange` ferme le flux quand l’onglet est masqué (Web Push prend le relais) et le
  rouvre au retour au premier plan ;
- heartbeat implicite : chaque requête authentifiée met à jour `last_seen` (présence) ;
- l’indicateur de saisie reste stocké en base avec expiration à 7 s.

**Pourquoi SSE et pas WebSocket ?** Apache + `mod_php` ne peut pas héberger un WebSocket sans
processus séparé (Node, Ratchet, proxy WS…). SSE utilise l’API existante, le même modèle de
données et le même déploiement. Chaque flux ouvert immobilise un worker Apache pendant ~20 s :
pour quelques dizaines d’utilisateurs c’est négligeable, mais au-delà de quelques centaines de
connexions simultanées, passer à un serveur WebSocket dédié devient pertinent — la couche
`SyncStream` (`src/services/realtime.ts`) isole déjà le transport.

> Le jeton de session transite par `?session=` pour le flux, car `EventSource` ne permet pas
> d’envoyer l’en-tête `X-Session-Token`. Les journaux serveur contiennent donc l’URL du flux :
> pensez à les protéger ou à passer à un cookie de session si cela pose problème.

---

## 5. API

Toutes les actions passent par `?action=…`. Auth : header `X-Session-Token`
(ou `?session=` pour les cas média). Réponse JSON `{ ok: true, … }` ou `{ ok: false, error }`.

### Publiques
`ping`, `bootstrap_status`, `bootstrap`, `login`, `register`, `invite_info`, `push_key`

### Authentifiées
- Compte : `me`, `heartbeat`, `profile_get`, `profile_update`, `password_change`, `user_search`,
  `directory`, `block_user`, `unblock_user`, `logout`
- Invitations : `invites_list`, `invite_create`, `invite_revoke`
- Conversations : `conversations_list`, `conversation_get`, `conversation_create_direct`,
  `conversation_create_group`, `conversation_update`, `conversation_add_members`,
  `conversation_remove_member`, `conversation_leave`, `conversation_set_role`,
  `conversation_mute`, `conversation_pin`, `conversation_archive`, `conversation_read`,
  `conversation_clear`, `conversation_delete`, `conversation_invite`, `conversation_join`,
  `conversation_media`
- Messages : `messages_list`, `message_send`, `message_edit`, `message_delete`, `message_forward`,
  `message_react`, `message_star`, `messages_starred`, `message_info`, `search_messages`, `search`,
  `typing`, `sync`, `stream` (SSE, jeton via `?session=`)
- Médias : `media_upload` (multipart), `media_get`
- Push : `push_subscribe`, `push_unsubscribe`, `push_test`
- Admin : `admin_users`, `admin_user_update`, `admin_stats`

Exemple :

```sh
curl -s 'https://pulse.example.com/api-messagerie.php?action=ping'

curl -s -X POST 'https://pulse.example.com/api-messagerie.php?action=login' \
  -H 'Content-Type: application/json' \
  -d '{"login":"alex","password":"…"}'

curl -s -X POST 'https://pulse.example.com/api-messagerie.php?action=conversations_list' \
  -H 'Content-Type: application/json' -H 'X-Session-Token: …' -d '{}'
```

---

## 6. Modèle de données (SQLite)

- `users` (profil, rôle, préférences notif/confidentialité, `last_seen`)
- `sessions` (jetons, expiration 1 an)
- `invites` (code, e-mail nominatif, usages, expiration, rôle)
- `conversations` (direct/groupe, nom, avatar, TTL, restriction d’écriture, code d’invitation)
- `conversation_members` (rôle, lecture/distribution, sourdine, épinglé, archivé, historique masqué)
- `messages` (texte/image/vocal/fichier/système, édition, suppression, expiration, `updated_at`)
- `message_hidden`, `reactions`, `stars`, `typing`
- `media` (fichiers privés dans `data/messagerie-media/`)
- `blocks`, `push_subscriptions`, `throttle`, `meta`

Les réglages VAPID sont générés au premier abonnement et stockés dans `meta`.

---

## 7. Sécurité & limites

- Mots de passe : `password_hash` / `password_verify`, rehash automatique.
- Jetons de session aléatoires 256 bits, expiration, révocation (logout, mot de passe, désactivation).
- Limitation des tentatives de connexion/inscription (8 essais / 15 min, blocage 10 min).
- Uploads : validation MIME réelle (`finfo`), extension aléatoire, images ré-encodées si trop grandes,
  extensions dangereuses refusées, taille limitée. Les médias sont servis après contrôle d’accès.
- Blocage, confidentialité, rôles de groupe et d’administration appliqués **côté serveur**.
- `data/` protégé par `.htaccess`/Nginx ; ne jamais l’exposer en statique.
- **Pas de chiffrement de bout en bout** : le serveur détient les messages en clair (SQLite).
  Chiffrer au repos (disque/LUKS) et sauvegarder les accès si nécessaire.
- Les jetons sont dans `localStorage` (standard pour une PWA avec API séparée) : protéger contre XSS
  (React échappe le HTML, pas de `dangerouslySetInnerHTML` sur les messages).
- Les notifications push transitent par le service push du navigateur (Google/Mozilla/Apple) :
  le payload est chiffré pour l’abonnement, mais le serveur voit le contenu au moment de l’envoi.
- Le polling ne remplace pas un vrai push en arrière-plan : les Web Push prennent le relais app fermée.

---

## 8. Tests

Les scripts supposent une base **vierge** pour `test-api.mjs` (ils créent les comptes de test).

```sh
# API complète (91 assertions) — serveur PHP lancé sur 8110
npm run api
node scripts/test-api.mjs

# Cryptographie Web Push (VAPID ES256 + AES-128-GCM, sans réseau)
php scripts/test-push.php

# Tests UI Playwright (Chromium local)
npx playwright install chromium   # ou CHROME_PATH=/usr/bin/chromium
node scripts/ui-smoke.mjs          # captures desktop/mobile
node scripts/ui-flow.mjs           # temps réel, édition, suppression, recherche
node scripts/ui-flow2.mjs          # invitation compte, groupe, image, vocal, thème clair
```

Variables : `API_URL`, `BASE`, `CHROME_PATH`. Les captures sont écrites dans `/tmp/pulse-*`.

Comptes créés par `test-api.mjs` : `alex` / `motdepasse1` (admin), `bob@example.com`
(mot de passe changé en `nouveaupass2` en fin de suite), `charlie` / `motdepasse3`.

---

## 9. Structure du projet

```
api/
  api-messagerie.php     API monolithique PHP + SQLite
  router.php             routeur dev (bloque /data)
  .user.ini              limites d'upload
  data/                  créé au runtime (ignoré par git)
public/                  logo, icônes PWA, push-sw.js
scripts/
  test-api.mjs           tests API
  test-push.php          tests crypto push
  ui-smoke.mjs           captures UI
  ui-flow.mjs            parcours temps réel
  ui-flow2.mjs           invitations/médias/thème
src/
  App.tsx                shell, rail, onglets mobiles, routes
  context/AppContext.tsx session, sync globale, toasts, thème, push
  components/            chat, composer, médias, modales, profil, groupe…
  pages/                 Auth, Chats, Chat, Contacts, Settings, NewGroup, Join
  services/              api, realtime (SSE), settings, notifications, voice, image, utils
  styles/app.css         design system complet
```

---

## 10. Roadmap suggérée

1. **Appels audio/vidéo** (WebRTC + signalisation via `stream`/WebSocket).
2. **Statuts / stories** 24 h avec audience paramétrable.
3. **Chiffrement de bout en bout** (Signal Protocol ou libsodium + appareils de confiance).
4. **WebSocket dédié** si le nombre de connexions simultanées dépasse la capacité des workers Apache
   (SSE déjà en place pour la latence < 1 s et les appels).
5. **Sauvegarde/export** (JSON par conversation, export admin, restauration).
6. **Envoi d’e-mails** transactionnels (invitations, réinitialisation de mot de passe).
7. **FTS5** pour la recherche plein texte à grande échelle.
8. **Mode hors-ligne** (IndexedDB + file d’envoi) et applications Capacitor.
9. **Réactions multiples**, sondages, événements de groupe.
10. **Journal d’audit admin** et verrouillage biométrique de l’app.

---

Fait avec soin pour rester **auto-hébergé, privé et simple à déployer**.
