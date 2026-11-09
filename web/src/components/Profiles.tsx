import { useEffect, useState } from 'react';
import { api, type ProfileInfo, type ServerState } from '../api';
import { Avatar } from './Rail';
import { Icon } from './Icon';

/** Profile für Familie und Freunde: jede Person hat ihren eigenen, verschlüsselten Bereich. */
export function ProfilesSection({ server, onRenamed }: { server: ServerState; onRenamed: () => void }) {
  const me = server.profile!;
  const [list, setList] = useState<ProfileInfo[] | null>(null);
  const [name, setName] = useState('');
  const [msg, setMsg] = useState('');
  const [invite, setInvite] = useState<{ id: string; name: string; code: string } | null>(null);
  const [editing, setEditing] = useState<{ id: string; name: string } | null>(null);

  const load = () => me.admin ? api.profiles().then(setList).catch((e) => setMsg(e.message)) : Promise.resolve();
  useEffect(() => { load(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const run = async (fn: () => Promise<void>) => { setMsg(''); try { await fn(); } catch (e: any) { setMsg(e.message ?? String(e)); } };
  const link = (i: { id: string; code: string }) => `${location.origin}/?p=${i.id}&invite=${i.code}`;

  const add = (e: React.FormEvent) => { e.preventDefault(); run(async () => {
    const r = await api.createProfile(name);
    setInvite({ id: r.profile.id, name: r.profile.name, code: r.invite });
    setName('');
    await load();
  }); };
  const rename = (e: React.FormEvent) => { e.preventDefault(); if (!editing) return; run(async () => {
    await api.renameProfile(editing.id, editing.name);
    setEditing(null);
    await load();
    if (editing.id === me.id) onRenamed();
  }); };

  const share = async (i: { id: string; name: string; code: string }) => {
    const text = `Hallo ${i.name}, hier ist dein Zugang zu Chorus: ${link(i)}\nEinladungscode: ${i.code}`;
    if (navigator.share) await navigator.share({ title: 'Einladung zu Chorus', text }).catch(() => {});
    else { await navigator.clipboard?.writeText(text); setMsg('Einladung kopiert.'); }
  };

  const editForm = (id: string) => editing?.id === id && (
    <form className="row gap prof-edit" onSubmit={rename}>
      <input className="input small" value={editing.name} onChange={(e) => setEditing({ id, name: e.target.value })} autoFocus />
      <button className="btn small primary">Speichern</button>
      <button type="button" className="btn small ghost" onClick={() => setEditing(null)}>Abbrechen</button>
    </form>
  );

  if (!me.admin) {
    return (
      <div className="stack prof">
        <div className="prof-row">
          <Avatar name={me.name} size={40} />
          <div className="prof-main"><b>{me.name}</b><small>Dein Profil</small></div>
          <button className="icon-btn" title="Umbenennen" onClick={() => setEditing({ id: me.id, name: me.name })}><Icon name="edit" size={18} /></button>
        </div>
        {editForm(me.id)}
        {msg && <small className="tfa-msg">{msg}</small>}
      </div>
    );
  }

  return (
    <div className="stack prof">
      <small className="muted">Jede Person bekommt einen eigenen Bereich mit eigenem Passwort, eigenen Messengern und eigenen KI-Schlüsseln. Alles ist getrennt verschlüsselt, auch du als Admin kannst fremde Chats nicht lesen.</small>
      {list?.map((p) => (
        <div key={p.id}>
          <div className="prof-row">
            <Avatar name={p.name} size={40} src={p.avatar} />
            <div className="prof-main">
              <b>{p.name}{p.id === me.id && ' (du)'}</b>
              <small>{p.admin ? 'Admin · ' : ''}{!p.initialized ? 'Einladung offen' : p.online ? 'Entsperrt' : 'Gesperrt'}{p.totp ? ' · 2FA' : ''}</small>
            </div>
            {!p.initialized && <button className="btn small" onClick={() => run(async () => { const r = await api.newInvite(p.id); setInvite({ id: p.id, name: p.name, code: r.invite }); })}>Einladung</button>}
            <button className="icon-btn" title="Umbenennen" onClick={() => setEditing({ id: p.id, name: p.name })}><Icon name="edit" size={18} /></button>
            {p.id !== me.id && <button className="icon-btn danger" title="Löschen" onClick={() => confirm(`Profil „${p.name}“ mit allen Chats und verbundenen Messengern löschen? Das lässt sich nicht rückgängig machen.`) && run(async () => { await api.deleteProfile(p.id); await load(); })}><Icon name="trash" size={18} /></button>}
          </div>
          {editForm(p.id)}
        </div>
      ))}
      {invite && (
        <div className="invite-card">
          <b>Einladung für {invite.name}</b>
          <small>Schick {invite.name} den Link. Beim ersten Öffnen legt {invite.name} ein eigenes Passwort fest. Der Code gilt nur einmal.</small>
          <div className="recovery-code small">{invite.code.match(/.{1,4}/g)!.join('-')}</div>
          <div className="row gap">
            <button className="btn primary" onClick={() => share(invite)}><Icon name="send" size={16} /> Einladung teilen</button>
            <button className="btn ghost" onClick={() => setInvite(null)}>Fertig</button>
          </div>
        </div>
      )}
      <form className="row gap prof-add" onSubmit={add}>
        <input className="input" placeholder="Name, z. B. Anna" value={name} onChange={(e) => setName(e.target.value)} />
        <button className="btn" disabled={!name.trim()}><Icon name="plus" size={18} /> Profil anlegen</button>
      </form>
      {msg && <small className="tfa-msg">{msg}</small>}
    </div>
  );
}
