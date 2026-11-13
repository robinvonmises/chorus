import { useEffect, useMemo, useState } from 'react';
import { api, serverText, type Account, type Chat } from '../api';
import { NETWORKS } from '../util';
import { Avatar } from './Rail';
import { Icon } from './Icon';
import { T, lang, locale } from '../i18n';
import { setBroadcast, useBroadcast } from '../broadcastState';

const MAX_BULK = 50;

/** „Neue Nachricht“: Kontakt oder Gruppe suchen oder an eine Nummer schreiben */
export function NewChat({ chats, accounts, onOpen, onClose, onFound }: {
  chats: Chat[]; accounts: Account[]; onOpen: (id: string) => void; onClose: () => void; onFound: (cs: Chat[]) => void;
}) {
  const [q, setQ] = useState('');
  // Massen-Nachricht: mehrere Empfänger auswählen, jeder bekommt die Nachricht einzeln über seinen Messenger
  const [bulk, setBulk] = useState(false);
  const [picked, setPicked] = useState<Chat[]>([]);
  const [text, setText] = useState('');
  const job = useBroadcast();
  useEffect(() => { api.broadcastJob().then(setBroadcast).catch(() => {}); }, []);
  const toggle = (c: Chat) => setPicked((p) => p.some((x) => x.id === c.id) ? p.filter((x) => x.id !== c.id) : p.length >= MAX_BULK ? p : [...p, c]);
  const sendBulk = async () => {
    setBusy(true); setErr('');
    try { setBroadcast(await api.broadcast(picked.map((c) => c.id), text.trim())); setPicked([]); setText(''); }
    catch (e: any) { setErr(serverText(e.message)); }
    finally { setBusy(false); }
  };
  const waSecs = picked.filter((c) => c.network === 'whatsapp').length * 6.5 + picked.filter((c) => c.network !== 'whatsapp').length * 2.5;
  // Kontakte ohne Nachrichten lädt die Chatliste nicht immer mit (Limit), daher zusätzlich auf dem Server suchen
  const [found, setFound] = useState<Chat[]>([]);
  useEffect(() => {
    const s = q.trim();
    if (s.length < 2) { setFound([]); return; }
    let off = false;
    const t = setTimeout(() => { api.searchChats(s).then((cs) => { if (!off) setFound(cs); }).catch(() => {}); }, 200);
    return () => { off = true; clearTimeout(t); };
  }, [q]);
  const phoneAccounts = accounts.filter((a) => (a.network === 'signal' || a.network === 'whatsapp') && a.status.state === 'connected');
  const [acc, setAcc] = useState(phoneAccounts[0]?.id ?? '');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  const list = useMemo(() => {
    const s = q.trim().toLowerCase();
    const known = new Set(chats.map((c) => c.id));
    return [...chats, ...found.filter((c) => !known.has(c.id))]
      .filter((c) => c.network !== 'notes' || !bulk)
      .filter((c) => !s || c.title.toLowerCase().includes(s) || c.remoteId.toLowerCase().includes(s))
      .sort((a, b) => Number(a.kind !== 'direct') - Number(b.kind !== 'direct') || a.title.localeCompare(b.title, locale))
      .slice(0, 300);
  }, [chats, found, q, bulk]);
  const looksLikePhone = /^[+0][\d\s\-/()]{6,}$/.test(q.trim());

  const byPhone = async () => {
    setBusy(true); setErr('');
    try { const c = await api.startChat(acc, q.trim()); onOpen(c.id); onClose(); }
    catch (e: any) { setErr(e.message); }
    finally { setBusy(false); }
  };

  return (
    <div className="modal-bg" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()} role="dialog" aria-label={T('Neue Nachricht')}>
        <header className="modal-head">
          <h2>{bulk ? T('Massen-Nachricht') : T('Neue Nachricht')}</h2>
          <button className={`icon-btn${bulk ? ' on' : ''}`} onClick={() => { setBulk((v) => !v); setErr(''); }} aria-label={T('Massen-Nachricht')} title={T('Eine Nachricht einzeln an mehrere Kontakte')}><Icon name="megaphone" /></button>
          <button className="icon-btn" onClick={onClose} aria-label={T('Schließen')}><Icon name="close" /></button>
        </header>
        <div className="modal-body newchat">
          <div className="search">
            <Icon name="search" size={18} />
            <input autoFocus autoComplete="off" autoCorrect="off" enterKeyHint="search" placeholder={T('Name, Gruppe oder Telefonnummer')} value={q} onChange={(e) => { setQ(e.target.value); setErr(''); }} />
          </div>
          {bulk && (
            <div className="bc-compose">
              {job && (job.running || job.done + job.failed > 0) && (
                <div className="stack">
                  <div className="bc-progress"><i style={{ width: `${((job.done + job.failed) / job.total) * 100}%` }} /></div>
                  <small className="muted">{job.running ? T('Sende {0} von {1}{2} …', job.done + job.failed + 1, job.total, job.current ? ` · ${job.current}` : '') : T('Fertig: {0} gesendet{1}', job.done, job.failed ? T(', {0} fehlgeschlagen', job.failed) : '')}</small>
                </div>
              )}
              {picked.length > 0 && (
                <div className="bc-picked">
                  {picked.map((c) => <button key={c.id} className="bc-chip" onClick={() => toggle(c)}><span className="dot" style={{ background: NETWORKS[c.network].color }} />{c.title}<Icon name="close" size={14} /></button>)}
                </div>
              )}
              <textarea className="input" placeholder={T('Nachricht an alle – {name} wird durch den Vornamen ersetzt')} value={text} onChange={(e) => setText(e.target.value)} />
              <div className="row gap">
                <small className="muted" style={{ flex: 1 }}>{picked.length ? T('{0} Empfänger · jeder bekommt sie einzeln, mit kurzen Pausen (ca. {1} s)', picked.length, Math.round(waSecs)) : T('Wähle unten bis zu {0} Kontakte aus.', MAX_BULK)}</small>
                <button className="btn primary" disabled={busy || !picked.length || !text.trim() || !!job?.running} onClick={sendBulk}>{busy ? <span className="spinner" /> : T('Senden')}</button>
              </div>
              {err && <div className="error">{err}</div>}
            </div>
          )}
          {!bulk && looksLikePhone && (
            <div className="newchat-phone">
              {phoneAccounts.length ? (<>
                <span>{T('An')}{' '}<b>{q.trim()}</b> {T('schreiben über')}</span>
                <div className="row gap">
                  {phoneAccounts.length > 1 ? (
                    <select className="input" value={acc} onChange={(e) => setAcc(e.target.value)}>
                      {phoneAccounts.map((a) => <option key={a.id} value={a.id}>{NETWORKS[a.network].name}{a.label !== NETWORKS[a.network].name ? ` (${a.label})` : ''}</option>)}
                    </select>
                  ) : <span className="pill on">{NETWORKS[phoneAccounts[0].network].name}</span>}
                  <button className="btn primary" disabled={busy} onClick={byPhone}>{busy ? <span className="spinner" /> : T('Chat öffnen')}</button>
                </div>
              </>) : <span className="muted">{T('Über die Nummer geht es bei Signal und WhatsApp. Verbinde zuerst einen der beiden.')}</span>}
              {err && <div className="error">{err}</div>}
            </div>
          )}
          <ul className="chats">
            {list.map((c) => (
              <li key={c.id}>
                <button className={`chat-item${bulk && picked.some((x) => x.id === c.id) ? ' picked' : ''}`} onClick={() => { if (bulk) return toggle(c); onFound([c]); onOpen(c.id); onClose(); }}>
                  <Avatar name={c.title} src={c.avatar} />
                  <span className="chat-main">
                    <span className="chat-top"><span className="chat-title">{c.title}</span></span>
                    <span className="chat-bottom"><span className="chat-preview">{c.kind === 'group' ? T('Gruppe') : c.kind === 'channel' ? T('Kanal') : T('Kontakt')} · {NETWORKS[c.network].name}</span></span>
                  </span>
                  {bulk && picked.some((x) => x.id === c.id) && <Icon name="check" className="bc-tick" />}
                </button>
              </li>
            ))}
            {!list.length && !looksLikePhone && <li className="list-empty">{T('Nichts gefunden. Du kannst auch eine Telefonnummer eingeben.')}</li>}
          </ul>
        </div>
      </div>
    </div>
  );
}
