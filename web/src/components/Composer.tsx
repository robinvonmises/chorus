import { haptic } from '../haptics';
import { useEffect, useRef, useState } from 'react';
import { api, type Chat, type Message } from '../api';
import { duration } from '../util';
import { Icon } from './Icon';
import { EmojiPicker } from './EmojiPicker';
import { ImageEditor } from './ImageEditor';
import { VideoEditor, type VideoEdit } from './VideoEditor';
import { outbox } from '../outbox';
import { armRise } from '../sendAnim';
import { previewOf } from './Message';
import { useStorage } from '../storageState';
import { NextcloudBrowser } from './NextcloudBrowser';
import { ImmichPicker } from './ImmichPicker';
import { GifPicker } from './GifPicker';
import { useAi } from '../aiState';
import { WhenPicker, whenLabel } from './WhenPicker';
import { T, lang, locale } from '../i18n';

const isTouch = () => matchMedia('(pointer: coarse)').matches;

// Gruppenmitglieder für @-Erwähnungen, einmal pro Chat und App-Start geladen
const memberCache = new Map<string, Promise<{ id: string; name: string }[]>>();
/** „@abc“ direkt vor der Schreibmarke (Anfang oder Leerzeichen vor dem @, keine Zeilenumbrüche) */
function mentionQuery(text: string, caret: number): { at: number; q: string } | null {
  const before = text.slice(0, caret);
  const at = before.lastIndexOf('@');
  if (at < 0 || (at > 0 && !/[\s(]/.test(before[at - 1]))) return null;
  const q = before.slice(at + 1);
  // Leerzeichen am Ende: Erwähnung ist fertig (auch direkt nach dem Auswählen)
  if (q.length > 30 || /\n/.test(q) || /\s$/.test(q)) return null;
  return { at, q };
}

export function Composer({ chat, onPickLang, draftId, serverDraft, placeholder, onResize, disabled, replyTo, editing, inject, onAi, aiOpen, onCancel, onSent, onError, onInfo, onEmpty }: {
  chat: Chat; onPickLang?: () => void; draftId?: string; serverDraft?: { text: string | null; ts: number | null }; placeholder?: string; onResize?: () => void; disabled: boolean; onInfo?: (t: string) => void; replyTo: Message | null; editing: Message | null; inject?: { text: string; n: number } | null; onAi?: () => void; aiOpen?: boolean; onEmpty?: (empty: boolean) => void;
  onCancel: () => void; onSent: () => void; onError: (t: string) => void;
}) {
  const draftKey = `inbox:draft:${draftId ?? chat.id}`;
  // Live-Übersetzung: eigene Nachrichten in der Sprache des Chatpartners senden (pro Nachricht abschaltbar)
  const tr = chat.translate;
  const canTr = !!(tr?.on && tr.out !== false && tr.lang && tr.lang !== lang && tr.langName);
  // Übersetzung an, aber noch keine Sprache bekannt: Hinweis zum Wählen
  const trUnknown = !!(tr?.on && tr.out !== false && !tr.lang);
  const [noTr, setNoTr] = useState(false);
  const [gifPick, setGifPick] = useState(false);
  const [when, setWhen] = useState(false);
  // Entwurf: lokal sofort, auf dem Server kurz verzögert (geräteübergreifend). Der neuere Stand gewinnt.
  const draftTsKey = `inbox:draftTs:${draftId ?? chat.id}`;
  const localTs = useRef(Number(localStorage.getItem(draftTsKey)) || 0);
  const [text, setText] = useState(() => {
    const local = localStorage.getItem(draftKey) ?? '';
    if (serverDraft?.ts && serverDraft.ts > localTs.current) { localTs.current = serverDraft.ts; return serverDraft.text ?? ''; }
    return local;
  });
  const synced = useRef(text);
  const syncTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pushDraft = useRef<() => void>(() => {});
  const [emoji, setEmoji] = useState(false);
  const [files, setFiles] = useState<File[]>([]);
  const [editIdx, setEditIdx] = useState<number | null>(null);
  // Videoschnitt je Datei (geschnitten wird beim Senden auf dem Server)
  const [vEdits, setVEdits] = useState(() => new Map<File, VideoEdit>());
  const [rec, setRec] = useState<{ start: number; secs: number } | null>(null);
  const ta = useRef<HTMLTextAreaElement>(null);
  const fileIn = useRef<HTMLInputElement>(null);
  const storage = useStorage();
  const [ncPick, setNcPick] = useState(false);
  const [imPick, setImPick] = useState(false);
  const [attMenu, setAttMenu] = useState(false);
  const recorder = useRef<MediaRecorder | null>(null);
  const chunks = useRef<Blob[]>([]);
  const cancelRec = useRef(false);
  const [speaking, setSpeaking] = useState(false);
  const ai = useAi();

  const serverTs = useRef(serverDraft?.ts ?? 0);
  serverTs.current = Math.max(serverTs.current, serverDraft?.ts ?? 0);
  useEffect(() => {
    if (editing) return; // Bearbeiten ist kein Entwurf
    localStorage.setItem(draftKey, text); if (!text) localStorage.removeItem(draftKey);
    // Ausstehende Speicherung eines älteren Stands verwerfen (sonst kam der Text nach dem Senden als Entwurf zurück)
    if (syncTimer.current) { clearTimeout(syncTimer.current); syncTimer.current = null; }
    if (text === synced.current) return;
    // Leeren (z. B. nach dem Senden) muss immer gewinnen, auch wenn die Uhr eines anderen Geräts vorgeht
    const ts = text.trim() ? Date.now() : Math.max(Date.now(), serverTs.current + 1);
    localTs.current = ts; localStorage.setItem(draftTsKey, String(ts));
    const id = draftId ?? chat.id, t = text;
    const save = (retry: boolean): void => void api.saveDraft(id, t.trim() ? t : '', ts).catch(() => { if (retry) setTimeout(() => save(false), 3000); });
    pushDraft.current = () => { syncTimer.current = null; synced.current = t; save(true); };
    if (!t.trim()) pushDraft.current(); else syncTimer.current = setTimeout(() => pushDraft.current(), 800);
  }, [text, draftKey]); // eslint-disable-line react-hooks/exhaustive-deps
  // Beim Verlassen des Chats den letzten Stand sofort speichern
  useEffect(() => () => { if (syncTimer.current) { clearTimeout(syncTimer.current); pushDraft.current(); } }, []);
  // Server hat noch einen älteren Entwurf als dieses Gerät (z. B. Leeren nach dem Senden ging verloren): nachziehen
  useEffect(() => {
    if (editing || !serverDraft?.text?.trim() || !serverDraft.ts || serverDraft.ts > localTs.current || serverDraft.text === text) return;
    const ts = Math.max(localTs.current, serverDraft.ts + 1);
    localTs.current = ts; localStorage.setItem(draftTsKey, String(ts)); synced.current = text;
    void api.saveDraft(draftId ?? chat.id, text.trim() ? text : '', ts).catch(() => {});
  }, [draftId, chat.id]); // eslint-disable-line react-hooks/exhaustive-deps
  // Auf einem anderen Gerät weitergeschrieben: übernehmen, solange hier nicht gerade getippt wird
  useEffect(() => {
    if (!serverDraft?.ts || serverDraft.ts <= localTs.current || editing) return;
    if (document.activeElement === ta.current && text.trim()) return;
    localTs.current = serverDraft.ts; localStorage.setItem(draftTsKey, String(serverDraft.ts));
    synced.current = serverDraft.text ?? ''; setText(serverDraft.text ?? '');
  }, [serverDraft?.ts]); // eslint-disable-line react-hooks/exhaustive-deps
  // Bearbeiten beendet (auch über „Antworten“): bearbeiteten Text nicht als Entwurf stehen lassen
  const editedText = useRef<string | null>(null);
  useEffect(() => {
    if (editing) { editedText.current = editing.text; setText(editing.text); ta.current?.focus(); }
    else if (editedText.current !== null) { const was = editedText.current; editedText.current = null; setText((t) => (t === was ? '' : t)); }
  }, [editing]);
  useEffect(() => { if (replyTo) ta.current?.focus(); }, [replyTo]);
  const empty = !text.trim();
  useEffect(() => { onEmpty?.(empty); }, [empty]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { if (inject) { setText(inject.text); requestAnimationFrame(() => ta.current?.focus()); } }, [inject?.n]);
  useEffect(() => { // Höhe automatisch
    const el = ta.current; if (!el) return;
    // Beim Messen klappt das Feld kurz zusammen. Den Rahmen so lange festhalten, damit der Chat darüber nicht springt.
    const box = el.closest('.composer-wrap') as HTMLElement | null;
    if (box) box.style.minHeight = box.offsetHeight + 'px';
    el.style.height = 'auto'; el.style.height = Math.min(el.scrollHeight, 160) + 'px';
    if (box) box.style.minHeight = '';
    // Das kurze Zusammenklappen (auto) verschiebt den Chat darüber: dort wieder nach unten rücken lassen
    onResize?.();
  }, [text]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { if (!isTouch()) ta.current?.focus(); }, [chat.id]);

  // Einfügen von Bildern und Dateien per Drag & Drop
  useEffect(() => {
    const drop = (e: DragEvent) => { if (e.dataTransfer?.files.length) { e.preventDefault(); const add = [...e.dataTransfer.files]; setFiles((f) => [...f, ...add]); } };
    const view = ta.current?.closest('.chat-view');
    view?.addEventListener('drop', drop as any);
    return () => view?.removeEventListener('drop', drop as any);
  }, []);

  // Senden-Knopf darf dem Textfeld den Fokus nicht wegnehmen, sonst klappt am Handy die Tastatur zu
  // @-Erwähnungen in Gruppen: Auswahlliste über dem Eingabefeld
  const group = chat.kind === 'group';
  const [caret, setCaret] = useState<number | null>(null);
  const [members, setMembers] = useState<{ id: string; name: string }[] | null>(null);
  const [mSel, setMSel] = useState(0);
  const [mClosed, setMClosed] = useState<number | null>(null);
  const mq = group && caret != null && !rec ? mentionQuery(text, caret) : null;
  useEffect(() => {
    if (!mq || members) return;
    let p = memberCache.get(chat.id);
    if (!p) { p = api.members(chat.id).catch(() => { memberCache.delete(chat.id); return []; }); memberCache.set(chat.id, p); }
    p.then(setMembers);
  }, [!!mq, chat.id]);
  useEffect(() => { setMembers(null); }, [chat.id]);
  const mMatches = mq && members && mClosed !== mq.at ? members.filter((m) => {
    const q = mq.q.toLowerCase().trim(), n = m.name.toLowerCase();
    return !q || n.startsWith(q) || n.split(/\s+/).some((w) => w.startsWith(q));
  }).slice(0, 8) : [];
  useEffect(() => { setMSel(0); if (!mq) setMClosed(null); }, [mq?.q, mq?.at]);
  const pickMention = (m: { name: string }) => {
    if (!mq) return;
    const el = ta.current;
    const end = mq.at + 1 + mq.q.length;
    const ins = '@' + m.name + ' ';
    const next = text.slice(0, mq.at) + ins + text.slice(end).replace(/^ /, '');
    const pos = mq.at + ins.length;
    setText(next); setCaret(pos); haptic();
    requestAnimationFrame(() => { el?.focus(); el?.setSelectionRange(pos, pos); });
  };
  const keepKeyboard = (e: React.SyntheticEvent) => { if (document.activeElement === ta.current) e.preventDefault(); };
  const send = async () => {
    const t = text.trim();
    if (disabled) return onError(T('Messenger ist gerade nicht verbunden.'));
    if (editing) {
      if (!t) return;
      setText(''); onSent();
      try { await api.edit(editing.id, t); } catch (e: any) { onError(e.message); }
      return;
    }
    if (files.length) {
      haptic();
      const fs = files, ve = vEdits; setFiles([]); setVEdits(new Map()); setText(''); setNoTr(false); onSent();
      // Blasen sofort zeigen, dann nacheinander hochladen
      const ids = fs.map((f, i) => outbox.add({
        chatId: chat.id, name: f.name, caption: i === 0 && t ? t : undefined,
        kind: isVideo(f) ? 'video' : f.type.startsWith('image/') ? 'image' : 'file',
        url: isVideo(f) || f.type.startsWith('image/') ? URL.createObjectURL(f) : null,
      }));
      for (let i = 0; i < fs.length; i++) {
        const id = ids[i];
        try {
          const dims = isVideo(fs[i]) ? await videoSize(fs[i]) : null;
          await api.upload(chat.id, fs[i], fs[i].name, {
            ...(dims ?? {}), caption: i === 0 ? t : undefined, translate: i === 0 && !!t && canTr && !noTr, replyTo: replyTo?.remoteId, video: ve.get(fs[i]),
            onProgress: (p) => outbox.update(id, p >= 1 ? { progress: 1, phase: 'work' } : { progress: p }),
          });
          outbox.remove(id);
        } catch (e: any) {
          outbox.update(id, { phase: 'error', error: e.message });
          onError(`${fs[i].name}: ${e.message}`);
        }
      }
      return;
    }
    if (!t) return;
    const r = replyTo?.remoteId;
    const translate = canTr && !noTr;
    haptic(); setText(''); setNoTr(false); onSent(); armRise();
    try { await api.send(chat.id, t, r, translate); } catch (e: any) { onError(e.message); }
  };

  /** Zeitversetzt senden */
  const schedule = async (at: number) => {
    const t = text.trim();
    setWhen(false);
    if (!t) return;
    try {
      await api.plan({ kind: 'send', chatId: chat.id, at, text: t, replyTo: replyTo?.remoteId ?? null, translate: canTr && !noTr });
      setText(''); setNoTr(false); onSent();
      onInfo?.(T('Wird {0} gesendet', whenLabel(at)));
    } catch (e: any) { onError(e.message); }
  };
  const sendPress = useRef<number | null>(null);
  const pressStart = () => { if (editing) return; sendPress.current = window.setTimeout(() => { sendPress.current = -1; haptic(); setWhen(true); }, 500); };
  const pressEnd = () => { if (sendPress.current && sendPress.current > 0) clearTimeout(sendPress.current); };

  /** Text in der eigenen ElevenLabs-Stimme als Sprachnachricht senden */
  const sendAsVoice = async () => {
    const t = text.trim();
    if (!t || speaking) return;
    if (disabled) return onError(T('Messenger ist gerade nicht verbunden.'));
    setSpeaking(true);
    try { await api.ai.voice(chat.id, t, replyTo?.remoteId); setText(''); onSent(); }
    catch (e: any) { onError(e.message); }
    finally { setSpeaking(false); }
  };

  const onKey = (e: React.KeyboardEvent) => {
    if (mMatches.length) {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); setMSel((i) => (i + (e.key === 'ArrowDown' ? 1 : mMatches.length - 1)) % mMatches.length); return; }
      if ((e.key === 'Enter' && !e.shiftKey) || e.key === 'Tab') { e.preventDefault(); pickMention(mMatches[Math.min(mSel, mMatches.length - 1)]); return; }
      if (e.key === 'Escape') { e.preventDefault(); setMClosed(mq!.at); return; }
    }
    if (e.key === 'Enter' && !e.shiftKey && !isTouch()) { e.preventDefault(); send(); }
    if (e.key === 'Escape') { onCancel(); setEmoji(false); }
  };

  const startRec = async () => {
    if (disabled) return onError(T('Messenger ist gerade nicht verbunden.'));
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
      const mime = ['audio/ogg;codecs=opus', 'audio/webm;codecs=opus', 'audio/mp4'].find((m) => MediaRecorder.isTypeSupported(m)) ?? '';
      const r = new MediaRecorder(stream, mime ? { mimeType: mime, audioBitsPerSecond: 32000 } : undefined);
      chunks.current = []; cancelRec.current = false;
      r.ondataavailable = (e) => e.data.size && chunks.current.push(e.data);
      const start = Date.now();
      r.onstop = async () => {
        stream.getTracks().forEach((t) => t.stop());
        const secs = (Date.now() - start) / 1000;
        setRec(null);
        if (cancelRec.current || secs < 0.7) return;
        const blob = new Blob(chunks.current, { type: r.mimeType || 'audio/webm' });
        const ext = blob.type.includes('ogg') ? 'ogg' : blob.type.includes('mp4') ? 'm4a' : 'webm';
        // Blase sofort zeigen, nicht erst nach dem Senden
        const oid = outbox.add({ chatId: chat.id, name: T('Sprachnachricht'), kind: 'voice', duration: Math.round(secs), url: null });
        onSent();
        try {
          await api.upload(chat.id, blob, `sprachnachricht.${ext}`, { voice: true, duration: Math.round(secs), replyTo: replyTo?.remoteId,
            onProgress: (p) => outbox.update(oid, p >= 1 ? { progress: 1, phase: 'work' } : { progress: p }) });
          outbox.remove(oid);
        } catch (e: any) { outbox.update(oid, { phase: 'error', error: e.message }); onError(e.message); }
      };
      r.start(250);
      recorder.current = r;
      setRec({ start, secs: 0 });
    } catch {
      onError(T('Kein Zugriff aufs Mikrofon. Bitte im Browser erlauben (nur über HTTPS möglich).'));
    }
  };
  useEffect(() => {
    if (!rec) return;
    const t = setInterval(() => setRec((r) => r && { ...r, secs: (Date.now() - r.start) / 1000 }), 200);
    return () => clearInterval(t);
  }, [rec?.start]);
  const stopRec = (cancel: boolean) => { cancelRec.current = cancel; recorder.current?.stop(); recorder.current = null; };

  const insertEmoji = (e: string) => {
    const el = ta.current;
    if (!el) return setText((t) => t + e);
    const s = el.selectionStart ?? text.length, en = el.selectionEnd ?? text.length;
    const next = text.slice(0, s) + e + text.slice(en);
    setText(next);
    requestAnimationFrame(() => { el.focus(); el.setSelectionRange(s + e.length, s + e.length); });
  };

  const hasContent = text.trim().length > 0 || files.length > 0;
  // Beim Tippen (Handy) Platz fürs Textfeld: KI-Knopf einklappen; Anhänge, Emoji und GIF liegen hinter „+“

  return (
    <footer className="composer-wrap">
      {when && <WhenPicker title={T('Später senden')} confirm={T('Planen')} hint={T('„{0}{1}“ wird automatisch gesendet{2}.', text.trim().slice(0, 80), text.trim().length > 80 ? '…' : '', canTr && !noTr ? T(', übersetzt auf {0}', tr!.langName) : '')}
        onPick={schedule} onClose={() => setWhen(false)} />}
      {canTr && !editing && (
        <div className="tr-chip">
          <Icon name="globe" size={15} />
          <span>{noTr ? T('Ohne Übersetzung senden') : T('Antwort wird auf {0} übersetzt', tr!.langName)}</span>
          <button className="link-btn" onClick={() => setNoTr((v) => !v)}>{noTr ? T('Übersetzen') : "Original"}</button>
        </div>
      )}
      {trUnknown && !editing && (
        <div className="tr-chip">
          <Icon name="globe" size={15} />
          <span>{T('Sprache noch unbekannt')}</span>
          {onPickLang && <button className="link-btn" onClick={onPickLang}>{T('Sprache wählen')}</button>}
        </div>
      )}
      {(replyTo || editing) && (
        <div className="composer-context">
          <Icon name={editing ? 'edit' : 'reply'} size={18} />
          <div><b>{editing ? T('Nachricht bearbeiten') : replyTo!.fromMe ? T('Antwort an dich') : T('Antwort an {0}', replyTo!.senderName)}</b><span>{previewOf((editing ?? replyTo)!)}</span></div>
          <button className="icon-btn small" onClick={() => { onCancel(); if (editing) setText(''); }} aria-label={T('Abbrechen')}><Icon name="close" size={18} /></button>
        </div>
      )}
      {files.length > 0 && (
        <div className="composer-files">
          {files.map((f, i) => isVideo(f) ? (
            <span key={i} className="file-thumb">
              <button className={`file-thumb-img ${vEdits.has(f) ? 'edited' : ''}`} onClick={() => setEditIdx(i)} aria-label={T('Video bearbeiten')}><VideoThumb file={f} /><span className="file-thumb-edit"><Icon name={vEdits.has(f) ? 'check' : 'scissors'} size={13} /></span></button>
              <button className="file-thumb-x" onClick={() => setFiles((fs) => fs.filter((_, j) => j !== i))} aria-label={T('Entfernen')}><Icon name="close" size={12} /></button>
            </span>
          ) : f.type.startsWith('image/') && !/svg|gif/.test(f.type) ? (
            <span key={i} className="file-thumb">
              <button className="file-thumb-img" onClick={() => setEditIdx(i)} aria-label={T('Bild bearbeiten')}><Thumb file={f} /><span className="file-thumb-edit"><Icon name="pen" size={13} /></span></button>
              <button className="file-thumb-x" onClick={() => setFiles((fs) => fs.filter((_, j) => j !== i))} aria-label={T('Entfernen')}><Icon name="close" size={12} /></button>
            </span>
          ) : (
            <span key={i} className="file-chip">
              {f.type.startsWith('image/') ? <Thumb file={f} /> : <Icon name="file" size={18} />}
              <span>{f.name}</span>
              <button onClick={() => setFiles((fs) => fs.filter((_, j) => j !== i))} aria-label={T('Entfernen')}><Icon name="close" size={14} /></button>
            </span>
          ))}
        </div>
      )}
      {editIdx != null && files[editIdx] && isVideo(files[editIdx]) && (
        <VideoEditor file={files[editIdx]} initial={vEdits.get(files[editIdx])} onCancel={() => setEditIdx(null)}
          onDone={(ed) => { const f = files[editIdx]; setVEdits((m) => { const n = new Map(m); if (ed) n.set(f, ed); else n.delete(f); return n; }); setEditIdx(null); }} />
      )}
      {editIdx != null && files[editIdx] && !isVideo(files[editIdx]) && (
        <ImageEditor file={files[editIdx]} onCancel={() => setEditIdx(null)}
          onDone={(nf) => { setFiles((fs) => fs.map((x, j) => (j === editIdx ? nf : x))); setEditIdx(null); }} />
      )}
      {mMatches.length > 0 && (
        <div className="mention-menu menu-list" role="listbox">
          {mMatches.map((m, i) => (
            <button key={m.id} role="option" aria-selected={i === mSel} className={i === mSel ? 'sel' : ''}
              onPointerDown={keepKeyboard} onMouseDown={keepKeyboard} onClick={() => pickMention(m)}>
              <span className="mention-av">{m.name.replace(/^\+/, '').slice(0, 1).toUpperCase()}</span><span>{m.name}</span>
            </button>
          ))}
        </div>
      )}
      {emoji && <div className="att-menu-bg" onClick={() => setEmoji(false)} />}
      {emoji && <div className="composer-emoji"><EmojiPicker onPick={insertEmoji} /></div>}
      {attMenu && <>
        <div className="att-menu-bg" onClick={() => setAttMenu(false)} />
        <div className="att-menu menu-list" role="menu">
          {!editing && <button onClick={() => { setAttMenu(false); fileIn.current?.click(); }}><Icon name="attach" size={18} />{T('Fotos und Dateien vom Gerät')}</button>}
          {!editing && storage?.immich.enabled && <button onClick={() => { setAttMenu(false); setImPick(true); }}><Icon name="photos" size={18} />{T('Aus Immich')}</button>}
          {!editing && storage?.nextcloud.enabled && <button onClick={() => { setAttMenu(false); setNcPick(true); }}><Icon name="folder" size={18} />{T('Aus Nextcloud')}</button>}
          <button onClick={() => { setAttMenu(false); setEmoji(true); }}><Icon name="smile" size={18} />Emoji</button>
          {!editing && <button onClick={() => { setAttMenu(false); setEmoji(false); setGifPick(true); }}><span className="gif-badge menu-gif">GIF</span>{T('GIF senden')}</button>}
        </div>
      </>}
      {gifPick && <GifPicker onClose={() => setGifPick(false)} onPick={(g) => {
        setGifPick(false); onSent();
        api.sendGif(chat.id, g.id, replyTo?.remoteId).catch((e: any) => onError(e.message));
      }} />}
      {imPick && <ImmichPicker onClose={() => setImPick(false)} onPick={(add) => setFiles((f) => [...f, ...add])} />}
      {ncPick && <NextcloudBrowser mode="pick" onClose={() => setNcPick(false)} onPick={(add) => setFiles((f) => [...f, ...add])} />}
      {rec ? (
        <div className="composer recording">
          <button className="icon-btn" onClick={() => stopRec(true)} aria-label="Verwerfen"><Icon name="trash" /></button>
          <span className="rec-dot" /> <span className="rec-time">{duration(rec.secs)}</span>
          <span className="rec-hint">{T('Aufnahme läuft …')}</span>
          <button className="send-btn" onClick={() => stopRec(false)} aria-label={T('Sprachnachricht senden')}><Icon name="send" /></button>
        </div>
      ) : (
        <div className={`composer ${text.trim() ? 'compact' : ''}`}>
          <button className={`icon-btn plus-btn ${attMenu || emoji ? 'on' : ''}`} onPointerDown={keepKeyboard} onMouseDown={keepKeyboard} onClick={() => { setEmoji(false); setAttMenu((v) => !v); }} aria-label={T('Anhängen, Emoji, GIF')} title={T('Anhängen, Emoji, GIF')}><Icon name="plus" /></button>
          {onAi && <button className={`icon-btn tool ai-compose ${aiOpen ? 'on' : ''}`} onClick={onAi} aria-label={T('KI-Assistent')} title={T('KI: Nachricht schreiben lassen, zusammenfassen, Antworten vorschlagen')}><Icon name="robot" /></button>}
          <textarea ref={ta} rows={1} value={text} placeholder={disabled ? T('Nicht verbunden') : placeholder ?? T('Nachricht')} onChange={(e) => { setText(e.target.value); setCaret(e.target.selectionStart); }} onKeyDown={onKey}
            onSelect={(e) => setCaret(e.currentTarget.selectionStart)} onBlur={() => setCaret(null)}
            onPaste={(e) => { const fs = [...e.clipboardData.files]; if (fs.length) { e.preventDefault(); setFiles((f) => [...f, ...fs]); } }} />
          <input ref={fileIn} type="file" multiple hidden onChange={(e) => { const add = [...(e.target.files ?? [])]; setFiles((f) => [...f, ...add]); e.target.value = ""; }} />
          {ai?.features.voice && !editing && !files.length && text.trim() && (
            <button className="icon-btn tool speak-btn" onPointerDown={keepKeyboard} onMouseDown={keepKeyboard} onClick={sendAsVoice} disabled={speaking} title={T('Als Sprachnachricht in deiner Stimme senden')} aria-label={T('Als Sprachnachricht senden')}>
              {speaking ? <span className="spinner" /> : <Icon name="speak" />}
            </button>
          )}
          {hasContent || editing ? (
            <>
            {!editing && !files.length && <button className="icon-btn tool" onPointerDown={keepKeyboard} onMouseDown={keepKeyboard} onClick={() => setWhen(true)} title={T('Später senden')} aria-label={T('Später senden')}><Icon name="clock" /></button>}
            <button className="send-btn" onPointerDown={(e) => { keepKeyboard(e); if (!files.length) pressStart(); }} onPointerUp={pressEnd} onPointerLeave={pressEnd} onMouseDown={keepKeyboard}
              onContextMenu={(e) => { if (!editing && !files.length) { e.preventDefault(); setWhen(true); } }}
              onClick={() => { if (sendPress.current === -1) { sendPress.current = null; return; } if (isTouch() && document.activeElement === ta.current) ta.current?.focus(); send(); }} aria-label={T('Senden')} title={T('Senden (gedrückt halten: später senden)')}><Icon name={editing ? 'check' : 'send'} /></button>
            </>
          ) : (
            <button className="send-btn mic" onClick={startRec} aria-label={T('Sprachnachricht aufnehmen')}><Icon name="mic" /></button>
          )}
        </div>
      )}
    </footer>
  );
}

