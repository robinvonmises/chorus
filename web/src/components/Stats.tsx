import { useEffect, useMemo, useState } from 'react';
import { api, type Stats } from '../api';
import { NETWORKS } from '../util';
import { Avatar } from './Rail';
import { T, locale } from '../i18n';

const nf = new Intl.NumberFormat(locale);
const n = (x: number) => nf.format(x);
/** Antwortzeit lesbar: 45 Sek., 12 Min., 3 Std. */
export function waitText(sec: number | null): string {
  if (sec == null) return '–';
  if (sec < 60) return T('{0} Sek.', sec);
  if (sec < 3600) return T('{0} Min.', Math.round(sec / 60));
  return T('{0} Std.', Math.round(sec / 360) / 10);
}
const WD = [T('Mo'), T('Di'), T('Mi'), T('Do'), T('Fr'), T('Sa'), T('So')];

/** Statistik: mit wem du am meisten schreibst, wie schnell du antwortest, welche Messenger, dazu eine Jahresrückblick-Karte zum Teilen */
export function StatsPage({ name, onOpenChat }: { name: string; onOpenChat: (id: string) => void }) {
  const [year, setYear] = useState<number | 'all'>(() => new Date().getFullYear());
  const [st, setSt] = useState<Stats | null>(null);
  const [err, setErr] = useState('');
  useEffect(() => {
    let off = false; setErr('');
    api.stats(year).then((s) => { if (!off) setSt(s); }).catch((e) => !off && setErr(e.message));
    return () => { off = true; };
  }, [year]);

  if (err) return <div className="ios-card pad"><p className="error">{err}</p></div>;
  if (!st) return <div className="ios-card pad center"><span className="spinner" /></div>;
  const total = st.sent + st.received;
  const maxTop = Math.max(1, ...st.top.map((p) => p.sent + p.received));
  const maxH = Math.max(1, ...st.hours), maxW = Math.max(1, ...st.weekdays);
  const netTotal = st.networks.reduce((a, b) => a + b.count, 0) || 1;
  const peakHour = st.hours.indexOf(maxH);

  return (
    <div className="stats">
      <div className="stats-years">
        {st.years.map((y) => <button key={y} className={`pill${year === y ? ' on' : ''}`} onClick={() => setYear(y)}>{y}</button>)}
        <button className={`pill${year === 'all' ? ' on' : ''}`} onClick={() => setYear('all')}>{T('Gesamt')}</button>
      </div>

      {!total ? <div className="ios-card pad"><p className="muted">{T('Für diesen Zeitraum liegen keine Nachrichten vor.')}</p></div> : <>
        <RecapCard st={st} name={name} />

        <div className="stats-grid">
          <Tile big={n(st.sent)} label={T('gesendet')} />
          <Tile big={n(st.received)} label={T('empfangen')} />
          <Tile big={n(st.words)} label={T('Wörter geschrieben')} />
          <Tile big={n(st.chats)} label={T('Chats')} />
          <Tile big={n(st.voice)} label={T('Sprachnachrichten')} />
          <Tile big={n(st.photos)} label={T('Fotos gesendet')} />
        </div>

        <p className="ios-caption">{T('Antwortzeit')}</p>
        <div className="ios-card pad stats-reply">
          <div><b>{waitText(st.replyMedian)}</b><small>{T('brauchst du meist für eine Antwort')}</small></div>
          <div><b>{waitText(st.theirMedian)}</b><small>{T('brauchen andere für ihre Antwort an dich')}</small></div>
          <small className="muted">{T('Median über Einzelchats, nur Antworten innerhalb von 24 Stunden. E-Mail zählt nicht mit.')}</small>
        </div>

        {st.top.length > 0 && <>
          <p className="ios-caption">{T('Mit wem du am meisten schreibst')}</p>
          <div className="ios-card">
            {st.top.map((p, i) => (
              <button key={p.key} className="stats-person" onClick={() => onOpenChat(p.chatId)}>
                <span className="stats-rank">{i + 1}</span>
                <Avatar name={p.title} src={p.avatar} size={36} />
                <span className="stats-person-main">
                  <span className="stats-person-top"><b>{p.title}</b><small>{n(p.sent + p.received)}</small></span>
                  <span className="stats-bar"><i className="out" style={{ width: `${(p.sent / maxTop) * 100}%` }} /><i className="in" style={{ width: `${(p.received / maxTop) * 100}%` }} /></span>
                  <small className="muted">{p.networks.map((x) => NETWORKS[x].name).join(' · ')} · {T('{0} von dir', n(p.sent))}</small>
                </span>
              </button>
            ))}
          </div>
        </>}

        {st.groups.length > 0 && <>
          <p className="ios-caption">{T('Aktivste Gruppen')}</p>
          <div className="ios-card">
            {st.groups.map((p) => (
              <button key={p.key} className="stats-person" onClick={() => onOpenChat(p.chatId)}>
                <Avatar name={p.title} src={p.avatar} size={32} />
                <span className="stats-person-main"><span className="stats-person-top"><b>{p.title}</b><small>{n(p.sent + p.received)}</small></span>
                  <small className="muted">{NETWORKS[p.networks[0]].name} · {T('{0} von dir', n(p.sent))}</small></span>
              </button>
            ))}
          </div>
        </>}

        <p className="ios-caption">{T('Messenger')}</p>
        <div className="ios-card pad">
          <div className="stats-stack">{st.networks.map((x) => <i key={x.network} style={{ width: `${(x.count / netTotal) * 100}%`, background: NETWORKS[x.network].color }} />)}</div>
          <ul className="stats-legend">
            {st.networks.map((x) => <li key={x.network}><span className="dot" style={{ background: NETWORKS[x.network].color }} />{NETWORKS[x.network].name}<b>{Math.round((x.count / netTotal) * 100)} %</b><small>{n(x.count)}</small></li>)}
          </ul>
        </div>

        <p className="ios-caption">{T('Wann du schreibst')}</p>
        <div className="ios-card pad">
          <div className="stats-cols h24" role="img" aria-label={T('Nachrichten nach Uhrzeit')}>
            {st.hours.map((v, h) => <i key={h} className={h === peakHour ? 'peak' : ''} style={{ height: `${Math.max(2, (v / maxH) * 100)}%` }} title={`${h}:00 · ${n(v)}`} />)}
          </div>
          <div className="stats-axis"><span>0</span><span>6</span><span>12</span><span>18</span><span>24</span></div>
          <small className="muted">{T('Am meisten los: {0}–{1} Uhr', peakHour, peakHour + 1)}</small>
          <div className="stats-cols wd">
            {st.weekdays.map((v, d) => <span key={d}><i style={{ height: `${Math.max(3, (v / maxW) * 100)}%` }} /><small>{WD[d]}</small></span>)}
          </div>
          {st.busiestDay && <small className="muted">{T('Stärkster Tag: {0} mit {1} Nachrichten', new Date(st.busiestDay.day + 'T12:00').toLocaleDateString(locale, { day: 'numeric', month: 'long', year: 'numeric' }), n(st.busiestDay.count))}</small>}
        </div>

        {st.emojis.length > 0 && <>
          <p className="ios-caption">{T('Deine Emojis')}</p>
          <div className="ios-card pad stats-emojis">{st.emojis.map((e) => <span key={e.emoji}><b>{e.emoji}</b><small>{n(e.count)}</small></span>)}</div>
        </>}
      </>}
    </div>
  );
}

