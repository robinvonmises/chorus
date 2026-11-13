import { useEffect, useMemo, useState } from 'react';
import { api, attachmentUrl, thumbUrl, type LinkPreview, type Attachment, type Chat, type MediaKind, type Message } from '../api';
import { NETWORKS, dayLabel, fileSize, msgTime } from '../util';
import { Icon } from './Icon';
import { AttachmentView, MediaThumb as Thumb, previewOf } from './Message';
import { openLightbox } from './Lightbox';
import { T, lang, locale } from '../i18n';

const TABS: { k: MediaKind; label: string }[] = [
  { k: 'media', label: T('Medien') }, { k: 'files', label: T('Dateien') }, { k: 'links', label: T('Links') }, { k: 'voice', label: T('Sprache') }, { k: 'starred', label: T('Gemerkt') },
];
const MONTH = new Intl.DateTimeFormat(locale, { month: 'long', year: 'numeric' });
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
  const who = (m: Message) => (chatIds?.length === 1 ? (m.fromMe ? T('Du') : m.senderName) : chats.get(m.chatId)?.title ?? '');
  const s = q.trim().toLowerCase();
  const shown = useMemo(() => (items ?? []).filter((m) => !s || [m.text, m.senderName, chats.get(m.chatId)?.title, ...m.attachments.map((a) => a.name)].some((t) => t?.toLowerCase().includes(s))), [items, s, chats]);
  const months = useMemo(() => {
    if (tab !== 'media') return [];
    const out = new Map<string, { m: Message; a: Attachment; i: number }[]>();
    for (const m of shown) m.attachments.forEach((a, i) => {
      if (a.kind !== 'image' && a.kind !== 'video') return;
      const k = MONTH.format(new Date(m.ts));
      if (!out.has(k)) out.set(k, []);
      out.get(k)!.push({ m, a, i });
    });
    return [...out];
  }, [shown, tab]);
  const links = useMemo(() => tab !== 'links' ? [] : shown.flatMap((m) => (m.text.match(URL_RE) ?? []).map((u) => ({ m, u: u.startsWith('http') ? u : 'https://' + u }))), [shown, tab]);

  return (
    <div className="modal-bg" onClick={onClose}>
      <div className="modal wide gallery" onClick={(e) => e.stopPropagation()} role="dialog" aria-label={T('Medien und Dateien')}>
        <header className="modal-head"><h2>{title}</h2><button className="icon-btn" onClick={onClose} aria-label={T('Schließen')}><Icon name="close" /></button></header>
        <div className="gallery-tabs" role="tablist">
          {TABS.map((t) => <button key={t.k} role="tab" aria-selected={tab === t.k} className={tab === t.k ? 'on' : ''} onClick={() => setTab(t.k)}>{t.label}</button>)}
        </div>
        <div className="search gallery-search"><Icon name="search" size={18} /><input placeholder={T("Durchsuchen")} value={q} onChange={(e) => setQ(e.target.value)} />{q && <button className="icon-btn small" onClick={() => setQ('')}><Icon name="close" size={16} /></button>}</div>
        <div className="modal-body gallery-body">
          {!items && <p className="muted center">{T('Lade …')}</p>}
          {items && !shown.length && <p className="muted center">{s ? T('Nichts gefunden.') : T('Hier ist noch nichts.')}</p>}
          {tab === 'media' && (
            months.map(([label, cells]) => (
              <section key={label} className="gallery-month">
                <h3>{label}</h3>
                <div className="gallery-grid">
                  {cells.map(({ m, a, i }) => (
                    <button key={m.id + i} className="gallery-cell" title={`${who(m)} · ${dayLabel(m.ts)}`}
                      onClick={() => a.kind === 'image' ? openLightbox({ src: attachmentUrl(m, i), name: a.name, download: attachmentUrl(m, i, true), ref: { m, i } }) : onOpen(m)}>
                      <Thumb m={m} a={a} i={i} />
                    </button>
                  ))}
                </div>
              </section>
            ))
          )}
          {tab === 'starred' && (
            <ul className="gallery-list">
              {shown.map((m) => (
                <li key={m.id} className="gallery-starred">
                  <button className="gallery-starred-main" onClick={() => onOpen(m)} title={T('Im Chat zeigen')}>
                    <small>{chatIds?.length !== 1 && <span className="dot" style={{ background: NETWORKS[chats.get(m.chatId)?.network ?? 'demo'].color }} />}{chatIds?.length !== 1 ? `${chats.get(m.chatId)?.title ?? ''} · ${m.fromMe ? T('Du') : m.senderName}` : m.fromMe ? T('Du') : m.senderName} · {dayLabel(m.ts)} {msgTime(m.ts)}</small>
                    <span>{previewOf(m)}</span>
                  </button>
                  <button className="icon-btn small" title={T('Nicht mehr merken')} aria-label={T('Nicht mehr merken')}
                    onClick={() => { setItems((x) => x?.filter((y) => y.id !== m.id) ?? x); void api.mark(m.id, { starred: false }).catch(() => {}); }}><Icon name="star" size={18} className="star-on" /></button>
                </li>
              ))}
            </ul>
          )}
          {tab === 'links' && (
            <ul className="gallery-list">
              {links.map(({ m, u }, i) => (
                <li key={m.id + i}>
                  <LinkCard u={u} sub={`${who(m)} · ${dayLabel(m.ts)}`} />
                  <button className="icon-btn small" onClick={() => onOpen(m)} title={T('Im Chat zeigen')}><Icon name="chat" size={18} /></button>
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
                  <button className="icon-btn small" onClick={() => onOpen(m)} title={T('Im Chat zeigen')}><Icon name="chat" size={18} /></button>
                </li>
              ))}
            </ul>
          )}
          {more && items && items.length > 0 && <button className="btn ghost block" onClick={loadMore}>{T('Mehr laden')}</button>}
        </div>
      </div>
    </div>
  );
}


