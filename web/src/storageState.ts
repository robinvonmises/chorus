import { useSyncExternalStore } from 'react';
import { api, type Attachment, type Message, type StorageSettings, type StorageTarget } from './api';

/** Speicherziele (Immich, Nextcloud) einmal laden und überall teilen */
let current: StorageSettings | null = null;
let loading = false;
const subs = new Set<() => void>();
export const storageState = {
  get: () => current,
  set(s: StorageSettings) { current = s; subs.forEach((f) => f()); },
  async refresh() { if (loading) return; loading = true; try { storageState.set(await api.storage()); } catch { /* später erneut */ } finally { loading = false; } },
};
export function useStorage(): StorageSettings | null {
  return useSyncExternalStore((f) => { subs.add(f); if (!current) void storageState.refresh(); return () => subs.delete(f); }, () => current);
}

export const TARGET_LABEL: Record<StorageTarget, string> = { immich: 'In Immich speichern', nextcloud: 'In Nextcloud speichern' };
/** Mögliche Ziele für einen Anhang, das Standardziel zuerst: Fotos/Videos → Immich, alles andere → Nextcloud */
export function targetsFor(s: StorageSettings | null, a: Pick<Attachment, 'kind' | 'mime'>): StorageTarget[] {
  if (!s) return [];
  const visual = a.kind === 'image' || a.kind === 'video' || /^(image|video)\//i.test(a.mime);
  const out: StorageTarget[] = [];
  if (visual && s.immich.enabled) out.push('immich');
  if (s.nextcloud.enabled) out.push('nextcloud');
  return out;
}
export const saveAttachment = (m: Message, i: number, t: StorageTarget) => api.saveTo(m, i, t).then((r) => r.message);
