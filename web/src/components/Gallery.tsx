import { useEffect, useMemo, useState } from 'react';
import { api, attachmentUrl, thumbUrl, type Chat, type MediaKind, type Message } from '../api';
import { NETWORKS, dayLabel, fileSize, msgTime } from '../util';
import { Icon } from './Icon';
import { AttachmentView } from './Message';
import { openLightbox } from './Lightbox';

const TABS: { k: MediaKind; label: string }[] = [
  { k: 'media', label: 'Medien' }, { k: 'files', label: 'Dateien' }, { k: 'links', label: 'Links' }, { k: 'voice', label: 'Sprache' },
];
const URL_RE = /(https?:\/\/[^\s<]+[^\s<.,;:!?)\]'"]|www\.[^\s<]+[^\s<.,;:!?)\]'"])/g;

/** Medien, Dateien, Links und Sprachnachrichten eines Chats (oder aller Chats) */
export function Gallery({ chatIds, title, chats, onClose, onOpen }: {
  chatIds?: string[]; title: string; chats: Map<string, Chat>; onClose: () => void; onOpen: (m: Message) => void;
}) {
  const [tab, setTab] = useState<MediaKind>('media');
  const [items, setItems] = useState<Message[] | null>(null);
  const [more, setMore] = useState(true);
  const [q, setQ] = useState('');
  useEffect(() => {
    let off = false;
    setItems(null); setMore(true);
    api.gallery(tab, chatIds).then((r) => { if (!off) { setItems(r); setMore(r.length >= 120); } }).catch(() => !off && setItems([]));
    return () => { off = true; };
  }, [tab, chatIds?.join(',')]); // eslint-disable-line react-hooks/exhaustive-deps
  const loadMore = async () => {
    const last = items?.at(-1); if (!last) return;
    const r = await api.gallery(tab, chatIds, last.ts).catch(() => []);
    setItems((x) => [...(x ?? []), ...r]); setMore(r.length >= 120);
  };
  const who = (m: Message) => (chatIds?.length === 1 ? (m.fromMe ? 'Du' : m.senderName) : chats.get(m.chatId)?.title ?? '');
  const s = q.trim().toLowerCase();
  const shown = useMemo(() => (items ?? []).filter((m) => !s || [m.text, m.senderName, chats.get(m.chatId)?.title, ...m.attachments.map((a) => a.name)].some((t) => t?.toLowerCase().includes(s))), [items, s, chats]);
  const links = useMemo(() => tab !== 'links' ? [] : shown.flatMap((m) => (m.text.match(URL_RE) ?? []).map((u) => ({ m, u: u.startsWith('http') ? u : 'https://' + u }))), [shown, tab]);

  return (
    <div className="modal-bg" onClick={onClose}>
      <div className="modal wide gallery" onClick={(e) => e.stopPropagation()} role="dialog" aria-label="Medien und Dateien">
        <header className="modal-head"><h2>{title}</h2><button className="icon-btn" onClick={onClose} aria-label="Schließen"><Icon name="close" /></button></header>
        <div className="gallery-tabs" role="tablist">
          {TABS.map((t) => <button key={t.k} role="tab" aria-selected={tab === t.k} className={tab === t.k ? 'on' : ''} onClick={() => setTab(t.k)}>{t.label}</button>)}
        </div>
        <div className="search gallery-search"><Icon name="search" size={18} /><input placeholder="Durchsuchen" value={q} onChange={(e) => setQ(e.target.value)} />{q && <button className="icon-btn small" onClick={() => setQ('')}><Icon name="close" size={16} /></button>}</div>
        <div className="modal-body gallery-body">
          {!items && <p className="muted center">Lade …</p>}
          {items && !shown.length && <p className="muted center">{s ? 'Nichts gefunden.' : 'Hier ist noch nichts.'}</p>}
          {tab === 'media' && (
            <div className="gallery-grid">
              {shown.flatMap((m) => m.attachments.map((a, i) => ({ m, a, i })).filter(({ a }) => a.kind === 'image' || a.kind === 'video')).map(({ m, a, i }) => (
                <button key={m.id + i} className="gallery-cell" title={`${who(m)} · ${dayLabel(m.ts)}`}
                  onClick={() => a.kind === 'image' ? openLightbox({ src: attachmentUrl(m, i), name: a.name, download: attachmentUrl(m, i, true) }) : onOpen(m)}>
                  {a.kind === 'video'
                    ? <><img src={`${attachmentUrl(m, i)}&thumb=1`} alt="" loading="lazy" decoding="async" /><span className="gallery-play"><Icon name="play" size={18} /></span></>
                    : <img src={thumbUrl(m, i)} alt="" loading="lazy" decoding="async" />}
                </button>
              ))}
            </div>
          )}
          {tab === 'links' && (
            <ul className="gallery-list">
              {links.map(({ m, u }, i) => (
                <li key={m.id + i}>
                  <a className="gallery-link" href={u} target="_blank" rel="noreferrer noopener"><Icon name="link" size={18} /><span><b>{u.replace(/^https?:\/\//, '').slice(0, 80)}</b><small>{who(m)} · {dayLabel(m.ts)}</small></span></a>
                  <button className="icon-btn small" onClick={() => onOpen(m)} title="Im Chat zeigen"><Icon name="chat" size={18} /></button>
                </li>
              ))}
            </ul>
          )}
          {(tab === 'files' || tab === 'voice') && (
            <ul className="gallery-list">
              {shown.map((m) => (
                <li key={m.id} className="gallery-file">
                  <div className="gallery-file-main">
                    {m.attachments.map((a, i) => (tab === 'voice' ? a.kind === 'voice' : a.kind === 'file' || a.kind === 'audio') && <AttachmentView key={i} m={m} a={a} i={i} />)}
                    <small className="muted">{chatIds?.length !== 1 && <span className="dot" style={{ background: NETWORKS[chats.get(m.chatId)?.network ?? 'demo'].color }} />}{who(m)} · {dayLabel(m.ts)} {msgTime(m.ts)}{m.attachments[0] && tab === 'files' ? ` · ${fileSize(m.attachments[0].size)}` : ''}</small>
                  </div>
                  <button className="icon-btn small" onClick={() => onOpen(m)} title="Im Chat zeigen"><Icon name="chat" size={18} /></button>
                </li>
              ))}
            </ul>
          )}
          {more && items && items.length > 0 && <button className="btn ghost block" onClick={loadMore}>Mehr laden</button>}
        </div>
      </div>
    </div>
  );
}
