import { useEffect, useRef, useState, type ReactNode } from 'react';
import type { EmailConfig } from '../api';
import { api, type Account, type ServerState } from '../api';
import { deriveKey, keyStore, newSalt } from '../keys';
import { NETWORKS } from '../util';
import { Icon } from './Icon';
import { LinkStatus } from './AccountWizard';
import { AiSettingsSection } from './AiSettings';
import { TwoFactor } from './TwoFactor';
import { ProfilesSection } from './Profiles';
import { MyProfile } from './MyProfile';
import { BackupSection } from './Backup';
import { StorageSection } from './StorageSettings';
import { useStorage } from '../storageState';
import { BubbleSection } from './BubbleSettings';
import { AdminSection } from './AdminSection';
import { PushSection } from './PushSection';
import { Avatar } from './Rail';
import { loadBubbles } from '../bubbles';
import { useExit } from '../useExit';

const STATE_TEXT: Record<Account['status']['state'], string> = {
  connected: 'Verbunden', connecting: 'Verbinde …', disconnected: 'Getrennt', need_input: 'Anmeldung offen', qr: 'QR-Code scannen', error: 'Fehler',
};

type Page = 'me' | 'accounts' | 'ai' | 'push' | 'look' | 'backup' | 'storage' | 'security' | 'profiles' | 'server' | 'about' | `acc:${string}`;

const TITLES: Record<string, string> = {
  me: 'Mein Profil', accounts: 'Messenger', ai: 'KI-Assistent', push: 'Benachrichtigungen', look: 'Darstellung', backup: 'Sicherung', storage: 'Speicherorte',
  security: 'Sicherheit', profiles: 'Profile', server: 'Server', about: 'Über Chorus',
};

/** Farbiges, abgerundetes Quadrat wie in den iOS-Einstellungen */
function Tile({ color, icon, letter }: { color: string; icon?: string; letter?: string }) {
  return <span className="ios-icon" style={{ background: color }}>{icon ? <Icon name={icon} size={17} /> : <b>{letter}</b>}</span>;
}

function Row({ tile, title, sub, value, onClick, chevron = true, danger }: {
  tile?: ReactNode; title: ReactNode; sub?: ReactNode; value?: ReactNode; onClick?: () => void; chevron?: boolean; danger?: boolean;
}) {
  return (
    <button className={`ios-row${danger ? ' danger' : ''}`} onClick={onClick}>
      {tile}
      <span className="ios-row-main">
        <span className="ios-row-text"><span className="ios-title">{title}</span>{sub && <small>{sub}</small>}</span>
        {value != null && <span className="ios-value">{value}</span>}
        {chevron && <Icon name="chevron" size={18} />}
      </span>
    </button>
  );
}

