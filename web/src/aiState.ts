import { useSyncExternalStore } from 'react';
import { api, type AiSettings } from './api';

/** KI-Einstellungen einmal laden und überall teilen */
let current: AiSettings | null = null;
const subs = new Set<() => void>();
export const aiState = {
  get: () => current,
  set(s: AiSettings) { current = s; subs.forEach((f) => f()); },
  async refresh() { try { aiState.set(await api.ai.settings()); } catch { /* später erneut */ } },
};
export function useAi(): AiSettings | null {
  return useSyncExternalStore((f) => { subs.add(f); if (!current) aiState.refresh(); return () => subs.delete(f); }, () => current);
}
