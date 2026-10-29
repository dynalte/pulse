/** Object URLs partagées pour les médias authentifiés (fetch avec header). */
import { useEffect, useState } from 'react';
import { mediaBlob } from './api';

const objectUrls = new Map<number, string>();
const pending = new Map<number, Promise<string>>();

export function useMediaUrl(mediaId: number | null | undefined): string | undefined {
  const [url, setUrl] = useState<string | undefined>(() => (mediaId ? objectUrls.get(mediaId) : undefined));

  useEffect(() => {
    if (!mediaId) {
      setUrl(undefined);
      return;
    }
    const cached = objectUrls.get(mediaId);
    if (cached) {
      setUrl(cached);
      return;
    }
    let alive = true;
    let p = pending.get(mediaId);
    if (!p) {
      p = mediaBlob(mediaId).then((blob) => {
        const u = objectUrls.get(mediaId) || URL.createObjectURL(blob);
        objectUrls.set(mediaId, u);
        pending.delete(mediaId);
        return u;
      });
      p.catch(() => pending.delete(mediaId));
      pending.set(mediaId, p);
    }
    void p.then((u) => {
      if (alive) setUrl(u);
    }).catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [mediaId]);

  return url;
}

export function clearMediaObjectUrls() {
  for (const url of objectUrls.values()) URL.revokeObjectURL(url);
  objectUrls.clear();
  pending.clear();
}

export async function downloadMediaFile(id: number, filename: string): Promise<void> {
  const blob = await mediaBlob(id);
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename || 'fichier';
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}
