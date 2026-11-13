/**
 * Sende-Animation wie bei iMessage: die eigene neue Blase steigt aus dem Eingabefeld in den Chat.
 * Bewusst minimal: nur transform/opacity auf genau dieser einen Blase, kein Layout-Übergang.
 * Abschaltbar in Einstellungen → Darstellung; bei „Bewegung reduzieren“ immer aus.
 */
const KEY = 'inbox:sendAnim';

export const sendAnimEnabled = () => localStorage.getItem(KEY) !== '0';
export const setSendAnim = (on: boolean) => localStorage.setItem(KEY, on ? '1' : '0');

const active = () => {
  try { return sendAnimEnabled() && !matchMedia('(prefers-reduced-motion: reduce)').matches; } catch { return false; }
};

// Textnachrichten erscheinen erst, wenn der Server sie zurückmeldet: beim Senden vormerken,
// damit nur die eigene gerade gesendete Nachricht animiert wird (nicht z. B. eine vom Handy aus gesendete)
let armedAt = 0;
export const armRise = () => { armedAt = Date.now(); };
export const takeRise = () => { const ok = Date.now() - armedAt < 15000; armedAt = 0; return ok; };

/** Sende-Animation nach iMessage-Vorbild, Details im Ablauf-Kommentar unten. */
export function rise(msg: Element | null | undefined) {
  if (!(msg instanceof HTMLElement) || !active() || typeof msg.animate !== 'function') return;
  const bubble = msg.querySelector('.bubble');
  const field = document.querySelector('.composer textarea') ?? document.querySelector('.composer');
  const wrap = field?.closest('.composer-wrap') ?? field;
  if (!(bubble instanceof HTMLElement) || !field || !wrap) return;
  const b = bubble.getBoundingClientRect(), f = field.getBoundingClientRect();
  if (!b.width || !f.width || b.height > 400) return;
  const host = msg.closest('.chat-view') ?? document.body;
  const list = msg.parentElement;
  let layer: HTMLDivElement | null = null, stage: HTMLDivElement | null = null;
  // Der Server ersetzt die gerade gesendete Nachricht oft kurz danach durch eine neue (andere ID → neues Element).
  // Alles, was während des Flugs als eigene Blase dazukommt, bleibt bis zur Landung unsichtbar, sonst ist sie doppelt da.
  const hidden: HTMLElement[] = [msg];
  const hide = (el: HTMLElement) => { el.style.opacity = '0'; hidden.push(el); };
  const mo = typeof MutationObserver !== 'undefined' && list ? new MutationObserver((recs) => {
    for (const r of recs) r.addedNodes.forEach((n) => { if (n instanceof HTMLElement && n.matches('.msg.out')) hide(n); });
  }) : null;
  let done = false;
  const restore = () => {
    if (done) return; done = true;
    mo?.disconnect();
    hidden.forEach((el) => { el.style.opacity = ''; });
    stage?.remove(); stage = null; layer = null;
    host.classList.remove('sending');
  };
  try {
    const cs = getComputedStyle(bubble);
    // Bühne: feste Ebene über dem Chat, aber UNTER der Eingabeleiste (.chat-dock hat z-index 6).
    // Die Leiste wird währenddessen gleichmäßig milchig-durchsichtig (.chat-view.sending, styles.css),
    // so sieht man die Blase unscharf durch die ganze Leiste und sie taucht oben dahinter auf (wie bei iMessage).
    stage = document.createElement('div');
    Object.assign(stage.style, { position: 'fixed', left: '0px', top: '0px', right: '0px', bottom: '0px', zIndex: '5', pointerEvents: 'none' });
    host.appendChild(stage);
    host.classList.add('sending');
    const o = stage.getBoundingClientRect(); // falls die Ebene nicht am Bildschirmrand beginnt (umgebende Transformation)
    const X = (v: number) => `${Math.round(v - o.left)}px`, Y = (v: number) => `${Math.round(v - o.top)}px`;

    layer = document.createElement('div');
    layer.className = msg.className;
    Object.assign(layer.style, { position: 'absolute', left: X(b.left), top: Y(b.top), width: `${b.width}px`, height: `${b.height}px`, maxWidth: 'none', margin: '0', transformOrigin: '100% 100%' });
    const bg = document.createElement('div');
    Object.assign(bg.style, { position: 'absolute', top: '0', bottom: '0', right: '0', width: `${b.width}px`, background: cs.backgroundColor, borderRadius: cs.borderRadius });
    const copy = bubble.cloneNode(true) as HTMLElement;
    Object.assign(copy.style, { background: 'transparent', boxSizing: 'border-box', width: `${b.width}px`, height: `${b.height}px`, margin: '0' });
    layer.append(bg, copy);
    stage.appendChild(layer);
    msg.style.opacity = '0';
    if (mo && list) mo.observe(list, { childList: true });

    /* Ablauf nach Waynes iMessage-Aufnahme (16:05, 30 fps) und Feinschliff (13.11.):
       1. Im Feld, wie hinter Milchglas: blass und unscharf, feldbreit, wird schnell nach rechts gedrückt.
       2. Noch während sie nach rechts ausläuft, steigt sie langsam auf (X und Y getrennt getaktet,
          dadurch eine runde Bahn statt einer Ecke), dabei kleiner (~82 %) und scharf.
       3. Wächst an ihrem Platz auf volle Größe.
       Die Bahn wird vorab in dichte Schlüsselbilder gerechnet: weiterhin nur transform/filter/opacity
       auf einem Element, Safari bekommt dasselbe wie vorher, nur mehr Stützpunkte. */
    const dy = Math.round((f.top + f.height / 2) - (b.top + b.height / 2));
    const dx = Math.round(Math.min(0, f.right - b.right));
    const bw0 = Math.max(b.width, f.width);
    const tx = Math.round(Math.min(0, f.left - (b.left + dx)));
    const T = 850; // Wayne: eher 0,8–1 s
    const X1 = 0.26, Y0 = 0.1, Y1 = 0.66; // Anteile von T: nach rechts bis X1, Aufstieg von Y0 bis Y1, dann Wachsen
    const push = bezier(0.2, 0.85, 0.35, 1), lift = bezier(0.45, 0, 0.2, 1), grow = bezier(0.3, 0.6, 0.3, 1);
    const part = (t: number, a: number, z: number) => Math.min(1, Math.max(0, (t - a) / (z - a)));
    const N = 40;
    const frames: Keyframe[] = [];
    for (let i = 0; i <= N; i++) {
      const t = i / N;
      const px = push(part(t, 0, X1)), py = lift(part(t, Y0, Y1)), pg = grow(part(t, Y1, 1));
      const s = 1 - 0.18 * px + 0.06 * py + 0.12 * pg;
      frames.push({
        offset: t,
        transform: `translate(${(dx * (1 - px)).toFixed(1)}px, ${(dy * (1 - py)).toFixed(1)}px) scale(${s.toFixed(4)})`,
        filter: `blur(${Math.max(0, 5 - 2 * px - 3 * py).toFixed(2)}px)`,
        opacity: Math.min(1, 0.5 + 0.25 * px + 0.25 * py),
      });
    }
    const pushCss = 'cubic-bezier(.2, .85, .35, 1)';
    const anims = [
      layer.animate(frames, { duration: T }),
      bg.animate([
        { width: `${bw0}px`, easing: pushCss },
        { offset: X1, width: `${b.width}px` },
        { width: `${b.width}px` },
      ], { duration: T }),
      copy.animate([
        { transform: `translateX(${tx}px)`, easing: pushCss },
        { offset: X1, transform: 'translateX(0px)' },
        { transform: 'translateX(0px)' },
      ], { duration: T }),
    ];
    anims[0].onfinish = restore;
    anims[0].oncancel = restore;
    setTimeout(restore, T + 300); // Sicherheitsnetz: echte Blase kommt in jedem Fall zurück
  } catch {
    restore();
  }
}

/** CSS-cubic-bezier als Funktion (x → y), für die vorab gerechneten Schlüsselbilder. */
function bezier(x1: number, y1: number, x2: number, y2: number) {
  const cx = 3 * x1, bx = 3 * (x2 - x1) - cx, ax = 1 - cx - bx;
  const cy = 3 * y1, by = 3 * (y2 - y1) - cy, ay = 1 - cy - by;
  const sx = (u: number) => ((ax * u + bx) * u + cx) * u;
  return (x: number) => {
    if (x <= 0) return 0;
    if (x >= 1) return 1;
    let lo = 0, hi = 1, u = x;
    for (let i = 0; i < 30; i++) { u = (lo + hi) / 2; if (sx(u) < x) lo = u; else hi = u; }
    return ((ay * u + by) * u + cy) * u;
  };
}
