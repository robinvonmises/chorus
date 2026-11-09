import { useSyncExternalStore } from 'react';

/** Ein zentraler Player für Sprachnachrichten: läuft weiter, auch wenn der Chat gewechselt wird. */
export interface Track { key: string; url: string; chatId: string; sender: string; voice: boolean; dur?: number }
export interface PlayerState { track: Track | null; playing: boolean; pos: number; total: number; rate: number }

const audio = typeof Audio !== 'undefined' ? new Audio() : (null as unknown as HTMLAudioElement);
let state: PlayerState = { track: null, playing: false, pos: 0, total: 0, rate: 1 };
const subs = new Set<() => void>();
const set = (p: Partial<PlayerState>) => { state = { ...state, ...p }; subs.forEach((f) => f()); };

if (audio) {
  audio.preload = 'auto';
  audio.onplay = () => set({ playing: true });
  audio.onpause = () => set({ playing: false });
  audio.ontimeupdate = () => set({ pos: audio.currentTime });
  audio.onloadedmetadata = () => isFinite(audio.duration) && set({ total: audio.duration });
  audio.ondurationchange = () => isFinite(audio.duration) && set({ total: audio.duration });
  audio.onended = () => set({ playing: false, pos: 0, track: null });
}

export const player = {
  play(t: Track) {
    if (state.track?.key === t.key) { audio.paused ? audio.play() : audio.pause(); return; }
    audio.src = t.url;
    audio.playbackRate = state.rate;
    set({ track: t, pos: 0, total: t.dur ?? 0, playing: false });
    audio.play().catch(() => set({ playing: false }));
  },
  toggle() { if (state.track) (audio.paused ? audio.play() : audio.pause()); },
  seek(sec: number) { if (state.track) audio.currentTime = sec; },
  cycleRate() { const r = state.rate === 1 ? 1.5 : state.rate === 1.5 ? 2 : 1; audio.playbackRate = r; set({ rate: r }); },
  close() { audio.pause(); audio.removeAttribute('src'); audio.load(); set({ track: null, playing: false, pos: 0 }); },
};

export function usePlayer(): PlayerState {
  return useSyncExternalStore((f) => { subs.add(f); return () => subs.delete(f); }, () => state);
}
