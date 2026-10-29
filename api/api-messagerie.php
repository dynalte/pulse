<?php
/*
    Pulse — API de messagerie (PHP + SQLite)

    Déploiement type :
      - copier ce fichier sur le serveur (ex. /srv/web/pulse/api-messagerie.php) ;
      - le dossier data/ est créé automatiquement à côté du script ;
      - extensions PHP requises : pdo_sqlite, openssl, fileinfo, mbstring, gd (recommandé), curl (push).

    Modèle :
      - Le tout premier compte créé via ?action=bootstrap devient administrateur.
      - Les comptes suivants sont créés uniquement sur invitation (?action=register).
      - Session = jeton aléatoire (header X-Session-Token), valable 1 an.
      - Temps réel : polling adaptatif de ?action=sync (2 s dans une conversation,
        6 s sur la liste). Pas de WebSocket : inutile à cette échelle et plus simple
        à héberger. La structure de sync permet d'ajouter SSE/WS plus tard.

    Sécurité : mots de passe hashés (password_hash), jetons en base, limitation
    des tentatives de connexion, uploads validés (MIME + taille + ré-encodage image),
    fichiers servis uniquement aux membres de la conversation.
*/
declare(strict_types=1);

// ============================== CONFIG ==============================
const DB_FILE = __DIR__ . '/data/messagerie.sqlite';
const MEDIA_DIR = __DIR__ . '/data/messagerie-media';
const SESSION_TTL = 365 * 24 * 3600;          // 1 an
const MAX_UPLOAD = 30 * 1024 * 1024;          // 30 Mo
const MAX_IMAGE_DIM = 1920;                    // ré-encodage serveur au-delà
const INVITE_TTL = 7 * 24 * 3600;              // validité par défaut d'une invitation
const ALLOW_MEMBER_INVITES = true;             // les membres peuvent inviter
const MAX_GROUP_MEMBERS = 250;
const APP_NAME = 'Pulse';
const APP_VERSION = '0.1.0';
const VAPID_SUBJECT = 'mailto:admin@pulse.local';
// =====================================================================

error_reporting(E_ALL);
ini_set('display_errors', '0');
ini_set('log_errors', '1');

header('Content-Type: application/json; charset=utf-8');
header('Access-Control-Allow-Origin: *');
header('Access-Control-Allow-Headers: Content-Type, X-Session-Token');
header('Access-Control-Allow-Methods: GET, POST, OPTIONS');
header('X-Content-Type-Options: nosniff');
header('Referrer-Policy: no-referrer');
header('Cache-Control: no-store');

if (($_SERVER['REQUEST_METHOD'] ?? 'GET') === 'OPTIONS') {
    http_response_code(204);
    exit;
}

// ============================== HELPERS ==============================

function now(): int
{
    return time();
}

