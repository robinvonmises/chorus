import { useEffect, useRef, useState } from 'react';
import { api, type Chat, type Message } from '../api';
import { useAi } from '../aiState';
import { Icon } from './Icon';

/** KI-Texte mit 🤖 kennzeichnen */
const withBot = (t: string) => (t.trim().endsWith('🤖') ? t.trim() : `${t.trim()} 🤖`);

type Tab = 'write' | 'overview' | 'auto';
type Busy = '' | 'summary' | 'suggest' | 'toggle' | 'compose' | 'send' | 'dictate' | 'listen';
const TAB_KEY = 'inbox:ai-tab';

/** KI-Leiste über dem Eingabefeld, aufgeteilt in drei Reiter */
export function AiPanel({ chat, replyTo, onClose, onUse, onError }: {
  chat: Chat; replyTo: Message | null; onClose: () => void; onUse: (text: string) => void; onError: (t: string) => void;
}) {
  const ai = useAi();
  const [tab, setTabState] = useState<Tab>(() => (localStorage.getItem(TAB_KEY) as Tab) || 'write');
  const setTab = (t: Tab) => { setTabState(t); localStorage.setItem(TAB_KEY, t); };
  const [busy, setBusy] = useState<Busy>('');
  const run = async (what: Busy, fn: () => Promise<void>) => {
    setBusy(what);
    try { await fn(); } catch (e: any) { onError(e.message ?? 'Fehler'); } finally { setBusy(''); }
  };
  const openSettings = () => window.dispatchEvent(new Event('inbox:open-settings'));

  if (ai && !ai.features.text) {
    return (
      <div className="ai-panel">
        <div className="ai-head"><span className="ai-title"><Icon name="robot" size={18} /> KI-Assistent</span><CloseBtn onClose={onClose} /></div>
        <div className="ai-empty">
          <p>Die KI schreibt Nachrichten für dich, fasst Chats zusammen und kann selbst antworten. Dafür braucht es einen Claude-Schlüssel.</p>
          <button className="btn primary" onClick={openSettings}><Icon name="settings" size={18} /> KI einrichten</button>
        </div>
      </div>
    );
  }

  const autoOn = !!chat.autopilot?.on;
  return (
    <div className="ai-panel">
      <div className="ai-head">
        <div className="ai-tabs" role="tablist">
          <button role="tab" className={tab === 'write' ? 'on' : ''} onClick={() => setTab('write')}>Schreiben</button>
          <button role="tab" className={tab === 'overview' ? 'on' : ''} onClick={() => setTab('overview')}>Überblick</button>
          <button role="tab" className={tab === 'auto' ? 'on' : ''} onClick={() => setTab('auto')}>Autopilot{autoOn && <span className="ai-dot" />}</button>
        </div>
        <CloseBtn onClose={onClose} />
      </div>
      {!ai ? <p className="muted">Lade …</p>
        : tab === 'write' ? <WriteTab chat={chat} replyTo={replyTo} busy={busy} run={run} voiceOk={ai.features.voice} dictateOk={ai.features.transcribe} openSettings={openSettings} onError={onError} onDone={onClose} />
        : !chat.aiEnabled ? <OptIn chat={chat} busy={busy} run={run} what={tab === 'auto' ? 'Der Autopilot' : 'Zusammenfassen und Vorschläge'} />
        : tab === 'overview' ? <OverviewTab chat={chat} busy={busy} run={run} onUse={onUse} />
        : <AutoTab chat={chat} onError={onError} />}
    </div>
  );
}

function CloseBtn({ onClose }: { onClose: () => void }) {
  return <button className="icon-btn small" onClick={onClose} aria-label="KI-Leiste schließen"><Icon name="close" size={16} /></button>;
}

type Run = (what: Busy, fn: () => Promise<void>) => Promise<void>;

