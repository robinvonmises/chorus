import { useEffect, useState } from 'react';
import QRCode from 'qrcode';
import { api, serverText, type Account, type Network, type ServerState } from '../api';
import { NETWORKS } from '../util';
import { Icon } from './Icon';
import { T } from '../i18n';

const ORDER: Network[] = ['whatsapp', 'signal', 'telegram', 'email', 'demo'];

export function AccountWizard({ server, accounts, onClose }: { server: ServerState; accounts: Account[]; onClose: () => void }) {
  const [net, setNet] = useState<Network | null>(null);
  const [accId, setAccId] = useState<string | null>(null);
  const acc = accounts.find((a) => a.id === accId);

  return (
    <div className="modal-bg" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()} role="dialog" aria-label={T('Messenger verbinden')}>
        <header className="modal-head">
          {net && !accId && <button className="icon-btn" onClick={() => setNet(null)} aria-label={T('Zurück')}><Icon name="back" /></button>}
          <h2>{net ? T('{0} verbinden', NETWORKS[net].name) : T('Messenger verbinden')}</h2>
          <button className="icon-btn" onClick={onClose} aria-label={T('Schließen')}><Icon name="close" /></button>
        </header>
        <div className="modal-body">
          {!net && (
            <>
              <p className="lead">{T('Welchen Messenger möchtest du hinzufügen?')}</p>
              <div className="net-grid">
                {ORDER.filter((n) => n !== 'demo' || server.networks.includes('demo')).map((n) => {
                  const avail = server.networks.includes(n);
                  const has = accounts.some((a) => a.network === n);
                  return (
                    <button key={n} className="net-card" disabled={!avail} onClick={() => setNet(n)}>
                      <span className="net-chip big" style={{ background: NETWORKS[n].color }}>{NETWORKS[n].short}</span>
                      <b>{NETWORKS[n].name}</b>
                      <small>{!avail ? T('Kommt bald') : has ? T('Weiteres Konto') : T('Verbinden')}</small>
                    </button>
                  );
                })}
              </div>
            </>
          )}
          {net === 'telegram' && !accId && <TelegramSetup onCreated={setAccId} />}
          {net === 'email' && !accId && <EmailSetup onCreated={setAccId} />}
          {(net === 'signal' || net === 'whatsapp') && !accId && <QrIntro net={net} onCreated={setAccId} />}
          {net === 'demo' && !accId && (
            <div className="stack">
              <p>{T('Der Demo-Messenger zeigt Beispiel-Chats, damit du die App ausprobieren kannst.')}</p>
              <button className="btn primary wide" onClick={async () => setAccId((await api.addAccount('demo', 'Demo', {})).id)}>{T('Demo hinzufügen')}</button>
            </div>
          )}
          {acc && <LinkStatus acc={acc} onClose={onClose} />}
        </div>
      </div>
    </div>
  );
}

