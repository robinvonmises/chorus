import { useEffect, useState } from 'react';
import QRCode from 'qrcode';
import { api, type Account, type Network, type ServerState } from '../api';
import { NETWORKS } from '../util';
import { Icon } from './Icon';

const ORDER: Network[] = ['whatsapp', 'signal', 'telegram', 'demo'];

export function AccountWizard({ server, accounts, onClose }: { server: ServerState; accounts: Account[]; onClose: () => void }) {
  const [net, setNet] = useState<Network | null>(null);
  const [accId, setAccId] = useState<string | null>(null);
  const acc = accounts.find((a) => a.id === accId);

  return (
    <div className="modal-bg" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()} role="dialog" aria-label="Messenger verbinden">
        <header className="modal-head">
          {net && !accId && <button className="icon-btn" onClick={() => setNet(null)} aria-label="Zurück"><Icon name="back" /></button>}
          <h2>{net ? `${NETWORKS[net].name} verbinden` : 'Messenger verbinden'}</h2>
          <button className="icon-btn" onClick={onClose} aria-label="Schließen"><Icon name="close" /></button>
        </header>
        <div className="modal-body">
          {!net && (
            <>
              <p className="lead">Welchen Messenger möchtest du hinzufügen?</p>
              <div className="net-grid">
                {ORDER.filter((n) => n !== 'demo' || server.networks.includes('demo')).map((n) => {
                  const avail = server.networks.includes(n);
                  const has = accounts.some((a) => a.network === n);
                  return (
                    <button key={n} className="net-card" disabled={!avail} onClick={() => setNet(n)}>
                      <span className="net-chip big" style={{ background: NETWORKS[n].color }}>{NETWORKS[n].short}</span>
                      <b>{NETWORKS[n].name}</b>
                      <small>{!avail ? 'Kommt bald' : has ? 'Weiteres Konto' : 'Verbinden'}</small>
                    </button>
                  );
                })}
              </div>
            </>
          )}
          {net === 'telegram' && !accId && <TelegramSetup onCreated={setAccId} />}
          {(net === 'signal' || net === 'whatsapp') && !accId && <QrIntro net={net} onCreated={setAccId} />}
          {net === 'demo' && !accId && (
            <div className="stack">
              <p>Der Demo-Messenger zeigt Beispiel-Chats, damit du die App ausprobieren kannst.</p>
              <button className="btn primary wide" onClick={async () => setAccId((await api.addAccount('demo', 'Demo', {})).id)}>Demo hinzufügen</button>
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
  const [method, setMethod] = useState<'qr' | 'phone'>(matchMedia('(pointer: coarse)').matches && net === 'whatsapp' ? 'phone' : 'qr');
  const go = async () => {
    setBusy(true); setErr('');
    try { onCreated((await api.addAccount(net, NETWORKS[net].name, { loginMethod: method })).id); } catch (e: any) { setErr(e.message); setBusy(false); }
  };
  return (
    <div className="stack">
      <p>Chorus wird als zusätzliches Gerät mit deinem {NETWORKS[net].name}-Konto gekoppelt, so wie {net === 'signal' ? 'Signal Desktop' : 'WhatsApp Web'}. Dein Handy bleibt das Hauptgerät.</p>
      <div className="steps">
        <p><b>Du brauchst:</b> dein Handy mit {NETWORKS[net].name}. Gleich erscheint ein QR-Code, den du damit scannst.</p>
        {net === 'signal' && <p>Hinweis: Signal überträgt keine alten Nachrichten an neue Geräte. Du siehst alles ab jetzt.</p>}
        {net === 'whatsapp' && <p>Hinweis: WhatsApp überträgt einen Teil der letzten Chats. Öffne WhatsApp am Handy mindestens alle 14 Tage, sonst wird Chorus abgemeldet.</p>}
      </div>
      {net === 'whatsapp' && (
        <div className="field"><span>Koppeln per</span>
          <div className="seg">
            <button type="button" className={method === 'qr' ? 'on' : ''} onClick={() => setMethod('qr')}>QR-Code<small>Ich bin am Computer</small></button>
            <button type="button" className={method === 'phone' ? 'on' : ''} onClick={() => setMethod('phone')}>Code eintippen<small>Ich bin am Handy</small></button>
          </div>
        </div>
      )}
      {err && <div className="error">{err}</div>}
      <button className="btn primary wide" disabled={busy} onClick={go}>{busy ? 'Einen Moment …' : method === 'qr' ? 'QR-Code anzeigen' : 'Weiter'}</button>
    </div>
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
    if (!/^\d{3,12}$/.test(apiId.trim())) return setErr('Die api_id besteht nur aus Ziffern.');
    if (!/^[0-9a-f]{32}$/i.test(apiHash.trim())) return setErr('Der api_hash ist 32 Zeichen lang (0–9, a–f).');
    setBusy(true);
    try {
      const a = await api.addAccount('telegram', 'Telegram', { apiId: Number(apiId.trim()), apiHash: apiHash.trim(), loginMethod: method });
      onCreated(a.id);
    } catch (e: any) { setErr(e.message); } finally { setBusy(false); }
  };

  return (
    <form className="stack" onSubmit={go}>
      <div className="steps">
        <p><b>Schritt 1:</b> Öffne <a href="https://my.telegram.org/apps" target="_blank" rel="noreferrer">my.telegram.org/apps</a> und melde dich mit deiner Telefonnummer an.</p>
        <p><b>Schritt 2:</b> Lege eine App an. Name und Kurzname sind egal, zum Beispiel „Chorus“. Plattform: „Web“.</p>
        <p><b>Schritt 3:</b> Kopiere <b>App api_id</b> und <b>App api_hash</b> hier hinein.</p>
      </div>
      <label className="field"><span>api_id</span><input className="input" inputMode="numeric" value={apiId} onChange={(e) => setApiId(e.target.value)} placeholder="z. B. 1234567" /></label>
      <label className="field"><span>api_hash</span><input className="input mono" value={apiHash} onChange={(e) => setApiHash(e.target.value)} placeholder="32 Zeichen" autoComplete="off" /></label>
      <div className="field"><span>Anmelden per</span>
        <div className="seg">
          <button type="button" className={method === 'qr' ? 'on' : ''} onClick={() => setMethod('qr')}>QR-Code<small>Ich bin am Computer</small></button>
          <button type="button" className={method === 'phone' ? 'on' : ''} onClick={() => setMethod('phone')}>Telefonnummer<small>Ich bin am Handy</small></button>
        </div>
      </div>
      {err && <div className="error">{err}</div>}
      <button className="btn primary wide" disabled={busy}>{busy ? 'Verbinde …' : 'Weiter'}</button>
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
      <h3>{NETWORKS[acc.network].name} ist verbunden</h3>
      <p>Deine Chats werden jetzt geladen. Das kann beim ersten Mal ein paar Minuten dauern.</p>
      <button className="btn primary wide" onClick={onClose}>Zu den Chats</button>
    </div>
  );
  if (s.state === 'qr' && s.code) return (
    <div className="stack center">
      <p>Gib diesen Code auf deinem Handy ein:</p>
      <div className="pair-code">{s.code}</div>
      <ol className="qr-steps">
        <li>Öffne WhatsApp → Einstellungen → <b>Verknüpfte Geräte</b></li>
        <li>Tippe auf „Gerät hinzufügen“</li>
        <li>Wähle unten „<b>Stattdessen mit Telefonnummer verknüpfen</b>“ und tippe den Code ein</li>
      </ol>
    </div>
  );
  if (s.state === 'qr') return (
    <div className="stack center">
      {qrImg ? <img className="qr" src={qrImg} alt="QR-Code" width={280} height={280} /> : <div className="qr placeholder" />}
      <ol className="qr-steps">
        {acc.network === 'telegram' && <><li>Öffne Telegram auf deinem Handy</li><li>Einstellungen → Geräte → <b>Desktop-Gerät verbinden</b></li><li>Halte die Kamera auf diesen Code</li></>}
        {acc.network === 'whatsapp' && <><li>Öffne WhatsApp auf deinem Handy</li><li>Einstellungen → <b>Verknüpfte Geräte</b> → Gerät hinzufügen</li><li>Halte die Kamera auf diesen Code</li></>}
        {acc.network === 'signal' && <><li>Öffne Signal auf deinem Handy</li><li>Einstellungen → <b>Gekoppelte Geräte</b> → +</li><li>Halte die Kamera auf diesen Code</li></>}
      </ol>
      <small className="muted">Der Code erneuert sich automatisch.</small>
    </div>
  );
  if (s.state === 'need_input') {
    const labels = { phone: ['Telefonnummer', '+49 170 1234567', 'tel'], code: ['Bestätigungscode', '12345', 'numeric'], password: ['Passwort', '', 'text'], api: ['Wert', '', 'text'] } as const;
    const [label, ph, mode] = labels[s.field ?? 'api'];
    return (
      <form className="stack" onSubmit={submit}>
        {s.message && <p>{s.message}</p>}
        <label className="field"><span>{label}</span>
          <input className="input" autoFocus type={s.field === 'password' ? 'password' : 'text'} inputMode={mode as any} placeholder={ph} value={val} onChange={(e) => setVal(e.target.value)} />
        </label>
        {s.field === 'code' && <small className="muted">Den Code schickt dir Telegram als Nachricht in der Telegram-App (nicht per SMS).</small>}
        {err && <div className="error">{err}</div>}
        <button className="btn primary wide" disabled={!val.trim()}>Weiter</button>
      </form>
    );
  }
  if (s.state === 'error') return (
    <div className="stack center">
      <div className="error">{s.message ?? 'Unbekannter Fehler'}</div>
      <button className="btn wide" onClick={() => api.restartAccount(acc.id)}><Icon name="refresh" size={18} /> Nochmal versuchen</button>
    </div>
  );
  return <div className="stack center"><div className="spinner" /><p>Verbinde mit {NETWORKS[acc.network].name} …</p></div>;
}
