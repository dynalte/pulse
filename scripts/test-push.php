<?php
/**
 * Auto-test cryptographique Web Push (VAPID + AES-128-GCM / RFC 8291).
 * Usage : php scripts/test-push.php
 *
 * Ne contacte aucun service push : génère un couple de clés « navigateur »,
 * chiffre un payload avec les mêmes fonctions que l'API puis le déchiffre.
 */
declare(strict_types=1);

function b64u(string $data): string { return rtrim(strtr(base64_encode($data), '+/', '-_'), '='); }
function b64u_dec(string $data): string {
    $d = strtr($data, '-_', '+/');
    $pad = strlen($d) % 4;
    if ($pad) $d .= str_repeat('=', 4 - $pad);
    $out = base64_decode($d, true);
    return $out === false ? '' : $out;
}
function hkdf_extract(string $salt, string $ikm): string { return hash_hmac('sha256', $ikm, $salt, true); }
function hkdf_expand(string $prk, string $info, int $len): string {
    $t = ''; $okm = '';
    for ($i = 1; strlen($okm) < $len; $i++) {
        $t = hash_hmac('sha256', $t . $info . chr($i), $prk, true);
        $okm .= $t;
    }
    return substr($okm, 0, $len);
}
function hkdf(string $salt, string $ikm, string $info, int $len): string {
    return hkdf_expand(hkdf_extract($salt, $ikm), $info, $len);
}
function raw_p256_pem(string $raw): string {
    $prefix = hex2bin('3059301306072a8648ce3d020106082a8648ce3d030107034200');
    return "-----BEGIN PUBLIC KEY-----\n" . chunk_split(base64_encode($prefix . $raw), 64, "\n") . "-----END PUBLIC KEY-----\n";
}
function ec_keypair(): array {
    $key = openssl_pkey_new(['private_key_type' => OPENSSL_KEYTYPE_EC, 'curve_name' => 'prime256v1']);
    $details = openssl_pkey_get_details($key);
    $raw = "\x04" . $details['ec']['x'] . $details['ec']['y'];
    return [$key, $raw];
}
function webpush_encrypt_local(string $payload, string $uaPublic, string $authSecret): array {
    [$local, $asPublic] = ec_keypair();
    $shared = openssl_pkey_derive(raw_p256_pem($uaPublic), $local, 32);
    $authInfo = "WebPush: info\x00" . $uaPublic . $asPublic;
    $ikm = hkdf($authSecret, $shared, $authInfo, 32);
    $salt = random_bytes(16);
    $prk = hkdf_extract($salt, $ikm);
    $cek = hkdf_expand($prk, "Content-Encoding: aes128gcm\x00", 16);
    $nonce = hkdf_expand($prk, "Content-Encoding: nonce\x00", 12);
    $tag = '';
    $cipher = openssl_encrypt($payload . "\x02", 'aes-128-gcm', $cek, OPENSSL_RAW_DATA, $nonce, $tag, '', 16);
    $body = $salt . pack('N', 4096) . chr(strlen($asPublic)) . $asPublic . $cipher . $tag;
    return [$body, $asPublic, $salt];
}
function webpush_decrypt_local(string $body, $uaPrivate, string $authSecret): string {
    $salt = substr($body, 0, 16);
    $idlen = ord($body[20]);
    $asPublic = substr($body, 21, $idlen);
    $cipherTag = substr($body, 21 + $idlen);
    $cipher = substr($cipherTag, 0, -16);
    $tag = substr($cipherTag, -16);
    $shared = openssl_pkey_derive(raw_p256_pem($asPublic), $uaPrivate, 32);
    $authInfo = "WebPush: info\x00" . $GLOBALS['uaRaw'] . $asPublic;
    $ikm = hkdf($authSecret, $shared, $authInfo, 32);
    $prk = hkdf_extract($salt, $ikm);
    $cek = hkdf_expand($prk, "Content-Encoding: aes128gcm\x00", 16);
    $nonce = hkdf_expand($prk, "Content-Encoding: nonce\x00", 12);
    $plain = openssl_decrypt($cipher, 'aes-128-gcm', $cek, OPENSSL_RAW_DATA, $nonce, $tag);
    if ($plain === false) throw new RuntimeException('Déchiffrement AES-GCM impossible');
    return substr($plain, 0, -1);
}
function der_to_jose(string $der): string {
    $pos = 1;
    $len = ord($der[$pos++]);
    if ($len & 0x80) { $n = $len & 0x7f; $len = 0; for ($i = 0; $i < $n; $i++) $len = ($len << 8) | ord($der[$pos++]); }
    $vals = [];
    for ($k = 0; $k < 2; $k++) {
        if (ord($der[$pos++]) !== 0x02) throw new RuntimeException('DER invalide');
        $ilen = ord($der[$pos++]);
        if ($ilen & 0x80) { $n = $ilen & 0x7f; $ilen = 0; for ($i = 0; $i < $n; $i++) $ilen = ($ilen << 8) | ord($der[$pos++]); }
        $vals[] = ltrim(substr($der, $pos, $ilen), "\x00");
        $pos += $ilen;
    }
    return str_pad($vals[0], 32, "\x00", STR_PAD_LEFT) . str_pad($vals[1], 32, "\x00", STR_PAD_LEFT);
}
function jose_to_der(string $jose): string {
    $r = ltrim(substr($jose, 0, 32), "\x00");
    $s = ltrim(substr($jose, 32), "\x00");
    if ($r === '') $r = "\x00";
    if ($s === '') $s = "\x00";
    if (ord($r[0]) & 0x80) $r = "\x00" . $r;
    if (ord($s[0]) & 0x80) $s = "\x00" . $s;
    $seq = "\x02" . chr(strlen($r)) . $r . "\x02" . chr(strlen($s)) . $s;
    return "\x30" . chr(strlen($seq)) . $seq;
}

