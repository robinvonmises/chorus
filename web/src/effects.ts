import { useEffect, useState } from 'react';

/**
 * Kleine Design-Effekte zum Ausprobieren. Jeder ist einzeln in Einstellungen → Darstellung abschaltbar
 * (Standard: an). Bewusst nur CSS transform/opacity, keine Layout-Übergänge; bei „Bewegung reduzieren“
 * laufen keine Animationen.
 */
export type Fx = 'inboxZero';

export const FX: { id: Fx; title: string; hint: string }[] = [
  { id: 'inboxZero', title: 'Gelesen-Moment', hint: 'Wenn alles gelesen ist, schwingt das Chorus-Logo einmal aus' },
];

const key = (f: Fx) => `inbox:fx:${f}`;
export const fxOn = (f: Fx) => { try { return localStorage.getItem(key(f)) !== '0'; } catch { return true; } };
export const setFx = (f: Fx, on: boolean) => { localStorage.setItem(key(f), on ? '1' : '0'); window.dispatchEvent(new Event('chorus:fx')); };
export const reducedMotion = () => { try { return matchMedia('(prefers-reduced-motion: reduce)').matches; } catch { return true; } };

/** Ist der Effekt an? Aktualisiert sich, wenn er in den Einstellungen umgeschaltet wird. */
export function useFx(f: Fx) {
  const [on, setOn] = useState(() => fxOn(f));
  useEffect(() => {
    const h = () => setOn(fxOn(f));
    window.addEventListener('chorus:fx', h);
    return () => window.removeEventListener('chorus:fx', h);
  }, [f]);
  return on;
}