/** Link mit Vorschau (Titel, Bild), geladen über den Server; höchstens vier gleichzeitig */
const previews = new Map<string, Promise<LinkPreview | null>>();
let running = 0; const waiting: (() => void)[] = [];
function loadPreview(u: string): Promise<LinkPreview | null> {
  let p = previews.get(u);
  if (!p) {
    p = new Promise<void>((go) => { if (running < 4) { running++; go(); } else waiting.push(() => { running++; go(); }); })
      .then(() => api.linkPreview(u)).catch(() => null)
      .finally(() => { running--; waiting.shift()?.(); });
    previews.set(u, p);
  }
  return p;
}
function LinkCard({ u, sub }: { u: string; sub: string }) {
  const [p, setP] = useState<LinkPreview | null | undefined>(undefined);
  const [imgOk, setImgOk] = useState(true);
  useEffect(() => { let off = false; void loadPreview(u).then((r) => { if (!off) setP(r); }); return () => { off = true; }; }, [u]);
  let host = u; try { host = new URL(u).hostname.replace(/^www\./, ''); } catch { /* bleibt */ }
  const title = p?.title && p.title !== host ? p.title : null;
  return (
    <a className="gallery-link" href={u} target="_blank" rel="noreferrer noopener">
      {p?.image && imgOk
        ? <img className="link-thumb" src={p.image} alt="" loading="lazy" onError={() => setImgOk(false)} />
        : <span className="link-thumb icon"><Icon name="link" size={18} /></span>}
      <span>
        {title && <b className="link-title">{title}</b>}
        <span className="link-url">{p?.site && p.site !== title ? `${p.site} · ` : ''}{u.replace(/^https?:\/\//, '').slice(0, 80)}</span>
        {p?.description && <span className="link-desc">{p.description}</span>}
        <small>{sub}</small>
      </span>
    </a>
  );
}