/** Reiter „Schreiben“: Auftrag tippen oder sprechen, als Text oder Sprachnachricht */
function WriteTab({ chat, replyTo, busy, run, voiceOk, dictateOk, openSettings, onError, onDone }: {
  chat: Chat; replyTo: Message | null; busy: Busy; run: Run; voiceOk: boolean; dictateOk: boolean; openSettings: () => void; onError: (t: string) => void; onDone: () => void;
}) {
  const [task, setTask] = useState('');
  const [mode, setMode] = useState<'text' | 'voice'>(voiceOk ? 'voice' : 'text');
  const [draft, setDraft] = useState<{ text: string; mode: 'text' | 'voice' } | null>(null);
  const [recording, setRecording] = useState(false);
  const rec = useRef<MediaRecorder | null>(null);
  const ta = useRef<HTMLTextAreaElement>(null);
  useEffect(() => { const el = ta.current; if (el) { el.style.height = 'auto'; el.style.height = Math.min(el.scrollHeight, 120) + 'px'; } }, [task]);

  const compose = (m = mode) => task.trim() && run('compose', async () => setDraft({ text: (await api.ai.compose(chat.id, task, m)).text, mode: m }));
  // Senden schließt die KI-Leiste sofort, die Nachricht erscheint dann wie gewohnt im Chat
  const send = () => {
    if (!draft) return;
    const d = draft, r = replyTo?.remoteId;
    // War die Tastatur offen, bleibt sie offen: Fokus noch im selben Tipp ins normale Eingabefeld legen
    if (document.activeElement?.matches('textarea, input')) document.querySelector<HTMLTextAreaElement>('.composer-wrap textarea')?.focus();
    setDraft(null); setTask(''); onDone();
    (d.mode === 'voice' ? api.ai.voice(chat.id, d.text, r) : api.send(chat.id, withBot(d.text), r)).catch((e: any) => onError(e.message));
  };
  const listen = () => draft && run('listen', async () => {
    const { audio, mime } = await api.ai.preview(chat.id, draft.text);
    await new Audio(`data:${mime};base64,${audio}`).play();
  });
  const dictate = async () => {
    if (recording) { rec.current?.stop(); return; }
    if (!navigator.mediaDevices) return onError('Das Mikrofon geht im Browser nur über HTTPS.');
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const mime = ['audio/webm;codecs=opus', 'audio/ogg;codecs=opus', 'audio/mp4'].find((m) => MediaRecorder.isTypeSupported(m)) ?? '';
      const r = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
      const chunks: Blob[] = [];
      r.ondataavailable = (e) => e.data.size && chunks.push(e.data);
      r.onstop = () => {
        stream.getTracks().forEach((t) => t.stop());
        setRecording(false);
        run('dictate', async () => { const { text } = await api.ai.dictate(new Blob(chunks, { type: r.mimeType || 'audio/webm' })); setTask((t) => (t ? t + ' ' : '') + text); });
      };
      r.start(250); rec.current = r; setRecording(true);
    } catch { onError('Kein Zugriff aufs Mikrofon. Bitte im Browser erlauben.'); }
  };

  if (draft) {
    return (
      <div className="ai-body">
        <small className="muted">{draft.mode === 'voice' ? 'Wird in deiner Stimme vorgelesen. Du kannst den Text noch ändern.' : 'Du kannst den Text noch ändern.'}</small>
        <textarea className="input ai-draft" rows={3} value={draft.text} onChange={(e) => setDraft({ ...draft, text: e.target.value })} />
        <div className="ai-row">
          <button className="btn ghost small" disabled={!!busy} onClick={() => setDraft(null)}>Zurück</button>
          <button className="btn ghost small" disabled={!!busy} onClick={() => compose(draft.mode)} title="Neu formulieren"><Icon name="refresh" size={16} /></button>
          {draft.mode === 'voice' && <button className="btn ghost small" disabled={!!busy} onClick={listen}>{busy === 'listen' ? <span className="spinner" /> : <Icon name="play" size={16} />} Anhören</button>}
          <span className="grow" />
          <button className="btn primary small" disabled={!draft.text.trim() || !!busy} onPointerDown={(e) => e.preventDefault()} onMouseDown={(e) => e.preventDefault()} onClick={send}>
            {busy === 'send' ? <span className="spinner" /> : <Icon name="send" size={16} />} Senden
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="ai-body">
      <div className={`ai-input ${recording ? 'rec' : ''}`}>
        <textarea ref={ta} rows={1} value={task} maxLength={1000}
          placeholder={recording ? 'Ich höre zu … zum Beenden aufs Mikrofon tippen' : `Was soll ich ${chat.kind === 'direct' ? chat.title : 'der Gruppe'} schreiben?`}
          onChange={(e) => setTask(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); compose(); } }} />
        {dictateOk && (
          <button className="icon-btn small" onClick={dictate} disabled={busy === 'dictate'} aria-label={recording ? 'Aufnahme beenden' : 'Auftrag sprechen'} title={recording ? 'Aufnahme beenden' : 'Auftrag sprechen'}>
            {busy === 'dictate' ? <span className="spinner" /> : <Icon name={recording ? 'stop' : 'mic'} size={18} />}
          </button>
        )}
      </div>
      <div className="ai-row">
        <div className="seg-mini" role="radiogroup" aria-label="Senden als">
          <button className={mode === 'voice' ? 'on' : ''} disabled={!voiceOk} onClick={() => setMode('voice')} title={voiceOk ? 'Als Sprachnachricht in deiner Stimme' : 'Dafür ElevenLabs und eine Stimme einrichten'}><Icon name="speak" size={15} /> Sprache</button>
          <button className={mode === 'text' ? 'on' : ''} onClick={() => setMode('text')}><Icon name="send" size={15} /> Text</button>
        </div>
        {!voiceOk && <button className="link small" onClick={openSettings}>Stimme einrichten</button>}
        <span className="grow" />
        <button className="btn primary small" disabled={!task.trim() || !!busy} onClick={() => compose()}>
          {busy === 'compose' ? <span className="spinner" /> : <Icon name="robot" size={16} />} Formulieren
        </button>
      </div>
    </div>
  );
}

