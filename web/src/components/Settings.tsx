import { useRef, useState, type ReactNode } from 'react';
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
import { BubbleSection } from './BubbleSettings';
import { AdminSection } from './AdminSection';
import { PushSection } from './PushSection';
import { Avatar } from './Rail';
import { loadBubbles } from '../bubbles';
import { useExit } from '../useExit';

const STATE_TEXT: Record<Account['status']['state'], string> = {
  connected: 'Verbunden', connecting: 'Verbinde …', disconnected: 'Getrennt', need_input: 'Anmeldung offen', qr: 'QR-Code scannen', error: 'Fehler',
};

type Page = 'me' | 'ai' | 'push' | 'look' | 'backup' | 'security' | 'profiles' | 'server' | 'about' | `acc:${string}`;

const TITLES: Record<string, string> = {
  me: 'Mein Profil', ai: 'KI-Assistent', push: 'Benachrichtigungen', look: 'Darstellung', backup: 'Sicherung',
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

export function Settings({ server, accounts, onClose, onAdd, onLocked, onProfileChanged }: {
  server: ServerState; accounts: Account[]; onClose: () => void; onAdd: () => void; onLocked: () => void; onProfileChanged: () => void;
}) {
  const me = server.profile!;
  const [comfort, setComfort] = useState(me.comfort);
  const pid = me.id;
  const [pw, setPw] = useState({ a: '', b: '', msg: '' });
  const [page, setPage] = useState<Page | null>(null);
  const [last, setLast] = useState<Page | null>(null);
  const anim = useExit(!!page, 320);
  const shown = page ?? last;
  const go = (p: Page) => { setLast(p); setPage(p); };
  const back = () => setPage(null);

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
      case 'me': return <div className="ios-card pad"><MyProfile server={server} onChanged={onProfileChanged} /></div>;
      case 'ai': return <div className="ios-card pad"><AiSettingsSection /></div>;
      case 'push': return <div className="ios-card pad"><PushSection /></div>;
      case 'look': return <div className="ios-card pad"><BubbleSection nets={[...new Set(accounts.map((a) => a.network))]} /></div>;
      case 'backup': return <div className="ios-card pad"><BackupSection /></div>;
      case 'profiles': return <div className="ios-card pad"><ProfilesSection key={`${me.name}:${me.avatar}`} server={server} onRenamed={onProfileChanged} /></div>;
      case 'server': return <div className="ios-card pad"><AdminSection /></div>;
      case 'about': return <div className="ios-card pad"><p className="muted">Chorus {server.version}. Deine Daten liegen verschlüsselt auf deinem eigenen Server.</p></div>;
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

            <p className="ios-caption">Messenger</p>
            <div className="ios-card">
              {accounts.map((a) => (
                <Row key={a.id} tile={<Tile color={NETWORKS[a.network].color} letter={NETWORKS[a.network].short} />}
                  title={a.label} sub={a.status.self && a.status.state === 'connected' ? a.status.self : undefined}
                  value={<span className={`state ${a.status.state}`}>{STATE_TEXT[a.status.state]}</span>} onClick={() => go(`acc:${a.id}`)} />
              ))}
              <Row tile={<Tile color="#34c759" icon="plus" />} title="Messenger hinzufügen" onClick={onAdd} />
            </div>

            <div className="ios-card">
              <Row tile={<Tile color="#af52de" icon="sparkle" />} title="KI-Assistent" onClick={() => go('ai')} />
              <Row tile={<Tile color="#ff3b30" icon="bell" />} title="Benachrichtigungen" value={pushOn ? 'Push an' : undefined} onClick={() => go('push')} />
              <Row tile={<Tile color="#007aff" icon="palette" />} title="Darstellung" value={bubbleMode} onClick={() => go('look')} />
              <Row tile={<Tile color="#30b0c7" icon="cloud" />} title="Sicherung" onClick={() => go('backup')} />
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
              <button className="ios-back" onClick={back}><Icon name="back" size={22} /><span>Zurück</span></button>
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
      <div className="ios-card">
        <Row title="Messenger trennen" danger chevron={false}
          onClick={async () => { if (confirm(`${acc.label} wirklich trennen? Die Chats werden aus Chorus gelöscht (nicht auf dem Handy).`)) { await api.removeAccount(acc.id); onBack(); } }} />
      </div>
      <p className="ios-foot">Beim Trennen werden nur die Daten in Chorus gelöscht. Auf deinem Handy bleibt alles, wie es ist.</p>
    </>
  );
}