export function Settings({ server, accounts, onClose, onAdd, onLocked, onProfileChanged, onReload }: {
  server: ServerState; accounts: Account[]; onClose: () => void; onAdd: () => void; onLocked: () => void; onProfileChanged: () => void; onReload: () => Promise<void>;
}) {
  const me = server.profile!;
  const [comfort, setComfort] = useState(me.comfort);
  const pid = me.id;
  const st = useStorage();
  const storeVal = [st?.immich.enabled && 'Immich', st?.nextcloud.enabled && 'Nextcloud'].filter(Boolean).join(', ');
  const [pw, setPw] = useState({ a: '', b: '', msg: '' });
  const [page, setPage] = useState<Page | null>(null);
  const [sync, setSync] = useState<'idle' | 'busy' | 'fail'>('idle');
  const [lastSync, setLastSync] = useState(() => Number(localStorage.getItem('inbox:lastSync')) || 0);
  const runSync = async () => {
    if (sync === 'busy') return; setSync('busy');
    try { await onReload(); const t = Date.now(); localStorage.setItem('inbox:lastSync', String(t)); setLastSync(t); setSync('idle'); } catch { setSync('fail'); }
  };
  const [last, setLast] = useState<Page | null>(null);
  const anim = useExit(!!page, 320);
  const shown = page ?? last;
  const go = (p: Page) => { setLast(p); setPage(p); };
  const back = () => { if (shown?.startsWith('acc:')) go('accounts'); else setPage(null); };

  // Vom linken Rand nach rechts wischen = zurück (wie unter iOS)
  const pageRef = useRef<HTMLDivElement>(null);
  const drag = useRef<{ x: number; y: number; dx: number; on: boolean } | null>(null);
  const onTouchStart = (e: React.TouchEvent) => {
    const t = e.touches[0];
    const left = pageRef.current?.getBoundingClientRect().left ?? 0;
    drag.current = t.clientX - left < 32 ? { x: t.clientX, y: t.clientY, dx: 0, on: false } : null;
  };
  const onTouchMove = (e: React.TouchEvent) => {
    const d = drag.current; if (!d || !pageRef.current) return;
    const t = e.touches[0]; d.dx = Math.max(0, t.clientX - d.x);
    if (!d.on && Math.abs(t.clientY - d.y) > 12 && d.dx < 12) { drag.current = null; return; }
    if (d.dx > 6) d.on = true;
    if (d.on) { pageRef.current.style.transition = 'none'; pageRef.current.style.transform = `translateX(${d.dx}px)`; }
  };
  const onTouchEnd = () => {
    const d = drag.current; drag.current = null; const el = pageRef.current;
    if (!d?.on || !el) return;
    el.style.transition = ''; el.style.transform = '';
    if (d.dx > 90) back();
  };

  const changePw = async (e: React.FormEvent) => {
    e.preventDefault();
    if (pw.a.length < 8) return setPw({ ...pw, msg: 'Mindestens 8 Zeichen.' });
    if (pw.a !== pw.b) return setPw({ ...pw, msg: 'Passwörter stimmen nicht überein.' });
    const salt = newSalt();
    const key = await deriveKey(pw.a, salt, 600_000);
    await api.changePassword(salt, key);
    if (await keyStore.get(pid)) await keyStore.set(pid, key);
    setPw({ a: '', b: '', msg: 'Passwort geändert.' });
  };
  const logout = async () => { await keyStore.clear(pid); await api.logout(); onLocked(); };

  const pushOn = localStorage.getItem('inbox:push') === '1';
  const bubbleMode = loadBubbles().mode === 'network' ? 'Farben je Dienst' : 'Einheitlich';
  const acc = shown?.startsWith('acc:') ? accounts.find((a) => a.id === shown.slice(4)) : undefined;
  const title = acc ? acc.label : shown ? TITLES[shown] : '';

  const renderPage = () => {
    if (!shown) return null;
    if (acc) return <AccountPage acc={acc} onBack={back} />;
    switch (shown) {
      case 'accounts': return <AccountsPage accounts={accounts} sync={sync} lastSync={lastSync} onSync={() => void runSync()} onOpen={(id) => go(`acc:${id}`)} onAdd={onAdd} />;
      case 'me': return <div className="ios-card pad"><MyProfile server={server} onChanged={onProfileChanged} /></div>;
      case 'ai': return <div className="ios-card pad"><AiSettingsSection /></div>;
      case 'push': return <div className="ios-card pad"><PushSection /></div>;
      case 'look': return <div className="ios-card pad"><BubbleSection nets={[...new Set(accounts.map((a) => a.network))]} /></div>;
      case 'backup': return <div className="ios-card pad"><BackupSection /></div>;
      case 'storage': return <div className="ios-card pad"><StorageSection /></div>;
      case 'profiles': return <div className="ios-card pad"><ProfilesSection key={`${me.name}:${me.avatar}`} server={server} onRenamed={onProfileChanged} /></div>;
      case 'server': return <div className="ios-card pad"><AdminSection /></div>;
      case 'about': return (
        <>
          <div className="ios-hero"><img src="/icon.svg" alt="" width={72} height={72} style={{ borderRadius: 16 }} /><h3>Chorus</h3><small className="muted">Version {server.version}</small></div>
          <div className="ios-card pad"><p className="muted">Deine Messenger in einer App. Deine Daten liegen verschlüsselt auf deinem eigenen Server.</p></div>
          <div className="ios-card">
            <a className="ios-row" href="https://github.com/robinvonmises/chorus" target="_blank" rel="noreferrer"><span className="ios-row-main"><span className="ios-row-text"><span className="ios-title">Quellcode auf GitHub</span></span><Icon name="chevron" size={18} /></span></a>
            <a className="ios-row" href={`https://github.com/robinvonmises/chorus/releases`} target="_blank" rel="noreferrer"><span className="ios-row-main"><span className="ios-row-text"><span className="ios-title">Neuigkeiten</span></span><Icon name="chevron" size={18} /></span></a>
          </div>
          <p className="ios-foot" style={{ marginTop: -14 }}>Freie Software unter der AGPL-3.0.</p>
        </>
      );
      case 'security': return (
        <>
          <p className="ios-caption">Zwei-Faktor</p>
          <div className="ios-card pad"><TwoFactor enabled={me.totp} profileId={pid} /></div>
          <p className="ios-caption">Neustart des Servers</p>
          <div className="ios-card pad">
            <label className="toggle">
              <input type="checkbox" checked={comfort} onChange={async (e) => setComfort((await api.setComfort(e.target.checked)).comfort)} />
              <span><b>Komfort-Modus</b><small>Nach einem Neustart des Servers sofort wieder Nachrichten empfangen, ohne die App zu öffnen. Dafür liegt ein Schlüssel auf dem Server. Aus = mehr Sicherheit (Tresor-Modus).</small></span>
            </label>
          </div>
          <p className="ios-caption">Passwort ändern</p>
          <form className="ios-card pad stack" onSubmit={changePw}>
            <input className="input" type="password" placeholder="Neues Passwort" value={pw.a} onChange={(e) => setPw({ ...pw, a: e.target.value })} autoComplete="new-password" />
            <input className="input" type="password" placeholder="Wiederholen" value={pw.b} onChange={(e) => setPw({ ...pw, b: e.target.value })} autoComplete="new-password" />
            {pw.msg && <small>{pw.msg}</small>}
            <button className="btn" disabled={!pw.a}>Ändern</button>
          </form>
        </>
      );
    }
    return null;
  };

  return (
    <div className="modal-bg" onClick={onClose}>
      <div className="modal wide ios-settings" onClick={(e) => e.stopPropagation()} role="dialog" aria-label="Einstellungen">
        <div className={`ios-layer ios-main${anim.mounted && !anim.closing ? ' behind' : ''}`} aria-hidden={!!page}>
          <header className="ios-head">
            <span />
            <h2>Einstellungen</h2>
            <button className="icon-btn" onClick={onClose} aria-label="Schließen"><Icon name="close" /></button>
          </header>
          <div className="ios-scroll">
            <div className="ios-card">
              <button className="ios-row ios-me" onClick={() => go('me')}>
                <Avatar name={me.name} size={58} src={me.avatar} />
                <span className="ios-row-main">
                  <span className="ios-row-text"><span className="ios-title big">{me.name}</span><small>{me.admin ? 'Admin · ' : ''}Profilbild und Name</small></span>
                  <Icon name="chevron" size={18} />
                </span>
              </button>
            </div>

            <div className="ios-card">
              <Row tile={<Tile color="#34c759" icon="chat" />} title="Messenger"
                sub={accounts.length ? [...new Set(accounts.map((a) => NETWORKS[a.network].name))].join(', ') : 'Noch keiner verbunden'}
                value={accounts.length ? <AccountsBadge accounts={accounts} /> : undefined} onClick={() => go('accounts')} />
            </div>

            <div className="ios-card">
              <Row tile={<Tile color="#af52de" icon="sparkle" />} title="KI-Assistent" onClick={() => go('ai')} />
              <Row tile={<Tile color="#ff3b30" icon="bell" />} title="Benachrichtigungen" value={pushOn ? 'Push an' : undefined} onClick={() => go('push')} />
              <Row tile={<Tile color="#007aff" icon="palette" />} title="Darstellung" value={bubbleMode} onClick={() => go('look')} />
            </div>

            <div className="ios-card">
              <Row tile={<Tile color="#30b0c7" icon="cloud" />} title="Sicherung" onClick={() => go('backup')} />
              <Row tile={<Tile color="#ff9f0a" icon="folder" />} title="Speicherorte" sub="Immich, Nextcloud" value={storeVal || undefined} onClick={() => go('storage')} />
            </div>

            <div className="ios-card">
              <Row tile={<Tile color="#8e8e93" icon="shield" />} title="Sicherheit" value={me.totp ? '2FA an' : '2FA aus'} onClick={() => go('security')} />
            </div>

            {me.admin && <>
              <p className="ios-caption">Verwaltung</p>
              <div className="ios-card">
                <Row tile={<Tile color="#ff9500" icon="users" />} title="Profile" onClick={() => go('profiles')} />
                <Row tile={<Tile color="#5856d6" icon="server" />} title="Server" value={server.version} onClick={() => go('server')} />
              </div>
            </>}

            <div className="ios-card">
              <Row tile={<Tile color="#636366" icon="info" />} title="Über Chorus" value={server.version} onClick={() => go('about')} />
            </div>

            <div className="ios-card">
              <button className="ios-row center danger" onClick={logout}><span className="ios-row-main"><span className="ios-title">Auf diesem Gerät abmelden</span></span></button>
            </div>
          </div>
        </div>

        {anim.mounted && (
          <div ref={pageRef} className={`ios-layer ios-page${anim.closing ? ' out' : ''}`}
            onTouchStart={onTouchStart} onTouchMove={onTouchMove} onTouchEnd={onTouchEnd}>
            <header className="ios-head">
              <button className="ios-back" onClick={back}><Icon name="back" size={22} /><span>{shown?.startsWith('acc:') ? 'Messenger' : 'Zurück'}</span></button>
              <h2>{title}</h2>
              <button className="icon-btn" onClick={onClose} aria-label="Schließen"><Icon name="close" /></button>
            </header>
            <div className="ios-scroll">{renderPage()}</div>
          </div>
        )}
      </div>
    </div>
  );
}

