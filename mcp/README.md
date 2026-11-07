# Pulse MCP — piloter Pulse depuis une IA

Serveur [MCP](https://modelcontextprotocol.io) local (stdio) qui expose l'API Pulse
à OpenCode (ou tout autre client MCP : Claude Desktop, Cursor…). Il ne modifie **rien**
côté serveur : il appelle `api-messagerie.php` en HTTPS avec un jeton de session.

```
OpenCode ──stdio──▶ mcp/pulse-mcp.mjs ──HTTPS──▶ api-messagerie.php ──▶ SQLite
```

## Outils exposés (22)

| Lecture | Écriture |
|---|---|
| `pulse_health` — joignabilité de l'API | `pulse_send_message` — texte ou sondage |
| `pulse_whoami` — compte courant | `pulse_send_to` — envoyer à un contact par son nom |
| `pulse_list_conversations` | `pulse_reply_last` — répondre au dernier message |
| `pulse_unread_summary` — non-lus compacts | `pulse_edit_message` — édition (15 min) |
| `pulse_get_conversation` — membres, rôles | `pulse_delete_message` — pour soi / pour tous |
| `pulse_read_messages` — transcript + pagination |
 `pulse_react` — réaction emoji |
| `pulse_search` — globale ou dans un fil | `pulse_mark_read` |
| `pulse_list_contacts` — contacts + demandes | `pulse_create_direct` |
| `pulse_find_people` — recherche d'utilisateurs | `pulse_create_group` |
| `pulse_list_media` — galerie d'un fil | `pulse_forward_message` |
| | `pulse_star_message`, `pulse_pin_message` |

Un cache court (3 s) de `conversations_list` est réutilisé par `pulse_unread_summary`,
`pulse_send_to` et `pulse_reply_last` ; il est invalidé à la première écriture.
Réglable via `PULSE_MCP_CACHE_MS` (0 pour désactiver).

Volontairement **hors périmètre** : administration (stats, comptes, invitations),
upload/téléchargement de médias, écoute du flux SSE. Ce sont des ajouts simples si
le besoin apparaît.

## Configuration

### 1. Dépendances

```sh
npm install
```

### 2. Jeton d'accès

Les jetons se gèrent depuis Pulse : **Réglages → Jetons d’accès (MCP / IA) →
Générer un jeton**. Le jeton complet n'est affiché **qu'une seule fois** ; le bouton
« Copier pour mcp/.env » place directement la ligne `PULSE_API_TOKEN=…` dans le
presse-papiers.

```dotenv
PULSE_API_URL=https://pulse.dynaspirit.com/api-messagerie.php
PULSE_API_TOKEN=pulse_…
```

Alternative en ligne de commande (le mot de passe sert une seule fois) :

```sh
npm run mcp:token
```

La commande se connecte, crée un jeton d'accès nommé « MCP (CLI) » (90 jours par
défaut) et l'écrit dans `mcp/.env` (chmod 600, ignoré par git). Le mot de passe n'est
ni conservé ni journalisé. Personnalisation : `PULSE_TOKEN_NAME`, `PULSE_TOKEN_DAYS`
(`0`, `30`, `90` ou `365`).

Le jeton est stocké **haché** côté serveur, révocable individuellement, et expire
selon la durée choisie. Un changement de mot de passe ou une désactivation du compte
révoque tous les jetons.

L'identifiant + mot de passe restent acceptés en repli (`PULSE_LOGIN` /
`PULSE_PASSWORD`), ainsi que l'ancien `PULSE_SESSION_TOKEN` du navigateur.

Le serveur lit aussi `~/.config/pulse-mcp/.env`, ou les variables d'environnement
habituelles. Un fichier `.env` local au projet est prioritaire.

> **Compte dédié recommandé.** Crée un compte « assistant » via une invitation, puis
> invite-le dans les conversations qu'il doit suivre. Tu gardes ainsi une trace claire
> de ce que fait l'IA, et tu peux le retirer sans toucher à ton compte.

### 2 bis. Plusieurs utilisateurs Pulse sur le même OpenCode

Le serveur MCP reste un processus unique, mais OpenCode transmet l'identifiant de la
session appelante dans `params._meta["ai.opencode/sessionID"]`. Echo dépose donc, pour
chaque session, un petit fichier `<PULSE_SESSION_DIR>/<sessionID>.json` :

```json
{ "token": "pulse_…", "apiUrl": "https://pulse.dynaspirit.com/api-messagerie.php" }
```

