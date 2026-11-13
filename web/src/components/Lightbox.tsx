import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Icon } from './Icon';
import { duration } from '../util';
import type { Message } from '../api';
import { saveAttachment, TARGET_LABEL, targetsFor, useStorage } from '../storageState';
import { openSaveAs } from './NextcloudBrowser';
import { standalone, useShareFile } from './FileViewer';
import { T } from '../i18n';

/** ref: Herkunft im Chat, damit „In Immich/Nextcloud speichern“ das Original serverseitig hochladen kann */
type Item = { src: string; name: string; download: string; video?: boolean; ref?: { m: Message; i: number } };
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
  /** Bei Videos: Leisten oben/unten nur zusammen mit der Video-Steuerung zeigen */
  const [vui, setVui] = useState(true);
  const img = useRef<HTMLImageElement>(null);
  const storage = useStorage();
  const [note, setNote] = useState('');
  const [saving, setSaving] = useState(false);
  const flashNote = (t: string) => { setNote(t); setTimeout(() => setNote((x) => (x === t ? '' : x)), 2500); };
  // Als Home-Bildschirm-App: Teilen statt Download-Link (der führt auf eine Seite ohne Rückweg)
  const att = item?.ref ? item.ref.m.attachments[item.ref.i] : undefined;
  const sh = useShareFile(standalone && item ? item.src : null, item?.name ?? '', att?.mime ?? '', att?.size ?? 0);
  const zr = useRef<Z>(Z0); zr.current = z;
  // Geste: swipe (schließen), pan (im Zoom), pinch (zwei Finger)
  const g = useRef<null | { mode: 'swipe' | 'pan' | 'pinch'; t: number; p0: Pt; z0: Z; d0?: number; moved: boolean; axis?: 'x' | 'y' }>(null);
  const lastTap = useRef<{ t: number; p: Pt } | null>(null);
  /** Zeit der letzten Berührung: Safari schickt nach einem Doppeltipp zusätzlich dblclick, das den Zoom sonst sofort wieder zurücksetzt */
  const lastTouch = useRef(0);

  const reset = () => { setDy(0); setDx(0); setZ(Z0); setLive(false); g.current = null; };
  useEffect(() => { const f = (o: Open) => { setOpen(o); setClosing(false); reset(); }; subs.add(f); return () => { subs.delete(f); }; }, []);
  const close = () => { setClosing(true); setTimeout(() => { setOpen(null); setClosing(false); reset(); }, 220); };
  /** Abstand zwischen zwei Bildern beim Blättern */
  const W = () => innerWidth + 16;
  const settling = useRef(false);
  /** Blättern: d = +1 nächstes, -1 voriges Bild. Erst gleitet der Streifen zum Nachbarn, dann wird er zum aktuellen Bild
   *  (gleiche Elemente, gleiche Position: kein Sprung) */
  const go = (d: number) => {
    const idx = (open?.idx ?? 0) + d;
    if (!open || settling.current) return;
    if (idx < 0 || idx >= open.list.length) { setDx(0); return; }
    settling.current = true;
    setLive(false); setZ(Z0); setDy(0); setDx(-d * W());
    setTimeout(() => { settling.current = false; setDx(0); setOpen((o) => o && { ...o, idx }); }, 280);
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
  const toggleZoom = (p: Pt) => { if (item?.video) return; setLive(false); setZ(zr.current.s > 1 ? Z0 : clamp(zoomAt(zr.current, 2.5, p))); };

  const begin = (ts: React.TouchList) => {
    const t = Date.now();
    if (settling.current) { g.current = null; return; }
    if (ts.length >= 2 && !item?.video) {
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
    <div className={`lightbox${closing ? ' out' : ''}${item.video && !vui ? ' ui-off' : ''}`} style={{ background: `rgba(0,0,0,${0.92 * fade})` }} onClick={() => { if (zr.current.s === 1) closeNav(); }}
      onTouchStart={(e) => { lastTouch.current = Date.now(); begin(e.touches); }}
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
          if (c.axis === 'x') {
            // Am Anfang/Ende des Albums nur etwas nachgeben
            const d = p.x - c.p0.x, edge = (d > 0 && open!.idx === 0) || (d < 0 && open!.idx === open!.list.length - 1);
            setDx(edge ? d * 0.3 : d);
          }
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
          if (Math.abs(dx) > innerWidth / 4 || fast) go(dx < 0 ? 1 : -1); else setDx(0);
          return;
        }
        if (c.mode === 'swipe') {
          const fast = Math.abs(dy) > 40 && Date.now() - c.t < 250;
          if (Math.abs(dy) > 120 || fast) { closeNav(); return; }
          setDy(0);
        }
        if (!c.moved) { // Doppeltipp erkennen
          const now = Date.now(), l = lastTap.current;
          if (!item.video && l && now - l.t < 350 && dist(l.p, c.p0) < 50) { lastTap.current = null; e.preventDefault(); toggleZoom(c.p0); }
          else lastTap.current = { t: now, p: c.p0 };
        }
      }}
      onWheel={(e) => { if (item.video) return; const s = Math.min(MAX, Math.max(1, zr.current.s * Math.exp(-e.deltaY / 300))); setZ(clamp(zoomAt(zr.current, s, rel(e.clientX, e.clientY)))); }}>
      <div className="lightbox-bar" onClick={(e) => e.stopPropagation()} onTouchStart={(e) => e.stopPropagation()} onTouchEnd={(e) => e.stopPropagation()}>
        {many && <span className="lightbox-count">{open!.idx + 1} / {open!.list.length}</span>}
        <button className="icon-btn" onClick={closeNav} title={T('Schließen')}><Icon name="close" /></button>
      </div>
      {/* Aktionen unten, in Daumenreichweite */}
      <div className="lightbox-actions" onClick={(e) => e.stopPropagation()} onTouchStart={(e) => e.stopPropagation()} onTouchEnd={(e) => e.stopPropagation()}>
        {(() => {
          const ref = item.ref, att = ref?.m.attachments[ref.i];
          const ts = ref && att ? targetsFor(storage, att) : [];
          if (!ref || !ts.length) return null;
          return <>{ts.includes('immich') && <button className="icon-btn" disabled={saving} title={TARGET_LABEL.immich} aria-label={TARGET_LABEL.immich}
            onClick={async () => { setSaving(true); flashNote(T('Wird gespeichert …')); try { flashNote(await saveAttachment(ref.m, ref.i, 'immich')); } catch (e: any) { flashNote(e.message ?? T('Fehler')); } finally { setSaving(false); } }}><Icon name="cloud" /></button>}
            {ts.includes('nextcloud') && <button className="icon-btn" title={T('In Nextcloud speichern …')} aria-label={T('In Nextcloud speichern')} onClick={() => openSaveAs(ref.m, ref.i)}><Icon name="folder" /></button>}</>;
        })()}
        {standalone
          ? sh.can && <button className="icon-btn" disabled={!sh.ready} title={T('Teilen / Sichern')} aria-label={T('Teilen / Sichern')}
              onClick={async () => { try { if (!(await sh.share())) flashNote(T('Teilen ist hier nicht möglich')); } catch (e: any) { flashNote(e?.message ?? T('Teilen fehlgeschlagen')); } }}><Icon name="share" /></button>
          : <a className="icon-btn" href={item.download} download={item.name} title={T('Auf dieses Gerät laden')}><Icon name="download" /></a>}
      </div>
      {[-1, 0, 1].map((off) => {
        const it = open!.list[open!.idx + off];
        if (!it) return null;
        const cur = off === 0;
        return (
          <div key={it.src} className="lightbox-slide" style={{ transform: `translate3d(${off * W() + dx}px, 0, 0)`, transition: live ? 'none' : undefined }}>
            {it.video
              ? <SlideVideo src={it.src} cur={cur} onUi={setVui} />
              : <img ref={cur ? img : undefined} src={it.src} alt={it.name} draggable={false} onClick={(e) => e.stopPropagation()}
                  onDoubleClick={cur ? (e) => { if (Date.now() - lastTouch.current > 1000) toggleZoom(rel(e.clientX, e.clientY)); } : undefined}
                  style={cur ? {
                    transform: z.s !== 1 || z.x || z.y
                      ? `translate(${z.x}px, ${z.y}px) scale(${z.s})`
                      : `translateY(${dy}px) scale(${1 - Math.min(Math.abs(dy), 300) / 1500})`,
                    transition: anim ? 'none' : undefined,
                  } : undefined} />}
          </div>
        );
      })}
      {many && open!.idx > 0 && <button className="icon-btn lightbox-nav prev" onClick={(e) => { e.stopPropagation(); go(-1); }} onTouchStart={(e) => e.stopPropagation()} onTouchEnd={(e) => e.stopPropagation()} aria-label={T('Voriges Bild')}><Icon name="back" /></button>}
      {many && open!.idx < open!.list.length - 1 && <button className="icon-btn lightbox-nav next" onClick={(e) => { e.stopPropagation(); go(1); }} onTouchStart={(e) => e.stopPropagation()} onTouchEnd={(e) => e.stopPropagation()} aria-label={T('Nächstes Bild')}><Icon name="back" className="rot-180" /></button>}
      {note && <div className="toast" onClick={(e) => e.stopPropagation()}>{note}</div>}
    </div>
  );
}

