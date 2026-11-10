import { Component, StrictMode, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import './styles.css';
import { applyBubbles } from './bubbles';
applyBubbles();

// iOS verkleinert beim Einblenden der Tastatur nicht die Seite, sondern schiebt sie hoch.
// Wir passen die App deshalb an den sichtbaren Bereich an, damit nichts verrutscht und keine Lücke entsteht.
const vv = window.visualViewport;
if (vv) {
  const root = document.documentElement;
  let maxH = vv.height;
  // Tastaturhöhe merken: Beim nächsten Fokus gleitet die App sofort mit der Tastatur nach oben,
  // statt erst nach dem Einblenden (iOS meldet die neue Höhe erst, wenn die Tastatur schon steht).
  let kbH = Number(localStorage.getItem('inbox:kbh')) || 0;
  window.addEventListener('orientationchange', () => { maxH = 0; kbH = 0; setTimeout(fit, 300); });
  const touch = window.matchMedia('(hover: none)').matches;
  // In der iOS-Web-App schrumpft innerHeight mit, daran lässt sich die Tastatur nicht erkennen.
  // Deshalb zusätzlich: Ein Textfeld hat den Fokus = Tastatur offen (auf Touch-Geräten).
  const typing = () => touch && !!document.activeElement?.matches('input:not([type=checkbox]):not([type=radio]), textarea, [contenteditable]');
  const set = (h: number, kbd: boolean) => {
    root.style.setProperty('--vvh', `${h}px`);
    root.classList.toggle('kbd', kbd);
  };
  const fit = () => {
    // Im Hintergrund meldet iOS teils unsinnige Größen (bis 0). Die nicht übernehmen, sonst bleibt die App beim Öffnen leer.
    if (document.visibilityState === 'hidden' || vv.height < 150) return;
    maxH = Math.max(maxH, vv.height);
    const diff = maxH - vv.height;
    if (diff > 120 && Math.abs(diff - kbH) > 4) { kbH = diff; localStorage.setItem('inbox:kbh', String(Math.round(diff))); }
    root.style.setProperty('--vvt', `${vv.offsetTop}px`);
    set(vv.height, window.innerHeight - vv.height > 120 || diff > 120 || typing());
  };
  document.addEventListener('focusin', () => {
    if (typing() && kbH && maxH - vv.height < 120) set(maxH - kbH, true); // vorausgleiten
    else fit();
  });
  document.addEventListener('focusout', () => setTimeout(() => {
    if (!typing() && touch && maxH - vv.height > 120) set(maxH, false); // schon mit zurückgleiten
    else fit();
  }, 30));
  // Zurück aus dem Hintergrund (z. B. über eine Benachrichtigung): iOS meldet die Fenstergröße erst verspätet
  // und lässt oft noch die alte Tastaturhöhe stehen. Deshalb beim Wegwechseln die Tastatur schließen und beim
  // Zurückkommen sofort die volle Höhe setzen, ohne Animation, damit nichts nachträglich an seinen Platz rutscht.
  const snap = () => {
    root.classList.remove('vv-ready');
    set(maxH || vv.height, false);
    requestAnimationFrame(() => requestAnimationFrame(() => root.classList.add('vv-ready')));
  };
  let hiddenAt = 0;
  document.addEventListener('visibilitychange', () => {
    // Nach langer Pause (über 15 Minuten) die App frisch laden: iOS hat sie dann oft halb abgeräumt
    if (document.visibilityState === 'hidden') hiddenAt = Date.now();
    else if (hiddenAt && Date.now() - hiddenAt > 15 * 60_000) { location.reload(); return; }
    if (!touch) return;
    if (document.visibilityState === 'hidden') { (document.activeElement as HTMLElement | null)?.blur?.(); snap(); }
    else if (!typing()) snap();
  });
  window.addEventListener('pageshow', () => { if (touch && !typing()) snap(); });
  vv.addEventListener('resize', fit);
  vv.addEventListener('scroll', fit);
  fit();
  requestAnimationFrame(() => root.classList.add('vv-ready'));
}

/** Stürzt die Oberfläche ab, nicht leer stehen bleiben: einmal automatisch neu laden, danach einen Knopf zeigen */
class Guard extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  componentDidCatch(e: unknown) {
    console.error(e);
    const last = Number(sessionStorage.getItem('inbox:crash') || 0);
    if (Date.now() - last > 60_000) { sessionStorage.setItem('inbox:crash', String(Date.now())); location.reload(); }
  }
  render() {
    if (!this.state.failed) return this.props.children;
    return (
      <div style={{ display: 'grid', placeItems: 'center', height: '100dvh', padding: 24, textAlign: 'center', gap: 12 }}>
        <div><p>Da ist etwas schiefgelaufen.</p><button className="btn primary" onClick={() => location.reload()}>Neu laden</button></div>
      </div>
    );
  }
}

createRoot(document.getElementById('root')!).render(<StrictMode><Guard><App /></Guard></StrictMode>);