/** Kurzstatus aller Messenger für die Hauptliste */
function AccountsBadge({ accounts }: { accounts: Account[] }) {
  const bad = accounts.filter((a) => a.status.state !== 'connected').length;
  if (!bad) return <span className="state connected">{accounts.length === 1 ? 'Verbunden' : `${accounts.length} verbunden`}</span>;
  return <span className="state error">{bad === 1 ? '1 braucht dich' : `${bad} brauchen dich`}</span>;
}

function ago(t: number): string {
  if (!t) return 'noch nie';
  const s = Math.round((Date.now() - t) / 1000);
  if (s < 60) return 'gerade eben';
  const m = Math.round(s / 60); if (m < 60) return `vor ${m} Min.`;
  const h = Math.round(m / 60); if (h < 24) return `vor ${h} Std.`;
  return new Date(t).toLocaleDateString();
}

/** Messenger-Übersicht: Status, Abgleich, Konten */
function AccountsPage({ accounts, sync, lastSync, onSync, onOpen, onAdd }: {
  accounts: Account[]; sync: 'idle' | 'busy' | 'fail'; lastSync: number; onSync: () => void; onOpen: (id: string) => void; onAdd: () => void;
}) {
  const [, tick] = useState(0);
  useEffect(() => { const t = setInterval(() => tick((x) => x + 1), 30_000); return () => clearInterval(t); }, []);
  const bad = accounts.filter((a) => a.status.state !== 'connected');
  const ok = accounts.length > 0 && !bad.length;
  return (
    <>
      <div className="ios-card sync-card">
        <span className={`sync-dot${ok ? ' ok' : accounts.length ? ' warn' : ''}`}><Icon name={ok ? 'check' : 'alert'} size={18} /></span>
        <span className="sync-text">
          <b>{!accounts.length ? 'Noch kein Messenger verbunden' : ok ? 'Alles verbunden' : bad.length === 1 ? `${bad[0].label} braucht dich` : `${bad.length} Messenger brauchen dich`}</b>
          <small>{sync === 'busy' ? 'Gleiche ab …' : sync === 'fail' ? 'Abgleich fehlgeschlagen' : `Abgeglichen ${ago(lastSync)}`}</small>
        </span>
        {accounts.length > 0 && (
          <button className={`btn sync-btn${sync === 'busy' ? ' busy' : ''}`} onClick={onSync} disabled={sync === 'busy'} title="Holt verpasste Nachrichten von allen Messengern">
            <Icon name="refresh" size={16} /><span>Abgleichen</span>
          </button>
        )}
      </div>
      <p className="ios-foot" style={{ marginTop: -18 }}>Chorus empfängt laufend. Abgleichen holt zusätzlich alles nach, was unterwegs verpasst wurde.</p>

      <p className="ios-caption">Verbunden</p>
      <div className="ios-card">
        {accounts.map((a) => (
          <Row key={a.id} tile={<Tile color={NETWORKS[a.network].color} letter={NETWORKS[a.network].short} />}
            title={a.label} sub={a.status.self && a.status.state === 'connected' ? a.status.self : NETWORKS[a.network].name}
            value={<span className={`state ${a.status.state}`}>{STATE_TEXT[a.status.state]}</span>} onClick={() => onOpen(a.id)} />
        ))}
        <Row tile={<Tile color="#34c759" icon="plus" />} title="Messenger hinzufügen" onClick={onAdd} />
      </div>
    </>
  );
}