const finePointer = typeof matchMedia !== 'undefined' && matchMedia('(pointer: fine)').matches;

/** Video im Vollbild. Startet sofort (noch in der Tipp-Geste, deshalb useLayoutEffect: so darf iOS mit Ton abspielen),
 *  ohne sichtbare Steuerung. Tippen aufs Video blendet sie ein, nach 3 s Laufzeit verschwindet sie wieder.
 *  Eigene Steuerung statt der eingebauten: die schluckt sonst das seitliche Wischen. */
function SlideVideo({ src, cur, onUi }: { src: string; cur: boolean; onUi: (show: boolean) => void }) {
  const v = useRef<HTMLVideoElement>(null);
  const [playing, setPlaying] = useState(false);
  const [ui, setUi] = useState(false);
  const [muted, setMuted] = useState(false);
  const [poke, setPoke] = useState(0);
  const [t, setT] = useState(0);
  const [d, setD] = useState(0);
  const start = () => {
    const el = v.current; if (!el) return;
    setPlaying(true);
    el.play().catch((e: any) => {
      // Ohne Geste erlaubt iOS nur stumm: dann stumm starten, Ton per Knopf
      if (e?.name !== 'NotAllowedError' || el.muted) throw e;
      el.muted = true; setMuted(true); return el.play();
    }).catch(() => { setPlaying(false); });
  };
  useLayoutEffect(() => {
    const el = v.current; if (!el) return;
    if (cur) start(); else { el.pause(); setUi(false); }
  }, [cur]);
  const visible = ui || !playing;
  useLayoutEffect(() => { if (cur) onUi(visible); }, [cur, visible]);
  useEffect(() => {
    if (!ui || !playing) return;
    const h = setTimeout(() => setUi(false), 3000);
    return () => clearTimeout(h);
  }, [ui, playing, poke]);
  const touch = () => { setUi(true); setPoke((n) => n + 1); };
  /** Mit Maus (nur pointer: fine, am iPhone unverändert): Bewegen blendet die Steuerung ein, Stillstand wieder aus */
  const onMove = finePointer ? () => { if (cur) touch(); } : undefined;
  const seek = (e: React.TouchEvent | React.MouseEvent) => {
    e.stopPropagation(); touch();
    const el = v.current, bar = e.currentTarget as HTMLElement;
    if (!el || !d) return;
    const x = 'touches' in e ? e.touches[0]?.clientX : e.clientX;
    if (x == null) return;
    const r = bar.getBoundingClientRect();
    el.currentTime = Math.min(1, Math.max(0, (x - r.left) / r.width)) * d;
    setT(el.currentTime);
  };
  const stop = (e: React.SyntheticEvent) => e.stopPropagation();
  const toggle = () => { const el = v.current; if (!el) return; if (el.paused) start(); else el.pause(); touch(); };
  return <>
    <video ref={v} src={src} playsInline preload="metadata" disableRemotePlayback
      onPlay={() => setPlaying(true)} onPause={() => setPlaying(false)} onEnded={() => setPlaying(false)}
      onTimeUpdate={(e) => setT(e.currentTarget.currentTime)} onLoadedMetadata={(e) => setD(e.currentTarget.duration || 0)}
      onMouseMove={onMove} onClick={(e) => { e.stopPropagation(); if (!playing) start(); else setUi((u) => !u); }} />
    {cur && visible && <button className="lightbox-play" onMouseMove={onMove} onClick={(e) => { e.stopPropagation(); toggle(); }} onTouchEnd={stop}
      aria-label={playing ? T('Pause') : T('Abspielen')}><Icon name={playing ? 'pause' : 'play'} size={30} /></button>}
    {cur && visible && d > 0 && (
      <div className="lightbox-vbar" onMouseMove={onMove} onClick={stop} onTouchEnd={stop}>
        <span>{duration(t)}</span>
        <div className="lightbox-vtrack" onTouchStart={seek} onTouchMove={seek} onMouseDown={seek}>
          <div style={{ width: `${(t / d) * 100}%` }} />
        </div>
        <span>{duration(d)}</span>
        <button className="lightbox-mute" aria-label={muted ? T('Ton an') : T('Ton aus')}
          onClick={() => { const el = v.current; if (!el) return; el.muted = !el.muted; setMuted(el.muted); touch(); }}>
          <Icon name={muted ? 'volumeoff' : 'volume'} size={20} />
        </button>
      </div>
    )}
  </>;
}
