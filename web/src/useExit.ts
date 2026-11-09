import { useEffect, useState } from 'react';

/** Hält ein Element nach dem Schließen noch kurz im DOM, damit es weich ausblenden kann. */
export function useExit(open: boolean, ms = 220): { mounted: boolean; closing: boolean } {
  const [mounted, setMounted] = useState(open);
  useEffect(() => {
    if (open) { setMounted(true); return; }
    if (!mounted) return;
    const reduce = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    const t = setTimeout(() => setMounted(false), reduce ? 0 : ms);
    return () => clearTimeout(t);
  }, [open, ms, mounted]);
  return { mounted: open || mounted, closing: !open && mounted };
}
