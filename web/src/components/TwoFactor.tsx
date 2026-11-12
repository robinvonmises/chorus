import { useState } from 'react';
import QRCode from 'qrcode';
import { api } from '../api';
import { trustStore } from '../keys';
import { T } from '../i18n';

/** Zwei-Faktor-Anmeldung (Authenticator-App) ein- und ausschalten */
export function TwoFactor({ enabled: initial, profileId }: { enabled: boolean; profileId: string }) {
  const [enabled, setEnabled] = useState(initial);
  const [setup, setSetup] = useState<{ secret: string; qr: string } | null>(null);
  const [code, setCode] = useState('');
  const [msg, setMsg] = useState('');
  const [busy, setBusy] = useState(false);
  const [disabling, setDisabling] = useState(false);

  const run = async (fn: () => Promise<void>) => {
    setBusy(true); setMsg('');
    try { await fn(); } catch (e: any) { setMsg(e.message ?? String(e)); } finally { setBusy(false); }
  };

  const start = () => run(async () => {
    const r = await api.totpSetup();
    setSetup({ secret: r.secret, qr: await QRCode.toDataURL(r.uri, { margin: 1, width: 220, errorCorrectionLevel: 'M' }) });
    setCode('');
  });
  const enable = (e: React.FormEvent) => { e.preventDefault(); run(async () => {
    const r = await api.totpEnable(code.replace(/\s/g, ''));
    trustStore.set(profileId, r.trust);
    setEnabled(true); setSetup(null); setCode('');
    setMsg(T('Zwei-Faktor-Anmeldung ist aktiv. Andere Geräte wurden abgemeldet.'));
  }); };
  const disable = (e: React.FormEvent) => { e.preventDefault(); run(async () => {
    await api.totpDisable(code.replace(/\s/g, ''));
    setEnabled(false); setDisabling(false); setCode('');
    setMsg(T('Zwei-Faktor-Anmeldung ist aus.'));
  }); };

  const codeInput = <input className="input otp-input" inputMode="numeric" pattern="[0-9 ]*" maxLength={7} placeholder={T('Code (6 Ziffern)')}
    value={code} onChange={(e) => setCode(e.target.value)} autoComplete="one-time-code" />;

  return (
    <div className="stack tfa">
      <b>{T('Zwei-Faktor-Anmeldung')}{' '}{enabled ? <span className="tfa-badge ok">{T('aktiv')}</span> : <span className="tfa-badge warn">{T('aus')}</span>}</b>
      {!enabled && !setup && <>
        <small className="muted">{T('Zusätzlich zum Passwort fragt Chorus nach einem Code aus einer Authenticator-App (z. B. 2FAS, Aegis, Google Authenticator, 1Password). Wer nur dein Passwort kennt, kommt dann nicht rein.')}</small>
        <button className="btn primary" disabled={busy} onClick={start}>{T('Einrichten')}</button>
      </>}
      {setup && <form className="stack" onSubmit={enable}>
        <small>{T('1. Scanne den QR-Code mit deiner Authenticator-App.')}</small>
        <img className="tfa-qr" src={setup.qr} alt={T('QR-Code für die Authenticator-App')} width={220} height={220} />
        <details><summary>{T('Kein Scannen möglich? Schlüssel anzeigen')}</summary><code className="tfa-secret">{setup.secret.match(/.{1,4}/g)!.join(' ')}</code></details>
        <small>{T('2. Gib den Code ein, den die App jetzt anzeigt.')}</small>
        {codeInput}
        <div className="row gap">
          <button className="btn primary" disabled={busy || code.replace(/\s/g, '').length !== 6}>{T('Aktivieren')}</button>
          <button type="button" className="btn ghost" onClick={() => { setSetup(null); setMsg(''); }}>{T('Abbrechen')}</button>
        </div>
      </form>}
      {enabled && !disabling && <>
        <small className="muted">{T('Beim Anmelden auf einem neuen Gerät brauchst du den Code aus der App. Geräte mit „30 Tage vertrauen“ fragen erst danach wieder. Handy verloren? Mit dem Wiederherstellungscode kommst du trotzdem rein, die Zwei-Faktor-Anmeldung wird dabei ausgeschaltet.')}</small>
        <button className="btn ghost" onClick={() => { setDisabling(true); setCode(''); setMsg(''); }}>{T('Ausschalten …')}</button>
      </>}
      {enabled && disabling && <form className="stack" onSubmit={disable}>
        <small>{T('Zum Ausschalten den aktuellen Code eingeben.')}</small>
        {codeInput}
        <div className="row gap">
          <button className="btn danger" disabled={busy || code.replace(/\s/g, '').length !== 6}>{T('Ausschalten')}</button>
          <button type="button" className="btn ghost" onClick={() => setDisabling(false)}>{T('Abbrechen')}</button>
        </div>
      </form>}
      {msg && <small className="tfa-msg">{msg}</small>}
    </div>
  );
}
