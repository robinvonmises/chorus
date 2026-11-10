import { useEffect, useState } from 'react';
import { api, type Voice } from '../api';
import { aiState, useAi } from '../aiState';
import { Icon } from './Icon';

/** Einstellungen → KI: Schlüssel, Modell, Stimme */
export function AiSettingsSection() {
  const ai = useAi();
  const [claudeKey, setClaudeKey] = useState('');
  const [elevenKey, setElevenKey] = useState('');
  const [voices, setVoices] = useState<Voice[] | null>(null);
  const [msg, setMsg] = useState('');
  const [busy, setBusy] = useState(false);

  const save = async (patch: Record<string, string | null>, ok = 'Gespeichert.') => {
    setBusy(true); setMsg('');
    try { aiState.set(await api.ai.save(patch)); setMsg(ok); return true; }
    catch (e: any) { setMsg(e.message); return false; }
    finally { setBusy(false); }
  };
  const loadVoices = async () => {
    try { setVoices(await api.ai.voices()); } catch (e: any) { setVoices([]); setMsg(e.message); }
  };
  useEffect(() => { if (ai?.hasElevenKey && !voices) loadVoices(); }, [ai?.hasElevenKey]);
  const [searchAll, setSearchAll] = useState<boolean | null>(null);
  useEffect(() => { api.aiSearchScope().then((r) => setSearchAll(r.all)).catch(() => {}); }, []);

  if (!ai) return <p className="muted">Lade …</p>;
  const pickVoice = (id: string) => {
    const v = voices?.find((x) => x.id === id);
    save({ voiceId: id, voiceName: v?.name ?? '' }, v ? `Stimme „${v.name}“ gewählt.` : 'Stimme entfernt.');
  };
  const playPreview = (v?: Voice) => { if (v?.previewUrl) new Audio(v.previewUrl).play().catch(() => {}); };

  return (<>
    <p className="muted">Die KI ist freiwillig und pro Chat abschaltbar. Chats werden nur übertragen, wenn du im Chat auf <Icon name="robot" size={14} /> drückst und die KI dort erlaubt hast. Die Schlüssel liegen verschlüsselt in deinem Tresor.</p>

    <div className="stack">
      <b>Claude (Zusammenfassen, Antwortvorschläge)</b>
      <small className="muted">Schlüssel unter <a href="https://console.anthropic.com/settings/keys" target="_blank" rel="noreferrer">console.anthropic.com</a> anlegen. Abrechnung nach Nutzung, eine Zusammenfassung kostet meist weniger als einen Cent.</small>
      <div className="row">
        <input className="input" type="password" autoComplete="off" placeholder={ai.hasAnthropicKey ? '•••••••• gespeichert' : 'sk-ant-…'} value={claudeKey} onChange={(e) => setClaudeKey(e.target.value)} />
        <button className="btn" disabled={!claudeKey || busy} onClick={async () => { if (await save({ anthropicKey: claudeKey }, 'Claude-Schlüssel gespeichert.')) setClaudeKey(''); }}>Speichern</button>
        {ai.hasAnthropicKey && <button className="icon-btn danger" title="Schlüssel löschen" onClick={() => save({ anthropicKey: null }, 'Claude-Schlüssel gelöscht.')}><Icon name="trash" size={18} /></button>}
      </div>
      <label className="row">
        <span>Modell</span>
        <select className="input" value={ai.model} onChange={(e) => save({ model: e.target.value })}>
          {ai.models.map((m) => <option key={m.id} value={m.id}>{m.label}</option>)}
        </select>
      </label>
    </div>

    <div className="stack">
      <b>ElevenLabs (Sprachnachrichten transkribieren, in deiner Stimme antworten)</b>
      <small className="muted">Schlüssel unter <a href="https://elevenlabs.io/app/settings/api-keys" target="_blank" rel="noreferrer">elevenlabs.io</a> anlegen, mit Rechten für Sprache-zu-Text, Text-zu-Sprache und Stimmen lesen. Deine eigene Stimme legst du bei ElevenLabs unter „Voices“ an (Voice Cloning).</small>
      <div className="row">
        <input className="input" type="password" autoComplete="off" placeholder={ai.hasElevenKey ? '•••••••• gespeichert' : 'ElevenLabs-API-Schlüssel'} value={elevenKey} onChange={(e) => setElevenKey(e.target.value)} />
        <button className="btn" disabled={!elevenKey || busy} onClick={async () => { if (await save({ elevenKey }, 'ElevenLabs-Schlüssel gespeichert.')) { setElevenKey(''); setVoices(null); loadVoices(); } }}>Speichern</button>
        {ai.hasElevenKey && <button className="icon-btn danger" title="Schlüssel löschen" onClick={() => { setVoices(null); save({ elevenKey: null, voiceId: null, voiceName: null }, 'ElevenLabs-Schlüssel gelöscht.'); }}><Icon name="trash" size={18} /></button>}
      </div>
      {ai.hasElevenKey && (
        <label className="row">
          <span>Stimme</span>
          <select className="input" value={ai.voiceId} onChange={(e) => pickVoice(e.target.value)} disabled={!voices}>
            <option value="">{voices ? '– Stimme wählen –' : 'Lade Stimmen …'}</option>
            {voices?.map((v) => <option key={v.id} value={v.id}>{v.name}{v.category === 'cloned' ? ' (eigene)' : ''}</option>)}
            {ai.voiceId && voices && !voices.some((v) => v.id === ai.voiceId) && <option value={ai.voiceId}>{ai.voiceName || ai.voiceId}</option>}
          </select>
          {voices?.find((v) => v.id === ai.voiceId)?.previewUrl && <button className="icon-btn" title="Probe hören" onClick={() => playPreview(voices.find((v) => v.id === ai.voiceId))}><Icon name="play" size={18} /></button>}
        </label>
      )}
    </div>
    {ai.hasAnthropicKey && searchAll !== null && (
      <label className="toggle">
        <input type="checkbox" checked={searchAll} onChange={async (e) => { const v = e.target.checked; setSearchAll(v); await api.setAiSearchScope(v).catch(() => setSearchAll(!v)); }} />
        <span><b>KI-Suche in allen Chats</b><small>Aus: Die KI durchsucht nur Chats, in denen du sie eingeschaltet hast. An: alle Chats. Übertragen werden nur die Nachrichten, die zu deiner Frage passen.</small></span>
      </label>
    )}
    {msg && <small>{msg}</small>}
  </>);
}
