import { useRef, useState } from 'react';
import { api, type ServerState } from '../api';
import { Avatar } from './Rail';
import { Icon } from './Icon';
import { T } from '../i18n';

/** Bild im Browser auf 256×256 zuschneiden und als JPEG ausgeben */
export async function squareJpeg(file: File, size = 256): Promise<Blob> {
  const bmp = await createImageBitmap(file);
  const s = Math.min(bmp.width, bmp.height);
  const c = document.createElement('canvas');
  c.width = c.height = size;
  c.getContext('2d')!.drawImage(bmp, (bmp.width - s) / 2, (bmp.height - s) / 2, s, s, 0, 0, size, size);
  return new Promise((res, rej) => c.toBlob((b) => (b ? res(b) : rej(new Error(T('Bild konnte nicht gelesen werden')))), 'image/jpeg', 0.86));
}

/** Kopf der Einstellungen: eigenes Profilbild und eigener Name */
export function MyProfile({ server, onChanged }: { server: ServerState; onChanged: () => void }) {
  const me = server.profile!;
  const [avatar, setAvatar] = useState(me.avatar);
  const [name, setName] = useState(me.name);
  const [editing, setEditing] = useState(false);
  const [msg, setMsg] = useState('');
  const file = useRef<HTMLInputElement>(null);

  const run = async (fn: () => Promise<void>) => { setMsg(''); try { await fn(); } catch (e: any) { setMsg(e.message ?? String(e)); } };
  const pick = (f: File | undefined) => f && run(async () => {
    const p = await api.setAvatar(me.id, await squareJpeg(f));
    setAvatar(p.avatar);
    onChanged();
  });

  return (
    <div className="me-card">
      <button className="me-avatar" onClick={() => file.current?.click()} title={T('Profilbild ändern')}>
        <Avatar name={name} size={72} src={avatar} />
        <span className="me-cam"><Icon name="edit" size={14} /></span>
      </button>
      <input ref={file} type="file" accept="image/*" hidden onChange={(e) => { pick(e.target.files?.[0]); e.target.value = ''; }} />
      <div className="me-main">
        {editing ? (
          <form className="row gap" onSubmit={(e) => { e.preventDefault(); run(async () => { await api.renameProfile(me.id, name); setEditing(false); onChanged(); }); }}>
            <input className="input small" value={name} onChange={(e) => setName(e.target.value)} autoFocus />
            <button className="btn small primary">{T('OK')}</button>
          </form>
        ) : (
          <button className="me-name" onClick={() => setEditing(true)} title={T('Namen ändern')}><b>{name}</b><Icon name="edit" size={16} /></button>
        )}
        <small>{me.admin ? T('Admin · ') : ''}{me.totp ? T('Zwei-Faktor aktiv') : T('Zwei-Faktor aus')}</small>
        {avatar && <button className="link small" onClick={() => run(async () => { await api.removeAvatar(me.id); setAvatar(null); onChanged(); })}>{T('Bild entfernen')}</button>}
        {msg && <small className="tfa-msg">{msg}</small>}
      </div>
    </div>
  );
}
