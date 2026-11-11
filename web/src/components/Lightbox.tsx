import { useEffect, useRef, useState } from 'react';
import { Icon } from './Icon';

type Item = { src: string; name: string; download: string; video?: boolean };
type Z = { s: number; x: number; y: number };
type Pt = { x: number; y: number };
type Open = { list: Item[]; idx: number };
const subs = new Set<(o: Open) => void>();
/** Öffnet ein Bild; mit Liste (z. B. Foto-Mosaik) kann man seitlich wischen oder mit den Pfeilen blättern */
export function openLightbox(i: Item, list?: Item[], idx?: number) {
  const o = list && list.length > 1 ? { list, idx: idx ?? Math.max(0, list.indexOf(i)) } : { list: [i], idx: 0 };
  for (const s of subs) s(o);
}

const MAX = 5;
const Z0: Z = { s: 1, x: 0, y: 0 };
const dist = (a: Pt, b: Pt) => Math.hypot(a.x - b.x, a.y - b.y);

/** Vollbild-Bildansicht: Pinch/Doppeltipp zoomt, im Zoom verschieben; ohne Zoom wischen nach oben/unten, Tippen daneben, Esc oder X schließt */
export function Lightbox() {
  const [open, setOpen] = useState<Open | null>(null);
  const item = open ? open.list[open.idx] : null;
  const many = (open?.list.length ?? 0) > 1;
  const [closing, setClosing] = useState(false);
  const [dy, setDy] = useState(0);
  const [dx, setDx] = useState(0);
  const [z, setZ] = useState<Z>(Z0);
  const [live, setLive] = useState(false);
  const img = useRef<HTMLImageElement>(null);
  const zr = useRef<Z>(Z0); zr.current = z;
  // Geste: swipe (schließen), pan (im Zoom), pinch (zwei Finger)
  const g = useRef<null | { mode: 'swipe' | 'pan' | 'pinch'; t: number; p0: Pt; z0: Z; d0?: number; moved: boolean; axis?: 'x' | 'y' }>(null);
  const lastTap = useRef<{ t: number; p: Pt } | null>(null);

  const reset = () => { setDy(0); setDx(0); setZ(Z0); setLive(false); g.current = null; };
  useEffect(() => { const f = (o: Open) => { setOpen(o); setClosing(false); reset(); }; subs.add(f); return () => { subs.delete(f); }; }, []);
  const close = () => { setClosing(true); setTimeout(() => { setOpen(null); setClosing(false); reset(); }, 220); };
  /** Blättern: d = +1 nächstes, -1 voriges Bild */
  const go = (d: number) => {
    const idx = (open?.idx ?? 0) + d;
    if (!open || idx < 0 || idx >= open.list.length) { setDx(0); return; }
    reset(); setOpen({ ...open, idx });
  };
  const goRef = useRef(go); goRef.current = go;
  const isOpen = !!open;
  useEffect(() => {
    if (!isOpen) return;
    const k = (e: KeyboardEvent) => { if (e.key === 'Escape') close(); else if (e.key === 'ArrowRight') goRef.current(1); else if (e.key === 'ArrowLeft') goRef.current(-1); };
    addEventListener('keydown', k);
    history.pushState({ lightbox: 1 }, '');
    const pop = () => close();
    addEventListener('popstate', pop);
    return () => { removeEventListener('keydown', k); removeEventListener('popstate', pop); };
  }, [isOpen]);
  const closeNav = () => { if (history.state?.lightbox) history.back(); else close(); };

  /** Punkt relativ zur Bildschirmmitte (= Mitte des unverschobenen Bildes) */
  const rel = (cx: number, cy: number): Pt => ({ x: cx - innerWidth / 2, y: cy - innerHeight / 2 });
  /** Verschiebung so begrenzen, dass keine Ränder ins Bild rutschen */
  const clamp = (n: Z): Z => {
    const s = Math.min(MAX, Math.max(1, n.s));
    if (s === 1) return Z0;
    const el = img.current;
    const w = (el?.offsetWidth ?? innerWidth) * s, h = (el?.offsetHeight ?? innerHeight) * s;
    const mx = Math.max(0, (w - innerWidth) / 2), my = Math.max(0, (h - innerHeight) / 2);
    return { s, x: Math.min(mx, Math.max(-mx, n.x)), y: Math.min(my, Math.max(-my, n.y)) };
  };
  /** Zoom auf Faktor s um Bildschirmpunkt f, der Bildpunkt unter f bleibt stehen */
  const zoomAt = (from: Z, s: number, f: Pt, to: Pt = f): Z => {
    const k = s / from.s;
    return { s, x: to.x - k * (f.x - from.x), y: to.y - k * (f.y - from.y) };
  };
  const toggleZoom = (p: Pt) => { setLive(false); setZ(zr.current.s > 1 ? Z0 : clamp(zoomAt(zr.current, 2.5, p))); };

  const begin = (ts: React.TouchList) => {
    const t = Date.now();
    if (ts.length >= 2) {
      const a = rel(ts[0].clientX, ts[0].clientY), b = rel(ts[1].clientX, ts[1].clientY);
      g.current = { mode: 'pinch', t, p0: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }, z0: zr.current, d0: dist(a, b) || 1, moved: true };
      setDy(0);
    } else {
      const p = rel(ts[0].clientX, ts[0].clientY);
      g.current = { mode: zr.current.s > 1 ? 'pan' : 'swipe', t, p0: p, z0: zr.current, moved: false };
    }
    setLive(true);
  };

  if (!item) return null;
  const fade = Math.max(0.25, 1 - Math.abs(dy) / 400);
  const anim = live || (dy !== 0 && !closing);
  return (
    <div className={`lightbox${closing ? ' out' : ''}`} style={{ background: `rgba(0,0,0,${0.92 * fade})` }} onClick={() => { if (zr.current.s === 1) closeNav(); }}
      onTouchStart={(e) => begin(e.touches)}
      onTouchMove={(e) => {
        const c = g.current; if (!c) return;
        if (e.touches.length >= 2 && c.mode !== 'pinch') { begin(e.touches); return; }
        if (c.mode === 'pinch' && e.touches.length >= 2) {
          const a = rel(e.touches[0].clientX, e.touches[0].clientY), b = rel(e.touches[1].clientX, e.touches[1].clientY);
          const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
          const s = Math.min(MAX * 1.2, Math.max(0.7, c.z0.s * dist(a, b) / c.d0!));
          setZ(zoomAt(c.z0, s, c.p0, mid));
          return;
        }
        const p = rel(e.touches[0].clientX, e.touches[0].clientY);
        if (dist(p, c.p0) > 8) c.moved = true;
        if (c.mode === 'pan') setZ({ ...c.z0, x: c.z0.x + p.x - c.p0.x, y: c.z0.y + p.y - c.p0.y });
        else if (c.mode === 'swipe') {
          // Seitlich wischen blättert (nur bei mehreren Bildern), nach oben/unten schließt
          if (!c.axis && c.moved) c.axis = many && Math.abs(p.x - c.p0.x) > Math.abs(p.y - c.p0.y) ? 'x' : 'y';
          if (c.axis === 'x') setDx(p.x - c.p0.x);
          else if (c.axis === 'y') setDy(p.y - c.p0.y);
        }
      }}
      onTouchEnd={(e) => {
        const c = g.current; if (!c) return;
        if (e.touches.length > 0) { // ein Finger bleibt nach Pinch liegen: nahtlos weiter verschieben
          if (c.mode === 'pinch') { const n = clamp(zr.current); setZ(n); zr.current = n; begin(e.touches); }
          return;
        }
        g.current = null; setLive(false);
        if (c.mode === 'pinch') { setZ(clamp(zr.current)); lastTap.current = null; return; }
        if (c.mode === 'pan') setZ(clamp(zr.current));
        if (c.mode === 'swipe' && c.axis === 'x') {
          const fast = Math.abs(dx) > 30 && Date.now() - c.t < 250;
          if (Math.abs(dx) > 70 || fast) go(dx < 0 ? 1 : -1); else setDx(0);
          return;
        }
        if (c.mode === 'swipe') {
          const fast = Math.abs(dy) > 40 && Date.now() - c.t < 250;
          if (Math.abs(dy) > 120 || fast) { closeNav(); return; }
          setDy(0);
        }
        if (!c.moved) { // Doppeltipp erkennen
          const now = Date.now(), l = lastTap.current;
          if (l && now - l.t < 300 && dist(l.p, c.p0) < 40) { lastTap.current = null; e.preventDefault(); toggleZoom(c.p0); }
          else lastTap.current = { t: now, p: c.p0 };
        }
      }}
      onWheel={(e) => { const s = Math.min(MAX, Math.max(1, zr.current.s * Math.exp(-e.deltaY / 300))); setZ(clamp(zoomAt(zr.current, s, rel(e.clientX, e.clientY)))); }}>
      <div className="lightbox-bar" onClick={(e) => e.stopPropagation()} onTouchStart={(e) => e.stopPropagation()} onTouchEnd={(e) => e.stopPropagation()}>
        {many && <span className="lightbox-count">{open!.idx + 1} / {open!.list.length}</span>}
        <a className="icon-btn" href={item.download} download={item.name} title="Speichern"><Icon name="download" /></a>
        <button className="icon-btn" onClick={closeNav} title="Schließen"><Icon name="close" /></button>
      </div>
      {item.video
        ? <video key={item.src} src={item.src} controls autoPlay playsInline onClick={(e) => e.stopPropagation()}
            onTouchStart={(e) => e.stopPropagation()} onTouchEnd={(e) => e.stopPropagation()} />
        : <img ref={img} key={item.src} src={item.src} alt={item.name} draggable={false} onClick={(e) => e.stopPropagation()}
        onDoubleClick={(e) => toggleZoom(rel(e.clientX, e.clientY))}
        style={{
          transform: z.s !== 1 || z.x || z.y
            ? `translate(${z.x}px, ${z.y}px) scale(${z.s})`
            : `translate(${dx}px, ${dy}px) scale(${1 - Math.min(Math.abs(dy), 300) / 1500})`,
          transition: anim ? 'none' : undefined,
        }} />}
      {many && open!.idx > 0 && <button className="icon-btn lightbox-nav prev" onClick={(e) => { e.stopPropagation(); go(-1); }} onTouchStart={(e) => e.stopPropagation()} onTouchEnd={(e) => e.stopPropagation()} aria-label="Voriges Bild"><Icon name="back" /></button>}
      {many && open!.idx < open!.list.length - 1 && <button className="icon-btn lightbox-nav next" onClick={(e) => { e.stopPropagation(); go(1); }} onTouchStart={(e) => e.stopPropagation()} onTouchEnd={(e) => e.stopPropagation()} aria-label="Nächstes Bild"><Icon name="back" className="rot-180" /></button>}
    </div>
  );
}