$passed = 0;
function check(string $name, bool $cond, string $detail = ''): void {
    global $passed;
    if (!$cond) { fwrite(STDERR, "✗ $name $detail\n"); exit(1); }
    $passed++;
    echo "✓ $name\n";
}

// 1. VAPID : signature ES256 vérifiable
[$vapidKey, $vapidPublic] = ec_keypair();
$vapidPublicPem = openssl_pkey_get_details($vapidKey)['key'];
$header = b64u(json_encode(['typ' => 'JWT', 'alg' => 'ES256']));
$claims = b64u(json_encode(['aud' => 'https://fcm.googleapis.com', 'exp' => time() + 3600, 'sub' => 'mailto:test@example.com']));
$data = "$header.$claims";
openssl_sign($data, $derSig, $vapidKey, OPENSSL_ALGO_SHA256);
$jose = der_to_jose($derSig);
$jwt = $data . '.' . b64u($jose);
[$h, $c, $s] = explode('.', $jwt);
$verified = openssl_verify("$h.$c", jose_to_der(b64u_dec($s)), $vapidPublicPem, OPENSSL_ALGO_SHA256);
check('signature VAPID ES256', $verified === 1);
check('clé publique P-256 non compressée', strlen($vapidPublic) === 65 && $vapidPublic[0] === "\x04");

// 2. Chiffrement Web Push : round-trip RFC 8291
[$uaKey, $uaRaw] = ec_keypair();
$GLOBALS['uaRaw'] = $uaRaw;
$authSecret = random_bytes(16);
$payload = json_encode(['title' => 'Pulse', 'body' => 'Nouveau message 🎉', 'conversationId' => 42], JSON_UNESCAPED_UNICODE);
[$body, $asPublic, $salt] = webpush_encrypt_local($payload, $uaRaw, $authSecret);
check('en-tête aes128gcm (salt + rs + idlen)', strlen($body) > 86 && substr($body, 16, 4) === pack('N', 4096));
check('clé éphémère dans l’en-tête', substr($body, 21, 1) === "\x04");
$decrypted = webpush_decrypt_local($body, $uaKey, $authSecret);
check('déchiffrement du payload', $decrypted === $payload, $decrypted);
check('taille du payload < limite push', strlen($body) < 4096);

echo "\n$passed tests cryptographiques réussis.\n";
