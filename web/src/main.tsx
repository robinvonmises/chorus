import { Component, StrictMode, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import './styles.css';
import { applyAccent, applyBubbles, applyChatBg, applyShape } from './bubbles';
import { T } from './i18n';
applyAccent();
applyBubbles();
applyChatBg();
applyShape();

// iOS-Statusleiste: Farbe beim Wechsel Hell/Dunkel nachziehen. Das Meta-Tag wird ersetzt statt geändert,
// weil iOS eine bloße Änderung in der Web-App oft übersieht. Farbe = Hintergrund der Kopfleiste (--bg).
const syncThemeColor = () => {
  const c = getComputedStyle(document.body).backgroundColor;
  const old = document.querySelector('meta[name="theme-color"]');
  if (!c || old?.getAttribute('content') === c) return;
  const m = document.createElement('meta');
  m.name = 'theme-color';
  m.content = c;
  if (old) old.replaceWith(m); else document.head.appendChild(m);
};
const darkMq = window.matchMedia?.('(prefers-color-scheme: dark)');
// Kein Neuladen bei Moduswechsel: iOS meldet im Hintergrund falsche Wechsel, das Neuladen wirkte wie ein Neustart der App.
// Die Leistenfarbe der Homescreen-App passt iOS dann erst beim nächsten Start an.
darkMq?.addEventListener?.('change', () => requestAnimationFrame(syncThemeColor));
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') requestAnimationFrame(syncThemeColor);
});
requestAnimationFrame(syncThemeColor);

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
  let settleT: number[] = [];
  const set = (h: number, kbd: boolean) => {
    root.style.setProperty('--vvh', `${h}px`);
    root.classList.toggle('kbd', kbd);
    if (!kbd) root.style.setProperty('--vvt', '0px'); // ohne Tastatur ist die App immer oben bündig
  };
  // Vorhergesagte Höhen (Tastatur zu, Rückkehr aus dem Hintergrund) später mit der echten Größe abgleichen.
  // Sonst bleibt eine zu große Höhe stehen, wenn iOS danach kein resize mehr meldet, und das Eingabefeld
  // ragt unten aus dem Bild (z. B. nach dem Foto-Picker).
  const settle = () => {
    settleT.forEach(clearTimeout);
    settleT = [450, 1100].map((ms) => window.setTimeout(() => {
      if (document.visibilityState === 'hidden' || vv.height < 150) return;
      if (!typing()) {
        // Deutlich kleiner = iOS meldet noch die alte Tastaturhöhe; dann die Vorhersage stehen lassen.
        if (maxH - vv.height > 120) return;
        maxH = vv.height;
        if (window.scrollY) window.scrollTo(0, 0);
      }
      fit();
    }, ms));
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
    if (typing() && kbH && maxH - vv.height < 120) { set(maxH - kbH, true); settle(); } // vorausgleiten
    else fit();
  });
  document.addEventListener('focusout', () => setTimeout(() => {
    if (!typing() && touch && maxH - vv.height > 120) { set(maxH, false); settle(); } // schon mit zurückgleiten
    else fit();
  }, 30));
  // Zurück aus dem Hintergrund (z. B. über eine Benachrichtigung): iOS meldet die Fenstergröße erst verspätet
  // und lässt oft noch die alte Tastaturhöhe stehen. Deshalb beim Wegwechseln die Tastatur schließen und beim
  // Zurückkommen sofort die volle Höhe setzen, ohne Animation, damit nichts nachträglich an seinen Platz rutscht.
  const snap = () => {
    root.classList.remove('vv-ready');
    set(maxH || vv.height, false);
    settle();
    requestAnimationFrame(() => requestAnimationFrame(() => root.classList.add('vv-ready')));
  };
  document.addEventListener('visibilitychange', () => {
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
        <div><p>{T('Da ist etwas schiefgelaufen.')}</p><button className="btn primary" onClick={() => location.reload()}>{T('Neu laden')}</button></div>
      </div>
    );
  }
}

createRoot(document.getElementById('root')!).render(<StrictMode><Guard><App /></Guard></StrictMode>);
