import { useEffect, useState, type ReactNode } from 'react';
import { api, type AiSettings, type Voice } from '../api';
import { aiState, useAi } from '../aiState';
import { Icon } from './Icon';

type Patch = Record<string, string | null>;

/** Schlüsselfeld: gespeichert = nur Status mit „Ersetzen“ und Löschen, sonst Eingabe */
function KeyField({ has, placeholder, help, onSave, onDelete, busy }: {
  has: boolean; placeholder: string; help: ReactNode; onSave: (v: string) => Promise<boolean>; onDelete: () => void; busy: boolean;
}) {
  const [v, setV] = useState('');
  const [edit, setEdit] = useState(false);
  if (has && !edit) return (
    <div className="key-saved">
      <span className="key-ok"><Icon name="check" size={16} />Schlüssel gespeichert</span>
      <button className="btn small ghost" onClick={() => setEdit(true)}>Ersetzen</button>
      <button className="icon-btn danger" title="Schlüssel löschen" onClick={onDelete}><Icon name="trash" size={18} /></button>
    </div>
  );
  return (
    <div className="stack" style={{ gap: 6 }}>
      <div className="row">
        <input className="input" type="password" autoComplete="off" placeholder={placeholder} value={v} onChange={(e) => setV(e.target.value)} />
        <button className="btn primary" disabled={!v || busy} onClick={async () => { if (await onSave(v.trim())) { setV(''); setEdit(false); } }}>Speichern</button>
        {edit && <button className="btn ghost" onClick={() => { setEdit(false); setV(''); }}>Abbrechen</button>}
      </div>
      <small className="muted">{help}</small>
    </div>
  );
}

const PROVIDERS: { id: AiSettings['provider']; name: string; sub: string; color: string; letter: string }[] = [
  { id: 'anthropic', name: 'Claude', sub: 'Anthropic', color: '#d97757', letter: 'C' },
  { id: 'openai', name: 'ChatGPT', sub: 'OpenAI oder kompatibel', color: '#10a37f', letter: 'G' },
];