function QrIntro({ net, onCreated }: { net: 'signal' | 'whatsapp'; onCreated: (id: string) => void }) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [ok, setOk] = useState(net !== 'whatsapp');
  const [method, setMethod] = useState<'qr' | 'phone'>(matchMedia('(pointer: coarse)').matches && net === 'whatsapp' ? 'phone' : 'qr');
  const go = async () => {
    setBusy(true); setErr('');
    try { onCreated((await api.addAccount(net, NETWORKS[net].name, { loginMethod: method })).id); } catch (e: any) { setErr(e.message); setBusy(false); }
  };
  return (
    <div className="stack">
      <p>{T('Chorus wird als zusätzliches Gerät mit deinem')}{' '}{NETWORKS[net].name}{T('-Konto gekoppelt, so wie')}{' '}{net === 'signal' ? T('Signal Desktop') : T('WhatsApp Web')}{T('. Dein Handy bleibt das Hauptgerät.')}</p>
      <div className="steps">
        <p><b>{T('Du brauchst:')}</b> {T('dein Handy mit')}{' '}{NETWORKS[net].name}{T('. Gleich erscheint ein QR-Code, den du damit scannst.')}</p>
        {net === 'signal' && <p>{T('Hinweis: Signal überträgt keine alten Nachrichten an neue Geräte. Du siehst alles ab jetzt.')}</p>}
        {net === 'whatsapp' && <p>{T('Hinweis: WhatsApp überträgt einen Teil der letzten Chats. Öffne WhatsApp am Handy mindestens alle 14 Tage, sonst wird Chorus abgemeldet.')}</p>}
      </div>
      {net === 'whatsapp' && (
        <div className="field"><span>{T('Koppeln per')}</span>
          <div className="seg">
            <button type="button" className={method === 'qr' ? 'on' : ''} onClick={() => setMethod('qr')}>{T('QR-Code')}<small>{T('Ich bin am Computer')}</small></button>
            <button type="button" className={method === 'phone' ? 'on' : ''} onClick={() => setMethod('phone')}>{T('Code eintippen')}<small>{T('Ich bin am Handy')}</small></button>
          </div>
        </div>
      )}
      {net === 'whatsapp' && (
        <div className="wa-risk">
          <p><b>{T('Bitte kurz lesen:')}</b> {T('Chorus ist kein offizieller WhatsApp-Client, sondern nutzt eine inoffizielle Anbindung (Baileys). Das verstößt gegen die Nutzungsbedingungen von WhatsApp, und WhatsApp kann Konten deshalb sperren.')}</p>
          <p>{T('Bei normaler privater Nutzung kommt das selten vor. Betroffen sind vor allem Konten, die massenhaft oder automatisiert Nachrichten verschicken oder ganz neu sind. Ausschließen lässt sich eine Sperre aber nicht. Die Nutzung erfolgt auf eigenes Risiko.')}</p>
          <label className="wa-risk-ok"><input type="checkbox" checked={ok} onChange={(e) => setOk(e.target.checked)} /> {T('Verstanden, ich verbinde WhatsApp auf eigenes Risiko.')}</label>
        </div>
      )}
      {err && <div className="error">{err}</div>}
      <button className="btn primary wide" disabled={busy || !ok} onClick={go}>{busy ? T('Einen Moment …') : method === 'qr' ? T('QR-Code anzeigen') : T('Weiter')}</button>
    </div>
  );
}

/** Bekannte Anbieter: Server werden aus der Adresse erraten (änderbar) */
const MAIL_PRESETS: [RegExp, string, string, string?][] = [
  [/^(gmail|googlemail)\.com$/, 'imap.gmail.com', 'smtp.gmail.com', T('Gmail: App-Passwort unter myaccount.google.com → Sicherheit → App-Passwörter (2-Faktor muss an sein).')],
  [/^(icloud|me|mac)\.com$/, 'imap.mail.me.com', 'smtp.mail.me.com', T('iCloud: App-Passwort unter account.apple.com → Anmelden und Sicherheit → App-spezifische Passwörter.')],
  [/^(outlook|hotmail|live)\.(com|de)$/, 'outlook.office365.com', 'smtp.office365.com', 'Outlook.com erlaubt Passwort-Anmeldung oft nicht mehr; dann klappt es nur mit einem App-Passwort.'],
  [/^gmx\.(de|net|at|ch)$/, 'imap.gmx.net', 'mail.gmx.net', T('GMX: IMAP-Zugriff in den GMX-Einstellungen unter „POP3/IMAP“ erlauben.')],
  [/^web\.de$/, 'imap.web.de', 'smtp.web.de', T('WEB.DE: IMAP-Zugriff in den Einstellungen unter „POP3/IMAP“ erlauben.')],
  [/^t-online\.de$/, 'secureimap.t-online.de', 'securesmtp.t-online.de', T('Telekom: eigenes E-Mail-Passwort im Kundencenter anlegen.')],
  [/^posteo\.(de|net)$/, 'posteo.de', 'posteo.de'],
  [/^mailbox\.org$/, 'imap.mailbox.org', 'smtp.mailbox.org'],
  [/^(yahoo)\.(com|de)$/, 'imap.mail.yahoo.com', 'smtp.mail.yahoo.com', T('Yahoo: App-Passwort in den Kontosicherheits-Einstellungen anlegen.')],
];

