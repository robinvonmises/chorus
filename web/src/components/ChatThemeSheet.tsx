import { useState } from 'react';
import type { Chat } from '../api';
import { BUBBLE_PALETTE, CHAT_BACKGROUNDS, chatBgCss, ink, loadBubbles, bubbleHex, loadChatTheme, saveChatTheme, type ChatTheme } from '../bubbles';
import { Icon } from './Icon';
import { T } from '../i18n';

/** Chat-Design für einen Chat: eigene Farbe der eigenen Blasen und eigener Hintergrund. „Wie überall“ = Darstellung. */
export function ChatThemeSheet({ chat, onClose }: { chat: Chat; onClose: () => void }) {
  const [th, setTh] = useState<ChatTheme>(() => loadChatTheme(chat.id));
  const set = (n: ChatTheme) => { setTh(n); saveChatTheme(chat.id, n); };
  const g = loadBubbles();
  const globalColor = g.mode === 'network' ? g.colors[chat.network] : bubbleHex(g.single);
  const color = th.color ?? globalColor;
  const bgCss = th.bg ? (CHAT_BACKGROUNDS.find((b) => b.id === th.bg)?.css || 'var(--bg)') : chatBgCss() || undefined;
  const custom = !!th.color && !BUBBLE_PALETTE.includes(th.color);

  return (
    <div className="modal-bg" onClick={onClose}>
      <div className="modal theme-sheet" onClick={(e) => e.stopPropagation()} role="dialog" aria-label={T('Chat-Design')}>
        <header className="modal-head"><h2>{T('Chat-Design')}</h2><button className="icon-btn" onClick={onClose} aria-label={T('Schließen')}><Icon name="close" /></button></header>
        <div className="modal-body">
          <div className="look-preview" style={{ background: bgCss }}>
            <span className="pv in">{T('Hast du heute Abend Zeit? 🍕')}</span>
            <span className="pv out" style={{ background: color, color: ink(color) }}>{T('Klar, um acht bei dir?')}</span>
          </div>

          <h4>{T('Meine Sprechblasen')}</h4>
          <div className="swatches pick" style={{ padding: 0 }}>
            <button className={`swatch auto ${!th.color ? 'on' : ''}`} style={{ background: globalColor }} title={T('Wie überall')} aria-label={T('Wie überall')} onClick={() => set({ ...th, color: undefined })}><Icon name="sparkle" size={14} /></button>
            {BUBBLE_PALETTE.map((c) => <button key={c} className={`swatch ${th.color === c ? 'on' : ''}`} style={{ background: c }} aria-label={c} onClick={() => set({ ...th, color: c })} />)}
            <label className={`swatch custom ${custom ? 'on' : ''}`} style={custom ? { background: th.color } : undefined} title={T('Eigene Farbe')}>
              {!custom && <Icon name="plus" size={14} />}
              <input type="color" value={color} onChange={(e) => set({ ...th, color: e.target.value })} />
            </label>
          </div>

          <h4>{T('Hintergrund')}</h4>
          <div className="bg-grid">
            <button className={`bg-tile${!th.bg ? ' on' : ''}`} onClick={() => set({ ...th, bg: undefined })}>
              <span style={{ background: chatBgCss() || 'var(--bg)' }}><Icon name="sparkle" size={16} /></span><small>{T('Wie überall')}</small>
            </button>
            {CHAT_BACKGROUNDS.map((x) => (
              <button key={x.id} className={`bg-tile${th.bg === x.id ? ' on' : ''}`} onClick={() => set({ ...th, bg: x.id })} aria-label={x.name}>
                <span style={{ background: x.css || 'var(--bg)' }}>{x.id === 'none' && <Icon name="close" size={16} />}</span><small>{x.name}</small>
              </button>
            ))}
          </div>
          <p className="muted small">{T('Gilt nur für diesen Chat und dieses Gerät. „Wie überall“ nimmt die Einstellungen aus Darstellung.')}</p>
        </div>
      </div>
    </div>
  );
}