À chaque appel d'outil, le serveur utilise le jeton de cette session s'il existe. Le
compte admin (`PULSE_API_TOKEN`) ne sert que de repli quand aucun fichier n'est présent
(CLI, usage direct d'OpenCode). Un fichier avec `"token": ""` bloque explicitement le
repli : la conversation doit se reconnecter dans Echo.

`PULSE_SESSION_DIR` vaut par défaut `/tmp/opencode/pulse-sessions`, le même chemin que
celui utilisé par Echo. Les jetons sont créés par Echo pour 90 jours, nommés « Echo MCP »,
et révoqués à la déconnexion.

### 2 ter. Instructions visibles dans Echo

Les consignes du serveur sont aussi publiées comme ressource MCP
`pulse://instructions` (texte complet dans sa description). Echo les affiche dans
**Réglages → Instructions MCP**, sans dupliquer le texte.

### 3. OpenCode

Le fichier `opencode.json` à la racine du projet déclare déjà le serveur :

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "servers": {
      "pulse": {
        "type": "local",
        "command": ["node", "mcp/pulse-mcp.mjs"],
        "cwd": "."
      }
    }
  }
}
```

OpenCode détecte le fichier et reconnecte le serveur automatiquement. Vérifie avec :

```sh
opencode mcp list
```

Les outils apparaissent sous `pulse_*` (ou `tools.pulse.*` en Code Mode).

Pour l'utiliser dans **tous** les projets, ajoute le même bloc dans
`~/.config/opencode/opencode.json` en pointant vers le chemin absolu du script.

### 4. Vérification

```sh
npm run mcp:check
```

Affiche l'URL, le compte, le mode, teste `ping` puis l'authentification (`me`).

## Sécurités

| Variable | Effet |
|---|---|
| `PULSE_READ_ONLY=1` | N'expose que les 9 outils de lecture (aucune écriture possible). |
| `PULSE_DRY_RUN=1` | Les outils d'écriture renvoient l'appel prévu sans l'exécuter. |
| `PULSE_API_TOKEN=…` | Jeton d'accès personnel (recommandé, généré dans Pulse ou via `npm run mcp:token`). |
| `PULSE_SESSION_TOKEN=…` | Ancien mode : jeton de session du navigateur. |
| `PULSE_SESSION_FILE=…` | Cache de session pour le mode login/mot de passe (défaut `~/.cache/pulse-mcp/session.json`, chmod 600). |
| `PULSE_SESSION_DIR=…` | Jetons par session OpenCode déposés par Echo (défaut `/tmp/opencode/pulse-sessions`). Un fichier présent mais vide interdit le repli sur le compte admin. |

Autres garde-fous :

- le mot de passe n'est **jamais** journalisé ni renvoyé par un outil ;
- les jetons sont stockés **hachés** côté serveur et révocables individuellement ;
- en mode login/mot de passe, la session est mise en cache par couple `(URL, compte)` et renouvelée sur 401 ;
- `pulse_delete_message` supprime **pour soi** par défaut (`forEveryone: false`) ;
- les consignes du serveur demandent à l'IA de ne rien envoyer sans demande explicite.

## Exemples de demandes

- « Résume les conversations non lues. »
- « Dans le groupe Famille, qu'est-ce qui s'est dit cette semaine ? »
- « Réponds à Alice que je serai là à 19 h. »
- « Cherche tous les messages qui parlent du restaurant. »
- « Crée un groupe “Vacances” avec Alice et Bob. »

## Dépannage

| Symptôme | Cause probable |
|---|---|
| `Identifiants Pulse absents` | `mcp/.env` manquant ou variables non chargées. |
| `Identifiant ou mot de passe incorrect` | Identifiants erronés, ou limitation après 8 essais / 15 min. |
| `Impossible de joindre l'API Pulse` | URL incorrecte, réseau, certificat, proxy. |
| `Session expirée` en boucle | Compte désactivé ou mot de passe changé : mets à jour `mcp/.env`. |
| Outils absents dans OpenCode | `opencode mcp list`, puis `/reload` dans l'interface. |

## Tests

```sh
node scripts/test-mcp.mjs
```

Le test démarre une fausse API Pulse en mémoire, un vrai client MCP, et vérifie les
63 assertions : découverte des outils, lecture, écriture, cache de session,
reconnexion transparente sur 401, génération de jeton, identité par session
OpenCode, ressource d'instructions, mode lecture seule et dry-run.
