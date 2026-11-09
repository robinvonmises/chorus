import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Icon } from './Icon';

/** Bildbearbeitung vor dem Senden: zuschneiden, drehen, Stift, Marker, Formen, Text, Verpixeln, Auswahl */

type Pt = { x: number; y: number };
type Obj =
  | { id: number; t: 'pen' | 'marker'; pts: Pt[]; color: string; w: number }
  | { id: number; t: 'arrow' | 'rect' | 'ellipse' | 'pixel'; a: Pt; b: Pt; color: string; w: number }
  | { id: number; t: 'text'; p: Pt; text: string; color: string; size: number };
type Shape = Extract<Obj, { a: Pt }>;
type Doc = { base: HTMLCanvasElement; objs: Obj[] };
type Tool = 'select' | 'pen' | 'marker' | 'arrow' | 'rect' | 'ellipse' | 'text' | 'pixel' | 'crop';
type Rect = { x: number; y: number; w: number; h: number };

const COLORS = ['#ffffff', '#111111', '#ff3b30', '#ff9500', '#ffcc00', '#34c759', '#007aff', '#af52de'];
const TOOLS: { id: Tool; icon: string; label: string }[] = [
  { id: 'crop', icon: 'crop', label: 'Zuschneiden' },
  { id: 'pen', icon: 'pen', label: 'Stift' },
  { id: 'marker', icon: 'marker', label: 'Marker' },
  { id: 'arrow', icon: 'arrow', label: 'Pfeil' },
  { id: 'rect', icon: 'square', label: 'Rechteck' },
  { id: 'ellipse', icon: 'circle', label: 'Kreis' },
  { id: 'text', icon: 'text', label: 'Text' },
  { id: 'pixel', icon: 'pixel', label: 'Verpixeln' },
  { id: 'select', icon: 'cursor', label: 'Auswahl' },
];
const RATIOS: { label: string; r: number | null }[] = [{ label: 'Frei', r: null }, { label: '1:1', r: 1 }, { label: '4:3', r: 4 / 3 }, { label: '3:4', r: 3 / 4 }, { label: '16:9', r: 16 / 9 }];
const MAX = 2560;
let nextId = 1;

function canvasOf(w: number, h: number) { const c = document.createElement('canvas'); c.width = Math.max(1, Math.round(w)); c.height = Math.max(1, Math.round(h)); return c; }
const norm = (a: Pt, b: Pt): Rect => ({ x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), w: Math.abs(b.x - a.x), h: Math.abs(b.y - a.y) });
const font = (size: number) => `600 ${size}px -apple-system, "SF Pro Text", system-ui, sans-serif`;