function Tile({ big, label }: { big: string; label: string }) {
  return <div className="stats-tile"><b>{big}</b><small>{label}</small></div>;
}

/** Jahresrückblick als Bild (1080 × 1350), zum Teilen oder Sichern */
function RecapCard({ st, name }: { st: Stats; name: string }) {
  const [names, setNames] = useState(() => localStorage.getItem('inbox:recapNames') !== '0');
  const [url, setUrl] = useState('');
  const [blob, setBlob] = useState<Blob | null>(null);
  const key = useMemo(() => JSON.stringify([st.year, st.sent, st.received, names]), [st, names]);
  useEffect(() => {
    let off = false;
    void drawRecap(st, name, names).then((b) => { if (off || !b) return; setBlob(b); setUrl((old) => { if (old) URL.revokeObjectURL(old); return URL.createObjectURL(b); }); });
    return () => { off = true; };
  }, [key]); // eslint-disable-line react-hooks/exhaustive-deps
  const file = () => new File([blob!], `chorus-${st.year ?? T('gesamt')}.png`, { type: 'image/png' });
  const canShare = !!blob && !!navigator.canShare?.({ files: [file()] });
  const share = async () => {
    if (!blob) return;
    if (canShare) { await navigator.share({ files: [file()], title: T('Mein Chorus-Jahr') }).catch(() => {}); return; }
    const a = document.createElement('a'); a.href = url; a.download = file().name; a.click();
  };
  return (
    <div className="ios-card pad stats-recap">
      {url ? <img src={url} alt={T('Jahresrückblick')} /> : <div className="stats-recap-ph"><span className="spinner" /></div>}
      <div className="row gap">
        <button className="btn primary" disabled={!blob} onClick={share}>{canShare ? T('Teilen') : T('Bild sichern')}</button>
        <label className="check"><input type="checkbox" checked={names} onChange={(e) => { setNames(e.target.checked); localStorage.setItem('inbox:recapNames', e.target.checked ? '1' : '0'); }} />{T('Namen zeigen')}</label>
      </div>
    </div>
  );
}