function EmailSetup({ onCreated }: { onCreated: (id: string) => void }) {
  const [f, setF] = useState({ address: '', name: '', password: '', user: '', imapHost: '', imapPort: '993', smtpHost: '', smtpPort: '465' });
  const [more, setMore] = useState(false);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const domain = f.address.split('@')[1]?.toLowerCase() ?? '';
  const preset = MAIL_PRESETS.find(([r]) => r.test(domain));
  const set = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement>) => setF({ ...f, [k]: e.target.value });
  const imapHost = f.imapHost || preset?.[1] || (domain ? `imap.${domain}` : '');
  const smtpHost = f.smtpHost || preset?.[2] || (domain ? `smtp.${domain}` : '');
  const go = async (e: React.FormEvent) => {
    e.preventDefault(); setErr('');
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(f.address.trim())) return setErr(T('Bitte eine gültige E-Mail-Adresse eingeben.'));
    if (!f.password) return setErr(T('Bitte das (App-)Passwort eingeben.'));
    setBusy(true);
    try {
      const a = await api.addAccount('email', f.address.trim(), {
        address: f.address.trim(), name: f.name.trim() || undefined, user: f.user.trim() || undefined, password: f.password,
        imapHost, imapPort: Number(f.imapPort) || 993, smtpHost, smtpPort: Number(f.smtpPort) || 465, hideBulk: true, days: 30,
      });
      onCreated(a.id);
    } catch (e: any) { setErr(e.message); } finally { setBusy(false); }
  };
  return (
    <form className="stack" onSubmit={go}>
      <p>{T('Chorus holt deine Mails per IMAP ab und sendet Antworten per SMTP. Jeder Absender erscheint wie ein Kontakt, darin die einzelnen Betreffe als Chats.')}</p>
      <label className="field"><span>{T('E-Mail-Adresse')}</span><input className="input" type="email" autoComplete="email" value={f.address} onChange={set('address')} placeholder="du@example.de" /></label>
      <label className="field"><span>{T('Dein Name (als Absender)')}</span><input className="input" value={f.name} onChange={set('name')} placeholder={T('z. B. Wayne von Ometzinski')} /></label>
      <label className="field"><span>{T('Passwort oder App-Passwort')}</span><input className="input" type="password" autoComplete="off" value={f.password} onChange={set('password')} /></label>
      {preset?.[3] && <small className="muted">{preset[3]}</small>}
      {!more && <button type="button" className="btn small ghost" onClick={() => setMore(true)}>{T('Server:')}{' '}{imapHost || '…'} / {smtpHost || '…'} {T('ändern')}</button>}
      {more && <>
        <label className="field"><span>{T('Benutzername (falls nicht die Adresse)')}</span><input className="input" value={f.user} onChange={set('user')} autoComplete="off" /></label>
        <div className="row" style={{ gap: 8, alignItems: 'flex-end' }}>
          <label className="field grow"><span>{T('IMAP-Server')}</span><input className="input" value={f.imapHost} onChange={set('imapHost')} placeholder={imapHost} /></label>
          <label className="field" style={{ width: 90 }}><span>{T('Port')}</span><input className="input" inputMode="numeric" value={f.imapPort} onChange={set('imapPort')} /></label>
        </div>
        <div className="row" style={{ gap: 8, alignItems: 'flex-end' }}>
          <label className="field grow"><span>{T('SMTP-Server')}</span><input className="input" value={f.smtpHost} onChange={set('smtpHost')} placeholder={smtpHost} /></label>
          <label className="field" style={{ width: 90 }}><span>{T('Port')}</span><input className="input" inputMode="numeric" value={f.smtpPort} onChange={set('smtpPort')} /></label>
        </div>
        <small className="muted">{T('Port 993 = IMAP mit SSL, 465 = SMTP mit SSL, 587 = SMTP mit STARTTLS.')}</small>
      </>}
      <small className="muted">{T('Beim ersten Abruf holt Chorus die Mails der letzten 30 Tage. Newsletter werden ausgeblendet (in den Einstellungen änderbar).')}</small>
      {err && <div className="error">{err}</div>}
      <button className="btn primary wide" disabled={busy}>{busy ? T('Verbinde …') : T('Verbinden')}</button>
    </form>
  );
}

