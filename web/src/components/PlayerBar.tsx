import { player, usePlayer } from '../player';
import { duration } from '../util';
import { Icon } from './Icon';
import { T } from '../i18n';

/** Leiste oben, solange eine Sprachnachricht läuft (auch in anderen Chats) */
export function PlayerBar({ chatTitle, onOpen }: { chatTitle: (id: string) => string; onOpen: (chatId: string) => void }) {
  const p = usePlayer();
  if (!p.track) return null;
  const t = p.track;
  return (
    <div className="player-bar" role="region" aria-label={T('Sprachnachricht')}>
      <button className="icon-btn small player-toggle" onClick={() => player.toggle()} aria-label={p.playing ? T('Pause') : T('Abspielen')}><Icon name={p.playing ? 'pause' : 'play'} size={18} /></button>
      <button className="player-info" onClick={() => onOpen(t.chatId)} title={T('Zum Chat')}>
        <b>{t.sender}</b><span>{chatTitle(t.chatId)}</span>
      </button>
      <div className="player-track" onClick={(e) => { const r = e.currentTarget.getBoundingClientRect(); if (p.total) player.seek(((e.clientX - r.left) / r.width) * p.total); }}>
        <div style={{ width: p.total ? `${(p.pos / p.total) * 100}%` : '0%' }} />
      </div>
      <span className="player-time">{duration(p.pos)}{p.total ? ` / ${duration(p.total)}` : ''}</span>
      <button className="player-rate" onClick={() => player.cycleRate()}>{p.rate}×</button>
      <button className="icon-btn small" onClick={() => player.close()} aria-label={T('Wiedergabe beenden')}><Icon name="close" size={16} /></button>
    </div>
  );
}
