import { useSyncExternalStore } from 'react';
import type { BroadcastJob } from './api';

/** Laufende Massen-Nachricht, vom Server live gemeldet */
let job: BroadcastJob | null = null;
const subs = new Set<() => void>();
export function setBroadcast(j: BroadcastJob | null) { job = j; subs.forEach((f) => f()); }
export function useBroadcast(): BroadcastJob | null {
  return useSyncExternalStore((f) => { subs.add(f); return () => subs.delete(f); }, () => job);
}
