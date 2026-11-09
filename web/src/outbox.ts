import { useSyncExternalStore } from 'react';

/**
 * Dateien, die gerade gesendet werden. Die Blase erscheint sofort im Chat und zeigt den Fortschritt,
 * bis der Messenger die echte Nachricht zurückmeldet.
 */
export type Outgoing = {
  id: number; chatId: string; name: string; kind: 'image' | 'video' | 'file';
  url: string | null; caption?: string;
  progress: number; // 0–1 Hochladen
  phase: 'upload' | 'work' | 'error'; // work = Server bearbeitet/sendet
  error?: string;
};

let items: Outgoing[] = [];
const subs = new Set<() => void>();
const emit = () => { items = [...items]; subs.forEach((f) => f()); };
let nextId = 1;

export const outbox = {
  add(o: Omit<Outgoing, 'id' | 'progress' | 'phase'>): number {
    const id = nextId++;
    items.push({ ...o, id, progress: 0, phase: 'upload' });
    emit();
    return id;
  },
  update(id: number, p: Partial<Outgoing>) {
    const i = items.findIndex((x) => x.id === id);
    if (i < 0) return;
    items[i] = { ...items[i], ...p };
    emit();
  },
  remove(id: number) {
    const o = items.find((x) => x.id === id);
    if (o?.url) setTimeout(() => URL.revokeObjectURL(o.url!), 2000);
    items = items.filter((x) => x.id !== id);
    emit();
  },
};

export function useOutbox(chatId: string): Outgoing[] {
  const all = useSyncExternalStore((f) => { subs.add(f); return () => subs.delete(f); }, () => items);
  return all.filter((o) => o.chatId === chatId);
}
