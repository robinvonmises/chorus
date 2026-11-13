import { useRef, useState } from 'react';
import type { Network } from '../api';
import { NETWORKS } from '../util';
import { sendAnimEnabled, setSendAnim } from '../sendAnim';
import { FX, fxOn, setFx } from '../effects';
import {
  ACCENTS, BUBBLE_DEFAULTS, BUBBLE_PALETTE, bubbleHex, loadAccent, saveAccent, CHAT_BACKGROUNDS, chatBgCss, customBgImage, ink, loadBubbles, loadChatBg, saveBubbles, saveChatBg, setCustomBg,
  BUBBLE_SHAPES, loadShape, saveShape, type BubbleSettings,
} from '../bubbles';
import { haptic, hapticsOn, setHaptics } from '../haptics';
import { Icon } from './Icon';
import { T } from '../i18n';

/** Eine Farbzeile: Tippen klappt die Auswahl auf (Palette + eigene Farbe) */
function ColorRow({ label, color, open, onToggle, onPick, auto }: { label: string; color: string; open: boolean; onToggle: () => void; onPick: (c: string) => void; auto?: boolean }) {
  const isAuto = color === 'accent';
  const custom = !isAuto && !BUBBLE_PALETTE.includes(color);
  const hex = bubbleHex(color);
  return (
    <div className={`color-row${open ? ' open' : ''}`}>
      <button className="ios-row" onClick={onToggle} aria-expanded={open}>
        <span className="ios-row-main">
          <span className="ios-row-text"><span className="ios-title">{label}</span>{isAuto && <small>{T('Wie die App-Farbe')}</small>}</span>
          <span className="color-dot" style={{ background: hex }} />
          <Icon name="chevron" size={18} />
        </span>
      </button>
      {open && (
        <div className="swatches pick">
          {auto && <button className={`swatch auto ${isAuto ? 'on' : ''}`} style={{ background: 'var(--brand)' }} aria-label={T('Wie die App-Farbe')} title={T('Wie die App-Farbe')} onClick={() => onPick('accent')}><Icon name="sparkle" size={14} /></button>}
          {BUBBLE_PALETTE.map((c) => (
            <button key={c} className={`swatch ${color === c ? 'on' : ''}`} style={{ background: c }} aria-label={c} onClick={() => onPick(c)} />
          ))}
          <label className={`swatch custom ${custom ? 'on' : ''}`} style={custom ? { background: color } : undefined} title={T('Eigene Farbe')}>
            {!custom && <Icon name="plus" size={14} />}
            <input type="color" value={hex} onChange={(e) => onPick(e.target.value)} />
          </label>
        </div>
      )}
    </div>
  );
}