/** Einstellungen → KI-Assistent */
export function AiSettingsSection() {
  const ai = useAi();
  const [voices, setVoices] = useState<Voice[] | null>(null);
  const [gptModels, setGptModels] = useState<string[] | null>(null);
  const [msg, setMsg] = useState('');
  const [busy, setBusy] = useState(false);
  const [adv, setAdv] = useState(false);
  const [base, setBase] = useState<string | null>(null);
  const [searchAll, setSearchAll] = useState<boolean | null>(null);

  const save = async (patch: Patch, ok = 'Gespeichert.') => {
    setBusy(true); setMsg('');
    try { aiState.set(await api.ai.save(patch)); setMsg(ok); return true; }
    catch (e: any) { setMsg(e.message); return false; }
    finally { setBusy(false); }
  };
  const loadVoices = async () => { try { setVoices(await api.ai.voices()); } catch (e: any) { setVoices([]); setMsg(e.message); } };
  const loadGpt = async () => { try { setGptModels(await api.ai.openaiModels()); } catch (e: any) { setGptModels([]); setMsg(e.message); } };
  useEffect(() => { if (ai?.hasElevenKey && !voices) loadVoices(); }, [ai?.hasElevenKey]);
  useEffect(() => { if (ai?.provider === 'openai' && (ai.hasOpenaiKey || ai.openaiBase)) loadGpt(); else setGptModels(null); }, [ai?.provider, ai?.hasOpenaiKey, ai?.openaiBase]);
  useEffect(() => { api.aiSearchScope().then((r) => setSearchAll(r.all)).catch(() => {}); }, []);
  useEffect(() => { if (ai && base === null) { setBase(ai.openaiBase); setAdv(!!ai.openaiBase); } }, [ai]);

  if (!ai) return <p className="muted">Lade …</p>;
  const prov = PROVIDERS.find((p) => p.id === ai.provider)!;
  const modelName = ai.provider === 'openai' ? ai.openaiModel : ai.models.find((m) => m.id === ai.model)?.label.replace(/ \(.*/, '') ?? ai.model;
  const pickVoice = (id: string) => {
    const v = voices?.find((x) => x.id === id);
    save({ voiceId: id, voiceName: v?.name ?? '' }, v ? `Stimme „${v.name}“ gewählt.` : 'Stimme entfernt.');
  };
  const curVoice = voices?.find((v) => v.id === ai.voiceId);
  const gptList = gptModels && !gptModels.includes(ai.openaiModel) ? [ai.openaiModel, ...gptModels] : gptModels;

  return (<>
    <div className="ios-card ai-status">
      <span className={`sync-dot${ai.features.text ? ' ok' : ''}`}><Icon name="sparkle" size={18} /></span>
      <span className="sync-text">
        <b>{ai.features.text ? `${prov.name} ist bereit` : 'KI ist noch nicht eingerichtet'}</b>
        <small>{ai.features.text ? modelName : 'Wähle unten einen Anbieter und trage einen Schlüssel ein.'}</small>
      </span>
    </div>
    <p className="ios-foot" style={{ marginTop: -18 }}>Die KI ist freiwillig. Ein Chat wird nur übertragen, wenn du die KI dort erlaubt hast. Schlüssel liegen verschlüsselt in deinem Tresor.</p>
    {msg && <p className="ai-msg" role="status">{msg}</p>}

    <p className="ios-caption">Texte · Zusammenfassen, Vorschläge, Übersetzen, Autobot</p>
    <div className="ios-card pad">
      <div className="seg">
        {PROVIDERS.map((p) => (
          <button key={p.id} className={ai.provider === p.id ? 'on' : ''} onClick={() => ai.provider !== p.id && save({ provider: p.id }, `${p.name} ist jetzt aktiv.`)}>
            <span className="row" style={{ gap: 8, justifyContent: 'center' }}><span className="ios-icon sm" style={{ background: p.color }}><b>{p.letter}</b></span>{p.name}</span>
            <small>{p.sub}</small>
          </button>
        ))}
      </div>

      {ai.provider === 'anthropic' ? (<>
        <KeyField has={ai.hasAnthropicKey} placeholder="sk-ant-…" busy={busy}
          help={<>Unter <a href="https://console.anthropic.com/settings/keys" target="_blank" rel="noreferrer">console.anthropic.com</a> anlegen. Abrechnung nach Nutzung, eine Zusammenfassung kostet meist unter einem Cent.</>}
          onSave={(v) => save({ anthropicKey: v }, 'Claude-Schlüssel gespeichert.')} onDelete={() => save({ anthropicKey: null }, 'Claude-Schlüssel gelöscht.')} />
        <label className="field"><span>Modell</span>
          <select className="input" value={ai.model} onChange={(e) => save({ model: e.target.value })}>
            {ai.models.map((m) => <option key={m.id} value={m.id}>{m.label}</option>)}
          </select>
        </label>
      </>) : (<>
        <KeyField has={ai.hasOpenaiKey} placeholder={ai.openaiBase ? 'Schlüssel (falls nötig)' : 'sk-…'} busy={busy}
          help={<>Unter <a href="https://platform.openai.com/api-keys" target="_blank" rel="noreferrer">platform.openai.com</a> anlegen. Ein ChatGPT-Abo reicht dafür nicht, die API wird getrennt nach Nutzung abgerechnet.</>}
          onSave={(v) => save({ openaiKey: v }, 'OpenAI-Schlüssel gespeichert.')} onDelete={() => save({ openaiKey: null }, 'OpenAI-Schlüssel gelöscht.')} />
        {(ai.hasOpenaiKey || ai.openaiBase) && (
          <label className="field"><span>Modell</span>
            {gptList?.length ? (
              <select className="input" value={ai.openaiModel} onChange={(e) => save({ openaiModel: e.target.value })}>
                {gptList.map((m) => <option key={m} value={m}>{m}</option>)}
              </select>
            ) : (
              <input className="input" defaultValue={ai.openaiModel} placeholder={gptModels ? 'z. B. gpt-5-mini' : 'Lade Modelle …'}
                onBlur={(e) => e.target.value.trim() && e.target.value.trim() !== ai.openaiModel && save({ openaiModel: e.target.value.trim() })} />
            )}
          </label>
        )}
        <button className="link-btn" onClick={() => setAdv(!adv)}>{adv ? 'Weniger' : 'Erweitert: eigener Dienst (Ollama, LM Studio, OpenRouter …)'}</button>
        {adv && (
          <div className="stack" style={{ gap: 6 }}>
            <div className="row">
              <input className="input" value={base ?? ''} onChange={(e) => setBase(e.target.value)} placeholder="http://192.168.1.10:11434/v1" inputMode="url" autoCapitalize="off" />
              <button className="btn" disabled={busy || (base ?? '') === ai.openaiBase} onClick={() => save({ openaiBase: base ?? '' }, base ? 'Adresse gespeichert.' : 'Wieder api.openai.com.')}>Speichern</button>
            </div>
            <small className="muted">Leer lassen für OpenAI. Jeder Dienst mit OpenAI-kompatibler Schnittstelle (…/v1/chat/completions) geht, auch lokal ohne Schlüssel. Kleine lokale Modelle liefern schwächere Ergebnisse.</small>
          </div>
        )}
      </>)}
    </div>

    <p className="ios-caption">Sprache · ElevenLabs</p>
    <div className="ios-card pad">
      <small className="muted">Sprachnachrichten in Text umwandeln, Diktieren und Antworten in deiner eigenen Stimme.</small>
      <KeyField has={ai.hasElevenKey} placeholder="ElevenLabs-API-Schlüssel" busy={busy}
        help={<>Unter <a href="https://elevenlabs.io/app/settings/api-keys" target="_blank" rel="noreferrer">elevenlabs.io</a> anlegen, mit Rechten für Sprache-zu-Text, Text-zu-Sprache und Stimmen lesen. Deine Stimme legst du dort unter „Voices“ an.</>}
        onSave={async (v) => { const ok = await save({ elevenKey: v }, 'ElevenLabs-Schlüssel gespeichert.'); if (ok) { setVoices(null); loadVoices(); } return ok; }}
        onDelete={() => { setVoices(null); save({ elevenKey: null, voiceId: null, voiceName: null }, 'ElevenLabs-Schlüssel gelöscht.'); }} />
      {ai.hasElevenKey && (
        <label className="field"><span>Stimme für Sprachantworten</span>
          <span className="row">
            <select className="input" value={ai.voiceId} onChange={(e) => pickVoice(e.target.value)} disabled={!voices}>
              <option value="">{voices ? '– Stimme wählen –' : 'Lade Stimmen …'}</option>
              {voices?.map((v) => <option key={v.id} value={v.id}>{v.name}{v.category === 'cloned' ? ' (eigene)' : ''}</option>)}
              {ai.voiceId && voices && !curVoice && <option value={ai.voiceId}>{ai.voiceName || ai.voiceId}</option>}
            </select>
            {curVoice?.previewUrl && <button className="icon-btn" title="Probe hören" onClick={() => new Audio(curVoice.previewUrl!).play().catch(() => {})}><Icon name="play" size={18} /></button>}
          </span>
        </label>
      )}
    </div>

    {ai.features.text && searchAll !== null && (<>
      <p className="ios-caption">Datenschutz</p>
      <div className="ios-card pad">
        <label className="toggle">
          <input type="checkbox" checked={searchAll} onChange={async (e) => { const v = e.target.checked; setSearchAll(v); await api.setAiSearchScope(v).catch(() => setSearchAll(!v)); }} />
          <span><b>KI-Suche in allen Chats</b><small>Aus: Die KI durchsucht nur Chats, in denen du sie erlaubt hast. An: alle Chats. Übertragen werden nur die Nachrichten, die zu deiner Frage passen.</small></span>
        </label>
      </div>
    </>)}
  </>);
}
