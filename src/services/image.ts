/** Compression d'image côté client avant upload (max 1600 px, JPEG 82 %). */

export interface PreparedImage {
  blob: Blob;
  width: number;
  height: number;
  filename: string;
}

const MAX_DIM = 1600;
const QUALITY = 0.82;

export async function prepareImage(file: File): Promise<PreparedImage> {
  if (!file.type.startsWith('image/')) throw new Error('Ce fichier n’est pas une image.');
  // Les GIF animés sont envoyés tels quels (le canvas perdrait l'animation).
  if (file.type === 'image/gif') {
    const dims = await readImageSize(file);
    return { blob: file, width: dims.width, height: dims.height, filename: file.name || 'image.gif' };
  }

  const bitmap = await loadBitmap(file);
  const scale = Math.min(1, MAX_DIM / Math.max(bitmap.width, bitmap.height));
  const width = Math.max(1, Math.round(bitmap.width * scale));
  const height = Math.max(1, Math.round(bitmap.height * scale));
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Impossible de préparer l’image.');
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(bitmap as CanvasImageSource, 0, 0, width, height);
  if ('close' in bitmap) (bitmap as ImageBitmap).close();
  const blob = await new Promise<Blob>((resolve, reject) => {
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('Compression impossible.'))), 'image/jpeg', QUALITY);
  });
  const base = (file.name || 'photo').replace(/\.[^.]+$/, '');
  return { blob, width, height, filename: `${base}.jpg` };
}

async function loadBitmap(file: File): Promise<ImageBitmap | HTMLImageElement> {
  if ('createImageBitmap' in window) {
    try {
      return await createImageBitmap(file);
    } catch {
      /* fallback <img> */
    }
  }
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    img.decoding = 'async';
    await new Promise<void>((resolve, reject) => {
      img.onload = () => resolve();
      img.onerror = () => reject(new Error('Image illisible (format non pris en charge).'));
      img.src = url;
    });
    return img;
  } finally {
    URL.revokeObjectURL(url);
  }
}

async function readImageSize(file: File): Promise<{ width: number; height: number }> {
  const bmp = await loadBitmap(file);
  return { width: bmp.width, height: bmp.height };
}

/** Image de prévisualisation locale (object URL à révoquer par l'appelant). */
export function localPreview(file: Blob): string {
  return URL.createObjectURL(file);
}
