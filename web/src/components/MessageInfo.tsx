import { useEffect, useState } from 'react';
import { api, type Message, type Network, type Receipt } from '../api';
import { T, locale } from '../i18n';
import { Icon } from './Icon';
import { Avatar } from './Rail';
import { previewOf, StatusIcon } from './Message';

/** Datum und Uhrzeit, z. B. „Sa., 14. Nov., 10:21“ (heute nur die Uhrzeit) */
function when(ts: number) {
  const d = new Date(ts);
  const today = d.toDateString() === new Date().toDateString();
  return d.toLocaleString(locale, today ? { hour: '2-digit', minute: '2-digit' } : { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
}

/** Lesbarer Name, wenn der Messenger keinen liefert (Nummer statt WhatsApp-JID) */
function label(r: Receipt) {
  if (r.name) return r.name;
  const n = r.who.split('@')[0];
  return /^\d{6,}$/.test(n) ? '+' + n : n || T('Unbekannt');
}

/**
 * Nachrichten-Infos (Blase nach links wischen): gesendet/empfangen, und bei eigenen Nachrichten,
 * wann zugestellt und gelesen wurde. In Gruppen je Person, soweit der Messenger das meldet (Signal, WhatsApp).
 */
export function MessageInfo({ m, group, network, avatars, onClose }: {
  m: Message; group: boolean; network: Network; avatars: Record<string, string | null>; onClose: () => void;
}) {
  const [rs, setRs] = useState<Receipt[] | null>(m.fromMe ? null : []);
  const [err, setErr] = useState('');
  // Neu laden, wenn sich der Status live ändert (z. B. gerade gelesen)
  useEffect(() => {
    if (!m.fromMe || m.remoteId.startsWith('local-')) { setRs([]); return; }
    let on = true;
    api.receipts(m.id).then((r) => { if (on) setRs(r.receipts); }, (e: any) => { if (on) { setErr(e.message ?? T('Fehler')); setRs([]); } });
    return () => { on = false; };
  }, [m.id, m.status]);

  const people = (rs ?? []).filter((r) => r.who);
  const first = (k: 'deliveredAt' | 'readAt' | 'playedAt') => Math.min(...(rs ?? []).map((r) => r[k] ?? Infinity));
  const voice = m.attachments.some((a) => a.kind === 'voice' || a.kind === 'audio' || a.kind === 'video');
  const read = people.filter((r) => r.readAt || r.playedAt);
  const delivered = people.filter((r) => !r.readAt && !r.playedAt && r.deliveredAt);
  const perPerson = group && people.length > 0;
  // Gelesen-Status ohne Zeitpunkt: Bestätigung kam vor dieser Funktion oder ohne Zeitangabe
  const row = (icon: React.ReactNode, title: string, ts: number) => (
    <li className="mi-row"><span className="mi-icon">{icon}</span><span className="mi-label">{title}</span><span className="mi-time">{Number.isFinite(ts) ? when(ts) : T('Zeit unbekannt')}</span></li>
  );
  const person = (r: Receipt) => {
    const ts = r.playedAt ?? r.readAt ?? r.deliveredAt!;
    return (
      <li key={r.who} className="mi-row">
        <Avatar name={label(r)} size={32} src={avatars[r.who] ?? null} />
        <span className="mi-label">{label(r)}{r.playedAt && voice ? <small>{T('abgespielt')}</small> : null}</span>
        <span className="mi-time">{when(ts)}</span>
      </li>
    );
  };

  return (
    <div className="modal-bg" onClick={onClose}>
      <div className="modal msg-info" onClick={(e) => e.stopPropagation()} role="dialog" aria-label={T('Nachrichten-Infos')}>
        <header className="modal-head"><h2>{T('Nachrichten-Infos')}</h2><button className="icon-btn" onClick={onClose} aria-label={T('Schließen')}><Icon name="close" /></button></header>
        <div className="modal-body">
          <p className="mi-preview">{previewOf(m).slice(0, 200) || T('Anhang')}</p>
          <ul className="mi-list">
            {m.fromMe ? row(<Icon name="send" size={16} />, T('Gesendet'), m.ts) : row(<Icon name="inbox" size={16} />, group ? T('Von {0}', m.senderName) : T('Empfangen'), m.ts)}
            {m.fromMe && !perPerson && rs && <>
              {(first('deliveredAt') < Infinity || m.status === 'delivered') && row(<StatusIcon s="delivered" />, T('Zugestellt'), first('deliveredAt'))}
              {(m.status === 'read' || first('readAt') < Infinity) && row(<StatusIcon s="read" />, T('Gelesen'), first('readAt'))}
              {voice && first('playedAt') < Infinity && row(<Icon name="play" size={16} />, T('Abgespielt'), first('playedAt'))}
              {m.status === 'sent' && row(<StatusIcon s="sent" />, T('Noch nicht zugestellt'), NaN)}
            </>}
          </ul>
          {m.fromMe && perPerson && <>
            {read.length > 0 && <><h3 className="mi-head">{T('Gelesen von')}</h3><ul className="mi-list">{read.map(person)}</ul></>}
            {delivered.length > 0 && <><h3 className="mi-head">{T('Zugestellt an')}</h3><ul className="mi-list">{delivered.map(person)}</ul></>}
          </>}
          {m.fromMe && rs === null && <p className="muted small">{T('Lädt …')}</p>}
          {err && <p className="muted small">{err}</p>}
          {m.fromMe && (network === 'email'
            ? <p className="muted small">{T('E-Mail meldet nicht, ob gelesen wurde.')}</p>
            : <p className="muted small">{group && network === 'telegram'
              ? T('Telegram meldet in Gruppen nicht, wer gelesen hat.')
              : T('Wer Lesebestätigungen abgeschaltet hat, taucht hier nicht als „gelesen“ auf.')}</p>)}
        </div>
      </div>
    </div>
  );
}
