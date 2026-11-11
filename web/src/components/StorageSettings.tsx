import { useState } from 'react';
import { api, type StorageTarget } from '../api';
import { storageState, useStorage } from '../storageState';
import { Icon } from './Icon';

/** Einstellungen → Speicherorte: Immich für Fotos/Videos, Nextcloud für Dateien */
export function StorageSection() {
  const s = useStorage();
  const [im, setIm] = useState<{ url?: string; key: string }>({ key: '' });
  const [nc, setNc] = useState<{ url?: string; user?: string; folder?: string; pass: string }>({ pass: '' });
  const [msg, setMsg] = useState<Record<StorageTarget, string>>({ immich: '', nextcloud: '' });
  const [busy, setBusy] = useState(false);
  if (!s) return <p className="muted">Lade …</p>;

  const say = (t: StorageTarget, m: string) => setMsg((x) => ({ ...x, [t]: m }));
  const run = async (t: StorageTarget, fn: () => Promise<string | void>) => {
    setBusy(true); say(t, '');
    try { const r = await fn(); if (r) say(t, r); }
    catch (e: any) { say(t, e.message ?? 'Fehler'); }
    finally { setBusy(false); }
  };
  const saveImmich = (enabled = true) => run('immich', async () => {
    storageState.set(await api.setStorage({ immich: { enabled, url: im.url ?? s.immich.url, key: im.key } }));
    setIm({ key: '' });
    if (!enabled) return 'Immich ausgeschaltet.';
    return (await api.testStorage('immich')).message;
  });
  const saveNc = (enabled = true) => run('nextcloud', async () => {
    storageState.set(await api.setStorage({ nextcloud: { enabled, url: nc.url ?? s.nextcloud.url, user: nc.user ?? s.nextcloud.user, folder: nc.folder ?? s.nextcloud.folder, pass: nc.pass } }));
    setNc({ pass: '' });
    if (!enabled) return 'Nextcloud ausgeschaltet.';
    return (await api.testStorage('nextcloud')).message;
  });
  const imReady = !!(im.url ?? s.immich.url) && (!!im.key || s.immich.hasKey);
  const ncReady = !!(nc.url ?? s.nextcloud.url) && !!(nc.user ?? s.nextcloud.user) && (!!nc.pass || s.nextcloud.hasPass);

  return (<>
    <p className="muted">Freiwillig: Verknüpfe deine eigenen Dienste, dann speichert Chorus Anhänge mit einem Tipp direkt dorthin. Fotos und Videos gehen standardmäßig nach Immich, andere Dateien nach Nextcloud. Der Server lädt das Original hoch, Schlüssel und Passwörter liegen verschlüsselt in deinem Tresor und verlassen den Server nie.</p>

    <div className="stack">
      <b>Immich (Fotos und Videos) {s.immich.enabled && <small className="state connected">· verknüpft</small>}</b>
      <small className="muted">In Immich unter Kontoeinstellungen → API-Schlüssel einen Schlüssel anlegen. Es reicht das Recht „asset.upload“.</small>
      <input className="input" type="url" inputMode="url" autoComplete="off" placeholder="https://fotos.example.de" value={im.url ?? s.immich.url} onChange={(e) => setIm({ ...im, url: e.target.value })} />
      <input className="input" type="password" autoComplete="off" placeholder={s.immich.hasKey ? '•••••••• gespeichert' : 'API-Schlüssel'} value={im.key} onChange={(e) => setIm({ ...im, key: e.target.value })} />
      <div className="row">
        <button className="btn" disabled={busy || !imReady} onClick={() => saveImmich(true)}><Icon name="check" size={18} /> {s.immich.enabled ? 'Speichern und prüfen' : 'Verknüpfen'}</button>
        {s.immich.enabled && <button className="btn ghost" disabled={busy} onClick={() => saveImmich(false)}>Ausschalten</button>}
      </div>
      {msg.immich && <small>{msg.immich}</small>}
    </div>

    <div className="stack">
      <b>Nextcloud (Dateien) {s.nextcloud.enabled && <small className="state connected">· verknüpft</small>}</b>
      <small className="muted">In Nextcloud unter Einstellungen → Sicherheit ein App-Passwort erzeugen. Dateien landen im Zielordner, gleiche Namen werden nicht überschrieben.</small>
      <input className="input" type="url" inputMode="url" autoComplete="off" placeholder="https://cloud.example.de" value={nc.url ?? s.nextcloud.url} onChange={(e) => setNc({ ...nc, url: e.target.value })} />
      <input className="input" autoComplete="off" autoCapitalize="none" placeholder="Benutzername" value={nc.user ?? s.nextcloud.user} onChange={(e) => setNc({ ...nc, user: e.target.value })} />
      <input className="input" type="password" autoComplete="off" placeholder={s.nextcloud.hasPass ? '•••••••• gespeichert' : 'App-Passwort'} value={nc.pass} onChange={(e) => setNc({ ...nc, pass: e.target.value })} />
      <label className="row"><span>Zielordner</span><input className="input" autoComplete="off" autoCapitalize="none" placeholder="Chorus" value={nc.folder ?? s.nextcloud.folder} onChange={(e) => setNc({ ...nc, folder: e.target.value })} /></label>
      <div className="row">
        <button className="btn" disabled={busy || !ncReady} onClick={() => saveNc(true)}><Icon name="check" size={18} /> {s.nextcloud.enabled ? 'Speichern und prüfen' : 'Verknüpfen'}</button>
        {s.nextcloud.enabled && <button className="btn ghost" disabled={busy} onClick={() => saveNc(false)}>Ausschalten</button>}
      </div>
      {msg.nextcloud && <small>{msg.nextcloud}</small>}
    </div>
  </>);
}
