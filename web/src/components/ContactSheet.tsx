import { useEffect, useRef, useState } from 'react';
import { api, type Account, type Chat } from '../api';
import { NETWORKS } from '../util';
import { Avatar } from './Rail';
import { Icon } from './Icon';
import { squareJpeg } from './MyProfile';
import { openLightbox } from './Lightbox';

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
    try { onChat(await api.refreshContact(chat.id)); if (!quiet) setMsg('Aktualisiert.'); }
    catch (e: any) { if (!quiet) setMsg(e.message ?? 'Fehler'); }
    finally { setBusy(false); }
  };
  // Beim Öffnen frisch holen, wenn die Daten älter als ein Tag sind
  useEffect(() => { if (!info.fetchedAt || Date.now() - info.fetchedAt > 864e5) refresh(true); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const save = async (patch: Partial<Pick<Chat, 'alias' | 'note' | 'muted' | 'pinned' | 'archived'>>) => {
    try { onChat(await api.patchChat(chat.id, patch)); } catch (e: any) { setMsg(e.message ?? 'Fehler'); }
  };
  const upload = async (f: File) => {
    try { onChat(await api.setChatAvatar(chat.id, await squareJpeg(f, 512))); } catch (e: any) { setMsg(e.message ?? 'Fehler'); }
  };
  const copy = (t: string) => { navigator.clipboard?.writeText(t); setMsg('Kopiert.'); };

  return (
    <div className="modal-bg" onClick={onClose}>
      <div className="modal contact" onClick={(e) => e.stopPropagation()} role="dialog" aria-label="Kontaktprofil">
        <header className="modal-head">
          <h2>{group ? 'Gruppe' : 'Kontakt'}</h2>
          <button className="icon-btn" onClick={onClose} aria-label="Schließen"><Icon name="close" /></button>
        </header>
        <div className="modal-body contact-body">
          <div className="contact-top">
            <button className="me-avatar" onClick={() => chat.avatar ? openLightbox({ src: chat.avatar, name: chat.title, download: chat.avatar }) : fileIn.current?.click()} aria-label="Profilbild">
              <Avatar name={chat.title} size={112} src={chat.avatar} />
            </button>
            <h2>{chat.title}</h2>
            {chat.alias && chat.netTitle && chat.netTitle !== chat.alias && <small className="muted">Bei {NETWORKS[chat.network].name}: {chat.netTitle}</small>}
            <span className="contact-net"><span className="dot" style={{ background: NETWORKS[chat.network].color }} />{NETWORKS[chat.network].name}{account && account.label !== NETWORKS[chat.network].name ? ` · ${account.label}` : ''}</span>
            <div className="row gap">
              <button className="btn small ghost" onClick={() => fileIn.current?.click()}><Icon name="edit" size={16} /> Eigenes Bild</button>
              {chat.customAvatar && <button className="btn small ghost" onClick={async () => onChat(await api.removeChatAvatar(chat.id))}>Bild vom Messenger</button>}
            </div>
            <input ref={fileIn} type="file" accept="image/*" hidden onChange={(e) => { const f = e.target.files?.[0]; if (f) upload(f); e.target.value = ''; }} />
          </div>

          <div className="contact-rows">
            {info.phone && (
              <div className="contact-row">
                <Icon name="phone" size={20} />
                <span><small>Telefonnummer</small><b>{info.phone}</b></span>
                <a className="icon-btn small" href={`tel:${info.phone.replace(/\s/g, '')}`} aria-label="Anrufen"><Icon name="phone" size={18} /></a>
                <button className="icon-btn small" onClick={() => copy(info.phone!)} aria-label="Kopieren"><Icon name="copy" size={18} /></button>
              </div>
            )}
            {info.username && (
              <div className="contact-row"><Icon name="user" size={20} /><span><small>Benutzername</small><b>{info.username}</b></span>
                <button className="icon-btn small" onClick={() => copy(info.username!)} aria-label="Kopieren"><Icon name="copy" size={18} /></button></div>
            )}
            {info.about && <div className="contact-row"><Icon name="smile" size={20} /><span><small>Info / Status</small><b className="pre">{info.about}</b></span></div>}
            {info.description && <div className="contact-row"><Icon name="file" size={20} /><span><small>Beschreibung</small><b className="pre">{info.description}</b></span></div>}
            {info.members ? <div className="contact-row"><Icon name="user" size={20} /><span><small>Mitglieder</small><b>{info.members}</b></span></div> : null}
            {!info.phone && !info.username && !info.about && !info.description && !info.members && (
              <p className="muted small">{busy ? 'Hole Infos vom Messenger …' : `${NETWORKS[chat.network].name} gibt zu diesem Chat keine weiteren Infos heraus.`}</p>
            )}
          </div>

          <label className="field">
            <span>Eigener Name</span>
            <input className="input" value={alias} placeholder={chat.netTitle ?? chat.title} maxLength={100}
              onChange={(e) => setAlias(e.target.value)} onBlur={() => alias !== (chat.alias ?? '') && save({ alias })} />
            <small className="muted">Nur in Chorus sichtbar. Leer lassen für den Namen vom Messenger.</small>
          </label>
          <label className="field">
            <span>Notiz</span>
            <textarea className="input" rows={3} value={note} placeholder="z. B. Geburtstag, Adresse, woher ihr euch kennt …"
              onChange={(e) => setNote(e.target.value)} onBlur={() => note !== (chat.note ?? '') && save({ note })} />
          </label>

          <div className="contact-actions">
            <button className="btn ghost" onClick={() => save({ muted: !chat.muted })}><Icon name={chat.muted ? 'bell' : 'belloff'} size={18} />{chat.muted ? 'Ton an' : 'Stumm'}</button>
            <button className="btn ghost" onClick={() => save({ pinned: !chat.pinned })}><Icon name="pin" size={18} />{chat.pinned ? 'Lösen' : 'Anheften'}</button>
            <button className="btn ghost" onClick={() => save({ archived: !chat.archived })}><Icon name="archive" size={18} />{chat.archived ? 'Zurückholen' : 'Archivieren'}</button>
            <button className="btn ghost" onClick={() => refresh()} disabled={busy}><Icon name="refresh" size={18} />{busy ? 'Lädt …' : 'Aktualisieren'}</button>
          </div>
          {msg && <p className="muted small">{msg}</p>}
        </div>
      </div>
    </div>
  );
}