function drawObj(ctx: CanvasRenderingContext2D, o: Obj, base: HTMLCanvasElement) {
  ctx.save();
  ctx.lineCap = 'round'; ctx.lineJoin = 'round';
  if (o.t === 'pen' || o.t === 'marker') {
    ctx.strokeStyle = o.color; ctx.lineWidth = o.t === 'marker' ? o.w * 3.2 : o.w;
    if (o.t === 'marker') { ctx.globalAlpha = 0.4; ctx.lineCap = 'butt'; }
    ctx.beginPath();
    o.pts.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)));
    if (o.pts.length === 1) ctx.lineTo(o.pts[0].x + 0.1, o.pts[0].y);
    ctx.stroke();
  } else if (o.t === 'arrow') {
    ctx.strokeStyle = o.color; ctx.lineWidth = o.w;
    const ang = Math.atan2(o.b.y - o.a.y, o.b.x - o.a.x), len = o.w * 4 + 8;
    ctx.beginPath(); ctx.moveTo(o.a.x, o.a.y); ctx.lineTo(o.b.x, o.b.y);
    ctx.moveTo(o.b.x - len * Math.cos(ang - 0.5), o.b.y - len * Math.sin(ang - 0.5)); ctx.lineTo(o.b.x, o.b.y);
    ctx.lineTo(o.b.x - len * Math.cos(ang + 0.5), o.b.y - len * Math.sin(ang + 0.5));
    ctx.stroke();
  } else if (o.t === 'rect' || o.t === 'ellipse') {
    const r = norm(o.a, o.b); ctx.strokeStyle = o.color; ctx.lineWidth = o.w;
    ctx.beginPath();
    if (o.t === 'rect') ctx.roundRect(r.x, r.y, r.w, r.h, Math.min(o.w * 1.5, r.w / 2, r.h / 2));
    else ctx.ellipse(r.x + r.w / 2, r.y + r.h / 2, r.w / 2, r.h / 2, 0, 0, Math.PI * 2);
    ctx.stroke();
  } else if (o.t === 'pixel') {
    const r = norm(o.a, o.b); if (r.w < 2 || r.h < 2) { ctx.restore(); return; }
    const blk = Math.max(8, Math.max(base.width, base.height) / 70);
    const small = canvasOf(Math.max(1, r.w / blk), Math.max(1, r.h / blk));
    small.getContext('2d')!.drawImage(base, r.x, r.y, r.w, r.h, 0, 0, small.width, small.height);
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(small, 0, 0, small.width, small.height, r.x, r.y, r.w, r.h);
  } else if (o.t === 'text') {
    ctx.font = font(o.size); ctx.textBaseline = 'top'; ctx.fillStyle = o.color;
    ctx.shadowColor = o.color === '#111111' ? 'rgba(255,255,255,.7)' : 'rgba(0,0,0,.55)'; ctx.shadowBlur = o.size / 6;
    o.text.split('\n').forEach((line, i) => ctx.fillText(line, o.p.x, o.p.y + i * o.size * 1.2));
  }
  ctx.restore();
}

function bounds(o: Obj, ctx: CanvasRenderingContext2D): Rect {
  if (o.t === 'pen' || o.t === 'marker') {
    const xs = o.pts.map((p) => p.x), ys = o.pts.map((p) => p.y), pad = o.t === 'marker' ? o.w * 1.6 : o.w / 2;
    return { x: Math.min(...xs) - pad, y: Math.min(...ys) - pad, w: Math.max(...xs) - Math.min(...xs) + pad * 2, h: Math.max(...ys) - Math.min(...ys) + pad * 2 };
  }
  if (o.t === 'text') {
    ctx.save(); ctx.font = font(o.size);
    const lines = o.text.split('\n'); const w = Math.max(...lines.map((l) => ctx.measureText(l).width)); ctx.restore();
    return { x: o.p.x, y: o.p.y, w, h: lines.length * o.size * 1.2 };
  }
  const sh = o as Shape, r = norm(sh.a, sh.b), pad = sh.w / 2;
  return { x: r.x - pad, y: r.y - pad, w: r.w + pad * 2, h: r.h + pad * 2 };
}

function distSeg(p: Pt, a: Pt, b: Pt) {
  const dx = b.x - a.x, dy = b.y - a.y, l = dx * dx + dy * dy;
  const t = l ? Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / l)) : 0;
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
}

function hit(o: Obj, p: Pt, tol: number, ctx: CanvasRenderingContext2D) {
  if (o.t === 'pen' || o.t === 'marker') {
    const w = (o.t === 'marker' ? o.w * 1.6 : o.w / 2) + tol;
    for (let i = 0; i < o.pts.length; i++) if (distSeg(p, o.pts[i], o.pts[Math.min(i + 1, o.pts.length - 1)]) < w) return true;
    return false;
  }
  if (o.t === 'arrow') return distSeg(p, o.a, o.b) < o.w / 2 + tol;
  const r = bounds(o, ctx);
  return p.x > r.x - tol && p.x < r.x + r.w + tol && p.y > r.y - tol && p.y < r.y + r.h + tol;
}

