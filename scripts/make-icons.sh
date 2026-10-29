#!/bin/sh
# Génère les icônes PWA à partir de public/logo.svg (ImageMagick).
set -e
cd "$(dirname "$0")/.."
command -v convert >/dev/null 2>&1 || { echo "ImageMagick (convert) requis"; exit 1; }
convert -background none public/logo.svg -resize 192x192 public/pwa-192x192.png
convert -background none public/logo.svg -resize 512x512 public/pwa-512x512.png
convert -background none public/logo.svg -resize 180x180 public/apple-touch-icon.png
convert -background none public/logo.svg -resize 64x64 public/favicon.png
# Maskable : logo dans la zone sûre (80 %) sur fond plein.
convert -size 512x512 xc:'#0a0f1c' \( -background none public/logo.svg -resize 410x410 \) -gravity center -composite public/pwa-maskable-512x512.png
echo "Icônes générées."
