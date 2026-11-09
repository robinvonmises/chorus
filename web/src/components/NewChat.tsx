import { useMemo, useState } from 'react';
import { api, type Account, type Chat } from '../api';
import { NETWORKS } from '../util';
import { Avatar } from './Rail';
import { Icon } from './Icon';

/** „Neue Nachricht“: Kontakt oder Gruppe suchen oder an eine Nummer schreiben */
export function NewChat({ chats, accounts, onOpen, onClose }: {
  chats: Chat[]; accounts: Account[]; onOpen: (id: string) => void; onClose: () => void;
}) {
  const [q, setQ] = useState('');
  const phoneAccounts = accounts.filter((a) => (a.network === 'signal' || a.network === 'whatsapp') && a.status.state === 'connected');
  const [acc, setAcc] = useState(phoneAccounts[0]?.id ?? '');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  const list = useMemo(() => {
    const s = q.trim().toLowerCase();
    return [...chats]
      .filter((c) => !s || c.title.toLowerCase().includes(s) || c.remoteId.toLowerCase().includes(s))
      .sort((a, b) => Number(a.kind !== 'direct') - Number(b.kind !== 'direct') || a.title.localeCompare(b.title, 'de'))
      .slice(0, 300);
  }, [chats, q]);
  const looksLikePhone = /^[+0][\d\s\-/()]{6,}$/.test(q.trim());

  const byPhone = async () => {
    setBusy(true); setErr('');
    try { const c = await api.startChat(acc, q.trim()); onOpen(c.id); onClose(); }
    catch (e: any) { setErr(e.message); }
    finally { setBusy(false); }
  };

  return (
    <div className="modal-bg" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()} role="dialog" aria-label="Neue Nachricht">
        <header className="modal-head">
          <h2>Neue Nachricht</h2>
          <button className="icon-btn" onClick={onClose} aria-label="Schließen"><Icon name="close" /></button>
        </header>
        <div className="modal-body newchat">
          <div className="search">
            <Icon name="search" size={18} />
            <input autoFocus placeholder="Name, Gruppe oder Telefonnummer" value={q} onChange={(e) => { setQ(e.target.value); setErr(''); }} />
          </div>
          {looksLikePhone && (
            <div className="newchat-phone">
              {phoneAccounts.length ? (<>
                <span>An <b>{q.trim()}</b> schreiben über</span>
                <div className="row gap">
                  {phoneAccounts.length > 1 ? (
                    <select className="input" value={acc} onChange={(e) => setAcc(e.target.value)}>
                      {phoneAccounts.map((a) => <option key={a.id} value={a.id}>{NETWORKS[a.network].name}{a.label !== NETWORKS[a.network].name ? ` (${a.label})` : ''}</option>)}
                    </select>
                  ) : <span className="pill on">{NETWORKS[phoneAccounts[0].network].name}</span>}
                  <button className="btn primary" disabled={busy} onClick={byPhone}>{busy ? <span className="spinner" /> : 'Chat öffnen'}</button>
                </div>
              </>) : <span className="muted">Über die Nummer geht es bei Signal und WhatsApp. Verbinde zuerst einen der beiden.</span>}
              {err && <div className="error">{err}</div>}
            </div>
          )}
          <ul className="chats">
            {list.map((c) => (
              <li key={c.id}>
                <button className="chat-item" onClick={() => { onOpen(c.id); onClose(); }}>
                  <Avatar name={c.title} src={c.avatar} />
                  <span className="chat-main">
                    <span className="chat-top"><span className="chat-title">{c.title}</span></span>
                    <span className="chat-bottom"><span className="chat-preview">{c.kind === 'group' ? 'Gruppe' : c.kind === 'channel' ? 'Kanal' : 'Kontakt'} · {NETWORKS[c.network].name}</span></span>
                  </span>
                </button>
              </li>
            ))}
            {!list.length && !looksLikePhone && <li className="list-empty">Nichts gefunden. Du kannst auch eine Telefonnummer eingeben.</li>}
          </ul>
        </div>
      </div>
    </div>
  );
}
