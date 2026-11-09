import { useEffect, useRef, useState } from 'react';
import { Icon } from './Icon';

type Item = { src: string; name: string; download: string };
const subs = new Set<(i: Item | null) => void>();
export function openLightbox(i: Item) { for (const s of subs) s(i); }

/** Vollbild-Bildansicht: Wischen nach oben/unten, Tippen daneben, Esc oder X schließt */
export function Lightbox() {
  const [item, setItem] = useState<Item | null>(null);
  const [closing, setClosing] = useState(false);
  const [dy, setDy] = useState(0);
  const start = useRef<{ x: number; y: number; t: number } | null>(null);

  useEffect(() => { const f = (i: Item | null) => { setItem(i); setClosing(false); setDy(0); }; subs.add(f); return () => { subs.delete(f); }; }, []);
  const close = () => { setClosing(true); setTimeout(() => { setItem(null); setClosing(false); setDy(0); }, 220); };
  useEffect(() => {
    if (!item) return;
    const k = (e: KeyboardEvent) => { if (e.key === 'Escape') close(); };
    addEventListener('keydown', k);
    history.pushState({ lightbox: 1 }, '');
    const pop = () => close();
    addEventListener('popstate', pop);
    return () => { removeEventListener('keydown', k); removeEventListener('popstate', pop); };
  }, [item]);
  const closeNav = () => { if (history.state?.lightbox) history.back(); else close(); };

  if (!item) return null;
  const fade = Math.max(0.25, 1 - Math.abs(dy) / 400);
  return (
    <div className={`lightbox${closing ? ' out' : ''}`} style={{ background: `rgba(0,0,0,${0.92 * fade})` }} onClick={closeNav}
      onTouchStart={(e) => { const t = e.touches[0]; start.current = { x: t.clientX, y: t.clientY, t: Date.now() }; }}
      onTouchMove={(e) => { if (!start.current || e.touches.length > 1) return; setDy(e.touches[0].clientY - start.current.y); }}
      onTouchEnd={() => {
        const fast = start.current && Math.abs(dy) > 40 && Date.now() - start.current.t < 250;
        start.current = null;
        if (Math.abs(dy) > 120 || fast) closeNav(); else setDy(0);
      }}>
      <div className="lightbox-bar" onClick={(e) => e.stopPropagation()}>
        <a className="icon-btn" href={item.download} download={item.name} title="Speichern"><Icon name="download" /></a>
        <button className="icon-btn" onClick={closeNav} title="Schließen"><Icon name="x" /></button>
      </div>
      <img src={item.src} alt={item.name} onClick={(e) => e.stopPropagation()}
        style={{ transform: `translateY(${dy}px) scale(${1 - Math.min(Math.abs(dy), 300) / 1500})`, transition: dy === 0 || closing ? undefined : 'none' }} />
    </div>
  );
}
