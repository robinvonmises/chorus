import { useEffect, useMemo, useState } from 'react';
import { api, type Chat, type Message } from '../api';
import { NETWORKS } from '../util';
import { Icon } from './Icon';
import { previewOf } from './Message';
import { T } from '../i18n';

/** Nachricht weiterleiten: einen oder mehrere Zielchats wählen, auch bei anderen Messengern */
export function ForwardSheet({ message, onClose, onDone }: { message: Message; onClose: () => void; onDone: (t: string) => void }) {
  const [all, setAll] = useState<Chat[] | null>(null);
  const [q, setQ] = useState('');
  const [sel, setSel] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  useEffect(() => { api.chats().then(setAll).catch((e: any) => setErr(e.message ?? T('Fehler'))); }, []);
  const s = q.trim().toLowerCase();
  const list = useMemo(() => (all ?? [])
    .filter((c) => c.kind !== 'channel' && (!s || name(c).toLowerCase().includes(s) || (c.info?.phone ?? '').replace(/\s/g, '').includes(s.replace(/\s/g, ''))))
    .sort((a, b) => Number(!!a.archived) - Number(!!b.archived) || b.lastTs - a.lastTs)
    .slice(0, 60), [all, s]);
  const toggle = (id: string) => setSel((x) => (x.includes(id) ? x.filter((y) => y !== id) : x.length >= 20 ? x : [...x, id]));
  const send = async () => {
    if (!sel.length || busy) return;
    setBusy(true); setErr('');
    try { await api.forward(message.id, sel); onDone(sel.length === 1 ? 'Weitergeleitet' : T('An {0} Chats weitergeleitet', sel.length)); }
    catch (e: any) { setErr(e.message ?? T('Fehler')); setBusy(false); }
  };
  return (
    <div className="modal-bg" onClick={onClose}>
      <div className="modal fwd-sheet" onClick={(e) => e.stopPropagation()} role="dialog" aria-label={T('Weiterleiten')}>
        <header className="modal-head"><h2>{T('Weiterleiten')}</h2><button className="icon-btn" onClick={onClose} aria-label={T('Schließen')}><Icon name="close" /></button></header>
        <div className="modal-body">
          <p className="fwd-preview">{previewOf(message).slice(0, 140) || T('Anhang')}</p>
          <input className="input" placeholder={T('Chat suchen')} value={q} onChange={(e) => setQ(e.target.value)} />
          <ul className="fwd-list">
            {list.map((c) => {
              const on = sel.includes(c.id);
              return (
                <li key={c.id}><label className={on ? 'on' : ''}>
                  <input type="checkbox" checked={on} onChange={() => toggle(c.id)} />
                  <span className="dot" style={{ background: NETWORKS[c.network].color }} />
                  <b>{name(c)}</b><small>{NETWORKS[c.network].name}{c.kind === 'group' ? T(' · Gruppe') : ''}</small>
                </label></li>
              );
            })}
            {all && !list.length && <li className="muted small">{T('Kein passender Chat.')}</li>}
            {!all && !err && <li className="muted small">{T('Lädt …')}</li>}
          </ul>
          {err && <p className="muted small">{err}</p>}
          <button className="btn primary" disabled={!sel.length || busy} onClick={send}>
            <Icon name="forward" size={18} />{busy ? T('Wird gesendet …') : sel.length > 1 ? T('An {0} Chats senden', sel.length) : T('Senden')}
          </button>
        </div>
      </div>
    </div>
  );
}

const name = (c: Chat) => c.alias || (c.peer ? `${c.peer.name} · ${c.title}` : c.title);
