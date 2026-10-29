<?php
/**
 * Réinitialisation de mot de passe en CLI (secours administrateur).
 * Usage : php scripts/reset-password.php <email-ou-identifiant> <nouveau-mot-de-passe>
 *
 * Révoque toutes les sessions du compte. À exécuter sur le serveur.
 */
declare(strict_types=1);

// Sécurité : exécution CLI uniquement (jamais via le serveur web).
if (PHP_SAPI !== 'cli') {
    http_response_code(404);
    exit;
}

$candidates = [
    __DIR__ . '/data/messagerie.sqlite',          // script placé à la racine web
    __DIR__ . '/../data/messagerie.sqlite',       // déployé dans scripts/
    __DIR__ . '/../api/data/messagerie.sqlite',   // dépôt local
];
$dbFile = '';
foreach ($candidates as $candidate) {
    if (is_file($candidate)) {
        $dbFile = $candidate;
        break;
    }
}
if ($dbFile === '') {
    fwrite(STDERR, "Base introuvable. Chemins testés :\n" . implode("\n", $candidates) . "\n");
    exit(1);
}
if ($argc < 3) {
    fwrite(STDERR, "Usage : php scripts/reset-password.php <email-ou-identifiant> <nouveau-mot-de-passe>\n");
    exit(1);
}
$login = strtolower(trim($argv[1]));
$password = (string)$argv[2];
if (strlen($password) < 8) {
    fwrite(STDERR, "Le mot de passe doit contenir au moins 8 caractères.\n");
    exit(1);
}

$pdo = new PDO('sqlite:' . $dbFile, null, null, [
    PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION,
    PDO::ATTR_DEFAULT_FETCH_MODE => PDO::FETCH_ASSOC,
]);
$pdo->exec('PRAGMA busy_timeout = 5000');
$st = $pdo->prepare('SELECT id, name, username, email FROM users WHERE email = ? OR username = ? LIMIT 1');
$st->execute([$login, $login]);
$user = $st->fetch();
if (!$user) {
    fwrite(STDERR, "Aucun compte pour « $login ».\n");
    exit(1);
}
$pdo->beginTransaction();
try {
    $pdo->prepare('UPDATE users SET password_hash = ?, password_changed_at = ? WHERE id = ?')
        ->execute([password_hash($password, PASSWORD_DEFAULT), time(), (int)$user['id']]);
    $pdo->prepare('DELETE FROM sessions WHERE user_id = ?')->execute([(int)$user['id']]);
    $pdo->commit();
} catch (Throwable $e) {
    if ($pdo->inTransaction()) $pdo->rollBack();
    fwrite(STDERR, "Échec : " . $e->getMessage() . "\n");
    exit(1);
}
echo "Mot de passe réinitialisé pour {$user['name']} (@{$user['username']}, {$user['email']}).\n";
echo "Toutes les sessions de ce compte ont été révoquées.\n";