/** Freigabe des Chatverlaufs (nötig für Überblick und Autopilot) */
function OptIn({ chat, busy, run, what }: { chat: Chat; busy: Busy; run: Run; what: string }) {
  return (
    <div className="ai-body ai-empty">
      <p>{what} braucht den Verlauf dieses Chats. Gib ihn einmal frei. Die KI liest ihn nur, wenn du sie hier benutzt oder der Autopilot an ist.</p>
      <button className="btn primary small" disabled={!!busy} onClick={() => run('toggle', () => api.ai.setChat(chat.id, true).then(() => {}))}>Chatverlauf freigeben</button>
    </div>
  );
}

/** Reiter „Überblick“: Zusammenfassung und Antwortvorschläge */
function OverviewTab({ chat, busy, run, onUse }: { chat: Chat; busy: Busy; run: Run; onUse: (t: string) => void }) {
  const [summary, setSummary] = useState('');
  const [suggestions, setSuggestions] = useState<string[]>([]);
  return (
    <div className="ai-body">
      <div className="ai-row">
        <button className="btn small" disabled={!!busy} onClick={() => run('summary', async () => setSummary((await api.ai.summary(chat.id)).text))}>
          {busy === 'summary' ? <span className="spinner" /> : <Icon name="file" size={16} />} Zusammenfassen
        </button>
        <button className="btn small" disabled={!!busy} onClick={() => run('suggest', async () => setSuggestions((await api.ai.suggest(chat.id)).suggestions))}>
          {busy === 'suggest' ? <span className="spinner" /> : <Icon name="reply" size={16} />} Antworten vorschlagen
        </button>
      </div>
      {summary && <div className="ai-text ai-card">{summary}</div>}
      {suggestions.length > 0 && (
        <div className="ai-suggestions">
          {suggestions.map((s, i) => <button key={i} className="ai-chip" onClick={() => onUse(withBot(s))} title="Ins Eingabefeld übernehmen">{s}</button>)}
        </div>
      )}
      <button className="link small ai-revoke" disabled={!!busy} onClick={() => run('toggle', () => api.ai.setChat(chat.id, false).then(() => {}))}>Freigabe für diesen Chat zurücknehmen</button>
    </div>
  );
}

/** Reiter „Autopilot“: Claude antwortet selbst, mit Limit */
function AutoTab({ chat, onError }: { chat: Chat; onError: (t: string) => void }) {
  const a = chat.autopilot ?? { on: false, max: 5, used: 0, note: '', mark: true };
  const [note, setNote] = useState(a.note);
  useEffect(() => { setNote(a.note); }, [chat.id]);
  if (chat.kind === 'channel') return <div className="ai-body ai-empty"><p>In Kanälen gibt es keinen Autopiloten.</p></div>;
  const save = (patch: Parameters<typeof api.ai.autopilot>[1]) => api.ai.autopilot(chat.id, patch).catch((e) => onError(e.message));
  const left = a.max - a.used;
  return (
    <div className="ai-body">
      <label className={`switch-row ${a.on ? 'on' : ''}`}>
        <span>
          <b>{a.on ? 'Autopilot ist an' : 'Autopilot ist aus'}</b>
          <small>{a.on ? `Claude antwortet selbst. Noch ${left} von ${a.max}.` : a.used >= a.max && a.used > 0 ? `Limit erreicht. Zum Weitermachen wieder einschalten.` : chat.kind === 'group' ? 'Antwortet in der Gruppe, wenn jemand eine Frage stellt, dich erwähnt oder dir antwortet.' : 'Claude antwortet für dich, bis das Limit erreicht ist.'}</small>
        </span>
        <input type="checkbox" className="switch" checked={a.on} onChange={(e) => save({ on: e.target.checked, note })} />
      </label>
      <textarea className="input small" rows={2} maxLength={1000} value={note} onChange={(e) => setNote(e.target.value)} onBlur={() => note !== a.note && save({ note })}
        placeholder="Hinweise für Claude, z. B. „Bin bis 18 Uhr im Meeting, keine Termine zusagen“" />
      <div className="ai-row">
        <label className="ai-inline">Höchstens
          <select className="input small" value={a.max} onChange={(e) => save({ max: Number(e.target.value) })}>
            {[1, 2, 3, 5, 10, 20].map((n) => <option key={n} value={n}>{n}</option>)}
          </select>
          Antworten
        </label>
        <span className="grow" />
        <label className="ai-inline"><input type="checkbox" checked={a.mark} onChange={(e) => save({ mark: e.target.checked })} /> mit 🤖 markieren</label>
      </div>
    </div>
  );
}