/** Kleine Vorschau einer angehängten Bilddatei */
/** Bildmaße eines Videos messen (höchstens 2 s warten), damit der Chat den Platz freihalten kann */
function videoSize(f: File): Promise<{ width: number; height: number } | null> {
  return new Promise((resolve) => {
    const v = document.createElement('video'), url = URL.createObjectURL(f);
    const done = (r: { width: number; height: number } | null) => { URL.revokeObjectURL(url); resolve(r); };
    const t = setTimeout(() => done(null), 2000);
    v.preload = 'metadata'; v.muted = true;
    v.onloadedmetadata = () => { clearTimeout(t); done(v.videoWidth && v.videoHeight ? { width: v.videoWidth, height: v.videoHeight } : null); };
    v.onerror = () => { clearTimeout(t); done(null); };
    v.src = url;
  });
}
const isVideo = (f: File) => f.type.startsWith('video/') || /\.(mp4|mov|m4v|webm)$/i.test(f.name);

function VideoThumb({ file }: { file: File }) {
  const [url, setUrl] = useState('');
  useEffect(() => { const u = URL.createObjectURL(file); setUrl(u); return () => URL.revokeObjectURL(u); }, [file]);
  // #t=0.1: iOS zeigt sonst nur ein schwarzes Feld statt des ersten Bildes
  return url ? <video src={`${url}#t=0.1`} muted playsInline preload="metadata" /> : null;
}

function Thumb({ file }: { file: File }) {
  const [url, setUrl] = useState('');
  useEffect(() => { const u = URL.createObjectURL(file); setUrl(u); return () => URL.revokeObjectURL(u); }, [file]);
  return url ? <img src={url} alt="" /> : null;
}
