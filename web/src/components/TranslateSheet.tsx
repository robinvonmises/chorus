import { useEffect, useState } from 'react';
import { api, type Chat } from '../api';
import { Icon } from './Icon';
import { T, lang, locale } from '../i18n';

const names = new Intl.DisplayNames([locale], { type: 'language' });
const langLabel = (c: string) => { const n = names.of(c) ?? c; return n.charAt(0).toLocaleUpperCase(locale) + n.slice(1); };
/** Häufige Sprachen; die eigene Oberflächensprache fällt raus, Deutsch kommt für englische Nutzer dazu */
const COMMON: [string, string][] = ['en', 'de', 'nl', 'fr', 'es', 'it', 'pl', 'tr', 'pt', 'uk', 'ru'].filter((c) => c !== lang).map((c) => [c, langLabel(c)]);

/** Live-Übersetzung: ein/aus, eigene Nachrichten übersetzen, Sprache des Gegenübers (automatisch oder fest) */
export function TranslateSheet({ chat, onChat, onClose, onError }: {
  chat: Chat; onChat: (c: Chat) => void; onClose: () => void; onError: (t: string) => void;
}) {
  const tr = chat.translate;
  const on = !!tr?.on;
  const [guess, setGuess] = useState<{ lang: string; langName: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const fixedCustom = tr?.fixed && tr.lang && !COMMON.some(([c]) => c === tr.lang) && tr.lang !== guess?.lang;
  const [other, setOther] = useState(fixedCustom ? tr!.langName ?? '' : '');
  const [otherOpen, setOtherOpen] = useState(!!fixedCustom);
  useEffect(() => { api.translateGuess(chat.id).then((r) => setGuess(r.guess)).catch(() => {}); }, [chat.id]);

  const apply = async (nextOn: boolean, out?: boolean, lang?: { lang: string | null; langName?: string | null }) => {
    if (busy) return;
    setBusy(true);
    try { onChat(await api.translate(chat.id, nextOn, out, lang)); }
    catch (e: any) { onError(e.message ?? T('Fehler')); }
    finally { setBusy(false); }
  };
  // Eine Sprache wählen schaltet die Übersetzung mit ein
  const pick = (lang: string | null, langName?: string) => { setOtherOpen(false); void apply(true, undefined, { lang, langName }); };

  const auto = !tr?.fixed;
  const list = guess && !COMMON.some(([c]) => c === guess.lang) ? [[guess.lang, guess.langName] as [string, string], ...COMMON] : COMMON;
  const autoHint = tr?.langName && !tr.fixed && on ? T('erkannt: {0}', tr.langName) : guess ? T('Vorschlag aus der Vorwahl: {0}', guess.langName) : T('aus den Nachrichten des Gegenübers');

  return (
    <div className="modal-bg" onClick={onClose}>
      <div className="modal tr-sheet" onClick={(e) => e.stopPropagation()} role="dialog" aria-label={T('Live-Übersetzung')}>
        <header className="modal-head"><h2>{T('Live-Übersetzung')}</h2><button className="icon-btn" onClick={onClose} aria-label={T('Schließen')}><Icon name="close" /></button></header>
        <div className="modal-body">
          <label className={`switch-row ${on ? 'on' : ''}`}>
            <span><b>{T('Live-Übersetzung')}</b><small>{T('Fremdsprachige Nachrichten bekommen eine deutsche Übersetzung')}</small></span>
            <input type="checkbox" className="switch" checked={on} disabled={busy} onChange={() => apply(!on)} />
          </label>
          {on && (
            <label className={`switch-row ${tr?.out !== false ? 'on' : ''}`}>
              <span><b>{T('Meine Nachrichten übersetzen')}</b><small>{T('Du schreibst Deutsch, gesendet wird in der Sprache des Gegenübers')}</small></span>
              <input type="checkbox" className="switch" checked={tr?.out !== false} disabled={busy} onChange={() => apply(true, tr?.out === false)} />
            </label>
          )}
          <h4 className="tr-head">{T('Sprache des Gegenübers')}</h4>
          <div className="tr-langs">
            <label className="radio-row">
              <input type="radio" name="tr-lang" checked={on && auto && !otherOpen} disabled={busy} onChange={() => pick(null)} />
              <span>{T('Automatisch')}{' '}<small className="muted">({autoHint})</small></span>
            </label>
            {list.map(([code, name]) => (
              <label key={code} className="radio-row">
                <input type="radio" name="tr-lang" checked={on && !!tr?.fixed && tr.lang === code && !otherOpen} disabled={busy} onChange={() => pick(code, name)} />
                <span>{name}{guess?.lang === code && <small className="muted"> {T('· Vorwahl')}</small>}</span>
              </label>
            ))}
            <label className="radio-row">
              <input type="radio" name="tr-lang" checked={otherOpen || (on && !!fixedCustom)} disabled={busy} onChange={() => setOtherOpen(true)} />
              <span>{fixedCustom && !otherOpen ? <>{tr!.langName} <small className="muted">{T('· eigene Sprache')}</small></> : T('Andere …')}</span>
            </label>
            {otherOpen && (
              <form className="tr-other" onSubmit={(e) => { e.preventDefault(); if (other.trim()) pick('', other.trim()); }}>
                <input className="input" autoFocus placeholder={T('z. B. Schwedisch')} value={other} onChange={(e) => setOther(e.target.value)} />
                <button className="btn small primary" disabled={!other.trim() || busy}>{T('Übernehmen')}</button>
              </form>
            )}
          </div>
          <p className="muted small tr-note">{T('Bei „Automatisch“ merkt sich Chorus die Sprache aus den Nachrichten. Bis dahin gilt der Vorschlag aus der Vorwahl, oder die Sprache, in der du selbst schreibst.')}</p>
        </div>
      </div>
    </div>
  );
}
