<?php
// Routeur pour `php -S` (dev uniquement) : interdit l'accès direct à data/.
$path = parse_url($_SERVER['REQUEST_URI'] ?? '/', PHP_URL_PATH) ?: '/';
if (str_starts_with($path, '/data/') || $path === '/data') {
    http_response_code(403);
    header('Content-Type: text/plain; charset=utf-8');
    echo "Accès interdit.";
    return true;
}
return false;
