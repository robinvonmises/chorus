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
  const b = bubble.getBoundingClientRect(), f = field.getBoundingClientRect(), wt = wrap.getBoundingClientRect().top;
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
  };
  try {
    const cs = getComputedStyle(bubble);
    // Bühne: feste Ebene über dem Chat, sichtbar nur oberhalb der Eingabeleiste und im Eingabefeld selbst.
    // So taucht die Blase hinter der Leiste auf, statt sie zu überdecken (wie bei iMessage).
    stage = document.createElement('div');
    Object.assign(stage.style, { position: 'fixed', left: '0px', top: '0px', right: '0px', bottom: '0px', zIndex: '60', pointerEvents: 'none' });
    host.appendChild(stage);
    const o = stage.getBoundingClientRect(); // falls die Ebene nicht am Bildschirmrand beginnt (umgebende Transformation)
    const X = (v: number) => `${Math.round(v - o.left)}px`, Y = (v: number) => `${Math.round(v - o.top)}px`;
    stage.style.clipPath = `polygon(0px 0px, 100% 0px, 100% ${Y(wt)}, ${X(f.right)} ${Y(wt)}, ${X(f.right)} ${Y(f.bottom)}, ${X(f.left)} ${Y(f.bottom)}, ${X(f.left)} ${Y(wt)}, 0px ${Y(wt)})`;

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

    /* Ablauf nach Waynes iMessage-Aufnahme (16:05, 30 fps):
       1. Im Feld, wie hinter Milchglas: blass und unscharf, feldbreit, schrumpft nach rechts.
       2. Taucht oben hinter der Leiste auf, dabei kleiner (~82 %) und wird scharf.
       3. Wächst an ihrem Platz auf volle Größe. */
    const dy = Math.round((f.top + f.height / 2) - (b.top + b.height / 2));
    const dx = Math.round(Math.min(0, f.right - b.right));
    const bw0 = Math.max(b.width, f.width);
    const tx = Math.round(Math.min(0, f.left - (b.left + dx)));
    const T = 850, A = 0.3; // Wayne: eher 0,8–1 s
    const slide = 'cubic-bezier(.45, .05, .25, 1)', up = 'cubic-bezier(.25, .7, .3, 1)', grow = 'cubic-bezier(.3, .6, .3, 1)';
    const anims = [
      layer.animate([
        { transform: `translate(${dx}px, ${dy}px) scale(1)`, filter: 'blur(5px)', opacity: 0.5, easing: slide },
        { offset: A, transform: `translate(0px, ${dy}px) scale(.82)`, filter: 'blur(3px)', opacity: 0.75, easing: up },
        { offset: 0.62, transform: 'translate(0px, 0px) scale(.88)', filter: 'blur(0px)', opacity: 1, easing: grow },
        { transform: 'translate(0px, 0px) scale(1)', filter: 'blur(0px)', opacity: 1 },
      ], { duration: T }),
      bg.animate([
        { width: `${bw0}px`, easing: slide },
        { offset: A, width: `${b.width}px` },
        { width: `${b.width}px` },
      ], { duration: T }),
      copy.animate([
        { transform: `translateX(${tx}px)`, easing: slide },
        { offset: A, transform: 'translateX(0px)' },
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
