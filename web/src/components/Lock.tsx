import { useMemo, useState } from 'react';
import { api, type PublicProfile, type ServerState } from '../api';
import { deriveKey, keyStore, lastProfile, newSalt, trustStore } from '../keys';
import { Avatar } from './Rail';

const ITER = 600_000;
type Mode = 'pick' | 'setup' | 'unlock' | 'recover';

export function Lock({ state, savedKey, onDone }: { state: ServerState; savedKey?: { profileId: string; key: string } | null; onDone: () => void }) {
  const params = useMemo(() => new URLSearchParams(location.search), []);
  const profiles = state.profiles;
  const first = profiles.length === 0;

  // Vorauswahl: Einladungslink > Profil mit gespeichertem Schlüssel > zuletzt benutzt > einziges Profil
  const initial = useMemo(() => {
    const ids = [params.get('p'), savedKey?.profileId, lastProfile.get(), profiles.length === 1 ? profiles[0].id : null];
    for (const id of ids) { const p = profiles.find((x) => x.id === id); if (p) return p; }
    return null;
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const [profile, setProfile] = useState<PublicProfile | null>(initial);
  const [mode, setMode] = useState<Mode>(first ? 'setup' : !initial ? 'pick' : initial.initialized ? 'unlock' : 'setup');
  const [name, setName] = useState('');
  const [invite, setInvite] = useState(params.get('invite') ?? '');
  const [pw, setPw] = useState('');
  const [pw2, setPw2] = useState('');
  const [code, setCode] = useState('');
  const [otp, setOtp] = useState('');
  const [remember, setRemember] = useState(true);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [recovery, setRecovery] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [useSaved, setUseSaved] = useState(!!savedKey && savedKey.profileId === initial?.id);

  const needOtp = mode === 'unlock' && !!profile?.totp;
  const needInvite = mode === 'setup' && !!profile?.invite;

  const choose = (p: PublicProfile) => {
    setProfile(p); setErr(''); setPw(''); setPw2(''); setOtp('');
    setUseSaved(!!savedKey && savedKey.profileId === p.id);
    setMode(p.initialized ? 'unlock' : 'setup');
  };
  const backToPick = () => { setProfile(null); setMode('pick'); setErr(''); setUseSaved(false); };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setErr('');
    if (mode === 'setup' && first && !name.trim()) return setErr('Wie heißt du? Der Name erscheint bei der Anmeldung.');
    if (needInvite && !invite.trim()) return setErr('Bitte den Einladungscode eingeben, den du bekommen hast.');
    if (mode === 'setup' || mode === 'recover') {
      if (pw.length < 8) return setErr('Bitte mindestens 8 Zeichen.');
      if (pw !== pw2) return setErr('Die beiden Passwörter stimmen nicht überein.');
    }
    if (needOtp && !/^\d{6}$/.test(otp.replace(/\s/g, ''))) return setErr('Bitte den 6-stelligen Code aus deiner Authenticator-App eingeben.');
    setBusy(true);
    try {
      if (mode === 'setup') {
        const salt = newSalt();
        const key = await deriveKey(pw, salt, ITER);
        const r = await api.setup({ profileId: profile?.id, name: first ? name.trim() : undefined, invite: invite || undefined, salt, key });
        lastProfile.set(r.profileId);
        if (remember) await keyStore.set(r.profileId, key);
        if (params.has('invite')) history.replaceState(null, '', '/');
        setRecovery(r.recoveryCode);
      } else if (mode === 'unlock' && profile) {
        const key = useSaved && savedKey ? savedKey.key : await deriveKey(pw, profile.kdf!.salt, profile.kdf!.iterations);
        const r = await api.unlock(profile.id, key, needOtp ? otp.replace(/\s/g, '') : undefined, remember);
        trustStore.set(profile.id, r.trust);
        lastProfile.set(profile.id);
        if (remember) await keyStore.set(profile.id, key); else await keyStore.clear(profile.id);
        onDone();
      } else if (mode === 'recover' && profile) {
        const salt = newSalt();
        const key = await deriveKey(pw, salt, ITER);
        await api.recover(profile.id, code, salt, key);
        lastProfile.set(profile.id);
        if (remember) await keyStore.set(profile.id, key);
        onDone();
      }
    } catch (e: any) {
      setErr(e.message ?? String(e));
    } finally {
      setBusy(false);
    }
  };

  if (recovery) {
    return (
      <div className="lock">
        <div className="lock-card">
          <Logo />
          <h1>Fast fertig</h1>
          <p>Das ist dein <b>Wiederherstellungscode</b>. Falls du dein Passwort vergisst, ist er der einzige Weg zurück an deine Daten. Schreib ihn auf oder speichere ihn im Passwort-Manager.</p>
          <div className="recovery-code">{recovery}</div>
          <div className="row gap">
            <button type="button" className="btn ghost" onClick={() => navigator.clipboard?.writeText(recovery)}>Kopieren</button>
            <button type="button" className="btn ghost" onClick={() => window.print()}>Drucken</button>
          </div>
          <label className="check"><input type="checkbox" checked={saved} onChange={(e) => setSaved(e.target.checked)} /> Ich habe den Code sicher aufbewahrt</label>
          <button className="btn primary wide" disabled={!saved} onClick={onDone}>Weiter</button>
        </div>
      </div>
    );
  }

  if (mode === 'pick') {
    return (
      <div className="lock">
        <div className="lock-card">
          <Logo />
          <h1>Wer bist du?</h1>
          <div className="profile-pick">
            {profiles.map((p) => (
              <button key={p.id} className="profile-btn" onClick={() => choose(p)}>
                <Avatar name={p.name} size={56} src={p.avatar} />
                <span>{p.name}</span>
                {!p.initialized && <small>Einladung</small>}
              </button>
            ))}
          </div>
        </div>
      </div>
    );
  }

  const switcher = profiles.length > 1 && profile && (
    <button type="button" className="profile-current" onClick={backToPick} title="Anderes Profil wählen">
      <Avatar name={profile.name} size={36} src={profile.avatar} /><span><b>{profile.name}</b><small>Profil wechseln</small></span>
    </button>
  );

  return (
    <div className="lock">
      <form className="lock-card" onSubmit={submit}>
        <Logo />
        {mode === 'setup' && first && <>
          <h1>Willkommen bei Chorus</h1>
          <p>Lege dein Profil an. Mit deinem Passwort werden deine Chats und Zugangsdaten verschlüsselt. Ohne dieses Passwort kann niemand sie lesen, auch nicht der Server.</p>
          <input className="input" placeholder="Dein Name" value={name} onChange={(e) => setName(e.target.value)} autoFocus autoComplete="nickname" />
        </>}
        {mode === 'setup' && !first && profile && <>
          {switcher}
          <h1>Hallo {profile.name}!</h1>
          <p>Lege dein eigenes Passwort fest. Damit werden deine Chats verschlüsselt, nur du kannst sie lesen.</p>
          {needInvite && <input className="input otp-input" placeholder="Einladungscode" value={invite} onChange={(e) => setInvite(e.target.value.toUpperCase())} autoComplete="off" autoCapitalize="characters" />}
        </>}
        {mode === 'unlock' && <>
          {switcher}
          <h1>{profiles.length > 1 && profile ? `Hallo ${profile.name}` : 'Entsperren'}</h1>
          <p>{useSaved ? 'Gib den Code aus deiner Authenticator-App ein.' : needOtp ? 'Gib dein Passwort und den Code aus deiner Authenticator-App ein.' : 'Gib dein Passwort ein.'}</p>
        </>}
        {mode === 'recover' && <>
          {switcher}
          <h1>Passwort vergessen</h1>
          <p>Gib deinen Wiederherstellungscode ein und lege ein neues Passwort fest.{profile?.totp ? ' Die Zwei-Faktor-Anmeldung wird dabei ausgeschaltet. Richte sie danach neu ein.' : ''}</p>
          <input className="input" placeholder="XXXX-XXXX-XXXX-XXXX-XXXX-XXXX" value={code} onChange={(e) => setCode(e.target.value)} autoFocus />
        </>}
        {profile && <input type="text" name="username" autoComplete="username" value={profile.name} readOnly hidden />}
        {!(mode === 'unlock' && useSaved) && <input className="input" type="password" placeholder={mode === 'unlock' ? 'Passwort' : 'Neues Passwort'} value={pw}
          onChange={(e) => setPw(e.target.value)} autoFocus={mode === 'unlock' || (mode === 'setup' && !first && !needInvite)} autoComplete={mode === 'unlock' ? 'current-password' : 'new-password'} />}
        {(mode === 'setup' || mode === 'recover') && <input className="input" type="password" placeholder="Passwort wiederholen" value={pw2} onChange={(e) => setPw2(e.target.value)} autoComplete="new-password" />}
        {needOtp && <input className="input otp-input" inputMode="numeric" pattern="[0-9 ]*" maxLength={7} placeholder="Code (6 Ziffern)"
          value={otp} onChange={(e) => setOtp(e.target.value)} autoComplete="one-time-code" autoFocus={useSaved} />}
        {!(mode === 'unlock' && useSaved) && <label className="check"><input type="checkbox" checked={remember} onChange={(e) => setRemember(e.target.checked)} /> {needOtp ? 'Diesem Gerät 30 Tage vertrauen' : 'Auf diesem Gerät angemeldet bleiben'}</label>}
        {err && <div className="error">{err}</div>}
        <button className="btn primary wide" disabled={busy}>{busy ? 'Einen Moment …' : mode === 'setup' ? (first ? 'Einrichten' : 'Passwort festlegen') : mode === 'unlock' ? 'Entsperren' : 'Zurücksetzen'}</button>
        {mode === 'unlock' && useSaved && profile && <button type="button" className="link" onClick={async () => { await keyStore.clear(profile.id); setUseSaved(false); setErr(''); }}>Mit Passwort anmelden</button>}
        {mode === 'unlock' && !useSaved && <button type="button" className="link" onClick={() => { setMode('recover'); setErr(''); }}>{profile?.totp ? 'Passwort oder Handy verloren?' : 'Passwort vergessen?'}</button>}
        {mode === 'recover' && <button type="button" className="link" onClick={() => { setMode('unlock'); setErr(''); }}>Zurück</button>}
      </form>
    </div>
  );
}

export function Logo() {
  return <img src="/icon.svg" alt="" className="logo" width={56} height={56} />;
}