async function drawRecap(st: Stats, me: string, names: boolean): Promise<Blob | null> {
  const W = 1080, H = 1350;
  const c = document.createElement('canvas'); c.width = W; c.height = H;
  const g = c.getContext('2d'); if (!g) return null;
  const css = getComputedStyle(document.documentElement);
  const brand = css.getPropertyValue('--brand').trim() || '#1d6fd6';
  const font = css.getPropertyValue('font-family') || 'system-ui, sans-serif';
  const F = (w: number, s: number) => `${w} ${s}px -apple-system, BlinkMacSystemFont, "SF Pro Display", ${font}`;
  // Hintergrund: App-Farbe ins Dunkle
  const bg = g.createLinearGradient(0, 0, W * 0.6, H);
  bg.addColorStop(0, brand); bg.addColorStop(1, '#0b1020');
  g.fillStyle = bg; g.fillRect(0, 0, W, H);
  const glow = g.createRadialGradient(W * 0.85, H * 0.1, 0, W * 0.85, H * 0.1, 700);
  glow.addColorStop(0, 'rgba(255,255,255,.28)'); glow.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = glow; g.fillRect(0, 0, W, H);

  const icon = await new Promise<HTMLImageElement | null>((res) => { const i = new Image(); i.onload = () => res(i); i.onerror = () => res(null); i.src = '/icon.svg?v=4'; });
  if (icon) { g.save(); roundRect(g, 80, 80, 96, 96, 22); g.clip(); g.drawImage(icon, 80, 80, 96, 96); g.restore(); }
  g.fillStyle = '#fff'; g.textBaseline = 'alphabetic';
  g.font = F(600, 40); g.fillText('Chorus', 200, 125);
  g.globalAlpha = .75; g.font = F(500, 30); g.fillText(st.year ? T('Mein Jahr {0}', st.year) : T('Mein Chorus'), 200, 165); g.globalAlpha = 1;

  g.font = F(800, 180); g.fillText(n(st.sent + st.received), 80, 420);
  g.font = F(500, 42); g.globalAlpha = .85; g.fillText(T('Nachrichten, davon {0} von {1}', n(st.sent), me.split(' ')[0] || T('mir')), 84, 485); g.globalAlpha = 1;

  // Kennzahlen
  const facts: [string, string][] = [
    [waitText(st.replyMedian), T('meine Antwortzeit')],
    [n(st.words), T('Wörter geschrieben')],
    [n(st.chats), T('Chats')],
  ];
  facts.forEach(([v, l], i) => {
    const x = 80 + i * 320;
    g.fillStyle = 'rgba(255,255,255,.12)'; roundRect(g, x, 560, 290, 170, 28); g.fill();
    g.fillStyle = '#fff'; g.font = F(750, 58); g.fillText(v, x + 28, 650);
    g.globalAlpha = .75; g.font = F(500, 26); g.fillText(clip(g, l, 250), x + 28, 696); g.globalAlpha = 1;
  });

  // Top 3
  g.font = F(700, 38); g.fillText(T('Am meisten geschrieben mit'), 80, 810);
  st.top.slice(0, 3).forEach((p, i) => {
    const y = 870 + i * 96;
    g.fillStyle = 'rgba(255,255,255,.16)'; g.beginPath(); g.arc(112, y + 8, 32, 0, Math.PI * 2); g.fill();
    g.fillStyle = '#fff'; g.font = F(800, 34); g.textAlign = 'center'; g.fillText(String(i + 1), 112, y + 20); g.textAlign = 'left';
    g.font = F(600, 44); g.fillText(names ? clip(g, p.title, 640) : '••••••', 170, y + 24);
    g.globalAlpha = .75; g.font = F(500, 32); g.textAlign = 'right'; g.fillText(n(p.sent + p.received), W - 80, y + 22); g.textAlign = 'left'; g.globalAlpha = 1;
  });

  // Messenger-Anteile
  const tot = st.networks.reduce((a, b) => a + b.count, 0) || 1;
  let x = 80; const y0 = 1190, bw = W - 160;
  g.save(); roundRect(g, 80, y0, bw, 26, 13); g.clip();
  for (const s of st.networks) { const w = (s.count / tot) * bw; g.fillStyle = netHex(s.network); g.fillRect(x, y0, w + 1, 26); x += w; }
  g.restore();
  g.font = F(500, 28); x = 80;
  for (const s of st.networks.slice(0, 4)) {
    const label = `${NETWORKS[s.network].name} ${Math.round((s.count / tot) * 100)} %`;
    g.fillStyle = netHex(s.network); g.beginPath(); g.arc(x + 10, 1258, 10, 0, Math.PI * 2); g.fill();
    g.fillStyle = 'rgba(255,255,255,.85)'; g.fillText(label, x + 28, 1268); x += g.measureText(label).width + 70;
  }
  return new Promise((res) => c.toBlob((b) => res(b), 'image/png'));
}
const NET_HEX: Record<string, string> = { telegram: '#2a9fd8', signal: '#3a6ff0', whatsapp: '#22a35a', email: '#e0892b', demo: '#a855f7', notes: '#ca8a04' };
const netHex = (k: string) => NET_HEX[k] ?? '#888';
function clip(g: CanvasRenderingContext2D, s: string, w: number) {
  if (g.measureText(s).width <= w) return s;
  while (s.length > 1 && g.measureText(s + '…').width > w) s = s.slice(0, -1);
  return s + '…';
}
function roundRect(g: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  g.beginPath(); g.moveTo(x + r, y); g.arcTo(x + w, y, x + w, y + h, r); g.arcTo(x + w, y + h, x, y + h, r); g.arcTo(x, y + h, x, y, r); g.arcTo(x, y, x + w, y, r); g.closePath();
}