function TelegramSetup({ onCreated }: { onCreated: (id: string) => void }) {
  const [apiId, setApiId] = useState('');
  const [apiHash, setApiHash] = useState('');
  const [method, setMethod] = useState<'qr' | 'phone'>(matchMedia('(pointer: coarse)').matches ? 'phone' : 'qr');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);

  const go = async (e: React.FormEvent) => {
    e.preventDefault();
    setErr('');
    if (!/^\d{3,12}$/.test(apiId.trim())) return setErr(T('Die api_id besteht nur aus Ziffern.'));
    if (!/^[0-9a-f]{32}$/i.test(apiHash.trim())) return setErr(T('Der api_hash ist 32 Zeichen lang (0–9, a–f).'));
    setBusy(true);
    try {
      const a = await api.addAccount('telegram', 'Telegram', { apiId: Number(apiId.trim()), apiHash: apiHash.trim(), loginMethod: method });
      onCreated(a.id);
    } catch (e: any) { setErr(e.message); } finally { setBusy(false); }
  };

  return (
    <form className="stack" onSubmit={go}>
      <div className="steps">
        <p><b>{T('Schritt 1:')}</b> {T('Öffne')}{' '}<a href="https://my.telegram.org/apps" target="_blank" rel="noreferrer">{T('my.telegram.org/apps')}</a> {T('und melde dich mit deiner Telefonnummer an.')}</p>
        <p><b>{T('Schritt 2:')}</b> {T('Lege eine App an. Name und Kurzname sind egal, zum Beispiel „Chorus“. Plattform: „Web“.')}</p>
        <p><b>{T('Schritt 3:')}</b> {T('Kopiere')}{' '}<b>{T('App api_id')}</b> {T('und')}{' '}<b>{T('App api_hash')}</b> {T('hier hinein.')}</p>
      </div>
      <label className="field"><span>{T('api_id')}</span><input className="input" inputMode="numeric" value={apiId} onChange={(e) => setApiId(e.target.value)} placeholder="z. B. 1234567" /></label>
      <label className="field"><span>{T('api_hash')}</span><input className="input mono" value={apiHash} onChange={(e) => setApiHash(e.target.value)} placeholder={T('32 Zeichen')} autoComplete="off" /></label>
      <div className="field"><span>{T('Anmelden per')}</span>
        <div className="seg">
          <button type="button" className={method === 'qr' ? 'on' : ''} onClick={() => setMethod('qr')}>{T('QR-Code')}<small>{T('Ich bin am Computer')}</small></button>
          <button type="button" className={method === 'phone' ? 'on' : ''} onClick={() => setMethod('phone')}>{T('Telefonnummer')}<small>{T('Ich bin am Handy')}</small></button>
        </div>
      </div>
      {err && <div className="error">{err}</div>}
      <button className="btn primary wide" disabled={busy}>{busy ? T('Verbinde …') : T('Weiter')}</button>
    </form>
  );
}

