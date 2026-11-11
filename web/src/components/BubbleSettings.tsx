import { useState } from 'react';
import type { Network } from '../api';
import { NETWORKS } from '../util';
import { sendAnimEnabled, setSendAnim } from '../sendAnim';
import { BUBBLE_DEFAULTS, BUBBLE_PALETTE, loadBubbles, saveBubbles, type BubbleSettings } from '../bubbles';

/** Einstellungen → Darstellung: Farbe der eigenen Sprechblasen */
export function BubbleSection({ nets }: { nets: Network[] }) {
  const [b, setB] = useState<BubbleSettings>(loadBubbles);
  const set = (n: BubbleSettings) => { setB(n); saveBubbles(n); };
  const [anim, setAnim] = useState(sendAnimEnabled);
  const list: Network[] = nets.length ? nets : ['signal', 'whatsapp', 'telegram'];
  return (
    <section className="set-section">
      <h3>Darstellung</h3>
      <label className="toggle">
        <input type="checkbox" checked={b.mode === 'network'} onChange={(e) => set({ ...b, mode: e.target.checked ? 'network' : 'single' })} />
        <span><b>Sprechblasen in Messenger-Farben</b><small>Deine Nachrichten bekommen die Farbe des jeweiligen Messengers. Aus: überall Chorus-Lila.</small></span>
      </label>
      {b.mode === 'network' && (
        <div className="bubble-set">
          {list.map((n) => (
            <div key={n} className="bubble-row">
              <b>{NETWORKS[n].name}</b>
              <div className="swatches">
                {BUBBLE_PALETTE.map((c) => (
                  <button key={c} className={`swatch ${b.colors[n] === c ? 'on' : ''}`} style={{ background: c }} aria-label={c}
                    onClick={() => set({ ...b, colors: { ...b.colors, [n]: c } })} />
                ))}
              </div>
              <span className="bubble-preview" style={{ background: `var(--bubble-${n})`, color: `var(--bubble-${n}-ink)` }}>Hallo!</span>
            </div>
          ))}
          <button className="link" style={{ justifySelf: 'start' }} onClick={() => set({ ...b, colors: BUBBLE_DEFAULTS.colors })}>Standardfarben</button>
        </div>
      )}
      <label className="toggle">
        <input type="checkbox" checked={anim} onChange={(e) => { setAnim(e.target.checked); setSendAnim(e.target.checked); }} />
        <span><b>Sende-Animation</b><small>Gesendete Nachrichten steigen aus dem Eingabefeld in den Chat.</small></span>
      </label>
    </section>
  );
}
