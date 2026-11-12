import type { Account, Chat } from '../api';
import type { Filter } from '../App';
import { NETWORKS, initials, hue } from '../util';
import { Icon } from './Icon';
import { T } from '../i18n';

/** Schmale Leiste links (nur Desktop): Filter nach Messenger, Einstellungen */
export function Rail({ filter, setFilter, accounts, chats, onSettings }: {
  filter: Filter; setFilter: (f: Filter) => void; accounts: Account[]; chats: Chat[]; onSettings: () => void;
}) {
  const nets = [...new Set(accounts.map((a) => a.network))];
  const unread = (f: 'all' | Chat['network']) => chats.filter((c) => !c.muted && !c.archived && (f === 'all' || c.network === f)).reduce((n, c) => n + c.unread, 0);
  const only = (n: Chat['network'] | null) => setFilter({ ...filter, archived: false, nets: n ? [n] : [] });
  const isAll = !filter.nets.length;
  return (
    <nav className="rail" aria-label={T('Messenger')}>
      <button className={`rail-btn ${isAll ? 'on' : ''}`} onClick={() => only(null)} title={T('Alle Chats')}>
        <Icon name="inbox" />
        {unread('all') > 0 && <span className="rail-badge">{unread('all') > 99 ? '99+' : unread('all')}</span>}
      </button>
      {nets.map((n) => {
        const a = accounts.find((x) => x.network === n)!;
        const bad = a.status.state !== 'connected' && a.status.state !== 'connecting';
        return (
          <button key={n} className={`rail-btn net ${filter.nets.includes(n) ? 'on' : ''}`} onClick={() => setFilter({ ...filter, archived: false, nets: filter.nets.includes(n) ? filter.nets.filter((x) => x !== n) : [...filter.nets, n] })} title={NETWORKS[n].name}>
            <span className="net-chip" style={{ background: NETWORKS[n].color }}>{NETWORKS[n].short}</span>
            {bad && <span className="rail-warn" title={T('Verbindung prüfen')}>!</span>}
            {!bad && unread(n) > 0 && <span className="rail-badge">{unread(n)}</span>}
          </button>
        );
      })}
      <div className="rail-spacer" />
      <button className="rail-btn" onClick={onSettings} title={T('Einstellungen')}><Icon name="settings" /></button>
    </nav>
  );
}

export function Avatar({ name, network, size = 48, src }: { name: string; network?: Chat['network']; size?: number; src?: string | null }) {
  const h = hue(name);
  return (
    <span className="avatar" style={{ width: size, height: size, fontSize: size * 0.38, background: `hsl(${h} 55% 88%)`, color: `hsl(${h} 45% 30%)` }}>
      {src ? <img className="avatar-img" src={src} alt="" /> : initials(name)}
      {network && <span className="avatar-net" style={{ background: NETWORKS[network].color }} title={NETWORKS[network].name} />}
    </span>
  );
}