/** Einstellungen → Darstellung: Sprechblasen, Chat-Hintergrund, Animation */
export function BubbleSection({ nets }: { nets: Network[] }) {
  const [b, setB] = useState<BubbleSettings>(loadBubbles);
  const set = (n: BubbleSettings) => { setB(n); saveBubbles(n); };
  const [open, setOpen] = useState<string | null>(null);
  const [bg, setBg] = useState(loadChatBg);
  const [hasImg, setHasImg] = useState(() => !!customBgImage());
  const [err, setErr] = useState('');
  const file = useRef<HTMLInputElement>(null);
  const [anim, setAnim] = useState(sendAnimEnabled);
  const [shape, setShape] = useState(loadShape);
  const [hap, setHap] = useState(hapticsOn);
  const list: Network[] = nets.length ? nets : ['signal', 'whatsapp', 'telegram'];
  const pickBg = (id: string) => { setBg(id); saveChatBg(id); };
  const previewNet = list[0];
  const [accent, setAccent] = useState(loadAccent);
  const outColor = b.mode === 'network' ? b.colors[previewNet] : bubbleHex(b.single);

  return (<>
    <div className="look-preview" style={{ background: chatBgCss(bg) || undefined }}>
      <span className="day"><span>{T('Heute')}</span></span>
      <span className="pv in">{T('Hast du heute Abend Zeit? 🍕')}</span>
      <span className="pv out" style={{ background: outColor, color: ink(outColor) }}>{T('Klar, um acht bei dir?')}</span>
    </div>

    <p className="ios-caption">{T('App-Farbe')}</p>
    <div className="ios-card pad">
      <div className="accent-grid">
        {ACCENTS.map((a) => (
          <button key={a.id} className={`accent-tile${accent.id === a.id ? ' on' : ''}`} onClick={() => { saveAccent(a.id); setAccent(a); }} aria-pressed={accent.id === a.id}>
            <span style={{ background: `linear-gradient(135deg, ${a.dark}, ${a.brand})` }}>{accent.id === a.id && <Icon name="check" size={16} />}</span><small>{a.name}</small>
          </button>
        ))}
      </div>
      <small className="muted">{T('Für Knöpfe, Markierungen und deine Sprechblasen. Gilt für dieses Gerät.')}</small>
    </div>

    <p className="ios-caption">{T('Meine Sprechblasen')}</p>
    <div className="ios-card">
      <label className="ios-row toggle-row">
        <span className="ios-row-main">
          <span className="ios-row-text"><span className="ios-title">{T('Farbe je Messenger')}</span><small>{b.mode === 'network' ? T('Jeder Dienst eigene Farbe') : T('Überall dieselbe Farbe')}</small></span>
          <input type="checkbox" className="switch" checked={b.mode === 'network'} onChange={(e) => set({ ...b, mode: e.target.checked ? 'network' : 'single' })} />
        </span>
      </label>
      {b.mode === 'network'
        ? list.map((n) => <ColorRow key={n} label={NETWORKS[n].name} color={b.colors[n]} open={open === n} onToggle={() => setOpen(open === n ? null : n)} onPick={(c) => set({ ...b, colors: { ...b.colors, [n]: c } })} />)
        : <ColorRow auto label={T('Alle Chats')} color={b.single} open={open === 'single'} onToggle={() => setOpen(open === 'single' ? null : 'single')} onPick={(c) => set({ ...b, single: c })} />}
    </div>
    <p className="ios-foot"><button className="link-btn" onClick={() => set({ ...b, colors: BUBBLE_DEFAULTS.colors, single: BUBBLE_DEFAULTS.single })}>{T('Standardfarben')}</button> {T('· Helle Farben bekommen automatisch dunkle Schrift.')}</p>

    <p className="ios-caption">{T('Blasen-Stil')}</p>
    <div className="ios-card pad">
      <div className="shape-grid">
        {BUBBLE_SHAPES.map((x) => (
          <button key={x.id} className={`shape-tile ${x.id}${shape === x.id ? ' on' : ''}`} onClick={() => { saveShape(x.id); setShape(x.id); }} aria-pressed={shape === x.id} title={x.hint}>
            <i className="a" /><i className="b" /><span>{x.name}</span>
          </button>
        ))}
      </div>
      <small className="muted">{BUBBLE_SHAPES.find((x) => x.id === shape)?.hint}</small>
    </div>

    <p className="ios-caption">{T('Chat-Hintergrund')}</p>
    <div className="ios-card pad">
      <div className="bg-grid">
        {CHAT_BACKGROUNDS.map((x) => (
          <button key={x.id} className={`bg-tile${bg === x.id ? ' on' : ''}`} onClick={() => pickBg(x.id)} aria-label={x.name}>
            <span style={{ background: x.css || 'var(--bg)' }}>{x.id === 'none' && <Icon name="close" size={16} />}</span><small>{x.name}</small>
          </button>
        ))}
        <button className={`bg-tile${bg === 'custom' ? ' on' : ''}`} onClick={() => (hasImg && bg !== 'custom' ? pickBg('custom') : file.current?.click())}>
          <span style={hasImg ? { background: chatBgCss('custom') } : undefined}>{!hasImg && <Icon name="photos" size={18} />}</span><small>{T('Eigenes Bild')}</small>
        </button>
      </div>
      <input ref={file} type="file" accept="image/*" hidden onChange={async (e) => {
        const f = e.target.files?.[0]; e.target.value = ''; if (!f) return;
        setErr(''); try { await setCustomBg(f); setHasImg(true); setBg('custom'); } catch (x: any) { setErr(x.message); }
      }} />
      {hasImg && <button className="link-btn" style={{ justifySelf: 'start' }} onClick={() => file.current?.click()}>{T('Anderes Bild wählen …')}</button>}
      {err && <small style={{ color: "var(--danger)" }}>{err}</small>}
      <small className="muted">{T('Der Hintergrund gilt für dieses Gerät.')}</small>
    </div>

    <p className="ios-caption">{T('Bewegung')}</p>
    <div className="ios-card">
      <label className="ios-row toggle-row">
        <span className="ios-row-main">
          <span className="ios-row-text"><span className="ios-title">{T('Sende-Animation')}</span><small>{T('Gesendete Nachrichten steigen aus dem Eingabefeld')}</small></span>
          <input type="checkbox" className="switch" checked={anim} onChange={(e) => { setAnim(e.target.checked); setSendAnim(e.target.checked); }} />
        </span>
      </label>
      <label className="ios-row toggle-row">
        <span className="ios-row-main">
          <span className="ios-row-text"><span className="ios-title">{T('Haptik')}</span><small>{T('Leichtes Vibrieren beim Reagieren und Wischen (iPhone ab iOS 18)')}</small></span>
          <input type="checkbox" className="switch" checked={hap} onChange={(e) => { setHap(e.target.checked); setHaptics(e.target.checked); if (e.target.checked) haptic(); }} />
        </span>
      </label>
    </div>
    <p className="ios-foot">{T('Ein eigenes Design für einzelne Chats gibt es im Chat-Menü unter „Chat-Design“.')}</p>

    <p className="ios-caption">{T('Effekte')}</p>
    <div className="ios-card">
      {FX.map((f) => <FxRow key={f.id} id={f.id} title={f.title} hint={f.hint} />)}
    </div>
    <p className="ios-foot">{T('Zum Ausprobieren. Bei „Bewegung reduzieren“ in den Systemeinstellungen laufen keine Animationen.')}</p>
  </>);
}

function FxRow({ id, title, hint }: { id: (typeof FX)[number]['id']; title: string; hint: string }) {
  const [on, setOn] = useState(() => fxOn(id));
  return (
    <label className="ios-row toggle-row">
      <span className="ios-row-main">
        <span className="ios-row-text"><span className="ios-title">{T(title)}</span><small>{T(hint)}</small></span>
        <input type="checkbox" className="switch" checked={on} onChange={(e) => { setOn(e.target.checked); setFx(id, e.target.checked); }} />
      </span>
    </label>
  );
}