/** Unterseite für einen verbundenen Messenger */
function AccountPage({ acc, onBack }: { acc: Account; onBack: () => void }) {
  const [fix, setFix] = useState(acc.status.state !== 'connected');
  const n = NETWORKS[acc.network];
  return (
    <>
      <div className="ios-hero">
        <span className="ios-icon xl" style={{ background: n.color }}><b>{n.short}</b></span>
        <h3>{acc.label}</h3>
        <small className={`state ${acc.status.state}`}>{acc.status.self ? `${acc.status.self} · ` : ''}{STATE_TEXT[acc.status.state]}{acc.status.state === 'error' && acc.status.message ? `: ${acc.status.message}` : ''}</small>
      </div>
      {fix && acc.status.state !== 'connected' && <div className="ios-card pad"><LinkStatus acc={acc} onClose={() => setFix(false)} /></div>}
      <div className="ios-card">
        {acc.status.state !== 'connected' && !fix && <Row tile={<Tile color="#ff9500" icon="key" />} title="Anmeldung beheben" onClick={() => setFix(true)} />}
        <Row tile={<Tile color="#007aff" icon="refresh" />} title="Neu verbinden" chevron={false} onClick={() => api.restartAccount(acc.id)} />
      </div>
      {acc.network === 'email' && <div className="ios-card pad"><EmailSettings id={acc.id} /></div>}
      <div className="ios-card">
        <Row title="Messenger trennen" danger chevron={false}
          onClick={async () => { if (confirm(`${acc.label} wirklich trennen? Die Chats werden aus Chorus gelöscht (nicht auf dem Handy).`)) { await api.removeAccount(acc.id); onBack(); } }} />
      </div>
      <p className="ios-foot">Beim Trennen werden nur die Daten in Chorus gelöscht. Auf deinem Handy bleibt alles, wie es ist.</p>
    </>
  );
}