function out(array $data, int $code = 200): void
{
    http_response_code($code);
    echo json_encode($data, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
    exit;
}

function fail(string $msg, int $code = 400): void
{
    out(['ok' => false, 'error' => $msg], $code);
}

function ok(array $data = []): void
{
    out(array_merge(['ok' => true], $data));
}

/**
 * Exécute une tâche après l'envoi de la réponse (push, notifications lourdes).
 * Sur PHP-FPM, fastcgi_finish_request libère immédiatement le client.
 */
function defer(callable $fn): void
{
    if (!isset($GLOBALS['pulse_deferred'])) {
        $GLOBALS['pulse_deferred'] = [];
        register_shutdown_function(function (): void {
            @ignore_user_abort(true);
            if (function_exists('fastcgi_finish_request')) {
                @fastcgi_finish_request();
            } else {
                while (ob_get_level() > 0) @ob_end_flush();
                @flush();
            }
            foreach ($GLOBALS['pulse_deferred'] as $task) {
                try {
                    $task();
                } catch (Throwable $e) {
                    @file_put_contents(dirname(DB_FILE) . '/error.log', '[' . date('c') . '] push différé : ' . $e->getMessage() . "\n", FILE_APPEND);
                }
            }
            $GLOBALS['pulse_deferred'] = [];
        });
    }
    $GLOBALS['pulse_deferred'][] = $fn;
}

function input(): array
{
    static $cached = null;
    if ($cached !== null) return $cached;
    $raw = file_get_contents('php://input');
    $data = $raw ? json_decode($raw, true) : null;
    if (!is_array($data) && !empty($_POST)) $data = $_POST;
    $cached = is_array($data) ? $data : [];
    return $cached;
}

function p(string $key, $default = null)
{
    $b = input();
    return $b[$key] ?? $_GET[$key] ?? $default;
}

function str_input(string $key, int $max = 5000): string
{
    $v = p($key, '');
    if (!is_string($v)) return '';
    $v = trim($v);
    return mb_substr($v, 0, $max);
}

function int_input(string $key, int $default = 0): int
{
    $v = p($key, $default);
    return is_numeric($v) ? (int)$v : $default;
}

function bool_input(string $key, bool $default = false): bool
{
    $v = p($key, $default);
    if (is_bool($v)) return $v;
    if (is_numeric($v)) return (int)$v === 1;
    return in_array($v, ['true', '1', 'yes', 'on'], true);
}

function b64u(string $data): string
{
    return rtrim(strtr(base64_encode($data), '+/', '-_'), '=');
}

function b64u_dec(string $data): string
{
    $d = strtr($data, '-_', '+/');
    $pad = strlen($d) % 4;
    if ($pad) $d .= str_repeat('=', 4 - $pad);
    $out = base64_decode($d, true);
    return $out === false ? '' : $out;
}

function valid_username(string $u): bool
{
    return (bool)preg_match('/^[a-z0-9._]{3,24}$/', $u);
}

function valid_email(string $e): bool
{
    return (bool)filter_var($e, FILTER_VALIDATE_EMAIL);
}

function normalize_username(string $u): string
{
    return strtolower(trim(ltrim($u, '@')));
}

function request_ip(): string
{
    return (string)($_SERVER['REMOTE_ADDR'] ?? '0.0.0.0');
}

// ============================== DATABASE ==============================

function db(): PDO
{
    static $pdo = null;
    if ($pdo instanceof PDO) return $pdo;
    $dir = dirname(DB_FILE);
    if (!is_dir($dir) && !@mkdir($dir, 0770, true) && !is_dir($dir)) {
        fail('Dossier data/ non accessible en écriture.', 500);
    }
    if (!is_dir(MEDIA_DIR) && !@mkdir(MEDIA_DIR, 0770, true) && !is_dir(MEDIA_DIR)) {
        fail('Dossier média non accessible en écriture.', 500);
    }
    // Protection Apache (le serveur intégré PHP utilise api/router.php).
    $ht = $dir . '/.htaccess';
    if (!file_exists($ht)) @file_put_contents($ht, "Require all denied\nDeny from all\n");
    $gitkeep = $dir . '/.gitkeep';
    if (!file_exists($gitkeep)) @file_put_contents($gitkeep, '');

    $pdo = new PDO('sqlite:' . DB_FILE, null, null, [
        PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION,
        PDO::ATTR_DEFAULT_FETCH_MODE => PDO::FETCH_ASSOC,
        PDO::ATTR_EMULATE_PREPARES => false,
    ]);
    $pdo->exec('PRAGMA journal_mode = WAL');
    $pdo->exec('PRAGMA synchronous = NORMAL');
    $pdo->exec('PRAGMA busy_timeout = 5000');
    $pdo->exec('PRAGMA foreign_keys = ON');
    migrate($pdo);
    return $pdo;
}

function migrate(PDO $pdo): void
{
    $pdo->exec("
    CREATE TABLE IF NOT EXISTS meta (
        k TEXT PRIMARY KEY,
        v TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        email TEXT NOT NULL UNIQUE COLLATE NOCASE,
        username TEXT NOT NULL UNIQUE COLLATE NOCASE,
        name TEXT NOT NULL,
        password_hash TEXT NOT NULL,
        bio TEXT NOT NULL DEFAULT '',
        phone TEXT NOT NULL DEFAULT '',
        avatar_id INTEGER,
        role TEXT NOT NULL DEFAULT 'member',
        active INTEGER NOT NULL DEFAULT 1,
        created_at INTEGER NOT NULL,
        last_seen INTEGER NOT NULL DEFAULT 0,
        notif TEXT NOT NULL DEFAULT '{}',
        privacy TEXT NOT NULL DEFAULT '{}',
        password_changed_at INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS sessions (
        token TEXT PRIMARY KEY,
        user_id INTEGER NOT NULL,
        created_at INTEGER NOT NULL,
        last_seen INTEGER NOT NULL,
        ua TEXT NOT NULL DEFAULT ''
    );
    CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
    CREATE TABLE IF NOT EXISTS invites (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        code TEXT NOT NULL UNIQUE,
        created_by INTEGER NOT NULL,
        email TEXT NOT NULL DEFAULT '',
        note TEXT NOT NULL DEFAULT '',
        role TEXT NOT NULL DEFAULT 'member',
        max_uses INTEGER NOT NULL DEFAULT 1,
        uses INTEGER NOT NULL DEFAULT 0,
        expires_at INTEGER NOT NULL,
        created_at INTEGER NOT NULL,
        revoked INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS conversations (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        type TEXT NOT NULL DEFAULT 'direct',
        name TEXT NOT NULL DEFAULT '',
        description TEXT NOT NULL DEFAULT '',
        avatar_id INTEGER,
        created_by INTEGER NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        last_message_id INTEGER NOT NULL DEFAULT 0,
        invite_code TEXT UNIQUE,
        disappearing_seconds INTEGER NOT NULL DEFAULT 0,
        only_admins_can_post INTEGER NOT NULL DEFAULT 0,
        deleted INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS conversation_members (
        conversation_id INTEGER NOT NULL,
        user_id INTEGER NOT NULL,
        role TEXT NOT NULL DEFAULT 'member',
        joined_at INTEGER NOT NULL,
        last_read_message_id INTEGER NOT NULL DEFAULT 0,
        last_delivered_message_id INTEGER NOT NULL DEFAULT 0,
        muted_until INTEGER NOT NULL DEFAULT 0,
        pinned INTEGER NOT NULL DEFAULT 0,
        archived INTEGER NOT NULL DEFAULT 0,
        hidden INTEGER NOT NULL DEFAULT 0,
        cleared_before INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (conversation_id, user_id)
    );
    CREATE INDEX IF NOT EXISTS idx_cm_user ON conversation_members(user_id);
    CREATE TABLE IF NOT EXISTS media (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL,
        kind TEXT NOT NULL,
        filename TEXT NOT NULL,
        orig_name TEXT NOT NULL DEFAULT '',
        mime TEXT NOT NULL,
        size INTEGER NOT NULL,
        width INTEGER NOT NULL DEFAULT 0,
        height INTEGER NOT NULL DEFAULT 0,
        duration REAL NOT NULL DEFAULT 0,
        waveform TEXT NOT NULL DEFAULT '',
        created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        conversation_id INTEGER NOT NULL,
        sender_id INTEGER NOT NULL,
        type TEXT NOT NULL DEFAULT 'text',
        body TEXT NOT NULL DEFAULT '',
        media_id INTEGER,
        reply_to INTEGER NOT NULL DEFAULT 0,
        forwarded INTEGER NOT NULL DEFAULT 0,
        edited_at INTEGER NOT NULL DEFAULT 0,
        deleted_at INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL DEFAULT 0,
        expires_at INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS idx_msg_conv ON messages(conversation_id, id);
    CREATE INDEX IF NOT EXISTS idx_msg_created ON messages(created_at);
    CREATE TABLE IF NOT EXISTS message_hidden (
        message_id INTEGER NOT NULL,
        user_id INTEGER NOT NULL,
        PRIMARY KEY (message_id, user_id)
    );
    CREATE TABLE IF NOT EXISTS reactions (
        message_id INTEGER NOT NULL,
        user_id INTEGER NOT NULL,
        emoji TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        PRIMARY KEY (message_id, user_id)
    );
    CREATE TABLE IF NOT EXISTS stars (
        user_id INTEGER NOT NULL,
        message_id INTEGER NOT NULL,
        created_at INTEGER NOT NULL,
        PRIMARY KEY (user_id, message_id)
    );
    CREATE TABLE IF NOT EXISTS typing (
        conversation_id INTEGER NOT NULL,
        user_id INTEGER NOT NULL,
        until INTEGER NOT NULL,
        PRIMARY KEY (conversation_id, user_id)
    );
    CREATE TABLE IF NOT EXISTS blocks (
        blocker_id INTEGER NOT NULL,
        blocked_id INTEGER NOT NULL,
        created_at INTEGER NOT NULL,
        PRIMARY KEY (blocker_id, blocked_id)
    );
    CREATE TABLE IF NOT EXISTS push_subscriptions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL,
        endpoint TEXT NOT NULL UNIQUE,
        p256dh TEXT NOT NULL,
        auth TEXT NOT NULL,
        ua TEXT NOT NULL DEFAULT '',
        created_at INTEGER NOT NULL,
        last_ok INTEGER NOT NULL DEFAULT 0,
        last_error TEXT NOT NULL DEFAULT ''
    );
    CREATE INDEX IF NOT EXISTS idx_push_user ON push_subscriptions(user_id);
    CREATE TABLE IF NOT EXISTS throttle (
        k TEXT PRIMARY KEY,
        count INTEGER NOT NULL DEFAULT 0,
        first_at INTEGER NOT NULL,
        blocked_until INTEGER NOT NULL DEFAULT 0
    );
    ");
    // Migration : colonne updated_at (propagation des éditions/réactions).
    $cols = $pdo->query('PRAGMA table_info(messages)')->fetchAll();
    if (!array_filter($cols, fn($c) => ($c['name'] ?? '') === 'updated_at')) {
        $pdo->exec('ALTER TABLE messages ADD COLUMN updated_at INTEGER NOT NULL DEFAULT 0');
    }
    $pdo->exec('UPDATE messages SET updated_at = created_at WHERE updated_at = 0');
    $pdo->exec('CREATE INDEX IF NOT EXISTS idx_msg_updated ON messages(conversation_id, updated_at)');
    meta_set_if_absent('installed_at', (string)now());
}

function meta_get(string $key): ?string
{
    $st = db()->prepare('SELECT v FROM meta WHERE k = ?');
    $st->execute([$key]);
    $v = $st->fetchColumn();
    return $v === false ? null : (string)$v;
}

function meta_set(string $key, string $value): void
{
    $st = db()->prepare('INSERT INTO meta(k, v) VALUES(?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v');
    $st->execute([$key, $value]);
}

function meta_set_if_absent(string $key, string $value): void
{
    if (meta_get($key) === null) meta_set($key, $value);
}

// ============================== THROTTLE ==============================

function throttle_check(string $key): void
{
    $st = db()->prepare('SELECT * FROM throttle WHERE k = ?');
    $st->execute([$key]);
    $r = $st->fetch();
    if (!$r) return;
    $t = now();
    if ((int)$r['blocked_until'] > $t) {
        fail('Trop de tentatives. Réessayez dans quelques minutes.', 429);
    }
    if ($t - (int)$r['first_at'] > 900) {
        db()->prepare('DELETE FROM throttle WHERE k = ?')->execute([$key]);
    }
}

function throttle_fail(string $key): void
{
    $t = now();
    $st = db()->prepare('SELECT * FROM throttle WHERE k = ?');
    $st->execute([$key]);
    $r = $st->fetch();
    if (!$r || $t - (int)$r['first_at'] > 900) {
        db()->prepare('INSERT INTO throttle(k, count, first_at, blocked_until) VALUES(?, 1, ?, 0)
            ON CONFLICT(k) DO UPDATE SET count = 1, first_at = excluded.first_at, blocked_until = 0')
            ->execute([$key, $t]);
        return;
    }
    $count = (int)$r['count'] + 1;
    $blocked = $count >= 8 ? $t + 600 : 0;
    db()->prepare('UPDATE throttle SET count = ?, blocked_until = ? WHERE k = ?')->execute([$count, $blocked, $key]);
}

function throttle_clear(string $key): void
{
    db()->prepare('DELETE FROM throttle WHERE k = ?')->execute([$key]);
}

// ============================== AUTH ==============================

function request_token(): string
{
    $h = (string)($_SERVER['HTTP_X_SESSION_TOKEN'] ?? '');
    if ($h === '') $h = (string)($_GET['session'] ?? '');
    return trim($h);
}

/**
 * Authentifie la requête et retourne la ligne utilisateur enrichie
 * (notif/privacy décodés, session_token).
 */
function auth(): array
{
    $token = request_token();
    if ($token === '') fail('Authentification requise.', 401);
    $st = db()->prepare('SELECT u.*, s.token AS session_token FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token = ? AND s.created_at >= ? LIMIT 1');
    $st->execute([$token, now() - SESSION_TTL]);
    $u = $st->fetch();
    if (!$u) {
        db()->prepare('DELETE FROM sessions WHERE token = ?')->execute([$token]);
        fail('Session expirée ou compte désactivé.', 401);
    }
    if ((int)$u['active'] !== 1) fail('Session expirée ou compte désactivé.', 401);
    $t = now();
    if ($t - (int)$u['last_seen'] > 25) {
        db()->prepare('UPDATE users SET last_seen = ? WHERE id = ?')->execute([$t, (int)$u['id']]);
        db()->prepare('UPDATE sessions SET last_seen = ? WHERE token = ?')->execute([$t, $token]);
        $u['last_seen'] = $t;
    }
    $u['notif'] = user_notif($u);
    $u['privacy'] = user_privacy($u);
    return $u;
}

function is_admin(array $u): bool
{
    return ($u['role'] ?? '') === 'admin';
}

function create_session(int $userId): string
{
    $token = bin2hex(random_bytes(32));
    $t = now();
    db()->prepare('INSERT INTO sessions(token, user_id, created_at, last_seen, ua) VALUES(?,?,?,?,?)')
        ->execute([$token, $userId, $t, $t, mb_substr((string)($_SERVER['HTTP_USER_AGENT'] ?? ''), 0, 250)]);
    db()->prepare('UPDATE users SET last_seen = ? WHERE id = ?')->execute([$t, $userId]);
    return $token;
}

// ============================== USERS / PRIVACY ==============================

function user_notif(array $u): array
{
    $default = ['enabled' => true, 'messages' => true, 'groups' => true, 'preview' => true, 'sound' => true, 'badge' => true];
    $raw = $u['notif'] ?? null;
    $v = is_array($raw) ? $raw : json_decode((string)$raw, true);
    return is_array($v) ? array_merge($default, $v) : $default;
}

function user_privacy(array $u): array
{
    $default = ['lastSeen' => 'contacts', 'profilePhoto' => 'contacts'];
    $raw = $u['privacy'] ?? null;
    $v = is_array($raw) ? $raw : json_decode((string)$raw, true);
    $p = is_array($v) ? array_merge($default, $v) : $default;
    foreach (['lastSeen', 'profilePhoto'] as $k) {
        if (!in_array($p[$k], ['everyone', 'contacts', 'nobody'], true)) $p[$k] = 'contacts';
    }
    return $p;
}

function online(int $lastSeen): bool
{
    return $lastSeen > 0 && (now() - $lastSeen) < 70;
}

/** Deux utilisateurs partagent-ils une conversation ? */
function is_contact(int $a, int $b): bool
{
    if ($a === $b) return true;
    $st = db()->prepare('SELECT 1 FROM conversation_members m1
        JOIN conversation_members m2 ON m2.conversation_id = m1.conversation_id
        WHERE m1.user_id = ? AND m2.user_id = ? LIMIT 1');
    $st->execute([$a, $b]);
    return (bool)$st->fetchColumn();
}

function user_is_blocked(int $viewerId, int $targetId): bool
{
    $st = db()->prepare('SELECT 1 FROM blocks WHERE blocker_id = ? AND blocked_id = ? LIMIT 1');
    $st->execute([$viewerId, $targetId]);
    return (bool)$st->fetchColumn();
}

function user_blocks_me(int $viewerId, int $targetId): bool
{
    return user_is_blocked($targetId, $viewerId);
}

/** Vue publique d'un utilisateur, avec respect de la confidentialité. */
function public_user(array $u, int $viewerId, bool $full = false): array
{
    $targetId = (int)($u['id'] ?? $u['user_id'] ?? 0);
    $isSelf = $targetId === $viewerId;
    $privacy = user_privacy($u);
    $contact = $isSelf ? true : is_contact($viewerId, $targetId);

    $showLastSeen = $isSelf || $privacy['lastSeen'] === 'everyone' || ($privacy['lastSeen'] === 'contacts' && $contact);
    $lastSeen = $showLastSeen ? (int)$u['last_seen'] : 0;
    $showPhoto = $isSelf || $privacy['profilePhoto'] === 'everyone' || ($privacy['profilePhoto'] === 'contacts' && $contact);

    $out = [
        'id' => $targetId,
        'username' => (string)$u['username'],
        'name' => (string)$u['name'],
        'bio' => (string)($u['bio'] ?? ''),
        'phone' => ($isSelf || $contact) ? (string)($u['phone'] ?? '') : '',
        'avatarId' => $showPhoto && !empty($u['avatar_id']) ? (int)$u['avatar_id'] : null,
        'role' => (string)($u['user_role'] ?? $u['role'] ?? 'member'),
        'createdAt' => (int)($u['created_at'] ?? 0),
        'lastSeen' => $lastSeen,
        'online' => $showLastSeen && online((int)$u['last_seen']),
        'isContact' => $contact,
        'blocked' => user_is_blocked($viewerId, $targetId),
        'blockedBy' => user_blocks_me($viewerId, $targetId),
    ];
    if ($full || $isSelf) {
        $out['email'] = (string)($u['email'] ?? '');
        $out['active'] = (int)($u['active'] ?? 1) === 1;
    }
    if ($isSelf) {
        $out['notif'] = user_notif($u);
        $out['privacy'] = $privacy;
    }
    return $out;
}

function me_payload(array $u): array
{
    $me = public_user($u, (int)$u['id'], true);
    $me['notif'] = user_notif($u);
    $me['privacy'] = user_privacy($u);
    $me['unreadTotal'] = unread_total((int)$u['id']);
    $st = db()->prepare('SELECT COUNT(*) FROM push_subscriptions WHERE user_id = ?');
    $st->execute([(int)$u['id']]);
    $me['pushDevices'] = (int)$st->fetchColumn();
    return $me;
}

// ============================== INVITES ==============================

function generate_code(int $len = 8): string
{
    $alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    for ($attempt = 0; $attempt < 20; $attempt++) {
        $code = '';
        for ($i = 0; $i < $len; $i++) $code .= $alphabet[random_int(0, strlen($alphabet) - 1)];
        $st = db()->prepare('SELECT 1 FROM invites WHERE code = ? UNION SELECT 1 FROM conversations WHERE invite_code = ? LIMIT 1');
        $st->execute([$code, $code]);
        if (!$st->fetchColumn()) return $code;
    }
    return strtoupper(bin2hex(random_bytes(6)));
}

function invite_json(array $r, ?string $creatorName = null): array
{
    return [
        'id' => (int)$r['id'],
        'code' => (string)$r['code'],
        'email' => (string)$r['email'],
        'note' => (string)$r['note'],
        'maxUses' => (int)$r['max_uses'],
        'uses' => (int)$r['uses'],
        'role' => (string)$r['role'],
        'createdAt' => (int)$r['created_at'],
        'expiresAt' => (int)$r['expires_at'],
        'creatorName' => $creatorName ?? '',
        'createdBy' => (int)($r['created_by'] ?? 0),
        'used' => (int)$r['uses'] >= (int)$r['max_uses'],
    ];
}

// ============================== CONVERSATIONS ==============================

function conversation_row(int $id): ?array
{
    $st = db()->prepare('SELECT * FROM conversations WHERE id = ? AND deleted = 0 LIMIT 1');
    $st->execute([$id]);
    $r = $st->fetch();
    return $r ?: null;
}

function membership(int $convId, int $userId): ?array
{
    $st = db()->prepare('SELECT * FROM conversation_members WHERE conversation_id = ? AND user_id = ? LIMIT 1');
    $st->execute([$convId, $userId]);
    $r = $st->fetch();
    return $r ?: null;
}

function require_conversation(int $convId, int $userId): array
{
    $c = conversation_row($convId);
    if (!$c) fail('Conversation introuvable.', 404);
    $m = membership($convId, $userId);
    if (!$m) fail('Vous ne faites pas partie de cette conversation.', 403);
    return [$c, $m];
}

function conversation_members_rows(int $convId): array
{
    $st = db()->prepare('SELECT cm.*, u.name, u.username, u.avatar_id, u.last_seen, u.role AS user_role, u.privacy
        FROM conversation_members cm JOIN users u ON u.id = cm.user_id
        WHERE cm.conversation_id = ? ORDER BY cm.joined_at ASC');
    $st->execute([$convId]);
    return $st->fetchAll();
}

function is_group_admin(array $membershipRow): bool
{
    return in_array((string)$membershipRow['role'], ['owner', 'admin'], true);
}

function can_post(array $conv, array $m): bool
{
    if ((int)$conv['only_admins_can_post'] === 1 && !is_group_admin($m)) return false;
    return true;
}

function find_direct_conversation(int $a, int $b): ?array
{
    $st = db()->prepare("SELECT c.* FROM conversations c
        JOIN conversation_members m1 ON m1.conversation_id = c.id AND m1.user_id = ?
        JOIN conversation_members m2 ON m2.conversation_id = c.id AND m2.user_id = ?
        WHERE c.type = 'direct' AND c.deleted = 0
        ORDER BY c.id DESC LIMIT 1");
    $st->execute([$a, $b]);
    $r = $st->fetch();
    return $r ?: null;
}

function touch_conversation(int $convId, int $updatedAt = 0): void
{
    $t = $updatedAt ?: now();
    db()->prepare('UPDATE conversations SET updated_at = ? WHERE id = ?')->execute([$t, $convId]);
}

function system_message(int $convId, int $actorId, string $text): int
{
    $t = now();
    $st = db()->prepare("INSERT INTO messages(conversation_id, sender_id, type, body, created_at, updated_at) VALUES(?,?, 'system', ?, ?, ?)");
    $st->execute([$convId, $actorId, $text, $t, $t]);
    $id = (int)db()->lastInsertId();
    db()->prepare('UPDATE conversations SET last_message_id = ?, updated_at = ? WHERE id = ?')->execute([$id, $t, $convId]);
    db()->prepare('UPDATE conversation_members SET hidden = 0 WHERE conversation_id = ?')->execute([$convId]);
    return $id;
}

function unread_total(int $userId): int
{
    $st = db()->prepare("SELECT COUNT(*) FROM messages m
        JOIN conversation_members cm ON cm.conversation_id = m.conversation_id AND cm.user_id = ?
        JOIN conversations c ON c.id = m.conversation_id AND c.deleted = 0
        LEFT JOIN message_hidden mh ON mh.message_id = m.id AND mh.user_id = cm.user_id
        WHERE m.id > cm.last_read_message_id AND m.sender_id <> ? AND m.deleted_at = 0 AND m.type <> 'system'
          AND m.id > cm.cleared_before AND mh.message_id IS NULL AND cm.hidden = 0
          AND (m.expires_at = 0 OR m.expires_at > ?)");
    $st->execute([$userId, $userId, now()]);
    return (int)$st->fetchColumn();
}

// ============================== MEDIA JSON ==============================

function media_json(array $r): array
{
    $wave = json_decode((string)($r['waveform'] ?? ''), true);
    return [
        'id' => (int)$r['id'],
        'kind' => (string)$r['kind'],
        'mime' => (string)$r['mime'],
        'size' => (int)$r['size'],
        'width' => (int)$r['width'],
        'height' => (int)$r['height'],
        'duration' => (float)$r['duration'],
        'filename' => (string)($r['orig_name'] !== '' ? $r['orig_name'] : $r['filename']),
        'waveform' => is_array($wave) ? array_values($wave) : [],
    ];
}

function media_from_joined(array $m): ?array
{
    if (empty($m['md_id'])) return null;
    return media_json([
        'id' => $m['md_id'],
        'kind' => $m['md_kind'],
        'mime' => $m['md_mime'],
        'size' => $m['md_size'],
        'width' => $m['md_width'],
        'height' => $m['md_height'],
        'duration' => $m['md_duration'],
        'orig_name' => $m['md_orig_name'],
        'filename' => $m['md_filename'],
        'waveform' => $m['md_waveform'],
    ]);
}

// ============================== MESSAGES JSON ==============================

function attach_messages(array $rows, int $viewerId, array $members): array
{
    if (!$rows) return [];
    $ids = array_map(fn($r) => (int)$r['id'], $rows);
    $in = implode(',', array_fill(0, count($ids), '?'));

    // Réactions (une par utilisateur).
    $reactions = [];
    $st = db()->prepare("SELECT r.message_id, r.user_id, r.emoji, u.name FROM reactions r JOIN users u ON u.id = r.user_id WHERE r.message_id IN ($in) ORDER BY r.created_at ASC");
    $st->execute($ids);
    foreach ($st->fetchAll() as $r) {
        $reactions[(int)$r['message_id']][] = ['userId' => (int)$r['user_id'], 'emoji' => (string)$r['emoji'], 'name' => (string)$r['name']];
    }

    // Favoris du lecteur.
    $stars = [];
    $st = db()->prepare("SELECT message_id FROM stars WHERE user_id = ? AND message_id IN ($in)");
    $st->execute(array_merge([$viewerId], $ids));
    foreach ($st->fetchAll() as $r) $stars[(int)$r['message_id']] = true;

    // Messages cités.
    $replyIds = [];
    foreach ($rows as $r) if (!empty($r['reply_to'])) $replyIds[] = (int)$r['reply_to'];
    $replies = [];
    if ($replyIds) {
        $rin = implode(',', array_fill(0, count($replyIds), '?'));
        $st = db()->prepare("SELECT m.id, m.sender_id, m.type, m.body, m.deleted_at, m.media_id, u.name AS sender_name
            FROM messages m JOIN users u ON u.id = m.sender_id WHERE m.id IN ($rin)");
        $st->execute(array_unique($replyIds));
        foreach ($st->fetchAll() as $r) $replies[(int)$r['id']] = $r;
    }

    $out = [];
    foreach ($rows as $r) {
        $senderId = (int)$r['sender_id'];
        $readCount = 0;
        $deliveredCount = 0;
        $otherCount = 0;
        foreach ($members as $m) {
            if ((int)$m['user_id'] === $senderId) continue;
            // Un membre arrivé après le message n'a pas à le lire.
            if ((int)($m['joined_at'] ?? 0) > (int)$r['created_at']) continue;
            $otherCount++;
            if ((int)$m['last_read_message_id'] >= (int)$r['id']) $readCount++;
            if ((int)$m['last_delivered_message_id'] >= (int)$r['id']) $deliveredCount++;
        }
        $reply = null;
        if (!empty($r['reply_to']) && isset($replies[(int)$r['reply_to']])) {
            $rp = $replies[(int)$r['reply_to']];
            $reply = [
                'id' => (int)$rp['id'],
                'senderId' => (int)$rp['sender_id'],
                'senderName' => (string)$rp['sender_name'],
                'type' => (string)$rp['type'],
                'body' => (int)$rp['deleted_at'] ? '' : (string)$rp['body'],
                'deleted' => (int)$rp['deleted_at'] > 0,
                'mediaId' => $rp['media_id'] ? (int)$rp['media_id'] : null,
            ];
        }
        $deleted = (int)$r['deleted_at'] > 0;
        $out[] = [
            'id' => (int)$r['id'],
            'conversationId' => (int)$r['conversation_id'],
            'senderId' => $senderId,
            'senderName' => (string)($r['sender_name'] ?? ''),
            'senderUsername' => (string)($r['sender_username'] ?? ''),
            'senderAvatarId' => !empty($r['sender_avatar_id']) ? (int)$r['sender_avatar_id'] : null,
            'type' => (string)$r['type'],
            'body' => $deleted ? '' : (string)$r['body'],
            'media' => $deleted ? null : media_from_joined($r),
            'replyTo' => $reply,
            'reactions' => $reactions[(int)$r['id']] ?? [],
            'readCount' => $readCount,
            'deliveredCount' => $deliveredCount,
            'otherCount' => $otherCount,
            'starred' => isset($stars[(int)$r['id']]),
            'editedAt' => (int)$r['edited_at'],
            'deletedAt' => (int)$r['deleted_at'],
            'createdAt' => (int)$r['created_at'],
            'expiresAt' => (int)$r['expires_at'],
            'forwarded' => (int)$r['forwarded'] === 1,
            'mine' => $senderId === $viewerId,
        ];
    }
    return $out;
}

function fetch_messages(int $convId, int $viewerId, array $opts = []): array
{
    $before = (int)($opts['before'] ?? 0);
    $after = (int)($opts['after'] ?? 0);
    $limit = min(100, max(1, (int)($opts['limit'] ?? 50)));
    $q = trim((string)($opts['q'] ?? ''));
    $cleared = (int)($opts['cleared_before'] ?? 0);
    $t = now();

    $where = ['m.conversation_id = ?', 'm.id > ?', 'm.sender_id <> 0'];
    $args = [$convId, $cleared];
    $where[] = '(m.expires_at = 0 OR m.expires_at > ?)';
    $args[] = $t;
    $where[] = 'NOT EXISTS (SELECT 1 FROM message_hidden mh WHERE mh.message_id = m.id AND mh.user_id = ?)';
    $args[] = $viewerId;
    if ($before > 0) {
        $where[] = 'm.id < ?';
        $args[] = $before;
    }
    if ($after > 0) {
        $where[] = 'm.id > ?';
        $args[] = $after;
    }
    if ($q !== '') {
        $where[] = '(m.body LIKE ? OR u.name LIKE ?)';
        $like = '%' . $q . '%';
        $args[] = $like;
        $args[] = $like;
    }
    $sql = "SELECT m.*, u.name AS sender_name, u.username AS sender_username, u.avatar_id AS sender_avatar_id,
            md.id AS md_id, md.kind AS md_kind, md.mime AS md_mime, md.size AS md_size,
            md.width AS md_width, md.height AS md_height, md.duration AS md_duration,
            md.filename AS md_filename, md.orig_name AS md_orig_name, md.waveform AS md_waveform
        FROM messages m
        JOIN users u ON u.id = m.sender_id
        LEFT JOIN media md ON md.id = m.media_id
        WHERE " . implode(' AND ', $where) . "
        ORDER BY m.id DESC LIMIT " . ($limit + 1);
    $st = db()->prepare($sql);
    $st->execute($args);
    $rows = $st->fetchAll();
    $hasMore = count($rows) > $limit;
    if ($hasMore) array_pop($rows);
    // Recherche : on préfère le plus récent d'abord, sinon ordre chronologique.
    if ($q === '') $rows = array_reverse($rows);
    return [$rows, $hasMore];
}

function last_visible_message(int $convId, array $member): ?array
{
    $st = db()->prepare("SELECT m.*, u.name AS sender_name, u.username AS sender_username, u.avatar_id AS sender_avatar_id,
            md.id AS md_id, md.kind AS md_kind, md.mime AS md_mime, md.size AS md_size,
            md.width AS md_width, md.height AS md_height, md.duration AS md_duration,
            md.filename AS md_filename, md.orig_name AS md_orig_name, md.waveform AS md_waveform
        FROM messages m
        JOIN users u ON u.id = m.sender_id
        LEFT JOIN media md ON md.id = m.media_id
        WHERE m.conversation_id = ? AND m.id > ? AND (m.expires_at = 0 OR m.expires_at > ?)
          AND NOT EXISTS (SELECT 1 FROM message_hidden mh WHERE mh.message_id = m.id AND mh.user_id = ?)
        ORDER BY m.id DESC LIMIT 1");
    $st->execute([$convId, (int)$member['cleared_before'], now(), (int)$member['user_id']]);
    $r = $st->fetch();
    return $r ?: null;
}

function conversation_summary(array $c, int $viewerId): array
{
    $convId = (int)$c['id'];
    $members = conversation_members_rows($convId);
    $me = null;
    foreach ($members as $m) if ((int)$m['user_id'] === $viewerId) $me = $m;
    if (!$me) return [];

    $peer = null;
    if ($c['type'] === 'direct') {
        foreach ($members as $m) {
            if ((int)$m['user_id'] !== $viewerId) {
                $st = db()->prepare('SELECT * FROM users WHERE id = ?');
                $st->execute([(int)$m['user_id']]);
                $row = $st->fetch();
                if ($row) $peer = public_user($row, $viewerId);
            }
        }
    }

    $title = $c['type'] === 'group'
        ? (string)($c['name'] !== '' ? $c['name'] : 'Groupe')
        : (string)($peer['name'] ?? 'Discussion');
    $avatarId = $c['type'] === 'group' ? ($c['avatar_id'] ? (int)$c['avatar_id'] : null) : ($peer['avatarId'] ?? null);

    $unread = 0;
    $st = db()->prepare("SELECT COUNT(*) FROM messages m
        LEFT JOIN message_hidden mh ON mh.message_id = m.id AND mh.user_id = ?
        WHERE m.conversation_id = ? AND m.id > ? AND m.sender_id <> ? AND m.deleted_at = 0 AND m.type <> 'system'
          AND m.id > ? AND mh.message_id IS NULL AND (m.expires_at = 0 OR m.expires_at > ?)");
    $st->execute([$viewerId, $convId, (int)$me['last_read_message_id'], $viewerId, (int)$me['cleared_before'], now()]);
    $unread = (int)$st->fetchColumn();

    $last = last_visible_message($convId, $me);
    $lastJson = null;
    if ($last) {
        $lastJson = [
            'id' => (int)$last['id'],
            'senderId' => (int)$last['sender_id'],
            'senderName' => (string)$last['sender_name'],
            'type' => (string)$last['type'],
            'body' => (int)$last['deleted_at'] ? '' : (string)$last['body'],
            'mediaId' => !empty($last['media_id']) ? (int)$last['media_id'] : null,
            'createdAt' => (int)$last['created_at'],
            'deleted' => (int)$last['deleted_at'] > 0,
        ];
    }

    $blocked = false;
    if ($c['type'] === 'direct' && $peer) {
        $blocked = (bool)$peer['blocked'] || (bool)$peer['blockedBy'];
    }

    $memberJson = [];
    foreach ($members as $m) {
        $u = ['id' => (int)$m['user_id'], 'name' => (string)$m['name'], 'username' => (string)$m['username'], 'avatar_id' => $m['avatar_id'], 'last_seen' => (int)$m['last_seen'], 'privacy' => $m['privacy'], 'created_at' => 0, 'role' => $m['user_role']];
        $pu = public_user($u, $viewerId);
        $memberJson[] = [
            'id' => (int)$m['user_id'],
            'username' => (string)$m['username'],
            'name' => (string)$m['name'],
            'avatarId' => $pu['avatarId'],
            'role' => (string)$m['role'],
            'lastSeen' => $pu['lastSeen'],
            'online' => $pu['online'],
            'lastReadMessageId' => (int)$m['last_read_message_id'],
            'mutedUntil' => (int)$m['muted_until'],
        ];
    }

    return [
        'id' => $convId,
        'type' => (string)$c['type'],
        'title' => $title,
        'description' => (string)$c['description'],
        'avatarId' => $avatarId,
        'createdBy' => (int)$c['created_by'],
        'createdAt' => (int)$c['created_at'],
        'updatedAt' => (int)$c['updated_at'],
        'members' => $memberJson,
        'peer' => $peer,
        'unread' => $unread,
        'lastReadMessageId' => (int)$me['last_read_message_id'],
        'lastDeliveredMessageId' => (int)$me['last_delivered_message_id'],
        'myRole' => (string)$me['role'],
        'mutedUntil' => (int)$me['muted_until'],
        'pinned' => (int)$me['pinned'],
        'archived' => (int)$me['archived'],
        'hidden' => (int)$me['hidden'],
        'inviteCode' => (string)($c['invite_code'] ?? ''),
        'disappearingSeconds' => (int)$c['disappearing_seconds'],
        'onlyAdminsCanPost' => (int)$c['only_admins_can_post'],
        'memberCount' => count($members),
        'lastMessage' => $lastJson,
        'blocked' => $blocked,
    ];
}

function conv_changed_since(int $userId, int $since): array
{
    $sql = 'SELECT c.* FROM conversations c
        JOIN conversation_members cm ON cm.conversation_id = c.id AND cm.user_id = ?
        WHERE c.deleted = 0 AND cm.hidden = 0';
    $args = [$userId];
    if ($since > 0) {
        $sql .= ' AND (c.updated_at >= ? OR cm.joined_at >= ?)';
        $args[] = $since;
        $args[] = $since;
    }
    $sql .= ' ORDER BY c.updated_at DESC LIMIT 250';
    $st = db()->prepare($sql);
    $st->execute($args);
    $out = [];
    foreach ($st->fetchAll() as $c) {
        $s = conversation_summary($c, $userId);
        if ($s) $out[] = $s;
    }
    return $out;
}

// ============================== UPLOADS ==============================

function safe_filename(string $name): string
{
    $name = preg_replace('/[^A-Za-z0-9._-]+/', '_', $name) ?: 'fichier';
    return mb_substr(trim($name, '._-') ?: 'fichier', 0, 120);
}

function image_mime_allowed(string $mime): bool
{
    return in_array($mime, ['image/jpeg', 'image/png', 'image/webp', 'image/gif'], true);
}

function audio_mime_allowed(string $mime): bool
{
    return str_starts_with($mime, 'audio/') || in_array($mime, ['video/webm', 'application/ogg'], true);
}

function handle_upload(array $user): array
{
    if (!isset($_FILES['file']) || !is_array($_FILES['file'])) fail('Aucun fichier reçu.');
    $f = $_FILES['file'];
    if (($f['error'] ?? UPLOAD_ERR_NO_FILE) !== UPLOAD_ERR_OK) {
        $map = [
            UPLOAD_ERR_INI_SIZE => 'Fichier trop volumineux (limite serveur).',
            UPLOAD_ERR_FORM_SIZE => 'Fichier trop volumineux.',
            UPLOAD_ERR_PARTIAL => 'Envoi interrompu.',
            UPLOAD_ERR_NO_FILE => 'Aucun fichier.',
        ];
        fail($map[$f['error']] ?? 'Échec de l’upload.', 400);
    }
    $size = (int)$f['size'];
    if ($size <= 0 || $size > MAX_UPLOAD) fail('Fichier trop volumineux (30 Mo max).', 413);
    $kind = (string)p('kind', 'file');
    if (!in_array($kind, ['image', 'voice', 'file'], true)) $kind = 'file';

    $tmp = (string)$f['tmp_name'];
    $finfo = new finfo(FILEINFO_MIME_TYPE);
    $mime = (string)$finfo->file($tmp);
    $ext = '';
    $width = 0;
    $height = 0;
    $filename = '';
    $duration = (float)p('duration', 0);
    $waveform = p('waveform', '');
    if (is_array($waveform)) $waveform = json_encode($waveform);
    if (!is_string($waveform)) $waveform = '';
    if ($waveform !== '') {
        $arr = json_decode($waveform, true);
        if (!is_array($arr)) $waveform = '';
        else {
            $arr = array_slice(array_map(fn($v) => max(0, min(100, (int)$v)), $arr), 0, 64);
            $waveform = json_encode($arr);
        }
    }

    if ($kind === 'image') {
        if (!image_mime_allowed($mime)) fail('Format d’image non pris en charge (JPEG, PNG, WebP, GIF).');
        $info = @getimagesize($tmp);
        if (!$info) fail('Image invalide.');
        $width = (int)$info[0];
        $height = (int)$info[1];
        $ext = ['image/jpeg' => 'jpg', 'image/png' => 'png', 'image/webp' => 'webp', 'image/gif' => 'gif'][$mime] ?? 'jpg';
        $target = MEDIA_DIR . '/' . bin2hex(random_bytes(16)) . '.' . $ext;
        if (!move_uploaded_file($tmp, $target)) fail('Impossible d’enregistrer l’image.', 500);
        // Ré-encodage si très grande (et si GD est disponible) : supprime les métadonnées.
        if (max($width, $height) > MAX_IMAGE_DIM && function_exists('imagecreatefromstring')) {
            $data = @file_get_contents($target);
            $src = $data !== false ? @imagecreatefromstring($data) : false;
            if ($src) {
                $ratio = MAX_IMAGE_DIM / max($width, $height);
                $nw = max(1, (int)round($width * $ratio));
                $nh = max(1, (int)round($height * $ratio));
                $dst = imagecreatetruecolor($nw, $nh);
                $white = imagecolorallocate($dst, 255, 255, 255);
                imagefill($dst, 0, 0, $white);
                imagecopyresampled($dst, $src, 0, 0, 0, 0, $nw, $nh, $width, $height);
                imagejpeg($dst, $target, 86);
                imagedestroy($dst);
                imagedestroy($src);
                $mime = 'image/jpeg';
                $ext = 'jpg';
                $width = $nw;
                $height = $nh;
                $size = filesize($target) ?: $size;
            }
        }
        $filename = $target;
    } elseif ($kind === 'voice') {
        if (!audio_mime_allowed($mime)) fail('Format audio non pris en charge.');
        $ext = str_starts_with($mime, 'audio/mp4') ? 'm4a'
            : (str_contains($mime, 'ogg') ? 'ogg'
            : (str_contains($mime, 'wav') ? 'wav'
            : (str_contains($mime, 'mpeg') ? 'mp3'
            : (str_contains($mime, 'aac') ? 'aac' : 'webm'))));
        $target = MEDIA_DIR . '/' . bin2hex(random_bytes(16)) . '.' . $ext;
        if (!move_uploaded_file($tmp, $target)) fail('Impossible d’enregistrer le vocal.', 500);
        $filename = $target;
        if ($duration <= 0 || $duration > 3600) $duration = 0;
    } else {
        $orig = safe_filename((string)($f['name'] ?? 'fichier'));
        $lower = strtolower($orig);
        $bad = ['php', 'phtml', 'phar', 'html', 'htm', 'svg', 'js', 'mjs', 'sh', 'bat', 'exe', 'com', 'htaccess'];
        $pext = strtolower(pathinfo($lower, PATHINFO_EXTENSION));
        if (in_array($pext, $bad, true)) fail('Ce type de fichier n’est pas autorisé.');
        $ext = $pext !== '' ? $pext : 'bin';
        $target = MEDIA_DIR . '/' . bin2hex(random_bytes(16)) . '.' . preg_replace('/[^a-z0-9]/', '', $ext);
        if (!move_uploaded_file($tmp, $target)) fail('Impossible d’enregistrer le fichier.', 500);
        $filename = $target;
        $origName = $orig;
    }

    $st = db()->prepare('INSERT INTO media(user_id, kind, filename, orig_name, mime, size, width, height, duration, waveform, created_at)
        VALUES(?,?,?,?,?,?,?,?,?,?,?)');
    $st->execute([
        (int)$user['id'], $kind, basename($filename), $origName ?? ($f['name'] ?? ''),
        $mime, $size, $width, $height, $duration, $waveform, now(),
    ]);
    $id = (int)db()->lastInsertId();
    $st = db()->prepare('SELECT * FROM media WHERE id = ?');
    $st->execute([$id]);
    return media_json($st->fetch());
}

function media_accessible(array $media, int $userId): bool
{
    if ((int)$media['user_id'] === $userId) return true;
    $st = db()->prepare('SELECT 1 FROM messages m
        JOIN conversation_members cm ON cm.conversation_id = m.conversation_id AND cm.user_id = ?
        WHERE m.media_id = ? LIMIT 1');
    $st->execute([$userId, (int)$media['id']]);
    if ($st->fetchColumn()) return true;
    $st = db()->prepare('SELECT 1 FROM users WHERE avatar_id = ? LIMIT 1');
    $st->execute([(int)$media['id']]);
    return (bool)$st->fetchColumn();
}

// ============================== WEB PUSH ==============================

function vapid_keys(): ?array
{
    $priv = meta_get('vapid_private');
    $pub = meta_get('vapid_public');
    if ($priv && $pub) return ['private' => $priv, 'public' => $pub];
    if (!function_exists('openssl_pkey_new')) return null;
    $key = @openssl_pkey_new(['private_key_type' => OPENSSL_KEYTYPE_EC, 'curve_name' => 'prime256v1']);
    if (!$key) return null;
    $details = openssl_pkey_get_details($key);
    if (!$details || !isset($details['ec']['x'], $details['ec']['y'])) return null;
    $raw = "\x04" . $details['ec']['x'] . $details['ec']['y'];
    $pem = '';
    if (!openssl_pkey_export($key, $pem)) return null;
    $public = b64u($raw);
    meta_set('vapid_private', $pem);
    meta_set('vapid_public', $public);
    return ['private' => $pem, 'public' => $public];
}

function hkdf_extract(string $salt, string $ikm): string
{
    return hash_hmac('sha256', $ikm, $salt, true);
}

function hkdf_expand(string $prk, string $info, int $len): string
{
    $t = '';
    $okm = '';
    for ($i = 1; strlen($okm) < $len; $i++) {
        $t = hash_hmac('sha256', $t . $info . chr($i), $prk, true);
        $okm .= $t;
    }
    return substr($okm, 0, $len);
}

function hkdf(string $salt, string $ikm, string $info, int $len): string
{
    return hkdf_expand(hkdf_extract($salt, $ikm), $info, $len);
}

function der_to_jose(string $der): string
{
    $pos = 0;
    if ($der === '' || ord($der[$pos++]) !== 0x30) throw new RuntimeException('DER invalide');
    $len = ord($der[$pos++]);
    if ($len & 0x80) {
        $n = $len & 0x7f;
        $len = 0;
        for ($i = 0; $i < $n; $i++) $len = ($len << 8) | ord($der[$pos++]);
    }
    $r = '';
    $s = '';
    for ($k = 0; $k < 2; $k++) {
        if (ord($der[$pos++]) !== 0x02) throw new RuntimeException('DER invalide');
        $ilen = ord($der[$pos++]);
        if ($ilen & 0x80) {
            $n = $ilen & 0x7f;
            $ilen = 0;
            for ($i = 0; $i < $n; $i++) $ilen = ($ilen << 8) | ord($der[$pos++]);
        }
        $val = substr($der, $pos, $ilen);
        $pos += $ilen;
        if ($k === 0) $r = $val;
        else $s = $val;
    }
    $r = ltrim($r, "\x00");
    $s = ltrim($s, "\x00");
    return str_pad($r, 32, "\x00", STR_PAD_LEFT) . str_pad($s, 32, "\x00", STR_PAD_LEFT);
}

function vapid_jwt(string $endpoint): ?string
{
    $keys = vapid_keys();
    if (!$keys) return null;
    $u = parse_url($endpoint);
    if (!$u || empty($u['scheme']) || empty($u['host'])) return null;
    $aud = $u['scheme'] . '://' . $u['host'] . (isset($u['port']) ? ':' . $u['port'] : '');
    $host = (string)($_SERVER['HTTP_HOST'] ?? '');
    $sub = VAPID_SUBJECT;
    if ($host !== '' && preg_match('/^[A-Za-z0-9.\-:\[\]]+$/', $host)) $sub = 'https://' . $host;
    $header = b64u(json_encode(['typ' => 'JWT', 'alg' => 'ES256']));
    $claims = b64u(json_encode(['aud' => $aud, 'exp' => now() + 12 * 3600, 'sub' => $sub]));
    $data = $header . '.' . $claims;
    $sig = '';
    if (!openssl_sign($data, $sig, $keys['private'], OPENSSL_ALGO_SHA256)) return null;
    return $data . '.' . b64u(der_to_jose($sig));
}

function raw_p256_pem(string $raw): string
{
    $prefix = hex2bin('3059301306072a8648ce3d020106082a8648ce3d030107034200');
    return "-----BEGIN PUBLIC KEY-----\n" . chunk_split(base64_encode($prefix . $raw), 64, "\n") . "-----END PUBLIC KEY-----\n";
}

function webpush_encrypt(string $payload, string $p256dh, string $auth): string
{
    $uaPublic = b64u_dec($p256dh);
    $authSecret = b64u_dec($auth);
    if (strlen($uaPublic) !== 65 || $uaPublic[0] !== "\x04") throw new RuntimeException('Clé p256dh invalide');
    if (strlen($authSecret) !== 16) throw new RuntimeException('Secret auth invalide');
    $local = @openssl_pkey_new(['private_key_type' => OPENSSL_KEYTYPE_EC, 'curve_name' => 'prime256v1']);
    if (!$local) throw new RuntimeException('OpenSSL indisponible');
    $details = openssl_pkey_get_details($local);
    if (!$details) throw new RuntimeException('Clé locale invalide');
    $asPublic = "\x04" . $details['ec']['x'] . $details['ec']['y'];
    $shared = @openssl_pkey_derive(raw_p256_pem($uaPublic), $local, 32);
    if ($shared === false || strlen($shared) < 32) throw new RuntimeException('ECDH impossible');
    $shared = substr($shared, 0, 32);

    $authInfo = "WebPush: info\x00" . $uaPublic . $asPublic;
    $ikm = hkdf($authSecret, $shared, $authInfo, 32);
    $salt = random_bytes(16);
    $prk = hkdf_extract($salt, $ikm);
    $cek = hkdf_expand($prk, "Content-Encoding: aes128gcm\x00", 16);
    $nonce = hkdf_expand($prk, "Content-Encoding: nonce\x00", 12);
    $plain = $payload . "\x02";
    $tag = '';
    $cipher = openssl_encrypt($plain, 'aes-128-gcm', $cek, OPENSSL_RAW_DATA, $nonce, $tag, '', 16);
    if ($cipher === false) throw new RuntimeException('Chiffrement AES-GCM impossible');
    return $salt . pack('N', 4096) . chr(strlen($asPublic)) . $asPublic . $cipher . $tag;
}

function endpoint_allowed(string $endpoint): bool
{
    $u = parse_url($endpoint);
    if (!$u || ($u['scheme'] ?? '') !== 'https' || empty($u['host'])) return false;
    $host = $u['host'];
    if (filter_var($host, FILTER_VALIDATE_IP)) {
        return (bool)filter_var($host, FILTER_VALIDATE_IP, FILTER_FLAG_NO_PRIV_RANGE | FILTER_FLAG_NO_RES_RANGE);
    }
    $ip = gethostbyname($host);
    if ($ip === $host) return true; // résolution indisponible : on laisse curl échouer
    return (bool)filter_var($ip, FILTER_VALIDATE_IP, FILTER_FLAG_NO_PRIV_RANGE | FILTER_FLAG_NO_RES_RANGE);
}

/** Envoie un push à un abonnement. Retourne [ok, statut, erreur]. */
function webpush_send(array $sub, array $payload): array
{
    if (!function_exists('curl_init')) return [false, 0, 'curl absent'];
    $endpoint = (string)$sub['endpoint'];
    if (!endpoint_allowed($endpoint)) return [false, 0, 'endpoint refusé'];
    $jwt = vapid_jwt($endpoint);
    $keys = vapid_keys();
    if (!$jwt || !$keys) return [false, 0, 'VAPID indisponible'];
    try {
        $body = webpush_encrypt(json_encode($payload, JSON_UNESCAPED_UNICODE), (string)$sub['p256dh'], (string)$sub['auth']);
    } catch (Throwable $e) {
        return [false, 0, $e->getMessage()];
    }
    $headers = [
        'TTL: 2419200',
        'Content-Encoding: aes128gcm',
        'Content-Type: application/octet-stream',
        'Authorization: vapid t=' . $jwt . ', k=' . $keys['public'],
        'Urgency: normal',
        'Topic: pulse-' . substr(sha1($endpoint), 0, 12),
    ];
    $ch = curl_init($endpoint);
    curl_setopt_array($ch, [
        CURLOPT_POST => true,
        CURLOPT_POSTFIELDS => $body,
        CURLOPT_HTTPHEADER => $headers,
        CURLOPT_RETURNTRANSFER => true,
        CURLOPT_CONNECTTIMEOUT => 3,
        CURLOPT_TIMEOUT => 6,
        CURLOPT_SSL_VERIFYPEER => true,
        CURLOPT_SSL_VERIFYHOST => 2,
        CURLOPT_USERAGENT => 'Pulse-Push/1.0',
    ]);
    $resp = curl_exec($ch);
    $status = (int)curl_getinfo($ch, CURLINFO_RESPONSE_CODE);
    $err = curl_error($ch);
    curl_close($ch);
    $ok = $status >= 200 && $status < 300;
    if ($ok) {
        db()->prepare('UPDATE push_subscriptions SET last_ok = ?, last_error = \'\' WHERE id = ?')->execute([now(), (int)$sub['id']]);
    } else {
        db()->prepare('UPDATE push_subscriptions SET last_error = ? WHERE id = ?')->execute([mb_substr($err !== '' ? $err : 'HTTP ' . $status, 0, 200), (int)$sub['id']]);
        if ($status === 404 || $status === 410) {
            db()->prepare('DELETE FROM push_subscriptions WHERE id = ?')->execute([(int)$sub['id']]);
        }
    }
    return [$ok, $status, $err !== '' ? $err : ($ok ? '' : 'HTTP ' . $status)];
}

function push_notify_message(array $conv, array $sender, array $message, array $members): void
{
    if (!function_exists('curl_multi_init')) return;
    $group = $conv['type'] === 'group';
    $title = $group ? (string)$conv['name'] : (string)$sender['name'];
    $preview = trim((string)$message['body']);
    if ((string)$message['type'] === 'image') $preview = $preview !== '' ? '📷 ' . $preview : '📷 Photo';
    elseif ((string)$message['type'] === 'voice') $preview = '🎤 Message vocal';
    elseif ((string)$message['type'] === 'file') $preview = '📎 ' . ($preview !== '' ? $preview : 'Fichier');
    $preview = mb_substr($preview, 0, 140);

    $subs = [];
    $seenUsers = [];
    foreach ($members as $m) {
        $uid = (int)$m['user_id'];
        if ($uid === (int)$sender['id'] || isset($seenUsers[$uid])) continue;
        $seenUsers[$uid] = true;
        if ((int)$m['muted_until'] > now()) continue;
        $st = db()->prepare('SELECT notif FROM users WHERE id = ?');
        $st->execute([$uid]);
        $row = $st->fetch();
        if (!$row) continue;
        $prefs = user_notif(['notif' => $row['notif']]);
        if (!$prefs['enabled'] || !$prefs['messages'] || ($group && !$prefs['groups'])) continue;
        $body = $prefs['preview'] ? $preview : 'Nouveau message';
        if ($group) $body = $sender['name'] . ' : ' . $body;
        $payload = [
            'title' => $title,
            'body' => $body,
            'conversationId' => (int)$conv['id'],
            'url' => '#/chat/' . (int)$conv['id'],
            'tag' => 'pulse-conv-' . (int)$conv['id'],
            'sound' => (bool)$prefs['sound'],
            'renotify' => true,
        ];
        $st = db()->prepare('SELECT * FROM push_subscriptions WHERE user_id = ?');
        $st->execute([$uid]);
        foreach ($st->fetchAll() as $sub) {
            $sub['_payload'] = $payload;
            $subs[] = $sub;
        }
    }
    if (!$subs) return;

    // Envoi parallèle, budget 6 s maximum : ne bloque pas durablement l'API.
    $mh = curl_multi_init();
    $handles = [];
    foreach ($subs as $sub) {
        if (!endpoint_allowed((string)$sub['endpoint'])) continue;
        $jwt = vapid_jwt((string)$sub['endpoint']);
        $keys = vapid_keys();
        if (!$jwt || !$keys) continue;
        try {
            $body = webpush_encrypt(json_encode($sub['_payload'], JSON_UNESCAPED_UNICODE), (string)$sub['p256dh'], (string)$sub['auth']);
        } catch (Throwable $e) {
            continue;
        }
        $ch = curl_init((string)$sub['endpoint']);
        curl_setopt_array($ch, [
            CURLOPT_POST => true,
            CURLOPT_POSTFIELDS => $body,
            CURLOPT_HTTPHEADER => [
                'TTL: 2419200',
                'Content-Encoding: aes128gcm',
                'Content-Type: application/octet-stream',
                'Authorization: vapid t=' . $jwt . ', k=' . $keys['public'],
                'Urgency: normal',
                'Topic: pulse-' . substr(sha1((string)$sub['endpoint']), 0, 12),
            ],
            CURLOPT_RETURNTRANSFER => true,
            CURLOPT_CONNECTTIMEOUT => 3,
            CURLOPT_TIMEOUT => 6,
            CURLOPT_SSL_VERIFYPEER => true,
            CURLOPT_SSL_VERIFYHOST => 2,
            CURLOPT_USERAGENT => 'Pulse-Push/1.0',
        ]);
        curl_multi_add_handle($mh, $ch);
        $handles[] = [$ch, (int)$sub['id']];
    }
    $deadline = microtime(true) + 6.0;
    do {
        $status = curl_multi_exec($mh, $running);
        if ($running) curl_multi_select($mh, 0.4);
    } while ($running && microtime(true) < $deadline);
    foreach ($handles as [$ch, $sid]) {
        $code = (int)curl_getinfo($ch, CURLINFO_RESPONSE_CODE);
        if ($code === 404 || $code === 410) {
            db()->prepare('DELETE FROM push_subscriptions WHERE id = ?')->execute([$sid]);
        } elseif ($code >= 200 && $code < 300) {
            db()->prepare('UPDATE push_subscriptions SET last_ok = ? WHERE id = ?')->execute([now(), $sid]);
        }
        curl_multi_remove_handle($mh, $ch);
        curl_close($ch);
    }
    curl_multi_close($mh);
}

// ============================== DISPATCH ==============================

$action = (string)($_GET['action'] ?? $_POST['action'] ?? '');

$PUBLIC_ACTIONS = ['ping', 'bootstrap_status', 'bootstrap', 'login', 'register', 'invite_info', 'push_key'];

try {
    if ($action === 'ping') {
        ok(['app' => APP_NAME, 'version' => APP_VERSION, 'time' => now(), 'needsSetup' => user_count() === 0]);
    }

    if ($action === 'bootstrap_status') {
        ok(['needsSetup' => user_count() === 0, 'app' => APP_NAME, 'version' => APP_VERSION]);
    }

    if ($action === 'bootstrap') {
        bootstrap_action();
    }

    if ($action === 'login') {
        login_action();
    }

    if ($action === 'register') {
        register_action();
    }

    if ($action === 'invite_info') {
        invite_info_action();
    }

    if ($action === 'push_key') {
        $keys = vapid_keys();
        ok(['publicKey' => $keys['public'] ?? '', 'enabled' => (bool)$keys && function_exists('curl_init')]);
    }

    // ---- à partir d'ici : session obligatoire ----
    if (!in_array($action, $PUBLIC_ACTIONS, true)) {
        $user = auth();
        $uid = (int)$user['id'];

        switch ($action) {
            case 'logout':
                db()->prepare('DELETE FROM sessions WHERE token = ?')->execute([(string)$user['session_token']]);
                ok();

            case 'me':
                ok(['user' => me_payload($user)]);

            case 'heartbeat':
                ok(['now' => now()]);

            case 'profile_get':
                profile_get_action($user);
            case 'profile_update':
                profile_update_action($user);
            case 'password_change':
                password_change_action($user);
            case 'user_search':
                user_search_action($user);
            case 'directory':
                directory_action($user);
            case 'block_user':
                block_user_action($user, true);
            case 'unblock_user':
                block_user_action($user, false);

            case 'invites_list':
                invites_list_action($user);
            case 'invite_create':
                invite_create_action($user);
            case 'invite_revoke':
                invite_revoke_action($user);

            case 'conversations_list':
                conversations_list_action($user);
            case 'conversation_get':
                conversation_get_action($user);
            case 'conversation_create_direct':
                conversation_create_direct_action($user);
            case 'conversation_create_group':
                conversation_create_group_action($user);
            case 'conversation_update':
                conversation_update_action($user);
            case 'conversation_add_members':
                conversation_add_members_action($user);
            case 'conversation_remove_member':
                conversation_remove_member_action($user);
            case 'conversation_leave':
                conversation_leave_action($user);
            case 'conversation_set_role':
                conversation_set_role_action($user);
            case 'conversation_mute':
                conversation_mute_action($user);
            case 'conversation_pin':
                conversation_pin_action($user, 'pinned');
            case 'conversation_archive':
                conversation_pin_action($user, 'archived');
            case 'conversation_read':
                conversation_read_action($user);
            case 'conversation_clear':
                conversation_clear_action($user);
            case 'conversation_delete':
                conversation_delete_action($user);
            case 'conversation_invite':
                conversation_invite_action($user);
            case 'conversation_join':
                conversation_join_action($user);
            case 'conversation_media':
                conversation_media_action($user);

            case 'messages_list':
                messages_list_action($user);
            case 'message_send':
                message_send_action($user);
            case 'message_edit':
                message_edit_action($user);
            case 'message_delete':
                message_delete_action($user);
            case 'message_forward':
                message_forward_action($user);
            case 'message_react':
                message_react_action($user);
            case 'message_star':
                message_star_action($user);
            case 'messages_starred':
                messages_starred_action($user);
            case 'message_info':
                message_info_action($user);
            case 'search_messages':
                search_messages_action($user);
            case 'search':
                search_action($user);
            case 'typing':
                typing_action($user);
            case 'sync':
                sync_action($user);

            case 'media_upload':
                ok(['media' => handle_upload($user)]);
            case 'media_get':
                media_get_action($user);

            case 'push_subscribe':
                push_subscribe_action($user);
            case 'push_unsubscribe':
                push_unsubscribe_action($user);
            case 'push_devices':
                push_devices_action($user);
            case 'push_test':
                push_test_action($user);

            case 'admin_users':
                admin_users_action($user);
            case 'admin_user_update':
                admin_user_update_action($user);
            case 'admin_stats':
                admin_stats_action($user);

            default:
                fail('Action inconnue : ' . $action, 404);
        }
    }

    fail('Action inconnue.', 404);
} catch (Throwable $e) {
    $log = dirname(DB_FILE) . '/error.log';
    @file_put_contents($log, '[' . date('c') . '] ' . $e->getMessage() . ' @ ' . $e->getFile() . ':' . $e->getLine() . "\n", FILE_APPEND);
    fail('Erreur interne du serveur.', 500);
}

// ============================== ACTIONS AUTH ==============================

function user_count(): int
{
    return (int)db()->query('SELECT COUNT(*) FROM users')->fetchColumn();
}

function bootstrap_action(): void
{
    if (user_count() > 0) fail('L’administrateur existe déjà. Utilisez une invitation pour créer un compte.', 403);
    $name = str_input('name', 60);
    $email = strtolower(str_input('email', 120));
    $username = normalize_username(str_input('username', 24));
    $password = (string)p('password', '');
    if (mb_strlen($name) < 2) fail('Indiquez votre nom.');
    if (!valid_email($email)) fail('Adresse e-mail invalide.');
    if (!valid_username($username)) fail('Identifiant invalide (3 à 24 caractères : lettres, chiffres, point, tiret bas).');
    if (strlen($password) < 8) fail('Le mot de passe doit contenir au moins 8 caractères.');

    $pdo = db();
    $pdo->beginTransaction();
    try {
        if ((int)$pdo->query('SELECT COUNT(*) FROM users')->fetchColumn() > 0) {
            $pdo->rollBack();
            fail('L’administrateur existe déjà.', 403);
        }
        $t = now();
        $notif = json_encode(['enabled' => true, 'messages' => true, 'groups' => true, 'preview' => true, 'sound' => true, 'badge' => true]);
        $privacy = json_encode(['lastSeen' => 'contacts', 'profilePhoto' => 'contacts']);
        $st = $pdo->prepare('INSERT INTO users(email, username, name, password_hash, role, created_at, last_seen, notif, privacy) VALUES(?,?,?,?, \'admin\', ?,?,?,?)');
        $st->execute([$email, $username, $name, password_hash($password, PASSWORD_DEFAULT), $t, $t, $notif, $privacy]);
        $id = (int)$pdo->lastInsertId();
        $pdo->commit();
    } catch (Throwable $e) {
        if ($pdo->inTransaction()) $pdo->rollBack();
        throw $e;
    }
    $token = create_session($id);
    $st = db()->prepare('SELECT * FROM users WHERE id = ?');
    $st->execute([$id]);
    ok(['token' => $token, 'user' => me_payload($st->fetch())]);
}

function login_action(): void
{
    $login = strtolower(str_input('login', 120));
    $password = (string)p('password', '');
    if ($login === '' || $password === '') fail('Identifiant et mot de passe requis.');
    $key = 'login:' . sha1($login . '|' . request_ip());
    throttle_check($key);

    $st = db()->prepare('SELECT * FROM users WHERE email = ? OR username = ? LIMIT 1');
    $st->execute([$login, $login]);
    $u = $st->fetch();
    if (!$u || !password_verify($password, (string)$u['password_hash'])) {
        throttle_fail($key);
        fail('Identifiant ou mot de passe incorrect.', 401);
    }
    if ((int)$u['active'] !== 1) fail('Ce compte est désactivé. Contactez l’administrateur.', 403);
    throttle_clear($key);
    if (password_needs_rehash((string)$u['password_hash'], PASSWORD_DEFAULT)) {
        db()->prepare('UPDATE users SET password_hash = ? WHERE id = ?')->execute([password_hash($password, PASSWORD_DEFAULT), (int)$u['id']]);
    }
    $token = create_session((int)$u['id']);
    $st = db()->prepare('SELECT * FROM users WHERE id = ?');
    $st->execute([(int)$u['id']]);
    ok(['token' => $token, 'user' => me_payload($st->fetch())]);
}

function register_action(): void
{
    $code = strtoupper(str_input('inviteCode', 24));
    $name = str_input('name', 60);
    $email = strtolower(str_input('email', 120));
    $username = normalize_username(str_input('username', 24));
    $password = (string)p('password', '');
    if ($code === '') fail('Code d’invitation requis.');
    $key = 'register:' . sha1($code . '|' . request_ip());
    throttle_check($key);

    $st = db()->prepare('SELECT * FROM invites WHERE code = ? AND revoked = 0 LIMIT 1');
    $st->execute([$code]);
    $inv = $st->fetch();
    if (!$inv || (int)$inv['uses'] >= (int)$inv['max_uses'] || (int)$inv['expires_at'] < now()) {
        throttle_fail($key);
        fail('Invitation invalide ou expirée.', 403);
    }
    if ((string)$inv['email'] !== '' && strtolower((string)$inv['email']) !== $email) {
        fail('Cette invitation est réservée à une autre adresse e-mail.', 403);
    }
    if (mb_strlen($name) < 2) fail('Indiquez votre nom.');
    if (!valid_email($email)) fail('Adresse e-mail invalide.');
    if (!valid_username($username)) fail('Identifiant invalide (3 à 24 caractères : lettres, chiffres, point, tiret bas).');
    if (strlen($password) < 8) fail('Le mot de passe doit contenir au moins 8 caractères.');

    $pdo = db();
    $pdo->beginTransaction();
    try {
        $st = $pdo->prepare('SELECT COUNT(*) FROM users WHERE email = ?');
        $st->execute([$email]);
        if ((int)$st->fetchColumn() > 0) {
            $pdo->rollBack();
            fail('Un compte existe déjà avec cette adresse e-mail.');
        }
        $st = $pdo->prepare('SELECT COUNT(*) FROM users WHERE username = ?');
        $st->execute([$username]);
        if ((int)$st->fetchColumn() > 0) {
            $pdo->rollBack();
            fail('Cet identifiant est déjà pris.');
        }
        // Re-vérifier l'invitation dans la transaction (usage concurrent).
        $st = $pdo->prepare('SELECT * FROM invites WHERE id = ?');
        $st->execute([(int)$inv['id']]);
        $fresh = $st->fetch();
        if (!$fresh || (int)$fresh['uses'] >= (int)$fresh['max_uses']) {
            $pdo->rollBack();
            fail('Invitation déjà utilisée.', 403);
        }
        $t = now();
        $notif = json_encode(['enabled' => true, 'messages' => true, 'groups' => true, 'preview' => true, 'sound' => true, 'badge' => true]);
        $privacy = json_encode(['lastSeen' => 'contacts', 'profilePhoto' => 'contacts']);
        $role = (string)$fresh['role'] === 'admin' ? 'admin' : 'member';
        $st = $pdo->prepare('INSERT INTO users(email, username, name, password_hash, role, created_at, last_seen, notif, privacy) VALUES(?,?,?,?,?,?,?,?,?)');
        $st->execute([$email, $username, $name, password_hash($password, PASSWORD_DEFAULT), $role, $t, $t, $notif, $privacy]);
        $id = (int)$pdo->lastInsertId();
        $pdo->prepare('UPDATE invites SET uses = uses + 1 WHERE id = ?')->execute([(int)$fresh['id']]);
        $pdo->commit();
    } catch (Throwable $e) {
        if ($pdo->inTransaction()) $pdo->rollBack();
        throw $e;
    }
    throttle_clear($key);
    $token = create_session($id);
    $st = db()->prepare('SELECT * FROM users WHERE id = ?');
    $st->execute([$id]);
    ok(['token' => $token, 'user' => me_payload($st->fetch())]);
}

function invite_info_action(): void
{
    $code = strtoupper(str_input('code', 24));
    if ($code === '') fail('Code manquant.');
    $st = db()->prepare('SELECT i.*, u.name AS creator_name FROM invites i LEFT JOIN users u ON u.id = i.created_by WHERE i.code = ? AND i.revoked = 0 LIMIT 1');
    $st->execute([$code]);
    $inv = $st->fetch();
    if ($inv) {
        $valid = (int)$inv['uses'] < (int)$inv['max_uses'] && (int)$inv['expires_at'] >= now();
        ok(['invite' => [
            'kind' => 'account', 'code' => $code, 'valid' => $valid,
            'email' => (string)$inv['email'], 'note' => (string)$inv['note'],
            'creatorName' => (string)($inv['creator_name'] ?? ''),
            'expiresAt' => (int)$inv['expires_at'],
            'reason' => $valid ? '' : 'Invitation expirée ou déjà utilisée.',
        ]]);
    }
    $st = db()->prepare('SELECT c.*, (SELECT COUNT(*) FROM conversation_members cm WHERE cm.conversation_id = c.id) AS member_count FROM conversations c WHERE c.invite_code = ? AND c.type = \'group\' AND c.deleted = 0 LIMIT 1');
    $st->execute([$code]);
    $g = $st->fetch();
    if ($g) {
        $viewer = null;
        $token = request_token();
        if ($token !== '') {
            $stv = db()->prepare('SELECT u.id FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token = ? AND u.active = 1 LIMIT 1');
            $stv->execute([$token]);
            if ($stv->fetchColumn()) $viewer = true;
        }
        ok(['invite' => [
            'kind' => 'group', 'code' => $code, 'valid' => true,
            'email' => '', 'note' => (string)$g['description'],
            'creatorName' => '', 'expiresAt' => 0,
            'groupName' => (string)$g['name'],
            'groupMemberCount' => (int)$g['member_count'],
            'needsAuth' => $viewer === null,
            'reason' => '',
        ]]);
    }
    ok(['invite' => ['kind' => 'account', 'code' => $code, 'valid' => false, 'email' => '', 'note' => '', 'creatorName' => '', 'expiresAt' => 0, 'reason' => 'Invitation introuvable ou expirée.']]);
}

// ============================== ACTIONS PROFIL ==============================

function profile_get_action(array $viewer): void
{
    $targetId = int_input('userId');
    if ($targetId <= 0) fail('Utilisateur manquant.');
    $st = db()->prepare('SELECT * FROM users WHERE id = ? LIMIT 1');
    $st->execute([$targetId]);
    $target = $st->fetch();
    if (!$target) fail('Utilisateur introuvable.', 404);
    $isSelf = $targetId === (int)$viewer['id'];
    if ((int)$target['active'] !== 1 && !$isSelf && !is_admin($viewer)) fail('Ce compte est désactivé.', 403);

    $user = public_user($target, (int)$viewer['id'], $isSelf || is_admin($viewer));
    $user['directId'] = null;
    $d = find_direct_conversation((int)$viewer['id'], $targetId);
    if ($d) $user['directId'] = (int)$d['id'];

    $groups = [];
    $st = db()->prepare("SELECT c.id, c.name, c.avatar_id, c.description,
            (SELECT COUNT(*) FROM conversation_members x WHERE x.conversation_id = c.id) AS member_count
        FROM conversations c
        JOIN conversation_members m1 ON m1.conversation_id = c.id AND m1.user_id = ? AND m1.hidden = 0
        JOIN conversation_members m2 ON m2.conversation_id = c.id AND m2.user_id = ?
        WHERE c.type = 'group' AND c.deleted = 0
        ORDER BY c.updated_at DESC LIMIT 50");
    $st->execute([(int)$viewer['id'], $targetId]);
    foreach ($st->fetchAll() as $g) {
        $groups[] = [
            'id' => (int)$g['id'],
            'title' => (string)$g['name'],
            'avatarId' => $g['avatar_id'] ? (int)$g['avatar_id'] : null,
            'description' => (string)$g['description'],
            'memberCount' => (int)$g['member_count'],
        ];
    }
    ok(['user' => $user, 'groups' => $groups]);
}

function profile_update_action(array $user): void
{
    $b = input();
    $id = (int)$user['id'];
    $sets = [];
    $args = [];

    if (array_key_exists('email', $b)) {
        $email = strtolower(trim((string)$b['email']));
        if (!valid_email($email)) fail('Adresse e-mail invalide.');
        $st = db()->prepare('SELECT COUNT(*) FROM users WHERE email = ? AND id <> ?');
        $st->execute([$email, $id]);
        if ((int)$st->fetchColumn() > 0) fail('Cette adresse e-mail est déjà utilisée.');
        $sets[] = 'email = ?';
        $args[] = $email;
    }
    if (array_key_exists('name', $b)) {
        $name = mb_substr(trim((string)$b['name']), 0, 60);
        if (mb_strlen($name) < 2) fail('Le nom doit contenir au moins 2 caractères.');
        $sets[] = 'name = ?';
        $args[] = $name;
    }
    if (array_key_exists('username', $b)) {
        $username = normalize_username((string)$b['username']);
        if (!valid_username($username)) fail('Identifiant invalide (3 à 24 caractères : lettres, chiffres, point, tiret bas).');
        $st = db()->prepare('SELECT COUNT(*) FROM users WHERE username = ? AND id <> ?');
        $st->execute([$username, $id]);
        if ((int)$st->fetchColumn() > 0) fail('Cet identifiant est déjà pris.');
        $sets[] = 'username = ?';
        $args[] = $username;
    }
    if (array_key_exists('bio', $b)) {
        $sets[] = 'bio = ?';
        $args[] = mb_substr(trim((string)$b['bio']), 0, 200);
    }
    if (array_key_exists('phone', $b)) {
        $sets[] = 'phone = ?';
        $args[] = mb_substr(trim((string)$b['phone']), 0, 30);
    }
    if (array_key_exists('avatarId', $b)) {
        $avatarId = $b['avatarId'] === null ? 0 : (int)$b['avatarId'];
        if ($avatarId > 0) {
            $st = db()->prepare('SELECT * FROM media WHERE id = ? AND user_id = ? AND kind = \'image\'');
            $st->execute([$avatarId, $id]);
            if (!$st->fetch()) fail('Image de profil invalide.');
            $sets[] = 'avatar_id = ?';
            $args[] = $avatarId;
        } else {
            $sets[] = 'avatar_id = NULL';
        }
    }
    if (array_key_exists('notif', $b) && is_array($b['notif'])) {
        $notif = user_notif($user);
        foreach (['enabled', 'messages', 'groups', 'preview', 'sound', 'badge'] as $k) {
            if (array_key_exists($k, $b['notif'])) $notif[$k] = (bool)$b['notif'][$k];
        }
        $sets[] = 'notif = ?';
        $args[] = json_encode($notif);
    }
    if (array_key_exists('privacy', $b) && is_array($b['privacy'])) {
        $privacy = user_privacy($user);
        foreach (['lastSeen', 'profilePhoto'] as $k) {
            if (array_key_exists($k, $b['privacy']) && in_array($b['privacy'][$k], ['everyone', 'contacts', 'nobody'], true)) {
                $privacy[$k] = $b['privacy'][$k];
            }
        }
        $sets[] = 'privacy = ?';
        $args[] = json_encode($privacy);
    }
    if ($sets) {
        $args[] = $id;
        db()->prepare('UPDATE users SET ' . implode(', ', $sets) . ' WHERE id = ?')->execute($args);
    }
    $st = db()->prepare('SELECT * FROM users WHERE id = ?');
    $st->execute([$id]);
    ok(['user' => me_payload($st->fetch())]);
}

function password_change_action(array $user): void
{
    $current = (string)p('current', '');
    $next = (string)p('next', '');
    if (strlen($next) < 8) fail('Le nouveau mot de passe doit contenir au moins 8 caractères.');
    if (!password_verify($current, (string)$user['password_hash'])) fail('Mot de passe actuel incorrect.', 403);
    db()->prepare('UPDATE users SET password_hash = ?, password_changed_at = ? WHERE id = ?')
        ->execute([password_hash($next, PASSWORD_DEFAULT), now(), (int)$user['id']]);
    db()->prepare('DELETE FROM sessions WHERE user_id = ? AND token <> ?')
        ->execute([(int)$user['id'], (string)$user['session_token']]);
    ok();
}

function user_search_action(array $user): void
{
    $q = trim(str_input('q', 64));
    if (mb_strlen($q) < 1) ok(['users' => []]);
    $like = '%' . $q . '%';
    $st = db()->prepare("SELECT * FROM users
        WHERE active = 1 AND id <> ? AND (name LIKE ? OR username LIKE ? OR (email LIKE ? AND ? <> ''))
        ORDER BY CASE WHEN username = ? THEN 0 WHEN username LIKE ? THEN 1 ELSE 2 END, name COLLATE NOCASE
        LIMIT 25");
    $st->execute([(int)$user['id'], $like, $like, $like, $q, normalize_username($q), $like]);
    $out = [];
    foreach ($st->fetchAll() as $row) {
        $u = public_user($row, (int)$user['id']);
        $d = find_direct_conversation((int)$user['id'], (int)$row['id']);
        $u['directId'] = $d ? (int)$d['id'] : null;
        $u['hasDirect'] = $d !== null;
        $out[] = $u;
    }
    ok(['users' => $out]);
}

function directory_action(array $user): void
{
    $st = db()->prepare('SELECT * FROM users WHERE active = 1 AND id <> ? ORDER BY name COLLATE NOCASE LIMIT 300');
    $st->execute([(int)$user['id']]);
    $out = [];
    foreach ($st->fetchAll() as $row) {
        $u = public_user($row, (int)$user['id']);
        $d = find_direct_conversation((int)$user['id'], (int)$row['id']);
        $u['directId'] = $d ? (int)$d['id'] : null;
        $u['hasDirect'] = $d !== null;
        $out[] = $u;
    }
    usort($out, function ($a, $b) {
        if ($a['online'] !== $b['online']) return $a['online'] ? -1 : 1;
        return strcoll(mb_strtolower($a['name']), mb_strtolower($b['name']));
    });
    ok(['users' => $out]);
}

function block_user_action(array $user, bool $block): void
{
    $targetId = int_input('userId');
    if ($targetId <= 0 || $targetId === (int)$user['id']) fail('Utilisateur invalide.');
    $st = db()->prepare('SELECT id FROM users WHERE id = ?');
    $st->execute([$targetId]);
    if (!$st->fetchColumn()) fail('Utilisateur introuvable.', 404);
    if ($block) {
        db()->prepare('INSERT OR IGNORE INTO blocks(blocker_id, blocked_id, created_at) VALUES(?,?,?)')
            ->execute([(int)$user['id'], $targetId, now()]);
    } else {
        db()->prepare('DELETE FROM blocks WHERE blocker_id = ? AND blocked_id = ?')->execute([(int)$user['id'], $targetId]);
    }
    ok(['blocked' => $block]);
}

// ============================== ACTIONS INVITATIONS ==============================

function invites_list_action(array $user): void
{
    if (is_admin($user)) {
        $st = db()->prepare('SELECT i.*, u.name AS creator_name FROM invites i LEFT JOIN users u ON u.id = i.created_by ORDER BY i.created_at DESC LIMIT 100');
        $st->execute();
    } else {
        $st = db()->prepare('SELECT i.*, u.name AS creator_name FROM invites i LEFT JOIN users u ON u.id = i.created_by WHERE i.created_by = ? ORDER BY i.created_at DESC LIMIT 50');
        $st->execute([(int)$user['id']]);
    }
    $out = [];
    foreach ($st->fetchAll() as $r) $out[] = invite_json($r, (string)($r['creator_name'] ?? ''));
    ok(['invites' => $out]);
}

function invite_create_action(array $user): void
{
    if (!ALLOW_MEMBER_INVITES && !is_admin($user)) fail('Les invitations sont réservées à l’administrateur.', 403);
    $email = strtolower(str_input('email', 120));
    if ($email !== '' && !valid_email($email)) fail('Adresse e-mail invalide.');
    $note = str_input('note', 120);
    $maxUses = max(1, min(100, int_input('maxUses', 1)));
    $expiresIn = int_input('expiresIn', INVITE_TTL);
    $expiresIn = max(3600, min(60 * 24 * 3600, $expiresIn));
    $role = (string)p('role', 'member') === 'admin' && is_admin($user) ? 'admin' : 'member';
    $code = generate_code(8);
    $st = db()->prepare('INSERT INTO invites(code, created_by, email, note, role, max_uses, uses, expires_at, created_at) VALUES(?,?,?,?,?,?,0,?,?)');
    $st->execute([$code, (int)$user['id'], $email, $note, $role, $maxUses, now() + $expiresIn, now()]);
    $id = (int)db()->lastInsertId();
    $st = db()->prepare('SELECT i.*, u.name AS creator_name FROM invites i LEFT JOIN users u ON u.id = i.created_by WHERE i.id = ?');
    $st->execute([$id]);
    $r = $st->fetch();
    ok(['invite' => invite_json($r, (string)$user['name'])]);
}

function invite_revoke_action(array $user): void
{
    $id = int_input('id');
    $st = db()->prepare('SELECT * FROM invites WHERE id = ?');
    $st->execute([$id]);
    $inv = $st->fetch();
    if (!$inv) fail('Invitation introuvable.', 404);
    if (!is_admin($user) && (int)$inv['created_by'] !== (int)$user['id']) fail('Action non autorisée.', 403);
    db()->prepare('UPDATE invites SET revoked = 1 WHERE id = ?')->execute([$id]);
    ok();
}

// ============================== ACTIONS CONVERSATIONS ==============================

function conversations_list_action(array $user): void
{
    $includeArchived = bool_input('includeArchived', true);
    $sql = 'SELECT c.* FROM conversations c
        JOIN conversation_members cm ON cm.conversation_id = c.id AND cm.user_id = ? AND cm.hidden = 0
        WHERE c.deleted = 0';
    if (!$includeArchived) $sql .= ' AND cm.archived = 0';
    $sql .= ' ORDER BY cm.pinned DESC, c.updated_at DESC LIMIT 250';
    $st = db()->prepare($sql);
    $st->execute([(int)$user['id']]);
    $out = [];
    foreach ($st->fetchAll() as $c) {
        $s = conversation_summary($c, (int)$user['id']);
        if ($s) $out[] = $s;
    }
    ok(['conversations' => $out, 'unreadTotal' => unread_total((int)$user['id'])]);
}

function conversation_get_action(array $user): void
{
    $id = int_input('id');
    [$c, $m] = require_conversation($id, (int)$user['id']);
    $summary = conversation_summary($c, (int)$user['id']);
    $members = conversation_members_rows($id);
    $memberOut = [];
    foreach ($members as $row) {
        $u = public_user($row, (int)$user['id']);
        $memberOut[] = array_merge($u, [
            'memberRole' => (string)$row['role'],
            'lastReadMessageId' => (int)$row['last_read_message_id'],
            'mutedUntil' => (int)$row['muted_until'],
        ]);
    }
    ok(['conversation' => $summary, 'members' => $memberOut]);
}

function conversation_create_direct_action(array $user): void
{
    $targetId = int_input('userId');
    if ($targetId <= 0 || $targetId === (int)$user['id']) fail('Destinataire invalide.');
    $st = db()->prepare('SELECT * FROM users WHERE id = ? AND active = 1');
    $st->execute([$targetId]);
    if (!$st->fetch()) fail('Utilisateur introuvable.', 404);
    if (user_is_blocked((int)$user['id'], $targetId) || user_is_blocked($targetId, (int)$user['id'])) {
        fail('Impossible de démarrer une discussion avec cet utilisateur.', 403);
    }
    $existing = find_direct_conversation((int)$user['id'], $targetId);
    if ($existing) {
        db()->prepare('UPDATE conversation_members SET hidden = 0, archived = 0 WHERE conversation_id = ? AND user_id IN (?, ?)')
            ->execute([(int)$existing['id'], (int)$user['id'], $targetId]);
        ok(['conversation' => conversation_summary($existing, (int)$user['id'])]);
    }
    $pdo = db();
    $pdo->beginTransaction();
    try {
        $t = now();
        $st = $pdo->prepare("INSERT INTO conversations(type, created_by, created_at, updated_at) VALUES('direct', ?, ?, ?)");
        $st->execute([(int)$user['id'], $t, $t]);
        $cid = (int)$pdo->lastInsertId();
        $st = $pdo->prepare('INSERT INTO conversation_members(conversation_id, user_id, role, joined_at) VALUES(?,?,?,?)');
        $st->execute([$cid, (int)$user['id'], 'owner', $t]);
        $st->execute([$cid, $targetId, 'member', $t]);
        $pdo->commit();
    } catch (Throwable $e) {
        if ($pdo->inTransaction()) $pdo->rollBack();
        throw $e;
    }
    $c = conversation_row($cid);
    ok(['conversation' => conversation_summary($c, (int)$user['id'])]);
}

function conversation_create_group_action(array $user): void
{
    $name = trim(str_input('name', 80));
    if ($name === '') $name = 'Nouveau groupe';
    $description = str_input('description', 300);
    $memberIds = p('memberIds', []);
    if (!is_array($memberIds)) $memberIds = [];
    $memberIds = array_values(array_unique(array_filter(array_map('intval', $memberIds), fn($id) => $id > 0 && $id !== (int)$user['id'])));
    if (!$memberIds) fail('Ajoutez au moins une personne au groupe.');
    if (count($memberIds) + 1 > MAX_GROUP_MEMBERS) fail('Groupe trop grand.');

    $placeholders = implode(',', array_fill(0, count($memberIds), '?'));
    $st = db()->prepare("SELECT id FROM users WHERE active = 1 AND id IN ($placeholders)");
    $st->execute($memberIds);
    $validIds = array_map(fn($r) => (int)$r['id'], $st->fetchAll());
    if (!$validIds) fail('Aucun destinataire valide.');

    $avatarId = 0;
    $b = input();
    if (array_key_exists('avatarId', $b) && (int)$b['avatarId'] > 0) {
        $st = db()->prepare('SELECT id FROM media WHERE id = ? AND user_id = ? AND kind = \'image\'');
        $st->execute([(int)$b['avatarId'], (int)$user['id']]);
        if ($st->fetchColumn()) $avatarId = (int)$b['avatarId'];
    }

    $pdo = db();
    $pdo->beginTransaction();
    try {
        $t = now();
        $code = generate_code(10);
        $st = $pdo->prepare("INSERT INTO conversations(type, name, description, avatar_id, created_by, created_at, updated_at, invite_code)
            VALUES('group', ?, ?, ?, ?, ?, ?, ?)");
        $st->execute([$name, $description, $avatarId ?: null, (int)$user['id'], $t, $t, $code]);
        $cid = (int)$pdo->lastInsertId();
        $st = $pdo->prepare('INSERT INTO conversation_members(conversation_id, user_id, role, joined_at) VALUES(?,?,?,?)');
        $st->execute([$cid, (int)$user['id'], 'owner', $t]);
        foreach ($validIds as $mid) $st->execute([$cid, $mid, 'member', $t]);
        $pdo->commit();
    } catch (Throwable $e) {
        if ($pdo->inTransaction()) $pdo->rollBack();
        throw $e;
    }
    system_message($cid, (int)$user['id'], $user['name'] . ' a créé le groupe « ' . $name . ' »');
    $c = conversation_row($cid);
    ok(['conversation' => conversation_summary($c, (int)$user['id'])]);
}

function conversation_update_action(array $user): void
{
    $id = int_input('id');
    [$c, $m] = require_conversation($id, (int)$user['id']);
    if ($c['type'] !== 'group') fail('Seuls les groupes peuvent être modifiés.');
    if (!is_group_admin($m)) fail('Action réservée aux administrateurs du groupe.', 403);
    $b = input();
    $sets = [];
    $args = [];
    $news = [];

    if (array_key_exists('name', $b)) {
        $name = mb_substr(trim((string)$b['name']), 0, 80);
        if ($name === '') fail('Le nom du groupe est requis.');
        $sets[] = 'name = ?';
        $args[] = $name;
        $news[] = 'le nom du groupe en « ' . $name . ' »';
    }
    if (array_key_exists('description', $b)) {
        $sets[] = 'description = ?';
        $args[] = mb_substr(trim((string)$b['description']), 0, 300);
        $news[] = 'la description du groupe';
    }
    if (array_key_exists('avatarId', $b)) {
        $avatarId = $b['avatarId'] === null ? 0 : (int)$b['avatarId'];
        if ($avatarId > 0) {
            $st = db()->prepare('SELECT id FROM media WHERE id = ? AND user_id = ? AND kind = \'image\'');
            $st->execute([$avatarId, (int)$user['id']]);
            if (!$st->fetchColumn()) fail('Image invalide.');
            $sets[] = 'avatar_id = ?';
            $args[] = $avatarId;
        } else {
            $sets[] = 'avatar_id = NULL';
        }
        $news[] = 'la photo du groupe';
    }
    if (array_key_exists('disappearingSeconds', $b)) {
        $sec = (int)$b['disappearingSeconds'];
        if (!in_array($sec, [0, 86400, 604800, 7776000], true)) fail('Durée de disparition invalide.');
        $sets[] = 'disappearing_seconds = ?';
        $args[] = $sec;
        $label = $sec === 0 ? 'désactivé' : ($sec === 86400 ? '24 heures' : ($sec === 604800 ? '7 jours' : '90 jours'));
        $news[] = 'les messages éphémères (' . $label . ')';
    }
    if (array_key_exists('onlyAdminsCanPost', $b)) {
        $sets[] = 'only_admins_can_post = ?';
        $args[] = bool_input('onlyAdminsCanPost') ? 1 : 0;
        $news[] = 'les restrictions d’envoi';
    }
    if ($sets) {
        $args[] = $id;
        db()->prepare('UPDATE conversations SET ' . implode(', ', $sets) . ' WHERE id = ?')->execute($args);
        touch_conversation($id);
        if ($news) system_message($id, (int)$user['id'], $user['name'] . ' a modifié ' . implode(', ', $news));
    }
    $c = conversation_row($id);
    ok(['conversation' => conversation_summary($c, (int)$user['id'])]);
}

function conversation_add_members_action(array $user): void
{
    $id = int_input('id');
    [$c, $m] = require_conversation($id, (int)$user['id']);
    if ($c['type'] !== 'group') fail('Action réservée aux groupes.');
    if ((int)$c['only_admins_can_post'] === 1 && !is_group_admin($m)) fail('Seuls les administrateurs peuvent ajouter des membres.', 403);
    $ids = p('userIds', []);
    if (!is_array($ids)) $ids = [];
    $ids = array_unique(array_filter(array_map('intval', $ids), fn($v) => $v > 0));
    $existing = array_map(fn($r) => (int)$r['user_id'], conversation_members_rows($id));
    $ids = array_values(array_diff($ids, $existing));
    if (!$ids) fail('Aucun nouveau membre à ajouter.');
    if (count($existing) + count($ids) > MAX_GROUP_MEMBERS) fail('Groupe trop grand (250 membres max).');
    $placeholders = implode(',', array_fill(0, count($ids), '?'));
    $st = db()->prepare("SELECT id, name FROM users WHERE active = 1 AND id IN ($placeholders)");
    $st->execute($ids);
    $rows = $st->fetchAll();
    if (!$rows) fail('Aucun utilisateur valide.');
    $pdo = db();
    $pdo->beginTransaction();
    try {
        $t = now();
        $st = $pdo->prepare('SELECT MAX(id) FROM messages WHERE conversation_id = ?');
        $st->execute([$id]);
        $cleared = (int)$st->fetchColumn();
        $st = $pdo->prepare('INSERT INTO conversation_members(conversation_id, user_id, role, joined_at, cleared_before) VALUES(?,?,?,?,?)');
        $names = [];
        foreach ($rows as $r) {
            $st->execute([$id, (int)$r['id'], 'member', $t, $cleared]);
            $names[] = $r['name'];
        }
        $pdo->commit();
    } catch (Throwable $e) {
        if ($pdo->inTransaction()) $pdo->rollBack();
        throw $e;
    }
    system_message($id, (int)$user['id'], $user['name'] . ' a ajouté ' . implode(', ', $names));
    touch_conversation($id);
    $c = conversation_row($id);
    ok(['conversation' => conversation_summary($c, (int)$user['id'])]);
}

function conversation_remove_member_action(array $user): void
{
    $id = int_input('id');
    $targetId = int_input('userId');
    [$c, $m] = require_conversation($id, (int)$user['id']);
    if ($c['type'] !== 'group') fail('Action réservée aux groupes.');
    if (!is_group_admin($m)) fail('Action réservée aux administrateurs.', 403);
    $target = membership($id, $targetId);
    if (!$target) fail('Ce membre n’est pas dans le groupe.', 404);
    if ($target['role'] === 'owner') fail('Le propriétaire du groupe ne peut pas être retiré.');
    if ($target['role'] === 'admin' && $m['role'] !== 'owner') fail('Seul le propriétaire peut retirer un administrateur.', 403);
    $st = db()->prepare('SELECT name FROM users WHERE id = ?');
    $st->execute([$targetId]);
    $targetName = (string)$st->fetchColumn();
    db()->prepare('DELETE FROM conversation_members WHERE conversation_id = ? AND user_id = ?')->execute([$id, $targetId]);
    system_message($id, (int)$user['id'], $user['name'] . ' a retiré ' . $targetName . ' du groupe');
    touch_conversation($id);
    ok();
}

function conversation_leave_action(array $user): void
{
    $id = int_input('id');
    [$c, $m] = require_conversation($id, (int)$user['id']);
    if ($c['type'] === 'direct') {
        $st = db()->prepare('SELECT MAX(id) FROM messages WHERE conversation_id = ?');
        $st->execute([$id]);
        $max = (int)$st->fetchColumn();
        db()->prepare('UPDATE conversation_members SET hidden = 1, archived = 1, pinned = 0, cleared_before = ?, last_read_message_id = ? WHERE conversation_id = ? AND user_id = ?')
            ->execute([$max, $max, $id, (int)$user['id']]);
        ok();
    }
    system_message($id, (int)$user['id'], $user['name'] . ' a quitté le groupe');
    if ($m['role'] === 'owner') {
        $st = db()->prepare("SELECT user_id, role FROM conversation_members WHERE conversation_id = ? AND user_id <> ? ORDER BY CASE role WHEN 'admin' THEN 0 ELSE 1 END, joined_at ASC LIMIT 1");
        $st->execute([$id, (int)$user['id']]);
        $next = $st->fetch();
        if ($next) {
            db()->prepare('UPDATE conversation_members SET role = \'owner\' WHERE conversation_id = ? AND user_id = ?')->execute([$id, (int)$next['user_id']]);
        } else {
            db()->prepare('UPDATE conversations SET deleted = 1 WHERE id = ?')->execute([$id]);
        }
    }
    db()->prepare('DELETE FROM conversation_members WHERE conversation_id = ? AND user_id = ?')->execute([$id, (int)$user['id']]);
    touch_conversation($id);
    ok();
}

function conversation_set_role_action(array $user): void
{
    $id = int_input('id');
    $targetId = int_input('userId');
    $role = (string)p('role', 'member') === 'admin' ? 'admin' : 'member';
    [$c, $m] = require_conversation($id, (int)$user['id']);
    if ($c['type'] !== 'group') fail('Action réservée aux groupes.');
    if ($m['role'] !== 'owner') fail('Seul le propriétaire peut nommer un administrateur.', 403);
    $target = membership($id, $targetId);
    if (!$target) fail('Membre introuvable.', 404);
    if ($targetId === (int)$user['id']) fail('Vous ne pouvez pas modifier votre propre rôle.');
    db()->prepare('UPDATE conversation_members SET role = ? WHERE conversation_id = ? AND user_id = ?')->execute([$role, $id, $targetId]);
    $st = db()->prepare('SELECT name FROM users WHERE id = ?');
    $st->execute([$targetId]);
    $targetName = (string)$st->fetchColumn();
    system_message($id, (int)$user['id'], $user['name'] . ($role === 'admin' ? ' a nommé ' : ' a retiré le rôle d’administrateur à ') . $targetName);
    touch_conversation($id);
    ok();
}

function conversation_mute_action(array $user): void
{
    $id = int_input('id');
    [, $m] = require_conversation($id, (int)$user['id']);
    $until = int_input('until');
    if ($until > 0) $until = min($until, now() + 365 * 86400);
    if ($until < 0) $until = 0;
    db()->prepare('UPDATE conversation_members SET muted_until = ? WHERE conversation_id = ? AND user_id = ?')
        ->execute([$until, $id, (int)$user['id']]);
    touch_conversation($id);
    ok(['mutedUntil' => $until]);
}

function conversation_pin_action(array $user, string $field): void
{
    if (!in_array($field, ['pinned', 'archived'], true)) fail('Champ invalide.');
    $id = int_input('id');
    require_conversation($id, (int)$user['id']);
    $raw = p($field, false);
    $value = (is_bool($raw) ? $raw : in_array($raw, [1, '1', 'true', true], true)) ? 1 : 0;
    db()->prepare("UPDATE conversation_members SET $field = ? WHERE conversation_id = ? AND user_id = ?")
        ->execute([$value, $id, (int)$user['id']]);
    touch_conversation($id);
    ok([$field => $value]);
}

function conversation_read_action(array $user): void
{
    $id = int_input('id');
    $messageId = int_input('messageId');
    [, $m] = require_conversation($id, (int)$user['id']);
    $st = db()->prepare('SELECT MAX(id) FROM messages WHERE conversation_id = ?');
    $st->execute([$id]);
    $max = (int)$st->fetchColumn();
    $target = min($messageId > 0 ? $messageId : $max, $max);
    $read = max((int)$m['last_read_message_id'], $target);
    $delivered = max((int)$m['last_delivered_message_id'], $max);
    db()->prepare('UPDATE conversation_members SET last_read_message_id = ?, last_delivered_message_id = ? WHERE conversation_id = ? AND user_id = ?')
        ->execute([$read, $delivered, $id, (int)$user['id']]);
    db()->prepare('DELETE FROM typing WHERE conversation_id = ? AND user_id = ?')->execute([$id, (int)$user['id']]);
    ok(['lastReadMessageId' => $read]);
}

function conversation_clear_action(array $user): void
{
    $id = int_input('id');
    [, $m] = require_conversation($id, (int)$user['id']);
    $st = db()->prepare('SELECT MAX(id) FROM messages WHERE conversation_id = ?');
    $st->execute([$id]);
    $max = (int)$st->fetchColumn();
    db()->prepare('UPDATE conversation_members SET cleared_before = ?, last_read_message_id = ?, last_delivered_message_id = ?, hidden = 0 WHERE conversation_id = ? AND user_id = ?')
        ->execute([$max, $max, $max, $id, (int)$user['id']]);
    touch_conversation($id);
    ok();
}

function conversation_delete_action(array $user): void
{
    $id = int_input('id');
    [, $m] = require_conversation($id, (int)$user['id']);
    $st = db()->prepare('SELECT MAX(id) FROM messages WHERE conversation_id = ?');
    $st->execute([$id]);
    $max = (int)$st->fetchColumn();
    db()->prepare('UPDATE conversation_members SET hidden = 1, archived = 1, pinned = 0, cleared_before = ?, last_read_message_id = ?, last_delivered_message_id = ? WHERE conversation_id = ? AND user_id = ?')
        ->execute([$max, $max, $max, $id, (int)$user['id']]);
    ok();
}

function conversation_invite_action(array $user): void
{
    $id = int_input('id');
    [$c, $m] = require_conversation($id, (int)$user['id']);
    if ($c['type'] !== 'group') fail('Invitation réservée aux groupes.');
    if (!is_group_admin($m)) fail('Seuls les administrateurs peuvent gérer le lien d’invitation.', 403);
    $rotate = bool_input('rotate');
    $code = (string)($c['invite_code'] ?? '');
    if ($code === '' || $rotate) {
        $code = generate_code(10);
        db()->prepare('UPDATE conversations SET invite_code = ? WHERE id = ?')->execute([$code, $id]);
    }
    ok(['inviteCode' => $code]);
}

function conversation_join_action(array $user): void
{
    $code = strtoupper(str_input('code', 24));
    if ($code === '') fail('Code manquant.');
    $st = db()->prepare("SELECT * FROM conversations WHERE invite_code = ? AND type = 'group' AND deleted = 0 LIMIT 1");
    $st->execute([$code]);
    $c = $st->fetch();
    if (!$c) fail('Lien d’invitation invalide.', 404);
    $id = (int)$c['id'];
    $existing = membership($id, (int)$user['id']);
    if ($existing) {
        db()->prepare('UPDATE conversation_members SET hidden = 0 WHERE conversation_id = ? AND user_id = ?')->execute([$id, (int)$user['id']]);
        ok(['conversation' => conversation_summary($c, (int)$user['id'])]);
    }
    $count = (int)db()->query('SELECT COUNT(*) FROM conversation_members WHERE conversation_id = ' . $id)->fetchColumn();
    if ($count >= MAX_GROUP_MEMBERS) fail('Ce groupe est complet.', 403);
    $t = now();
    $st = db()->prepare('SELECT MAX(id) FROM messages WHERE conversation_id = ?');
    $st->execute([$id]);
    $cleared = (int)$st->fetchColumn();
    db()->prepare('INSERT INTO conversation_members(conversation_id, user_id, role, joined_at, cleared_before) VALUES(?,?,?,?,?)')
        ->execute([$id, (int)$user['id'], 'member', $t, $cleared]);
    system_message($id, (int)$user['id'], $user['name'] . ' a rejoint le groupe via un lien d’invitation');
    touch_conversation($id);
    ok(['conversation' => conversation_summary($c, (int)$user['id'])]);
}

function conversation_media_action(array $user): void
{
    $id = int_input('id');
    [, $m] = require_conversation($id, (int)$user['id']);
    $st = db()->prepare("SELECT m.id AS message_id, m.created_at, u.name AS sender_name,
            md.*
        FROM messages m
        JOIN media md ON md.id = m.media_id
        JOIN users u ON u.id = m.sender_id
        WHERE m.conversation_id = ? AND m.deleted_at = 0 AND m.id > ?
          AND (m.expires_at = 0 OR m.expires_at > ?)
          AND NOT EXISTS (SELECT 1 FROM message_hidden mh WHERE mh.message_id = m.id AND mh.user_id = ?)
        ORDER BY m.id DESC LIMIT 120");
    $st->execute([$id, (int)$m['cleared_before'], now(), (int)$user['id']]);
    $items = [];
    foreach ($st->fetchAll() as $r) {
        $items[] = [
            'messageId' => (int)$r['message_id'],
            'createdAt' => (int)$r['created_at'],
            'senderName' => (string)$r['sender_name'],
            'media' => media_json($r),
        ];
    }
    ok(['items' => $items]);
}

// ============================== ACTIONS MESSAGES ==============================

function message_by_id(int $id): ?array
{
    $st = db()->prepare('SELECT * FROM messages WHERE id = ? LIMIT 1');
    $st->execute([$id]);
    $r = $st->fetch();
    return $r ?: null;
}

function create_message(int $convId, int $senderId, string $type, string $body, ?int $mediaId, int $replyTo, bool $forwarded, int $expiresAt): int
{
    $t = now();
    $st = db()->prepare('INSERT INTO messages(conversation_id, sender_id, type, body, media_id, reply_to, forwarded, created_at, updated_at, expires_at)
        VALUES(?,?,?,?,?,?,?,?,?,?)');
    $st->execute([$convId, $senderId, $type, $body, $mediaId, $replyTo, $forwarded ? 1 : 0, $t, $t, $expiresAt]);
    $id = (int)db()->lastInsertId();
    db()->prepare('UPDATE conversations SET last_message_id = ?, updated_at = ? WHERE id = ?')->execute([$id, $t, $convId]);
    db()->prepare('UPDATE conversation_members SET hidden = 0 WHERE conversation_id = ?')->execute([$convId]);
    db()->prepare('UPDATE conversation_members SET last_read_message_id = ?, last_delivered_message_id = ? WHERE conversation_id = ? AND user_id = ?')
        ->execute([$id, $id, $convId, $senderId]);
    db()->prepare('DELETE FROM typing WHERE conversation_id = ? AND user_id = ?')->execute([$convId, $senderId]);
    return $id;
}

function message_with_joins(int $id): array
{
    $st = db()->prepare("SELECT m.*, u.name AS sender_name, u.username AS sender_username, u.avatar_id AS sender_avatar_id,
            md.id AS md_id, md.kind AS md_kind, md.mime AS md_mime, md.size AS md_size,
            md.width AS md_width, md.height AS md_height, md.duration AS md_duration,
            md.filename AS md_filename, md.orig_name AS md_orig_name, md.waveform AS md_waveform
        FROM messages m JOIN users u ON u.id = m.sender_id LEFT JOIN media md ON md.id = m.media_id
        WHERE m.id = ? LIMIT 1");
    $st->execute([$id]);
    return $st->fetch() ?: [];
}

function conversation_title_for(int $convId, int $viewerId, array &$cache): string
{
    if (isset($cache[$convId])) return $cache[$convId];
    $c = conversation_row($convId);
    if (!$c) return $cache[$convId] = 'Discussion';
    if ($c['type'] === 'group') return $cache[$convId] = (string)($c['name'] !== '' ? $c['name'] : 'Groupe');
    $st = db()->prepare('SELECT u.name FROM conversation_members cm JOIN users u ON u.id = cm.user_id
        WHERE cm.conversation_id = ? AND cm.user_id <> ? LIMIT 1');
    $st->execute([$convId, $viewerId]);
    $name = (string)$st->fetchColumn();
    return $cache[$convId] = $name !== '' ? $name : 'Discussion';
}

function messages_list_action(array $user): void
{
    $cid = int_input('conversationId');
    [$c, $m] = require_conversation($cid, (int)$user['id']);
    $before = int_input('before');
    $after = int_input('after');
    $limit = min(100, max(1, int_input('limit', 50)));
    $q = str_input('q', 100);
    [$rows, $hasMore] = fetch_messages($cid, (int)$user['id'], [
        'before' => $before, 'after' => $after, 'limit' => $limit, 'q' => $q,
        'cleared_before' => (int)$m['cleared_before'],
    ]);
    $members = conversation_members_rows($cid);
    $messages = attach_messages($rows, (int)$user['id'], $members);

    $st = db()->prepare('SELECT MAX(id) FROM messages WHERE conversation_id = ?');
    $st->execute([$cid]);
    $max = (int)$st->fetchColumn();
    if ($max > (int)$m['last_delivered_message_id']) {
        db()->prepare('UPDATE conversation_members SET last_delivered_message_id = ? WHERE conversation_id = ? AND user_id = ?')
            ->execute([$max, $cid, (int)$user['id']]);
    }
    $peerReads = [];
    foreach ($members as $row) {
        if ((int)$row['user_id'] === (int)$user['id']) continue;
        $peerReads[] = ['userId' => (int)$row['user_id'], 'lastReadMessageId' => (int)$row['last_read_message_id']];
    }
    ok(['messages' => $messages, 'hasMore' => $hasMore, 'myLastRead' => (int)$m['last_read_message_id'], 'peerReads' => $peerReads]);
}

function message_send_action(array $user): void
{
    $cid = int_input('conversationId');
    [$c, $m] = require_conversation($cid, (int)$user['id']);
    if (!can_post($c, $m)) fail('Seuls les administrateurs peuvent envoyer des messages dans ce groupe.', 403);
    if ($c['type'] === 'direct') {
        $st = db()->prepare('SELECT user_id FROM conversation_members WHERE conversation_id = ? AND user_id <> ? LIMIT 1');
        $st->execute([$cid, (int)$user['id']]);
        $peerId = (int)$st->fetchColumn();
        if ($peerId && (user_is_blocked((int)$user['id'], $peerId) || user_is_blocked($peerId, (int)$user['id']))) {
            fail('Impossible d’envoyer un message : un blocage est actif.', 403);
        }
    }
    $type = (string)p('type', 'text');
    if (!in_array($type, ['text', 'image', 'voice', 'file'], true)) fail('Type de message invalide.');
    $body = str_input('body', 4000);
    $mediaId = int_input('mediaId');
    $replyTo = int_input('replyTo');
    $media = null;
    if (in_array($type, ['image', 'voice', 'file'], true)) {
        if ($mediaId <= 0) fail('Média manquant.');
        $st = db()->prepare('SELECT * FROM media WHERE id = ? AND user_id = ?');
        $st->execute([$mediaId, (int)$user['id']]);
        $media = $st->fetch();
        if (!$media) fail('Média introuvable.', 404);
        if ($type === 'image' && $media['kind'] !== 'image') fail('Ce média n’est pas une image.');
        if ($type === 'voice' && $media['kind'] !== 'voice') fail('Ce média n’est pas un vocal.');
        if ($type === 'file' && $media['kind'] !== 'file') fail('Ce média n’est pas un fichier.');
        if ($body === '' && $type === 'file') $body = (string)$media['orig_name'];
    }
    if ($type === 'text' && $body === '') fail('Le message est vide.');
    if ($replyTo > 0) {
        $st = db()->prepare('SELECT id FROM messages WHERE id = ? AND conversation_id = ?');
        $st->execute([$replyTo, $cid]);
        if (!$st->fetchColumn()) $replyTo = 0;
    }
    $expiresAt = 0;
    if ((int)$c['disappearing_seconds'] > 0) $expiresAt = now() + (int)$c['disappearing_seconds'];

    $id = create_message($cid, (int)$user['id'], $type, $body, $mediaId > 0 ? $mediaId : null, $replyTo, false, $expiresAt);
    $row = message_with_joins($id);
    $members = conversation_members_rows($cid);
    $message = attach_messages([$row], (int)$user['id'], $members)[0];
    $c = conversation_row($cid);
    $sender = ['id' => (int)$user['id'], 'name' => (string)$user['name']];
    defer(function () use ($c, $sender, $row, $members): void {
        push_notify_message($c, $sender, $row, $members);
    });
    ok(['message' => $message, 'conversation' => conversation_summary($c, (int)$user['id'])]);
}

function message_edit_action(array $user): void
{
    $id = int_input('messageId');
    $body = str_input('body', 4000);
    $m = message_by_id($id);
    if (!$m) fail('Message introuvable.', 404);
    require_conversation((int)$m['conversation_id'], (int)$user['id']);
    if ((int)$m['sender_id'] !== (int)$user['id']) fail('Vous ne pouvez modifier que vos messages.', 403);
    if ((int)$m['deleted_at'] > 0) fail('Message supprimé.');
    if ($m['type'] !== 'text') fail('Seuls les messages texte peuvent être modifiés.');
    if ($body === '') fail('Le message est vide.');
    if (now() - (int)$m['created_at'] > 900) fail('Il est trop tard pour modifier ce message (15 min).', 403);
    db()->prepare('UPDATE messages SET body = ?, edited_at = ?, updated_at = ? WHERE id = ?')->execute([$body, now(), now(), $id]);
    touch_conversation((int)$m['conversation_id']);
    $row = message_with_joins($id);
    $members = conversation_members_rows((int)$m['conversation_id']);
    ok(['message' => attach_messages([$row], (int)$user['id'], $members)[0]]);
}

function message_delete_action(array $user): void
{
    $id = int_input('messageId');
    $forEveryone = bool_input('forEveryone', true);
    $m = message_by_id($id);
    if (!$m) fail('Message introuvable.', 404);
    [$c, $member] = require_conversation((int)$m['conversation_id'], (int)$user['id']);
    $isMine = (int)$m['sender_id'] === (int)$user['id'];
    $canModerate = $c['type'] === 'group' && is_group_admin($member);
    if (!$forEveryone) {
        db()->prepare('INSERT OR IGNORE INTO message_hidden(message_id, user_id) VALUES(?,?)')->execute([$id, (int)$user['id']]);
        db()->prepare('UPDATE messages SET updated_at = ? WHERE id = ?')->execute([now(), $id]);
        ok(['messageId' => $id]);
    }
    if (!$isMine && !$canModerate) fail('Action non autorisée.', 403);
    $mediaId = (int)$m['media_id'];
    db()->prepare('UPDATE messages SET deleted_at = ?, body = \'\', media_id = NULL, updated_at = ? WHERE id = ?')->execute([now(), now(), $id]);
    db()->prepare('DELETE FROM reactions WHERE message_id = ?')->execute([$id]);
    db()->prepare('DELETE FROM stars WHERE message_id = ?')->execute([$id]);
    if ($mediaId > 0) {
        $st = db()->prepare('SELECT COUNT(*) FROM messages WHERE media_id = ?');
        $st->execute([$mediaId]);
        $used = (int)$st->fetchColumn();
        $st = db()->prepare('SELECT COUNT(*) FROM users WHERE avatar_id = ?');
        $st->execute([$mediaId]);
        $used += (int)$st->fetchColumn();
        if ($used === 0) {
            $st = db()->prepare('SELECT * FROM media WHERE id = ?');
            $st->execute([$mediaId]);
            if ($media = $st->fetch()) {
                $path = MEDIA_DIR . '/' . basename((string)$media['filename']);
                if (is_file($path)) @unlink($path);
                db()->prepare('DELETE FROM media WHERE id = ?')->execute([$mediaId]);
            }
        }
    }
    $st = db()->prepare('SELECT MAX(id) FROM messages WHERE conversation_id = ?');
    $st->execute([(int)$m['conversation_id']]);
    $max = (int)$st->fetchColumn();
    db()->prepare('UPDATE conversations SET last_message_id = ?, updated_at = ? WHERE id = ?')
        ->execute([$max, now(), (int)$m['conversation_id']]);
    ok(['messageId' => $id]);
}

function message_forward_action(array $user): void
{
    $id = int_input('messageId');
    $m = message_by_id($id);
    if (!$m) fail('Message introuvable.', 404);
    require_conversation((int)$m['conversation_id'], (int)$user['id']);
    if ((int)$m['deleted_at'] > 0) fail('Ce message a été supprimé.');
    $ids = p('conversationIds', []);
    if (!is_array($ids)) fail('Destination manquante.');
    $ids = array_values(array_unique(array_filter(array_map('intval', $ids), fn($v) => $v > 0)));
    if (!$ids) fail('Choisissez une conversation.');
    $created = [];
    foreach ($ids as $cid) {
        [$c, $member] = require_conversation($cid, (int)$user['id']);
        if (!can_post($c, $member)) continue;
        if ($c['type'] === 'direct') {
            $st = db()->prepare('SELECT user_id FROM conversation_members WHERE conversation_id = ? AND user_id <> ? LIMIT 1');
            $st->execute([$cid, (int)$user['id']]);
            $peerId = (int)$st->fetchColumn();
            if ($peerId && (user_is_blocked((int)$user['id'], $peerId) || user_is_blocked($peerId, (int)$user['id']))) continue;
        }
        $expires = (int)$c['disappearing_seconds'] > 0 ? now() + (int)$c['disappearing_seconds'] : 0;
        $newId = create_message($cid, (int)$user['id'], (string)$m['type'], (string)$m['body'], $m['media_id'] ? (int)$m['media_id'] : null, 0, true, $expires);
        $row = message_with_joins($newId);
        $members = conversation_members_rows($cid);
        $created[] = attach_messages([$row], (int)$user['id'], $members)[0];
        $c = conversation_row($cid);
        $sender = ['id' => (int)$user['id'], 'name' => (string)$user['name']];
        defer(function () use ($c, $sender, $row, $members): void {
            push_notify_message($c, $sender, $row, $members);
        });
    }
    if (!$created) fail('Aucune destination valide.');
    ok(['messages' => $created]);
}

function message_react_action(array $user): void
{
    $id = int_input('messageId');
    $emoji = str_input('emoji', 16);
    $allowed = ['👍', '❤️', '😂', '😮', '😢', '🙏', '🔥', '👏', '✅', '👀', '🎉', '😍'];
    if (!in_array($emoji, $allowed, true)) fail('Réaction invalide.');
    $m = message_by_id($id);
    if (!$m) fail('Message introuvable.', 404);
    require_conversation((int)$m['conversation_id'], (int)$user['id']);
    $st = db()->prepare('SELECT emoji FROM reactions WHERE message_id = ? AND user_id = ?');
    $st->execute([$id, (int)$user['id']]);
    $current = $st->fetchColumn();
    if ($current === $emoji) {
        db()->prepare('DELETE FROM reactions WHERE message_id = ? AND user_id = ?')->execute([$id, (int)$user['id']]);
    } else {
        db()->prepare('INSERT INTO reactions(message_id, user_id, emoji, created_at) VALUES(?,?,?,?)
            ON CONFLICT(message_id, user_id) DO UPDATE SET emoji = excluded.emoji, created_at = excluded.created_at')
            ->execute([$id, (int)$user['id'], $emoji, now()]);
    }
    $st = db()->prepare('SELECT r.user_id, r.emoji, u.name FROM reactions r JOIN users u ON u.id = r.user_id WHERE r.message_id = ? ORDER BY r.created_at ASC');
    $st->execute([$id]);
    db()->prepare('UPDATE messages SET updated_at = ? WHERE id = ?')->execute([now(), $id]);
    $out = [];
    foreach ($st->fetchAll() as $r) $out[] = ['userId' => (int)$r['user_id'], 'emoji' => (string)$r['emoji'], 'name' => (string)$r['name']];
    ok(['messageId' => $id, 'reactions' => $out]);
}

function message_star_action(array $user): void
{
    $id = int_input('messageId');
    $starred = bool_input('starred', true);
    $m = message_by_id($id);
    if (!$m) fail('Message introuvable.', 404);
    require_conversation((int)$m['conversation_id'], (int)$user['id']);
    if ($starred) {
        db()->prepare('INSERT OR IGNORE INTO stars(user_id, message_id, created_at) VALUES(?,?,?)')->execute([(int)$user['id'], $id, now()]);
    } else {
        db()->prepare('DELETE FROM stars WHERE user_id = ? AND message_id = ?')->execute([(int)$user['id'], $id]);
    }
    db()->prepare('UPDATE messages SET updated_at = ? WHERE id = ?')->execute([now(), $id]);
    ok(['starred' => $starred]);
}

function messages_starred_action(array $user): void
{
    $st = db()->prepare("SELECT m.*, u.name AS sender_name, u.username AS sender_username, u.avatar_id AS sender_avatar_id,
            md.id AS md_id, md.kind AS md_kind, md.mime AS md_mime, md.size AS md_size,
            md.width AS md_width, md.height AS md_height, md.duration AS md_duration,
            md.filename AS md_filename, md.orig_name AS md_orig_name, md.waveform AS md_waveform, s.created_at AS starred_at
        FROM stars s
        JOIN messages m ON m.id = s.message_id
        JOIN conversation_members cm ON cm.conversation_id = m.conversation_id AND cm.user_id = ? AND cm.hidden = 0
        JOIN conversations c ON c.id = m.conversation_id AND c.deleted = 0
        JOIN users u ON u.id = m.sender_id
        LEFT JOIN media md ON md.id = m.media_id
        WHERE s.user_id = ? AND m.deleted_at = 0 AND m.id > cm.cleared_before
          AND (m.expires_at = 0 OR m.expires_at > ?)
          AND NOT EXISTS (SELECT 1 FROM message_hidden mh WHERE mh.message_id = m.id AND mh.user_id = ?)
        ORDER BY s.created_at DESC LIMIT 100");
    $st->execute([(int)$user['id'], (int)$user['id'], now(), (int)$user['id']]);
    $rows = $st->fetchAll();
    $grouped = [];
    foreach ($rows as $r) $grouped[(int)$r['conversation_id']][] = $r;
    $titles = [];
    $out = [];
    foreach ($grouped as $cid => $list) {
        $members = conversation_members_rows($cid);
        $msgs = attach_messages($list, (int)$user['id'], $members);
        $title = conversation_title_for($cid, (int)$user['id'], $titles);
        foreach ($msgs as $msg) {
            $msg['conversationTitle'] = $title;
            $out[] = $msg;
        }
    }
    ok(['messages' => $out]);
}

function message_info_action(array $user): void
{
    $id = int_input('messageId');
    $m = message_by_id($id);
    if (!$m) fail('Message introuvable.', 404);
    [$c, $member] = require_conversation((int)$m['conversation_id'], (int)$user['id']);
    if ((int)$m['sender_id'] !== (int)$user['id'] && !is_admin($user)) fail('Action non autorisée.', 403);
    $members = conversation_members_rows((int)$m['conversation_id']);
    $delivered = [];
    $read = [];
    foreach ($members as $row) {
        if ((int)$row['user_id'] === (int)$m['sender_id']) continue;
        if ((int)$row['last_delivered_message_id'] >= $id) {
            $delivered[] = ['id' => (int)$row['user_id'], 'name' => (string)$row['name'], 'at' => (int)$m['created_at']];
        }
        if ((int)$row['last_read_message_id'] >= $id) {
            $read[] = ['id' => (int)$row['user_id'], 'name' => (string)$row['name'], 'at' => (int)$m['created_at']];
        }
    }
    ok(['delivered' => $delivered, 'read' => $read]);
}

function do_search_messages(array $user, string $q, int $convId, int $limit = 50): array
{
    $like = '%' . $q . '%';
    $sql = "SELECT m.*, u.name AS sender_name, u.username AS sender_username, u.avatar_id AS sender_avatar_id,
            md.id AS md_id, md.kind AS md_kind, md.mime AS md_mime, md.size AS md_size,
            md.width AS md_width, md.height AS md_height, md.duration AS md_duration,
            md.filename AS md_filename, md.orig_name AS md_orig_name, md.waveform AS md_waveform
        FROM messages m
        JOIN conversation_members cm ON cm.conversation_id = m.conversation_id AND cm.user_id = ? AND cm.hidden = 0
        JOIN conversations c ON c.id = m.conversation_id AND c.deleted = 0
        JOIN users u ON u.id = m.sender_id
        LEFT JOIN media md ON md.id = m.media_id
        WHERE m.body LIKE ? AND m.deleted_at = 0 AND m.id > cm.cleared_before
          AND (m.expires_at = 0 OR m.expires_at > ?)
          AND NOT EXISTS (SELECT 1 FROM message_hidden mh WHERE mh.message_id = m.id AND mh.user_id = ?)";
    $args = [(int)$user['id'], $like, now(), (int)$user['id']];
    if ($convId > 0) {
        $sql .= ' AND m.conversation_id = ?';
        $args[] = $convId;
    }
    $sql .= ' ORDER BY m.id DESC LIMIT ' . max(1, min(100, $limit));
    $st = db()->prepare($sql);
    $st->execute($args);
    $rows = $st->fetchAll();
    $grouped = [];
    foreach ($rows as $r) $grouped[(int)$r['conversation_id']][] = $r;
    $titles = [];
    $out = [];
    foreach ($grouped as $cid => $list) {
        $members = conversation_members_rows($cid);
        $msgs = attach_messages($list, (int)$user['id'], $members);
        $title = conversation_title_for($cid, (int)$user['id'], $titles);
        foreach ($msgs as $msg) {
            $msg['conversationTitle'] = $title;
            $out[] = $msg;
        }
    }
    usort($out, fn($a, $b) => $b['id'] <=> $a['id']);
    return $out;
}

function search_messages_action(array $user): void
{
    $q = trim(str_input('q', 100));
    if (mb_strlen($q) < 1) ok(['messages' => []]);
    $cid = int_input('conversationId');
    if ($cid > 0 && !membership($cid, (int)$user['id'])) fail('Accès refusé.', 403);
    ok(['messages' => do_search_messages($user, $q, $cid, 60)]);
}

function search_action(array $user): void
{
    $q = trim(str_input('q', 64));
    if (mb_strlen($q) < 1) {
        ok(['conversations' => [], 'users' => [], 'messages' => []]);
    }
    $uid = (int)$user['id'];
    $like = '%' . $q . '%';

    // Conversations : nom de groupe ou nom du correspondant direct.
    $st = db()->prepare("SELECT DISTINCT c.* FROM conversations c
        JOIN conversation_members cm ON cm.conversation_id = c.id AND cm.user_id = ? AND cm.hidden = 0
        LEFT JOIN conversation_members om ON om.conversation_id = c.id AND om.user_id <> ?
        LEFT JOIN users pu ON pu.id = om.user_id
        WHERE c.deleted = 0 AND ((c.type = 'group' AND c.name LIKE ?) OR (c.type = 'direct' AND pu.name LIKE ?))
        ORDER BY c.updated_at DESC LIMIT 12");
    $st->execute([$uid, $uid, $like, $like]);
    $convs = [];
    foreach ($st->fetchAll() as $c) {
        $s = conversation_summary($c, $uid);
        if ($s) $convs[] = $s;
    }

    // Utilisateurs.
    $st = db()->prepare("SELECT * FROM users WHERE active = 1 AND id <> ? AND (name LIKE ? OR username LIKE ?)
        ORDER BY name COLLATE NOCASE LIMIT 10");
    $st->execute([$uid, $like, $like]);
    $users = [];
    foreach ($st->fetchAll() as $row) {
        $u = public_user($row, $uid);
        $d = find_direct_conversation($uid, (int)$row['id']);
        $u['directId'] = $d ? (int)$d['id'] : null;
        $users[] = $u;
    }

    ok(['conversations' => $convs, 'users' => $users, 'messages' => do_search_messages($user, $q, 0, 30)]);
}

function typing_action(array $user): void
{
    $cid = int_input('conversationId');
    require_conversation($cid, (int)$user['id']);
    $typing = bool_input('typing', true);
    if ($typing) {
        db()->prepare('INSERT INTO typing(conversation_id, user_id, until) VALUES(?,?,?)
            ON CONFLICT(conversation_id, user_id) DO UPDATE SET until = excluded.until')
            ->execute([$cid, (int)$user['id'], now() + 7]);
    } else {
        db()->prepare('DELETE FROM typing WHERE conversation_id = ? AND user_id = ?')->execute([$cid, (int)$user['id']]);
    }
    ok();
}

function sync_action(array $user): void
{
    $uid = (int)$user['id'];
    $since = int_input('since');
    $cid = int_input('conversationId');
    $after = int_input('afterMessageId');
    $updatesSince = int_input('updatesSince');
    $convs = conv_changed_since($uid, $since);

    // Événements récents toutes conversations (pour les notifications locales).
    $events = [];
    if ($since > 0) {
        $st = db()->prepare("SELECT m.*, u.name AS sender_name, u.username AS sender_username, u.avatar_id AS sender_avatar_id,
                md.id AS md_id, md.kind AS md_kind, md.mime AS md_mime, md.size AS md_size,
                md.width AS md_width, md.height AS md_height, md.duration AS md_duration,
                md.filename AS md_filename, md.orig_name AS md_orig_name, md.waveform AS md_waveform
            FROM messages m
            JOIN conversation_members cm ON cm.conversation_id = m.conversation_id AND cm.user_id = ? AND cm.hidden = 0
            JOIN conversations c ON c.id = m.conversation_id AND c.deleted = 0
            JOIN users u ON u.id = m.sender_id
            LEFT JOIN media md ON md.id = m.media_id
            WHERE m.created_at >= ? AND m.id > cm.cleared_before
              AND (m.expires_at = 0 OR m.expires_at > ?)
              AND NOT EXISTS (SELECT 1 FROM message_hidden mh WHERE mh.message_id = m.id AND mh.user_id = ?)
            ORDER BY m.id ASC LIMIT 100");
        $st->execute([$uid, $since, now(), $uid]);
        $rows = $st->fetchAll();
        $grouped = [];
        foreach ($rows as $r) $grouped[(int)$r['conversation_id']][] = $r;
        $titles = [];
        $membersCache = [];
        foreach ($grouped as $gcid => $list) {
            if (!isset($membersCache[$gcid])) $membersCache[$gcid] = conversation_members_rows($gcid);
            $msgs = attach_messages($list, $uid, $membersCache[$gcid]);
            $title = conversation_title_for($gcid, $uid, $titles);
            foreach ($msgs as $msg) {
                $msg['conversationTitle'] = $title;
                $events[] = $msg;
            }
        }
    }

    $messages = [];
    $updates = [];
    $typing = [];
    $readStates = [];
    if ($cid > 0) {
        $c = conversation_row($cid);
        if ($c && membership($cid, $uid)) {
            $member = membership($cid, $uid);
            $rows = fetch_messages($cid, $uid, ['after' => $after, 'limit' => 100, 'cleared_before' => (int)$member['cleared_before']]);
            $members = conversation_members_rows($cid);
            $messages = attach_messages($rows[0], $uid, $members);
            if ($updatesSince > 0) {
                $st = db()->prepare("SELECT id FROM messages m
                    WHERE m.conversation_id = ? AND m.updated_at >= ? AND m.id > ?
                      AND (m.expires_at = 0 OR m.expires_at > ?)
                      AND NOT EXISTS (SELECT 1 FROM message_hidden mh WHERE mh.message_id = m.id AND mh.user_id = ?)
                    ORDER BY m.id DESC LIMIT 100");
                $st->execute([$cid, $updatesSince, (int)$member['cleared_before'], now(), $uid]);
                $updateRows = [];
                foreach ($st->fetchAll() as $r) {
                    $row = message_with_joins((int)$r['id']);
                    if ($row) $updateRows[] = $row;
                }
                $updates = attach_messages($updateRows, $uid, $members);
            }
            $st = db()->prepare('SELECT MAX(id) FROM messages WHERE conversation_id = ?');
            $st->execute([$cid]);
            $max = (int)$st->fetchColumn();
            db()->prepare('UPDATE conversation_members SET last_delivered_message_id = MAX(last_delivered_message_id, ?) WHERE conversation_id = ? AND user_id = ?')
                ->execute([$max, $cid, $uid]);
            $st = db()->prepare('SELECT t.conversation_id, t.user_id, t.until, u.name FROM typing t JOIN users u ON u.id = t.user_id
                WHERE t.conversation_id = ? AND t.until > ? AND t.user_id <> ?');
            $st->execute([$cid, now(), $uid]);
            foreach ($st->fetchAll() as $r) {
                $typing[] = ['conversationId' => (int)$r['conversation_id'], 'userId' => (int)$r['user_id'], 'name' => (string)$r['name'], 'until' => (int)$r['until']];
            }
            foreach ($members as $row) {
                $readStates[] = ['conversationId' => $cid, 'userId' => (int)$row['user_id'], 'lastReadMessageId' => (int)$row['last_read_message_id']];
            }
        }
    }

    $presence = [];
    $ids = p('presence', []);
    if (is_array($ids)) {
        $ids = array_slice(array_values(array_filter(array_map('intval', $ids), fn($v) => $v > 0)), 0, 100);
        foreach ($ids as $pid) {
            $st = db()->prepare('SELECT * FROM users WHERE id = ?');
            $st->execute([$pid]);
            $row = $st->fetch();
            if (!$row) continue;
            $pu = public_user($row, $uid);
            $presence[] = ['userId' => $pid, 'lastSeen' => $pu['lastSeen'], 'online' => $pu['online']];
        }
    }

    ok([
        'now' => now(),
        'me' => ['unreadTotal' => unread_total($uid), 'lastSeen' => now()],
        'conversations' => $convs,
        'events' => $events,
        'messages' => $messages,
        'updates' => $updates,
        'typing' => $typing,
        'presence' => $presence,
        'readStates' => $readStates,
    ]);
}

// ============================== MEDIA GET ==============================

function media_get_action(array $user): void
{
    $id = int_input('id');
    if ($id <= 0) fail('Média manquant.');
    $st = db()->prepare('SELECT * FROM media WHERE id = ? LIMIT 1');
    $st->execute([$id]);
    $media = $st->fetch();
    if (!$media) fail('Média introuvable.', 404);
    if (!media_accessible($media, (int)$user['id'])) fail('Accès refusé.', 403);
    $path = MEDIA_DIR . '/' . basename((string)$media['filename']);
    if (!is_file($path)) fail('Fichier introuvable.', 404);

    $mime = (string)$media['mime'];
    $size = filesize($path) ?: (int)$media['size'];
    $etag = '"' . md5((string)$media['filename'] . '|' . $size) . '"';
    header('Content-Type: ' . $mime);
    header('Cache-Control: private, max-age=31536000, immutable');
    header('ETag: ' . $etag);
    header('Accept-Ranges: bytes');
    if (($_SERVER['HTTP_IF_NONE_MATCH'] ?? '') === $etag) {
        http_response_code(304);
        exit;
    }
    $download = bool_input('download');
    $name = safe_filename((string)($media['orig_name'] !== '' ? $media['orig_name'] : $media['filename']));
    $disposition = ($download || $media['kind'] === 'file') ? 'attachment' : 'inline';
    header('Content-Disposition: ' . $disposition . '; filename="' . $name . '"');

    $start = 0;
    $end = $size - 1;
    $range = (string)($_SERVER['HTTP_RANGE'] ?? '');
    if ($range !== '' && preg_match('/bytes=(\d*)-(\d*)/', $range, $m)) {
        if ($m[1] !== '') $start = (int)$m[1];
        if ($m[2] !== '') $end = (int)$m[2];
        if ($end >= $size) $end = $size - 1;
        if ($start > $end || $start >= $size) {
            http_response_code(416);
            header('Content-Range: bytes */' . $size);
            exit;
        }
        http_response_code(206);
        header('Content-Range: bytes ' . $start . '-' . $end . '/' . $size);
    }
    header('Content-Length: ' . ($end - $start + 1));
    $fp = fopen($path, 'rb');
    if (!$fp) exit;
    fseek($fp, $start);
    $remaining = $end - $start + 1;
    while ($remaining > 0 && !feof($fp)) {
        $chunk = fread($fp, min(65536, $remaining));
        if ($chunk === false) break;
        echo $chunk;
        $remaining -= strlen($chunk);
    }
    fclose($fp);
    exit;
}

// ============================== PUSH ==============================

function push_subscribe_action(array $user): void
{
    $sub = p('subscription', null);
    if (!is_array($sub)) fail('Abonnement manquant.');
    $endpoint = (string)($sub['endpoint'] ?? '');
    $keys = $sub['keys'] ?? null;
    $p256dh = is_array($keys) ? (string)($keys['p256dh'] ?? '') : '';
    $auth = is_array($keys) ? (string)($keys['auth'] ?? '') : '';
    if ($endpoint === '' || $p256dh === '' || $auth === '') fail('Abonnement incomplet.');
    if (strlen($endpoint) > 2048 || !str_starts_with($endpoint, 'https://')) fail('Endpoint invalide.');
    if (!endpoint_allowed($endpoint)) fail('Endpoint refusé.');
    if (!preg_match('/^[A-Za-z0-9_-]+$/', $p256dh) || !preg_match('/^[A-Za-z0-9_-]+$/', $auth)) fail('Clés invalides.');
    $st = db()->prepare('SELECT COUNT(*) FROM push_subscriptions WHERE user_id = ?');
    $st->execute([(int)$user['id']]);
    if ((int)$st->fetchColumn() >= 10) {
        db()->prepare('DELETE FROM push_subscriptions WHERE id IN (SELECT id FROM push_subscriptions WHERE user_id = ? ORDER BY created_at ASC LIMIT 1)')
            ->execute([(int)$user['id']]);
    }
    $st = db()->prepare('INSERT INTO push_subscriptions(user_id, endpoint, p256dh, auth, ua, created_at) VALUES(?,?,?,?,?,?)
        ON CONFLICT(endpoint) DO UPDATE SET user_id = excluded.user_id, p256dh = excluded.p256dh, auth = excluded.auth, ua = excluded.ua')
        ->execute([(int)$user['id'], $endpoint, $p256dh, $auth, mb_substr((string)p('userAgent', ''), 0, 250), now()]);
    $st = db()->prepare('SELECT COUNT(*) FROM push_subscriptions WHERE user_id = ?');
    $st->execute([(int)$user['id']]);
    ok(['devices' => (int)$st->fetchColumn()]);
}

function push_unsubscribe_action(array $user): void
{
    $id = (int)p('id', 0);
    if ($id > 0) {
        // Suppression d'un autre appareil du même compte (jamais celui d'un autre utilisateur).
        db()->prepare('DELETE FROM push_subscriptions WHERE id = ? AND user_id = ?')->execute([$id, (int)$user['id']]);
    } else {
        $endpoint = str_input('endpoint', 2048);
        if ($endpoint !== '') {
            db()->prepare('DELETE FROM push_subscriptions WHERE endpoint = ? AND user_id = ?')->execute([$endpoint, (int)$user['id']]);
        }
    }
    $st = db()->prepare('SELECT COUNT(*) FROM push_subscriptions WHERE user_id = ?');
    $st->execute([(int)$user['id']]);
    ok(['devices' => (int)$st->fetchColumn()]);
}

function push_devices_action(array $user): void
{
    // L'endpoint complet n'est jamais renvoyé : seul un marqueur « cet appareil »
    // est calculé à partir de l'endpoint transmis par le client.
    $current = str_input('endpoint', 2048);
    $currentHash = $current !== '' ? hash('sha256', $current) : '';
    $st = db()->prepare('SELECT id, endpoint, ua, created_at, last_ok, last_error FROM push_subscriptions WHERE user_id = ? ORDER BY created_at ASC');
    $st->execute([(int)$user['id']]);
    $devices = [];
    foreach ($st->fetchAll() as $row) {
        $hash = hash('sha256', (string)$row['endpoint']);
        $devices[] = [
            'id' => (int)$row['id'],
            'ua' => (string)$row['ua'],
            'createdAt' => (int)$row['created_at'],
            'lastOk' => (int)$row['last_ok'],
            'error' => (string)$row['last_error'],
            'current' => $currentHash !== '' && hash_equals($currentHash, $hash),
        ];
    }
    ok(['devices' => $devices]);
}

function push_test_action(array $user): void
{
    $st = db()->prepare('SELECT * FROM push_subscriptions WHERE user_id = ?');
    $st->execute([(int)$user['id']]);
    $subs = $st->fetchAll();
    if (!$subs) ok(['sent' => 0, 'error' => 'Aucun appareil abonné.']);
    $sent = 0;
    $errors = [];
    foreach ($subs as $sub) {
        [$ok, $status, $err] = webpush_send($sub, [
            'title' => 'Pulse',
            'body' => 'Les notifications fonctionnent ! 🎉',
            'url' => '#/',
            'tag' => 'pulse-test',
            'sound' => true,
        ]);
        if ($ok) $sent++;
        else $errors[] = $status . ' ' . $err;
    }
    ok(['sent' => $sent, 'error' => $sent === 0 ? (implode(' · ', array_slice($errors, 0, 2)) ?: 'Échec de l’envoi.') : '']);
}

// ============================== ADMIN ==============================

function admin_users_action(array $user): void
{
    if (!is_admin($user)) fail('Action réservée à l’administrateur.', 403);
    $q = trim(str_input('q', 64));
    $sql = 'SELECT * FROM users';
    $args = [];
    if ($q !== '') {
        $sql .= ' WHERE name LIKE ? OR username LIKE ? OR email LIKE ?';
        $like = '%' . $q . '%';
        $args = [$like, $like, $like];
    }
    $sql .= ' ORDER BY created_at ASC LIMIT 500';
    $st = db()->prepare($sql);
    $st->execute($args);
    $out = [];
    foreach ($st->fetchAll() as $row) {
        $u = public_user($row, (int)$user['id'], true);
        $u['active'] = (int)$row['active'] === 1;
        $u['email'] = (string)$row['email'];
        $out[] = $u;
    }
    ok(['users' => $out]);
}

function admin_user_update_action(array $user): void
{
    if (!is_admin($user)) fail('Action réservée à l’administrateur.', 403);
    $targetId = int_input('userId');
    $st = db()->prepare('SELECT * FROM users WHERE id = ?');
    $st->execute([$targetId]);
    $target = $st->fetch();
    if (!$target) fail('Utilisateur introuvable.', 404);
    $b = input();
    $sets = [];
    $args = [];
    if (array_key_exists('role', $b)) {
        $role = (string)$b['role'] === 'admin' ? 'admin' : 'member';
        if ($targetId === (int)$user['id'] && $role !== 'admin') fail('Vous ne pouvez pas retirer votre propre rôle d’administrateur.');
        if ($target['role'] === 'admin' && $role !== 'admin') {
            $admins = (int)db()->query("SELECT COUNT(*) FROM users WHERE role = 'admin' AND active = 1")->fetchColumn();
            if ($admins <= 1) fail('Il doit rester au moins un administrateur actif.');
        }
        $sets[] = 'role = ?';
        $args[] = $role;
    }
    if (array_key_exists('active', $b)) {
        $active = (bool)$b['active'] ? 1 : 0;
        if ($targetId === (int)$user['id'] && $active === 0) fail('Vous ne pouvez pas désactiver votre propre compte.');
        if ($active === 0 && $target['role'] === 'admin') {
            $admins = (int)db()->query("SELECT COUNT(*) FROM users WHERE role = 'admin' AND active = 1")->fetchColumn();
            if ($admins <= 1) fail('Il doit rester au moins un administrateur actif.');
        }
        $sets[] = 'active = ?';
        $args[] = $active;
        if ($active === 0) db()->prepare('DELETE FROM sessions WHERE user_id = ?')->execute([$targetId]);
    }
    if ($sets) {
        $args[] = $targetId;
        db()->prepare('UPDATE users SET ' . implode(', ', $sets) . ' WHERE id = ?')->execute($args);
    }
    $st = db()->prepare('SELECT * FROM users WHERE id = ?');
    $st->execute([$targetId]);
    ok(['user' => public_user($st->fetch(), (int)$user['id'], true)]);
}

function admin_stats_action(array $user): void
{
    if (!is_admin($user)) fail('Action réservée à l’administrateur.', 403);
    $stats = [
        'users' => (int)db()->query('SELECT COUNT(*) FROM users')->fetchColumn(),
        'activeUsers' => (int)db()->query('SELECT COUNT(*) FROM users WHERE active = 1')->fetchColumn(),
        'conversations' => (int)db()->query('SELECT COUNT(*) FROM conversations WHERE deleted = 0')->fetchColumn(),
        'messages' => (int)db()->query('SELECT COUNT(*) FROM messages')->fetchColumn(),
        'mediaCount' => (int)db()->query('SELECT COUNT(*) FROM media')->fetchColumn(),
        'mediaBytes' => (int)db()->query('SELECT COALESCE(SUM(size), 0) FROM media')->fetchColumn(),
        'online' => (int)db()->query('SELECT COUNT(*) FROM users WHERE last_seen > ' . (now() - 70))->fetchColumn(),
    ];
    ok(['stats' => $stats]);
}
