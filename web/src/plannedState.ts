import { useSyncExternalStore } from 'react';
import type { Planned } from './api';

/** Geplante Nachrichten und Erinnerungen, vom Server live aktualisiert */
let items: Planned[] = [];
const subs = new Set<() => void>();
export function setPlanned(list: Planned[]) { items = list; subs.forEach((f) => f()); }
export function usePlanned(): Planned[] {
  return useSyncExternalStore((f) => { subs.add(f); return () => subs.delete(f); }, () => items);
}
