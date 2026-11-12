import { useEffect, useRef, useState } from 'react';
import { api, type Account, type Chat } from '../api';
import { NETWORKS } from '../util';
import { Avatar } from './Rail';
import { Icon } from './Icon';
import { squareJpeg } from './MyProfile';
import { openLightbox } from './Lightbox';
import { T } from '../i18n';

/** Profil eines Kontakts oder einer Gruppe: eigener Name, Bild, Nummer, Status, Notiz */
export function ContactSheet({ chat, account, onClose, onChat }: { chat: Chat; account?: Account; onClose: () => void; onChat: (c: Chat) => void }) {
  const [alias, setAlias] = useState(chat.alias ?? '');
  const [note, setNote] = useState(chat.note ?? '');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');
  const fileIn = useRef<HTMLInputElement>(null);
  const info = chat.info ?? {};
  const group = chat.kind !== 'direct';

  const refresh = async (quiet = false) => {
    setBusy(true); if (!quiet) setMsg('');
    try { onChat(await api.refreshContact(chat.id)); if (!quiet) setMsg(T('Aktualisiert.')); }
    catch (e: any) { if (!quiet) setMsg(e.message ?? T('Fehler')); }
    finally { setBusy(false); }
  };
  // Beim Öffnen frisch holen, wenn die Daten älter als ein Tag sind
  useEffect(() => { if (!info.fetchedAt || Date.now() - info.fetchedAt > 864e5) refresh(true); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const save = async (patch: Partial<Pick<Chat, 'alias' | 'note' | 'muted' | 'pinned' | 'archived'>>) => {
    try { onChat(await api.patchChat(chat.id, patch)); } catch (e: any) { setMsg(e.message ?? T('Fehler')); }
  };
  const upload = async (f: File) => {
    try { onChat(await api.setChatAvatar(chat.id, await squareJpeg(f, 512))); } catch (e: any) { setMsg(e.message ?? T('Fehler')); }
  };
  const copy = (t: string) => { navigator.clipboard?.writeText(t); setMsg(T('Kopiert.')); };

  return (
    <div className="modal-bg" onClick={onClose}>
      <div className="modal contact" onClick={(e) => e.stopPropagation()} role="dialog" aria-label="Kontaktprofil">
        <header className="modal-head">
          <h2>{group ? T('Gruppe') : T('Kontakt')}</h2>
          <button className="icon-btn" onClick={onClose} aria-label={T('Schließen')}><Icon name="close" /></button>
        </header>
        <div className="modal-body contact-body">
          <div className="contact-top">
            <button className="me-avatar" onClick={() => chat.avatar ? openLightbox({ src: chat.avatar, name: chat.title, download: chat.avatar }) : fileIn.current?.click()} aria-label="Profilbild">
              <Avatar name={chat.title} size={112} src={chat.avatar} />
            </button>
            <h2>{chat.title}</h2>
            {chat.alias && chat.netTitle && chat.netTitle !== chat.alias && <small className="muted">{T('Bei')}{' '}{NETWORKS[chat.network].name}: {chat.netTitle}</small>}
            <span className="contact-net"><span className="dot" style={{ background: NETWORKS[chat.network].color }} />{NETWORKS[chat.network].name}{account && account.label !== NETWORKS[chat.network].name ? ` · ${account.label}` : ''}</span>
            <div className="row gap">
              <button className="btn small ghost" onClick={() => fileIn.current?.click()}><Icon name="edit" size={16} /> {T('Eigenes Bild')}</button>
              {chat.customAvatar && <button className="btn small ghost" onClick={async () => onChat(await api.removeChatAvatar(chat.id))}>{T('Bild vom Messenger')}</button>}
            </div>
            <input ref={fileIn} type="file" accept="image/*" hidden onChange={(e) => { const f = e.target.files?.[0]; if (f) upload(f); e.target.value = ''; }} />
          </div>

          <div className="contact-rows">
            {info.phone && (
              <div className="contact-row">
                <Icon name="phone" size={20} />
                <span><small>{T('Telefonnummer')}</small><b>{info.phone}</b></span>
                <a className="icon-btn small" href={`tel:${info.phone.replace(/\s/g, '')}`} aria-label="Anrufen"><Icon name="phone" size={18} /></a>
                <button className="icon-btn small" onClick={() => copy(info.phone!)} aria-label={T('Kopieren')}><Icon name="copy" size={18} /></button>
              </div>
            )}
            {info.username && (
              <div className="contact-row"><Icon name="user" size={20} /><span><small>{T('Benutzername')}</small><b>{info.username}</b></span>
                <button className="icon-btn small" onClick={() => copy(info.username!)} aria-label={T('Kopieren')}><Icon name="copy" size={18} /></button></div>
            )}
            {info.about && <div className="contact-row"><Icon name="smile" size={20} /><span><small>{T('Info / Status')}</small><b className="pre">{info.about}</b></span></div>}
            {info.description && <div className="contact-row"><Icon name="file" size={20} /><span><small>{T('Beschreibung')}</small><b className="pre">{info.description}</b></span></div>}
            {info.members ? <div className="contact-row"><Icon name="user" size={20} /><span><small>{T('Mitglieder')}</small><b>{info.members}</b></span></div> : null}
            {!info.phone && !info.username && !info.about && !info.description && !info.members && (
              <p className="muted small">{busy ? T('Hole Infos vom Messenger …') : T('{0} gibt zu diesem Chat keine weiteren Infos heraus.', NETWORKS[chat.network].name)}</p>
            )}
          </div>

          <label className="field">
            <span>{T('Eigener Name')}</span>
            <input className="input" value={alias} placeholder={chat.netTitle ?? chat.title} maxLength={100}
              onChange={(e) => setAlias(e.target.value)} onBlur={() => alias !== (chat.alias ?? '') && save({ alias })} />
            <small className="muted">{T('Nur in Chorus sichtbar. Leer lassen für den Namen vom Messenger.')}</small>
          </label>
          <label className="field">
            <span>{T('Notiz')}</span>
            <textarea className="input" rows={3} value={note} placeholder={T('z. B. Geburtstag, Adresse, woher ihr euch kennt …')}
              onChange={(e) => setNote(e.target.value)} onBlur={() => note !== (chat.note ?? '') && save({ note })} />
          </label>

          {!group && <LinkSection chat={chat} onChat={onChat} />}

          <div className="contact-actions">
            <button className="btn ghost" onClick={() => save({ muted: !chat.muted })}><Icon name={chat.muted ? 'bell' : 'belloff'} size={18} />{chat.muted ? T('Ton an') : T('Stumm')}</button>
            <button className="btn ghost" onClick={() => save({ pinned: !chat.pinned })}><Icon name="pin" size={18} />{chat.pinned ? T('Lösen') : 'Anheften'}</button>
            <button className="btn ghost" onClick={() => save({ archived: !chat.archived })}><Icon name="archive" size={18} />{chat.archived ? T('Zurückholen') : 'Archivieren'}</button>
            <button className="btn ghost" onClick={() => refresh()} disabled={busy}><Icon name="refresh" size={18} />{busy ? T('Lädt …') : T('Aktualisieren')}</button>
          </div>
          {msg && <p className="muted small">{msg}</p>}
        </div>
      </div>
    </div>
  );
}

/** Dieselbe Person bei mehreren Messengern: Chats zu einem Kontakt zusammenführen */
function LinkSection({ chat, onChat }: { chat: Chat; onChat: (c: Chat) => void }) {
  const [data, setData] = useState<{ linked: Chat[]; suggestions: Chat[] } | null>(null);
  const [pick, setPick] = useState(false);
  const [all, setAll] = useState<Chat[]>([]);
  const [q, setQ] = useState('');
  const [err, setErr] = useState('');
  const load = () => api.links(chat.id).then(setData).catch(() => {});
  useEffect(() => { load(); }, [chat.id, chat.link]); // eslint-disable-line react-hooks/exhaustive-deps
  const link = async (other: Chat) => {
    setErr('');
    try { const cs = await api.link(chat.id, other.id); cs.forEach(onChat); setPick(false); setQ(''); load(); }
    catch (e: any) { setErr(e.message ?? T('Fehler')); }
  };
  const setVia = async (via: string | null) => { setErr(''); try { (await api.setVia(chat.id, via)).forEach(onChat); } catch (e: any) { setErr(e.message ?? T('Fehler')); } };
  const unlink = async (c: Chat) => { try { await api.unlink(c.id); load(); } catch (e: any) { setErr(e.message ?? T('Fehler')); } };
  const openPick = async () => { setPick(true); if (!all.length) setAll(await api.chats().catch(() => [])); };
  const s = q.trim().toLowerCase();
  const linkedIds = new Set([chat.id, ...(data?.linked ?? []).map((c) => c.id)]);
  const candidates = all.filter((c) => c.kind === 'direct' && !linkedIds.has(c.id) && (!s || c.title.toLowerCase().includes(s) || (c.info?.phone ?? '').replace(/\s/g, '').includes(s.replace(/\s/g, '')))).slice(0, 30);
  return (
    <div className="link-section">
      <h4>{T('Auch bei anderen Messengern')}</h4>
      <p className="muted small">{T('Zusammengeführte Chats erscheinen als ein Kontakt mit gemeinsamem Verlauf. Darunter legst du fest, über welchen Messenger du antwortest.')}</p>
      {data?.linked.map((c) => (
        <div key={c.id} className="contact-row">
          <span className="dot big" style={{ background: NETWORKS[c.network].color }} />
          <span><small>{NETWORKS[c.network].name}</small><b>{c.title}</b></span>
          <button className="btn small ghost" onClick={() => unlink(c)}>{T('Trennen')}</button>
        </div>
      ))}
      {!!data?.linked.length && (
        <div className="via-setting">
          <h4>{T('Senden über')}</h4>
          {[null, chat, ...data.linked].map((c) => {
            const id = c?.id ?? null;
            const cur = chat.sendVia ?? null;
            const same = c && [chat, ...data.linked].filter((x) => x.network === c.network).length > 1;
            return (
              <label key={id ?? 'auto'} className="radio-row">
                <input type="radio" name={`via-${chat.id}`} checked={cur === id} onChange={() => setVia(id)} />
                {c ? <><span className="dot" style={{ background: NETWORKS[c.network].color }} />{NETWORKS[c.network].name}{same ? ` · ${c.netTitle ?? c.title}` : ''}</>
                  : <span>{T('Automatisch')}{' '}<small className="muted">{T('(wo zuletzt geschrieben wurde)')}</small></span>}
              </label>
            );
          })}
        </div>
      )}
      {data?.suggestions.map((c) => (
        <div key={c.id} className="contact-row suggest">
          <span className="dot big" style={{ background: NETWORKS[c.network].color }} />
          <span><small>{T('Vorschlag ·')}{' '}{NETWORKS[c.network].name}</small><b>{c.title}</b></span>
          <button className="btn small primary" onClick={() => link(c)}>{T('Zusammenführen')}</button>
        </div>
      ))}
      {!pick ? (
        <button className="btn small ghost" onClick={openPick}><Icon name="link" size={16} /> {T('Chat auswählen …')}</button>
      ) : (
        <div className="link-pick">
          <input className="input" autoFocus placeholder={T('Name oder Nummer suchen')} value={q} onChange={(e) => setQ(e.target.value)} />
          <ul>
            {candidates.map((c) => (
              <li key={c.id}><button onClick={() => link(c)}><span className="dot" style={{ background: NETWORKS[c.network].color }} /><b>{c.title}</b><small>{NETWORKS[c.network].name}</small></button></li>
            ))}
            {!candidates.length && <li className="muted small">{T('Kein passender Chat.')}</li>}
          </ul>
          <button className="btn small ghost" onClick={() => setPick(false)}>{T('Abbrechen')}</button>
        </div>
      )}
      {err && <p className="muted small">{err}</p>}
    </div>
  );
}
