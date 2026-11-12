import { useEffect, useRef, useState } from 'react';
import { Icon } from './Icon';
import { T } from '../i18n';

/**
 * Videos vor dem Senden kürzen und zuschneiden.
 * Der Browser zeigt nur die Vorschau; geschnitten wird auf dem Server mit ffmpeg.
 * Zuschnitt in Anteilen (0–1) des Bildes, Zeiten in Sekunden.
 */
export type VideoEdit = { start: number; end: number; crop?: { x: number; y: number; w: number; h: number } };
type Rect = { x: number; y: number; w: number; h: number };
type Tool = 'trim' | 'crop';

const RATIOS: { label: string; r: number | null }[] = [{ label: 'Frei', r: null }, { label: '1:1', r: 1 }, { label: '4:3', r: 4 / 3 }, { label: '3:4', r: 3 / 4 }, { label: '16:9', r: 16 / 9 }, { label: '9:16', r: 9 / 16 }];
const MIN_LEN = 0.5;
const FRAMES = 8;

const time = (s: number) => {
  const m = Math.floor(s / 60), r = s - m * 60;
  return `${m}:${r < 10 ? '0' : ''}${r.toFixed(1)}`;
};

export function VideoEditor({ file, initial, onCancel, onDone }: {
  file: File; initial?: VideoEdit | null; onCancel: () => void; onDone: (e: VideoEdit | null) => void;
}) {
  const [url] = useState(() => URL.createObjectURL(file));
  useEffect(() => () => URL.revokeObjectURL(url), [url]);
  const vid = useRef<HTMLVideoElement>(null);
  const stage = useRef<HTMLDivElement>(null);
  const strip = useRef<HTMLDivElement>(null);
  const [meta, setMeta] = useState<{ w: number; h: number; dur: number } | null>(null);
  const [box, setBox] = useState({ w: 0, h: 0 });
  const [tool, setTool] = useState<Tool>('trim');
  const [range, setRange] = useState<[number, number]>([0, 0]);
  const [crop, setCrop] = useState<Rect>({ x: 0, y: 0, w: 1, h: 1 });
  const [ratio, setRatio] = useState<number | null>(null);
  const [playing, setPlaying] = useState(false);
  const [now, setNow] = useState(0);
  const [thumbs, setThumbs] = useState<string[]>([]);

  // Länge und Größe kennen, dann Startwerte setzen
  const onMeta = () => {
    const v = vid.current; if (!v) return;
    const dur = Number.isFinite(v.duration) ? v.duration : 0;
    setMeta({ w: v.videoWidth || 16, h: v.videoHeight || 9, dur });
    setRange(initial ? [Math.max(0, initial.start), Math.min(dur, initial.end)] : [0, dur]);
    if (initial?.crop) setCrop(initial.crop);
    v.currentTime = initial?.start ?? 0;
  };

  // Video in die Bühne einpassen
  useEffect(() => {
    const el = stage.current; if (!el || !meta) return;
    const fit = () => { const s = Math.min((el.clientWidth - 24) / meta.w, (el.clientHeight - 24) / meta.h); setBox({ w: meta.w * s, h: meta.h * s }); };
    fit();
    const ro = new ResizeObserver(fit); ro.observe(el);
    return () => ro.disconnect();
  }, [meta]);

  // Vorschaubilder für die Zeitleiste (zweites, unsichtbares Video, damit die Vorschau nicht springt)
  useEffect(() => {
    if (!meta?.dur) return;
    let dead = false;
    const v = document.createElement('video');
    v.muted = true; v.playsInline = true; v.preload = 'auto'; v.src = url;
    const c = document.createElement('canvas');
    const th = 64, tw = Math.max(24, Math.round((th * meta.w) / meta.h));
    c.width = tw; c.height = th;
    const ctx = c.getContext('2d')!;
    const out: string[] = [];
    const seek = (t: number) => new Promise<void>((r) => { const done = () => { v.removeEventListener('seeked', done); r(); }; v.addEventListener('seeked', done); v.currentTime = t; setTimeout(done, 1500); });
    (async () => {
      await new Promise<void>((r) => { if (v.readyState >= 1) r(); else { v.onloadedmetadata = () => r(); setTimeout(r, 2000); } });
      for (let i = 0; i < FRAMES && !dead; i++) {
        await seek(Math.min(meta.dur - 0.05, ((i + 0.5) / FRAMES) * meta.dur));
        try { ctx.drawImage(v, 0, 0, tw, th); out.push(c.toDataURL('image/jpeg', 0.6)); } catch { out.push(''); }
        if (!dead) setThumbs([...out]);
      }
    })();
    return () => { dead = true; v.removeAttribute('src'); v.load(); };
  }, [meta, url]);

  // Abspielen nur innerhalb des gewählten Bereichs, am Ende von vorn
  useEffect(() => {
    const v = vid.current; if (!v) return;
    let raf = 0;
    const tick = () => {
      if (!v.paused && v.currentTime >= range[1] - 0.03) v.currentTime = range[0];
      setNow(v.currentTime);
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [range]);

  const toggle = () => {
    const v = vid.current; if (!v) return;
    if (playing) { v.pause(); setPlaying(false); return; }
    if (v.currentTime < range[0] || v.currentTime >= range[1] - 0.05) v.currentTime = range[0];
    v.play().then(() => setPlaying(true)).catch(() => setPlaying(false));
  };

  // ---------- Zeitleiste ----------
  const timeAt = (clientX: number) => {
    const r = strip.current!.getBoundingClientRect();
    return Math.max(0, Math.min(1, (clientX - r.left) / r.width)) * (meta?.dur ?? 0);
  };
  const dragHandle = (which: 0 | 1) => (e: React.PointerEvent) => {
    if (!meta) return;
    e.stopPropagation(); e.preventDefault();
    const v = vid.current; v?.pause(); setPlaying(false);
    const move = (ev: PointerEvent) => {
      const t = timeAt(ev.clientX);
      setRange((r) => {
        const n: [number, number] = which === 0 ? [Math.min(t, r[1] - MIN_LEN), r[1]] : [r[0], Math.max(t, r[0] + MIN_LEN)];
        n[0] = Math.max(0, n[0]); n[1] = Math.min(meta.dur, n[1]);
        if (v) v.currentTime = n[which];
        return n;
      });
    };
    const up = () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); };
    window.addEventListener('pointermove', move); window.addEventListener('pointerup', up);
  };
  const scrub = (e: React.PointerEvent) => {
    const v = vid.current; if (!v || !meta) return;
    const set = (x: number) => { v.currentTime = Math.max(range[0], Math.min(range[1] - 0.05, timeAt(x))); };
    set(e.clientX);
    const move = (ev: PointerEvent) => set(ev.clientX);
    const up = () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); };
    window.addEventListener('pointermove', move); window.addEventListener('pointerup', up);
  };

  // ---------- Zuschneiden ----------
  const fitRatio = (r: number | null): Rect => {
    if (!r || !meta) return { x: 0, y: 0, w: 1, h: 1 };
    const img = meta.w / meta.h;
    let w = 1, h = img / r; // Anteile: Breite/Höhe im Verhältnis zum Bild
    if (h > 1) { h = 1; w = r / img; }
    return { x: (1 - w) / 2, y: (1 - h) / 2, w, h };
  };
  const cropDrag = (mode: 'move' | 'nw' | 'ne' | 'sw' | 'se') => (e: React.PointerEvent) => {
    if (!meta || !box.w) return;
    e.stopPropagation(); e.preventDefault();
    const sx = e.clientX, sy = e.clientY, c0 = { ...crop };
    const minW = 40 / box.w, minH = 40 / box.h, img = meta.w / meta.h;
    const move = (ev: PointerEvent) => {
      const dx = (ev.clientX - sx) / box.w, dy = (ev.clientY - sy) / box.h;
      if (mode === 'move') { setCrop({ ...c0, x: Math.max(0, Math.min(1 - c0.w, c0.x + dx)), y: Math.max(0, Math.min(1 - c0.h, c0.y + dy)) }); return; }
      let x1 = c0.x, y1 = c0.y, x2 = c0.x + c0.w, y2 = c0.y + c0.h;
      if (mode.includes('w')) x1 = Math.min(x2 - minW, Math.max(0, c0.x + dx)); else x2 = Math.max(x1 + minW, Math.min(1, c0.x + c0.w + dx));
      if (mode.includes('n')) y1 = Math.min(y2 - minH, Math.max(0, c0.y + dy)); else y2 = Math.max(y1 + minH, Math.min(1, c0.y + c0.h + dy));
      if (ratio) {
        let w = x2 - x1, h = (w * img) / ratio;
        const maxH = mode.includes('n') ? c0.y + c0.h : 1 - c0.y;
        if (h > maxH) { h = maxH; w = (h * ratio) / img; }
        if (mode.includes('w')) x1 = x2 - w; else x2 = x1 + w;
        if (mode.includes('n')) y1 = y2 - h; else y2 = y1 + h;
      }
      setCrop({ x: x1, y: y1, w: x2 - x1, h: y2 - y1 });
    };
    const up = () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); };
    window.addEventListener('pointermove', move); window.addEventListener('pointerup', up);
  };

  // ---------- Fertig ----------
  const fullCrop = crop.x < 0.005 && crop.y < 0.005 && crop.w > 0.99 && crop.h > 0.99;
  const fullRange = !meta || (range[0] < 0.05 && range[1] > meta.dur - 0.05);
  const finish = () => {
    if (!meta) return onCancel();
    if (fullCrop && fullRange) return onDone(null);
    onDone({ start: Math.round(range[0] * 1000) / 1000, end: Math.round(range[1] * 1000) / 1000, ...(fullCrop ? {} : { crop }) });
  };
  const changed = !(fullCrop && fullRange);
  const cancel = () => { if (!changed || initial || confirm(T('Änderungen verwerfen?'))) onCancel(); };

  useEffect(() => {
    const k = (e: KeyboardEvent) => {
      if (e.key === 'Escape') cancel();
      else if (e.key === ' ' && !(e.target as HTMLElement)?.closest('button')) { e.preventDefault(); toggle(); }
    };
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  });

  const pct = (v: number) => `${v * 100}%`;
  const dur = meta?.dur || 1;

  return (
    <div className="ie ve" role="dialog" aria-label={T('Video bearbeiten')}>
      <header className="ie-top">
        <button className="ie-txt" onClick={cancel}>{T('Abbrechen')}</button>
        <span className="ie-mid">
          {changed && <button className="ie-txt" onClick={() => { setCrop({ x: 0, y: 0, w: 1, h: 1 }); setRatio(null); if (meta) setRange([0, meta.dur]); }}>{T('Zurücksetzen')}</button>}
        </span>
        <button className="ie-txt done" onClick={finish}>{T('Fertig')}</button>
      </header>

      <div className="ie-stage" ref={stage}>
        <div className="ie-box" style={{ width: box.w || undefined, height: box.h || undefined, visibility: meta ? 'visible' : 'hidden' }}>
          <video ref={vid} className="ve-video" src={url} playsInline muted={false} preload="auto"
            onLoadedMetadata={onMeta} onClick={toggle} onPause={() => setPlaying(false)} onPlay={() => setPlaying(true)} />
          {tool === 'crop' && (
            <div className="ie-crop" style={{ left: pct(crop.x), top: pct(crop.y), width: pct(crop.w), height: pct(crop.h) }} onPointerDown={cropDrag('move')}>
              <i className="g1" /><i className="g2" /><i className="g3" /><i className="g4" />
              {(['nw', 'ne', 'sw', 'se'] as const).map((m) => <b key={m} className={`h ${m}`} onPointerDown={cropDrag(m)} />)}
            </div>
          )}
          {tool === 'trim' && !fullCrop && (
            <div className="ve-crop-shade" style={{ left: pct(crop.x), top: pct(crop.y), width: pct(crop.w), height: pct(crop.h) }} />
          )}
          {!playing && meta && tool === 'trim' && <button className="ve-play" onClick={toggle} aria-label={T('Abspielen')}><Icon name="play" size={30} /></button>}
        </div>
        {!meta && <div className="spinner" />}
      </div>

      <footer className="ie-bottom">
        {tool === 'trim' ? (
          <div className="ve-trim">
            <button className="icon-btn" onClick={toggle} aria-label={playing ? T('Pause') : T('Abspielen')}><Icon name={playing ? 'pause' : 'play'} /></button>
            <div className="ve-strip" ref={strip} onPointerDown={scrub}>
              <div className="ve-frames">{Array.from({ length: FRAMES }, (_, i) => <span key={i} style={thumbs[i] ? { backgroundImage: `url(${thumbs[i]})` } : undefined} />)}</div>
              <div className="ve-dim" style={{ left: 0, width: pct(range[0] / dur) }} />
              <div className="ve-dim" style={{ left: pct(range[1] / dur), right: 0 }} />
              <div className="ve-sel" style={{ left: pct(range[0] / dur), width: pct((range[1] - range[0]) / dur) }}>
                <b className="ve-h l" onPointerDown={dragHandle(0)} />
                <b className="ve-h r" onPointerDown={dragHandle(1)} />
              </div>
              <div className="ve-head" style={{ left: pct(now / dur) }} />
            </div>
          </div>
        ) : (
          <div className="ie-row">
            {RATIOS.map((r) => <button key={r.label} className={`pill ${ratio === r.r ? 'on' : ''}`} onClick={() => { setRatio(r.r); setCrop(fitRatio(r.r)); }}>{r.label}</button>)}
          </div>
        )}
        <div className="ie-hint">{meta ? T('{0} – {1} · Länge {2}', time(range[0]), time(range[1]), time(range[1] - range[0])) : T('Video wird geladen …')}</div>
        <div className="ie-tools">
          <button className={`ie-tool ${tool === 'trim' ? 'on' : ''}`} onClick={() => setTool('trim')} aria-label={T('Kürzen')}><Icon name="scissors" /><small>{T('Kürzen')}</small></button>
          <button className={`ie-tool ${tool === 'crop' ? 'on' : ''}`} onClick={() => { vid.current?.pause(); setTool('crop'); }} aria-label={T('Zuschneiden')}><Icon name="crop" /><small>{T('Zuschneiden')}</small></button>
        </div>
      </footer>
    </div>
  );
}