/** E-Mail: Signaturen, Newsletter, Zugangsdaten */
function EmailSettings({ id }: { id: string }) {
  const [c, setC] = useState<(EmailConfig & { password?: string }) | null>(null);
  const [others, setOthers] = useState('');
  const [msg, setMsg] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => { api.emailConfig(id).then((x) => { setC(x); setOthers((x.hideSignatures ?? []).join('\n\n---\n\n')); }).catch((e) => setMsg(e.message)); }, [id]);
  if (!c) return <small className="muted">{msg || 'Lade …'}</small>;
  const set = (k: keyof EmailConfig | 'password') => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => setC({ ...c, [k]: e.target.value });
  const save = async () => {
    setBusy(true); setMsg('');
    try {
      await api.setEmailConfig(id, { ...c, imapPort: Number(c.imapPort) || 993, smtpPort: Number(c.smtpPort) || 465, hideSignatures: others.split(/\n\s*---\s*\n/).map((x) => x.trim()).filter(Boolean) });
      setC({ ...c, password: '' }); setMsg('Gespeichert. Das Postfach wird neu verbunden.');
    } catch (e: any) { setMsg(e.message); } finally { setBusy(false); }
  };
  return (
    <div className="stack">
      <label className="field"><span>Meine Signatur</span>
        <textarea className="input" rows={4} value={c.signature ?? ''} onChange={set('signature')} placeholder={'Viele Grüße\nWayne'} />
      </label>
      <small className="muted">Wird an jede gesendete Mail angehängt und in den Blasen nicht angezeigt.</small>
      <label className="field"><span>Signaturen anderer ausblenden</span>
        <textarea className="input" rows={5} value={others} onChange={(e) => setOthers(e.target.value)} placeholder={'Anna Berger\nMusterfirma GmbH\nTel. 0170 …\n---\nnächste Signatur'} />
      </label>
      <small className="muted">Signaturen einfach hineinkopieren, mehrere durch eine Zeile mit „---“ trennen. Ab der ersten Zeile einer Signatur wird der Rest der Mail ausgeblendet. Signaturen nach „-- “, „Von meinem iPhone gesendet“ und zitierte Verläufe blendet Chorus ohnehin aus.</small>
      <label className="toggle">
        <input type="checkbox" checked={c.hideBulk !== false} onChange={(e) => setC({ ...c, hideBulk: e.target.checked })} />
        <span><b>Newsletter ausblenden</b><small>Mails mit Abmelde-Link und automatische Mails erscheinen nicht als Chat (gilt für neue Mails).</small></span>
      </label>
      <label className="field"><span>Absendername</span><input className="input" value={c.name ?? ''} onChange={set('name')} /></label>
      <label className="field"><span>Neues (App-)Passwort</span><input className="input" type="password" autoComplete="off" value={c.password ?? ''} onChange={set('password')} placeholder="leer lassen = unverändert" /></label>
      <label className="field"><span>Benutzername</span><input className="input" value={c.user ?? ''} onChange={set('user')} placeholder={c.address} /></label>
      <div className="row" style={{ gap: 8, alignItems: 'flex-end' }}>
        <label className="field grow"><span>IMAP-Server</span><input className="input" value={c.imapHost} onChange={set('imapHost')} /></label>
        <label className="field" style={{ width: 90 }}><span>Port</span><input className="input" inputMode="numeric" value={c.imapPort ?? 993} onChange={set('imapPort')} /></label>
      </div>
      <div className="row" style={{ gap: 8, alignItems: 'flex-end' }}>
        <label className="field grow"><span>SMTP-Server</span><input className="input" value={c.smtpHost} onChange={set('smtpHost')} /></label>
        <label className="field" style={{ width: 90 }}><span>Port</span><input className="input" inputMode="numeric" value={c.smtpPort ?? 465} onChange={set('smtpPort')} /></label>
      </div>
      {msg && <small className="muted">{msg}</small>}
      <button className="btn primary wide" disabled={busy} onClick={save}>{busy ? 'Speichere …' : 'Speichern'}</button>
    </div>
  );
}
