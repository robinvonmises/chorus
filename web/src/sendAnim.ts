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

/**
 * Ablauf nach iMessage (Bild für Bild aus Waynes Bildschirmaufnahme, 30 fps):
 * 1. Das Eingabefeld wird zur Blase: Hintergrund so breit wie das Feld, Text an seiner Stelle im Feld.
 * 2. ~120 ms: Hintergrund schrumpft nach rechts auf Blasenbreite, Text gleitet mit, Höhe bleibt im Feld.
 * 3. ~260 ms: erst dann steigt die Blase senkrecht an ihren Platz, mit leichtem Nachfedern.
 * Die echte Blase bleibt dabei an ihrem Platz und ist nur unsichtbar; eine Kopie fliegt in einer
 * fixierten Ebene darüber (nur transform), damit sie über dem Eingabefeld sichtbar ist und nichts am Scrollen ändert.
 */
export function rise(msg: Element | null | undefined) {
  if (!(msg instanceof HTMLElement) || !active() || typeof msg.animate !== 'function') return;
  const bubble = msg.querySelector('.bubble');
  const field = document.querySelector('.composer textarea')?.closest('.composer') ?? document.querySelector('.composer');
  if (!(bubble instanceof HTMLElement) || !field) return;
  const b = bubble.getBoundingClientRect(), f = field.getBoundingClientRect();
  if (!b.width || !f.width || b.height > 400) return;
  const host = msg.closest('.chat-view') ?? document.body;
  let layer: HTMLDivElement | null = null;
  const restore = () => { msg.style.opacity = ''; layer?.remove(); layer = null; };
  try {
    const cs = getComputedStyle(bubble);
    layer = document.createElement('div');
    layer.className = msg.className;
    Object.assign(layer.style, { position: 'fixed', left: '0px', top: '0px', width: `${b.width}px`, height: `${b.height}px`, maxWidth: 'none', margin: '0', zIndex: '60', pointerEvents: 'none' });
    const bg = document.createElement('div');
    Object.assign(bg.style, { position: 'absolute', top: '0', bottom: '0', right: '0', width: `${b.width}px`, background: cs.backgroundColor, borderRadius: cs.borderRadius });
    const copy = bubble.cloneNode(true) as HTMLElement;
    Object.assign(copy.style, { background: 'transparent', boxSizing: 'border-box', width: `${b.width}px`, height: `${b.height}px`, margin: '0' });
    layer.append(bg, copy);
    host.appendChild(layer);
    // Falls die Ebene nicht am Bildschirmrand beginnt (umgebende Transformation), ausgleichen
    const o = layer.getBoundingClientRect();
    layer.style.left = `${b.left - o.left}px`; layer.style.top = `${b.top - o.top}px`;
    msg.style.opacity = '0';

    const dy = Math.round((f.top + f.height / 2) - (b.top + b.height / 2)); // senkrecht mittig im Feld
    const dx = Math.round(Math.min(0, f.right - b.right));                   // rechte Kante wie das Feld
    const bw0 = Math.max(b.width, f.width);                                   // Hintergrund anfangs feldbreit (Breite statt scaleX, damit die Rundung rund bleibt)
    const tx = Math.round(Math.min(0, f.left - (b.left + dx)));               // Text anfangs links im Feld
    const T = 400, A = 0.3;
    const slide = 'cubic-bezier(.3, .6, .3, 1)', up = 'cubic-bezier(.25, .9, .35, 1)';
    const anims = [
      layer.animate([
        { transform: `translate(${dx}px, ${dy}px)`, easing: slide },
        { offset: A, transform: `translate(0px, ${dy}px)`, easing: up },
        { offset: 0.82, transform: 'translate(0px, -3px)', easing: 'ease-in-out' },
        { transform: 'translate(0px, 0px)' },
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