function move(o: Obj, dx: number, dy: number): Obj {
  const m = (p: Pt) => ({ x: p.x + dx, y: p.y + dy });
  if (o.t === 'pen' || o.t === 'marker') return { ...o, pts: o.pts.map(m) };
  if (o.t === 'text') return { ...o, p: m(o.p) };
  const sh = o as Shape;
  return { ...sh, a: m(sh.a), b: m(sh.b) };
}

function flatten(doc: Doc, crop?: Rect): HTMLCanvasElement {
  const r = crop ?? { x: 0, y: 0, w: doc.base.width, h: doc.base.height };
  const c = canvasOf(r.w, r.h), ctx = c.getContext('2d')!;
  ctx.translate(-r.x, -r.y);
  ctx.drawImage(doc.base, 0, 0);
  doc.objs.forEach((o) => drawObj(ctx, o, doc.base));
  return c;
}

export function ImageEditor({ file, onDone, onCancel }: { file: File; onDone: (f: File) => void; onCancel: () => void }) {
  const [doc, setDoc] = useState<Doc | null>(null);
  const [past, setPast] = useState<Doc[]>([]);
  const [future, setFuture] = useState<Doc[]>([]);
  const [tool, setTool] = useState<Tool>('pen');
  const [color, setColor] = useState('#ff3b30');
  const [size, setSize] = useState(4);
  const [draft, setDraft] = useState<Obj | null>(null);
  const [sel, setSel] = useState<number | null>(null);
  const [drag, setDrag] = useState<{ dx: number; dy: number } | null>(null);
  const [crop, setCrop] = useState<Rect | null>(null);
  const [ratio, setRatio] = useState<number | null>(null);
  const [textIn, setTextIn] = useState<{ p: Pt; screen: Pt; value: string; editId?: number } | null>(null);
  const [box, setBox] = useState({ w: 0, h: 0 });
  const cv = useRef<HTMLCanvasElement>(null);
  const stage = useRef<HTMLDivElement>(null);
  const ptr = useRef<{ start: Pt; last: Pt; id?: number } | null>(null);

  // Bild laden (große Fotos auf max. 2560 px verkleinern)
  useEffect(() => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      const s = Math.min(1, MAX / Math.max(img.naturalWidth, img.naturalHeight));
      const c = canvasOf(img.naturalWidth * s, img.naturalHeight * s);
      c.getContext('2d')!.drawImage(img, 0, 0, c.width, c.height);
      setDoc({ base: c, objs: [] });
      URL.revokeObjectURL(url);
    };
    img.src = url;
    return () => URL.revokeObjectURL(url);
  }, [file]);

  const W = doc?.base.width ?? 1, H = doc?.base.height ?? 1;
  const unit = Math.max(W, H) / 500;

  // Anzeigegröße an den freien Platz anpassen
  useLayoutEffect(() => {
    const el = stage.current; if (!el || !doc) return;
    const fit = () => { const s = Math.min((el.clientWidth - 24) / W, (el.clientHeight - 24) / H); setBox({ w: W * s, h: H * s }); };
    fit();
    const ro = new ResizeObserver(fit); ro.observe(el);
    return () => ro.disconnect();
  }, [doc, W, H]);

  const objsNow = (): Obj[] => {
    if (!doc) return [];
    return doc.objs.map((o) => (drag && o.id === sel ? move(o, drag.dx, drag.dy) : o));
  };

  // Zeichnen
  useEffect(() => {
    const c = cv.current; if (!c || !doc) return;
    if (c.width !== W) c.width = W; if (c.height !== H) c.height = H;
    const ctx = c.getContext('2d')!;
    ctx.clearRect(0, 0, W, H);
    ctx.drawImage(doc.base, 0, 0);
    const objs = objsNow();
    objs.forEach((o) => { if (o.id !== textIn?.editId) drawObj(ctx, o, doc.base); });
    if (draft) drawObj(ctx, draft, doc.base);
    const s = objs.find((o) => o.id === sel);
    if (s && tool === 'select') {
      const r = bounds(s, ctx), pad = unit * 4;
      ctx.save(); ctx.setLineDash([unit * 5, unit * 4]); ctx.lineWidth = Math.max(1, unit * 1.2); ctx.strokeStyle = '#fff';
      ctx.shadowColor = 'rgba(0,0,0,.6)'; ctx.shadowBlur = unit * 2;
      ctx.strokeRect(r.x - pad, r.y - pad, r.w + pad * 2, r.h + pad * 2); ctx.restore();
    }
  }); // bei jedem Render: billig genug, hält alles synchron

  const docRef = useRef<Doc | null>(null); docRef.current = doc;
  const textRef = useRef(textIn); textRef.current = textIn;
  const commit = (next: Doc) => { const cur = docRef.current; if (!cur) return; setPast((p) => [...p.slice(-29), cur]); setFuture([]); setDoc(next); docRef.current = next; };
  const undo = () => { if (!past.length || !doc) return; setFuture((f) => [doc, ...f]); setDoc(past[past.length - 1]); setPast((p) => p.slice(0, -1)); setSel(null); setCrop(null); setTool((t) => (t === 'crop' ? 'pen' : t)); };
  const redo = () => { if (!future.length || !doc) return; setPast((p) => [...p, doc]); setDoc(future[0]); setFuture((f) => f.slice(1)); setSel(null); };

  const toImg = (e: { clientX: number; clientY: number }): Pt => {
    const r = cv.current!.getBoundingClientRect();
    return { x: ((e.clientX - r.left) / r.width) * W, y: ((e.clientY - r.top) / r.height) * H };
  };
  const strokeW = size * unit * 1.3;
  const fontSize = size * unit * 5 + unit * 8;

  const openText = (p: Pt, e: { clientX: number; clientY: number }, existing?: Obj & { t: 'text' }) => {
    const sr = stage.current!.getBoundingClientRect();
    setTextIn({ p, screen: { x: e.clientX - sr.left, y: e.clientY - sr.top }, value: existing?.text ?? '', editId: existing?.id });
    if (existing) setColor(existing.color);
  };
  const closeText = () => {
    const textIn = textRef.current, doc = docRef.current;
    if (!textIn || !doc) return;
    textRef.current = null;
    const v = textIn.value.trim();
    const old = doc.objs.find((o) => o.id === textIn.editId) as (Obj & { t: 'text' }) | undefined;
    if (old) commit({ ...doc, objs: v ? doc.objs.map((o) => (o.id === old.id ? { ...old, text: v, color } : o)) : doc.objs.filter((o) => o.id !== old.id) });
    else if (v) commit({ ...doc, objs: [...doc.objs, { id: nextId++, t: 'text', p: textIn.p, text: v, color, size: fontSize }] });
    setTextIn(null);
  };

  const down = (e: React.PointerEvent) => {
    if (!doc || tool === 'crop') return;
    if (textIn) { e.preventDefault(); closeText(); return; }
    const p = toImg(e);
    if (tool !== 'text') (e.target as Element).setPointerCapture(e.pointerId);
    ptr.current = { start: p, last: p };
    if (tool === 'select') {
      const ctx = cv.current!.getContext('2d')!;
      const o = [...doc.objs].reverse().find((x) => hit(x, p, unit * 8, ctx));
      setSel(o?.id ?? null);
      if (o) { ptr.current.id = o.id; setDrag({ dx: 0, dy: 0 }); }
      return;
    }
    if (tool === 'text') {
      e.preventDefault();
      const ctx = cv.current!.getContext('2d')!;
      const o = [...doc.objs].reverse().find((x) => x.t === 'text' && hit(x, p, unit * 4, ctx));
      openText(o ? (o as any).p : p, e, o as any);
      ptr.current = null;
      return;
    }
    if (tool === 'pen' || tool === 'marker') setDraft({ id: nextId++, t: tool, pts: [p], color, w: strokeW });
    else setDraft({ id: nextId++, t: tool, a: p, b: p, color, w: strokeW } as Obj);
  };
  const moveP = (e: React.PointerEvent) => {
    const st = ptr.current; if (!st || !doc) return;
    const p = toImg(e); st.last = p;
    if (tool === 'select') { if (st.id != null) setDrag({ dx: p.x - st.start.x, dy: p.y - st.start.y }); return; }
    setDraft((d) => {
      if (!d) return d;
      if (d.t === 'pen' || d.t === 'marker') {
        const l = d.pts[d.pts.length - 1];
        return Math.hypot(p.x - l.x, p.y - l.y) < unit * 0.8 ? d : { ...d, pts: [...d.pts, p] };
      }
      if (d.t === 'text') return d;
      // Mit Shift (Desktop): gerade Linien / Quadrate
      let b = p;
      if (e.shiftKey && (d.t === 'rect' || d.t === 'ellipse')) { const s = Math.max(Math.abs(p.x - d.a.x), Math.abs(p.y - d.a.y)); b = { x: d.a.x + Math.sign(p.x - d.a.x) * s, y: d.a.y + Math.sign(p.y - d.a.y) * s }; }
      return { ...d, b };
    });
  };
  const up = () => {
    const st = ptr.current; ptr.current = null; if (!st || !doc) return;
    if (tool === 'select') {
      if (st.id != null && drag && (Math.abs(drag.dx) > 0.5 || Math.abs(drag.dy) > 0.5)) commit({ ...doc, objs: doc.objs.map((o) => (o.id === st.id ? move(o, drag.dx, drag.dy) : o)) });
      setDrag(null);
      return;
    }
    if (draft) {
      const tiny = draft.t !== 'pen' && draft.t !== 'marker' && draft.t !== 'text' && Math.hypot((draft as Shape).b.x - (draft as Shape).a.x, (draft as Shape).b.y - (draft as Shape).a.y) < unit * 4;
      if (!tiny) commit({ ...doc, objs: [...doc.objs, draft] });
      setDraft(null);
    }
  };

  const pickColor = (c: string) => {
    setColor(c);
    if (tool === 'select' && sel != null && doc) commit({ ...doc, objs: doc.objs.map((o) => (o.id === sel && o.t !== 'pixel' ? { ...o, color: c } : o)) });
  };
  const delSel = () => { if (doc && sel != null) { commit({ ...doc, objs: doc.objs.filter((o) => o.id !== sel) }); setSel(null); } };

  // ---------- Zuschneiden ----------
  const fitRatio = (r: number | null): Rect => {
    if (!r) return { x: 0, y: 0, w: W, h: H };
    let w = W, h = W / r; if (h > H) { h = H; w = H * r; }
    return { x: (W - w) / 2, y: (H - h) / 2, w, h };
  };
  const applyCrop = (): Doc | null => {
    if (!doc || !crop) return doc;
    const full = crop.x < 1 && crop.y < 1 && crop.w > W - 2 && crop.h > H - 2;
    if (full) return doc;
    const next = { base: flatten(doc, crop), objs: [] };
    commit(next);
    return next;
  };
  const chooseTool = (t: Tool) => {
    if (textIn) closeText();
    if (tool === 'crop' && t !== 'crop') { applyCrop(); setCrop(null); }
    if (t === 'crop') { setCrop(fitRatio(ratio)); setSel(null); }
    if (t !== 'select') setSel(null);
    setTool(t);
  };
  const transform = (kind: 'rotate' | 'flip') => {
    if (!doc) return;
    const src = flatten(doc);
    const c = kind === 'rotate' ? canvasOf(src.height, src.width) : canvasOf(src.width, src.height);
    const ctx = c.getContext('2d')!;
    if (kind === 'rotate') { ctx.translate(0, c.height); ctx.rotate(-Math.PI / 2); } else { ctx.translate(c.width, 0); ctx.scale(-1, 1); }
    ctx.drawImage(src, 0, 0);
    commit({ base: c, objs: [] });
    setCrop({ x: 0, y: 0, w: c.width, h: c.height }); setRatio(null);
  };
  const cropDrag = (mode: 'move' | 'nw' | 'ne' | 'sw' | 'se') => (e: React.PointerEvent) => {
    if (!crop) return;
    e.stopPropagation(); e.preventDefault();
    const start = toImg(e), c0 = { ...crop }, min = unit * 30;
    const onMove = (ev: PointerEvent) => {
      const p = toImg(ev), dx = p.x - start.x, dy = p.y - start.y;
      if (mode === 'move') { setCrop({ ...c0, x: Math.max(0, Math.min(W - c0.w, c0.x + dx)), y: Math.max(0, Math.min(H - c0.h, c0.y + dy)) }); return; }
      let x1 = c0.x, y1 = c0.y, x2 = c0.x + c0.w, y2 = c0.y + c0.h;
      if (mode.includes('w')) x1 = Math.min(x2 - min, Math.max(0, c0.x + dx)); else x2 = Math.max(x1 + min, Math.min(W, c0.x + c0.w + dx));
      if (mode.includes('n')) y1 = Math.min(y2 - min, Math.max(0, c0.y + dy)); else y2 = Math.max(y1 + min, Math.min(H, c0.y + c0.h + dy));
      if (ratio) {
        let w = x2 - x1, h = w / ratio;
        const maxH = mode.includes('n') ? c0.y + c0.h : H - c0.y;
        if (h > maxH) { h = maxH; w = h * ratio; }
        if (mode.includes('w')) x1 = x2 - w; else x2 = x1 + w;
        if (mode.includes('n')) y1 = y2 - h; else y2 = y1 + h;
      }
      setCrop({ x: x1, y: y1, w: x2 - x1, h: y2 - y1 });
    };
    const onUp = () => { window.removeEventListener('pointermove', onMove); window.removeEventListener('pointerup', onUp); };
    window.addEventListener('pointermove', onMove); window.addEventListener('pointerup', onUp);
  };

  // ---------- Fertig ----------
  const finish = () => {
    if (textIn) closeText();
    const d = tool === 'crop' ? applyCrop() : doc;
    if (!d) return;
    if (!d.objs.length && d === doc && !past.length) { onCancel(); return; }
    const out = flatten(d);
    const png = file.type === 'image/png' || file.type === 'image/gif';
    out.toBlob((b) => {
      if (!b) return onCancel();
      const name = file.name.replace(/\.[a-z0-9]+$/i, '') + (png ? '.png' : '.jpg');
      onDone(new File([b], name, { type: png ? 'image/png' : 'image/jpeg' }));
    }, png ? 'image/png' : 'image/jpeg', 0.92);
  };
  const cancel = () => { if (!past.length || confirm('Änderungen verwerfen?')) onCancel(); };

  useEffect(() => {
    const k = (e: KeyboardEvent) => {
      if (textIn) return;
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'z') { e.preventDefault(); e.shiftKey ? redo() : undo(); }
      else if ((e.key === 'Backspace' || e.key === 'Delete') && sel != null) delSel();
      else if (e.key === 'Escape') cancel();
    };
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  });

  const selObj = doc?.objs.find((o) => o.id === sel);
  const showColors = tool !== 'crop' && tool !== 'pixel' && !(tool === 'select' && (!selObj || selObj.t === 'pixel'));
  const showSize = ['pen', 'marker', 'arrow', 'rect', 'ellipse', 'text'].includes(tool);
  const pct = (v: number, of: number) => `${(v / of) * 100}%`;

  return (
    <div className="ie" role="dialog" aria-label="Bild bearbeiten">
      <header className="ie-top">
        <button className="ie-txt" onClick={cancel}>Abbrechen</button>
        <span className="ie-mid">
          <button className="icon-btn" onClick={undo} disabled={!past.length} aria-label="Rückgängig"><Icon name="undo" /></button>
          <button className="icon-btn" onClick={redo} disabled={!future.length} aria-label="Wiederholen"><Icon name="redo" /></button>
          {tool === 'select' && sel != null && <button className="icon-btn" onClick={delSel} aria-label="Löschen"><Icon name="trash" /></button>}
        </span>
        <button className="ie-txt done" onClick={finish}>Fertig</button>
      </header>

      <div className="ie-stage" ref={stage}>
        {doc ? (
          <div className="ie-box" style={{ width: box.w, height: box.h }}>
            <canvas ref={cv} className={`ie-canvas tool-${tool}`} onPointerDown={down} onPointerMove={moveP} onPointerUp={up} onPointerCancel={up} />
            {tool === 'crop' && crop && (
              <div className="ie-crop" style={{ left: pct(crop.x, W), top: pct(crop.y, H), width: pct(crop.w, W), height: pct(crop.h, H) }} onPointerDown={cropDrag('move')}>
                <i className="g1" /><i className="g2" /><i className="g3" /><i className="g4" />
                {(['nw', 'ne', 'sw', 'se'] as const).map((m) => <b key={m} className={`h ${m}`} onPointerDown={cropDrag(m)} />)}
              </div>
            )}
          </div>
        ) : <div className="spinner" />}
        {textIn && (
          <textarea className="ie-text" ref={(el) => { if (el && document.activeElement !== el) setTimeout(() => el.focus(), 0); }} value={textIn.value} rows={1} placeholder="Text"
            style={{ left: Math.min(textIn.screen.x, (stage.current?.clientWidth ?? 300) - 220), top: textIn.screen.y, color, fontSize: Math.max(16, (fontSize * box.w) / W) }}
            onChange={(e) => setTextIn({ ...textIn, value: e.target.value })}
            onBlur={closeText}
            onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); closeText(); } if (e.key === 'Escape') setTextIn(null); }} />
        )}
      </div>

      <footer className="ie-bottom">
        {tool === 'crop' ? (
          <div className="ie-row">
            {RATIOS.map((r) => <button key={r.label} className={`pill ${ratio === r.r ? 'on' : ''}`} onClick={() => { setRatio(r.r); setCrop(fitRatio(r.r)); }}>{r.label}</button>)}
            <span className="ie-sep" />
            <button className="icon-btn" onClick={() => transform('rotate')} aria-label="Drehen" title="Drehen"><Icon name="rotate" /></button>
            <button className="icon-btn" onClick={() => transform('flip')} aria-label="Spiegeln" title="Spiegeln"><Icon name="flip" /></button>
          </div>
        ) : (
          <div className="ie-row">
            {showColors && COLORS.map((c) => <button key={c} className={`ie-color ${color === c ? 'on' : ''}`} style={{ background: c }} onClick={() => pickColor(c)} aria-label={`Farbe ${c}`} />)}
            {showSize && <input className="ie-size" type="range" min={1} max={12} value={size} onChange={(e) => setSize(Number(e.target.value))} aria-label="Stärke" />}
            {tool === 'pixel' && <span className="ie-hint">Bereich aufziehen, um ihn unkenntlich zu machen</span>}
            {tool === 'select' && !selObj && <span className="ie-hint">Tippe auf eine Markierung, um sie zu verschieben, umzufärben oder zu löschen</span>}
          </div>
        )}
        <div className="ie-tools">
          {TOOLS.map((t) => (
            <button key={t.id} className={`ie-tool ${tool === t.id ? 'on' : ''}`} onClick={() => chooseTool(t.id)} aria-label={t.label}>
              <Icon name={t.icon} /><small>{t.label}</small>
            </button>
          ))}
        </div>
      </footer>
    </div>
  );
}