/** Zeigt live den Anmeldestatus: QR-Code, Eingabefelder, Erfolg */
export function LinkStatus({ acc, onClose }: { acc: Account; onClose: () => void }) {
  const [qrImg, setQrImg] = useState<string | null>(null);
  const [val, setVal] = useState('');
  const [err, setErr] = useState('');
  const s = acc.status;

  useEffect(() => {
    if (s.state === 'qr' && s.qr) QRCode.toDataURL(s.qr, { margin: 1, width: 280, errorCorrectionLevel: 'M' }).then(setQrImg);
  }, [s.state, s.qr]);
  useEffect(() => { setVal(''); }, [s.field]);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault(); setErr('');
    try { await api.input(acc.id, s.field!, val); } catch (e: any) { setErr(e.message); }
  };

  if (s.state === 'connected') return (
    <div className="stack center">
      <div className="success-icon"><Icon name="check" size={36} /></div>
      <h3>{NETWORKS[acc.network].name} {T('ist verbunden')}</h3>
      <p>{T('Deine Chats werden jetzt geladen. Das kann beim ersten Mal ein paar Minuten dauern.')}</p>
      <button className="btn primary wide" onClick={onClose}>{T('Zu den Chats')}</button>
    </div>
  );
  if (s.state === 'qr' && s.code) return (
    <div className="stack center">
      <p>{T('Gib diesen Code auf deinem Handy ein:')}</p>
      <div className="pair-code">{s.code}</div>
      <ol className="qr-steps">
        <li>{T('Öffne WhatsApp → Einstellungen →')}{' '}<b>{T('Verknüpfte Geräte')}</b></li>
        <li>{T('Tippe auf „Gerät hinzufügen“')}</li>
        <li>{T('Wähle unten „')}<b>{T('Stattdessen mit Telefonnummer verknüpfen')}</b>{T('“ und tippe den Code ein')}</li>
      </ol>
    </div>
  );
  if (s.state === 'qr') return (
    <div className="stack center">
      {qrImg ? <img className="qr" src={qrImg} alt={T('QR-Code')} width={280} height={280} /> : <div className="qr placeholder" />}
      <ol className="qr-steps">
        {acc.network === 'telegram' && <><li>{T('Öffne Telegram auf deinem Handy')}</li><li>{T('Einstellungen → Geräte →')}{' '}<b>{T('Desktop-Gerät verbinden')}</b></li><li>{T('Halte die Kamera auf diesen Code')}</li></>}
        {acc.network === 'whatsapp' && <><li>{T('Öffne WhatsApp auf deinem Handy')}</li><li>{T('Einstellungen →')}{' '}<b>{T('Verknüpfte Geräte')}</b> {T('→ Gerät hinzufügen')}</li><li>{T('Halte die Kamera auf diesen Code')}</li></>}
        {acc.network === 'signal' && <><li>{T('Öffne Signal auf deinem Handy')}</li><li>{T('Einstellungen →')}{' '}<b>{T('Gekoppelte Geräte')}</b> → +</li><li>{T('Halte die Kamera auf diesen Code')}</li></>}
      </ol>
      <small className="muted">{T('Der Code erneuert sich automatisch.')}</small>
    </div>
  );
  if (s.state === 'need_input') {
    const labels = { phone: ['Telefonnummer', '+49 170 1234567', 'tel'], code: [T('Bestätigungscode'), '12345', 'numeric'], password: [T('Passwort'), '', 'text'], api: ['Wert', '', 'text'] } as const;
    const [label, ph, mode] = labels[s.field ?? 'api'];
    return (
      <form className="stack" onSubmit={submit}>
        {s.message && <p>{serverText(s.message)}</p>}
        <label className="field"><span>{label}</span>
          <input className="input" autoFocus type={s.field === 'password' ? 'password' : 'text'} inputMode={mode as any} placeholder={ph} value={val} onChange={(e) => setVal(e.target.value)} />
        </label>
        {s.field === 'code' && <small className="muted">{T('Den Code schickt dir Telegram als Nachricht in der Telegram-App (nicht per SMS).')}</small>}
        {err && <div className="error">{err}</div>}
        <button className="btn primary wide" disabled={!val.trim()}>{T('Weiter')}</button>
      </form>
    );
  }
  if (s.state === 'error') return (
    <div className="stack center">
      <div className="error">{s.message ? serverText(s.message) : T('Unbekannter Fehler')}</div>
      <button className="btn wide" onClick={() => api.restartAccount(acc.id)}><Icon name="refresh" size={18} /> {T('Nochmal versuchen')}</button>
    </div>
  );
  return <div className="stack center"><div className="spinner" /><p>{T('Verbinde mit')}{' '}{NETWORKS[acc.network].name} …</p></div>;
}
