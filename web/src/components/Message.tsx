import { memo, useRef, useState } from 'react';
import { openLightbox } from './Lightbox';
import { attachmentUrl, thumbUrl, type Attachment, type Message } from '../api';
import { NETWORKS, adjLang, duration, fileSize, hue, isOnlyEmoji, msgTime } from '../util';
import type { Network } from '../api';
import { whenLabel } from './WhenPicker';
import { Icon } from './Icon';
import { Avatar } from './Rail';
import { player, usePlayer } from '../player';

export function previewOf(m: Message): string {
  if (m.deleted) return 'Nachricht gelöscht';
  if (m.text) return m.text;
  const a = m.attachments[0];
  if (!a) return '';
  return { image: '📷 Foto', video: '🎬 Video', audio: '🎵 Audio', voice: '🎤 Sprachnachricht', file: '📎 ' + a.name, sticker: 'Sticker' }[a.kind];
}

export const MessageBubble = memo(function MessageBubble({ m, group, showName, senderAvatar, replied, onAction, onReact, onJump, onTranscribe, reminder, trLang }: {
  m: Message; group: boolean; showName: boolean; replied?: Message | null;
  /** Gruppen, eingehend: Profilbild des Absenders (null = Initialen); undefined = keine Bild-Spalte */
  senderAvatar?: string | null;
  /** Live-Übersetzung: Sprache des Chatpartners (für „Übersetzt aus …“) */
  trLang?: string | null;
  /** Bei zusammengeführten Kontakten: über welchen Messenger die Nachricht lief */
  /** Erinnerung an diese Nachricht (Zeitpunkt) */
  reminder?: number;
  onAction: (m: Message, anchor: { x: number; y: number }) => void;
  onReact: (m: Message, emoji: string | null) => void;
  onJump: (remoteId: string) => void;
  onTranscribe?: (m: Message) => Promise<void>;
}) {
  const press = useRef<number | null>(null);
  const big = !m.deleted && !m.attachments.length && isOnlyEmoji(m.text);
  const media = m.attachments.length > 0 && ['image', 'video', 'sticker'].includes(effKind(m.attachments[0]));

  const startPress = (e: React.TouchEvent) => {
    const t = e.touches[0];
    press.current = window.setTimeout(() => { navigator.vibrate?.(10); onAction(m, { x: t.clientX, y: t.clientY }); }, 450);
  };
  const endPress = () => { if (press.current) clearTimeout(press.current); press.current = null; };

  // Reaktionen gruppieren
  const groups = new Map<string, { n: number; mine: boolean }>();
  for (const r of m.reactions) {
    const g = groups.get(r.emoji) ?? { n: 0, mine: false };
    g.n++; g.mine ||= r.fromMe;
    groups.set(r.emoji, g);
  }
  const myReaction = m.reactions.find((r) => r.fromMe)?.emoji ?? null;

  return (
    <div className={`msg ${m.fromMe ? 'out' : 'in'}${showName ? ' first' : ''}${senderAvatar !== undefined ? ' with-av' : ''}`} data-remote={m.remoteId}
      onContextMenu={(e) => { e.preventDefault(); onAction(m, { x: e.clientX, y: e.clientY }); }}
      onTouchStart={startPress} onTouchEnd={endPress} onTouchMove={endPress}
      onDoubleClick={() => !m.deleted && onReact(m, myReaction === '❤️' ? null : '❤️')}>
      {senderAvatar !== undefined && showName && <span className="msg-av"><Avatar name={m.senderName || '?'} src={senderAvatar} size={32} /></span>}
      <div className={`bubble ${big ? 'big-emoji' : ''} ${media && !m.text ? 'media-only' : ''} ${media && m.text ? 'has-media' : ''} ${m.deleted ? 'deleted' : ''}`}>
        {showName && group && !m.fromMe && <div className="sender" style={{ color: `hsl(${hue(m.senderName)} 50% 42%)` }}>{m.senderName}</div>}
        {replied !== undefined && m.replyToRemoteId && (
          <button className="quote" onClick={() => onJump(m.replyToRemoteId!)}>
            <b>{replied ? (replied.fromMe ? 'Du' : replied.senderName) : 'Nachricht'}</b>
            <span>{replied ? previewOf(replied) : 'Ältere Nachricht'}</span>
          </button>
        )}
        {m.deleted ? <i>Diese Nachricht wurde gelöscht.</i> : <>
          {m.attachments.map((a, i) => <AttachmentView key={i} m={m} a={a} i={i} />)}
          {hasAudio(m) && <Transcript m={m} onTranscribe={onTranscribe} />}
          {m.text && <div className="text">{linkify(m.text)}</div>}
          {m.translation && (() => {
            // Eigene, übersetzt gesendete Nachricht: darunter steht das deutsche Original. Sonst die deutsche Übersetzung.
            const orig = m.fromMe && !m.translationFrom;
            const from = m.translationFrom ? adjLang(m.translationFrom) : trLang;
            return <div className={`translation ${orig ? 'orig' : ''}`}><Icon name="globe" size={13} /> <span>{orig ? <><small>Original</small>{m.translation}</> : <>{from && <small>Aus dem {from}</small>}{m.translation}</>}</span></div>;
          })()}
        </>}
        <span className="meta">
          {reminder && <span className="remind-tag" title="Erinnerung">⏰ {whenLabel(reminder)}</span>}
          {m.edited && !m.deleted && <span>bearbeitet</span>}
          <span>{msgTime(m.ts)}</span>
          {m.fromMe && <StatusIcon s={m.status} />}
        </span>
      </div>
      {!m.deleted && (
        <div className="hover-actions">
          <button className="icon-btn small" title="Reagieren" onClick={(e) => onAction(m, { x: e.clientX, y: e.clientY })}><Icon name="smile" size={18} /></button>
          <button className="icon-btn small" title="Mehr" onClick={(e) => onAction(m, { x: e.clientX, y: e.clientY })}><Icon name="more" size={18} /></button>
        </div>
      )}
      {groups.size > 0 && (
        <div className="reactions">
          {[...groups].map(([emoji, g]) => (
            <button key={emoji} className={`reaction ${g.mine ? 'mine' : ''}`} onClick={() => onReact(m, g.mine ? null : emoji)} title={g.mine ? 'Reaktion entfernen' : 'Auch reagieren'}>
              {emoji}{g.n > 1 && <span>{g.n}</span>}
            </button>
          ))}
        </div>
      )}
    </div>
  );
});

function hasAudio(m: Message) { return m.attachments.some((a) => a.kind === 'voice' || effKind(a) === 'audio'); }

function Transcript({ m, onTranscribe }: { m: Message; onTranscribe?: (m: Message) => Promise<void> }) {
  const [busy, setBusy] = useState(false);
  if (m.transcript) return <div className="transcript"><Icon name="file" size={14} /> {m.transcript}</div>;
  if (!onTranscribe || m.status === 'pending') return null;
  return (
    <button className="transcribe-btn" disabled={busy} onClick={async () => { setBusy(true); await onTranscribe(m); setBusy(false); }}>
      {busy ? <><span className="spinner" /> Wird transkribiert …</> : <><Icon name="file" size={14} /> Transkribieren</>}
    </button>
  );
}

function StatusIcon({ s }: { s: Message['status'] }) {
  if (s === 'pending') return <Icon name="clock" size={14} className="st" />;
  if (s === 'failed') return <span className="st failed" title="Nicht gesendet"><Icon name="alert" size={14} /></span>;
  if (s === 'read') return <Icon name="checks" size={16} className="st read" />;
  if (s === 'delivered') return <Icon name="checks" size={16} className="st" />;
  return <Icon name="check" size={14} className="st" />;
}

/** Als Datei geschickte Fotos/Videos trotzdem als Bild/Video zeigen (auch bei älteren Nachrichten) */
function effKind(a: Attachment): Attachment['kind'] {
  if (a.kind !== 'file') return a.kind;
  if (/^image\/(jpeg|png|webp|gif|heic|heif|avif)/i.test(a.mime) || /\.(jpe?g|png|webp|gif|heic|avif)$/i.test(a.name)) return 'image';
  if (/^video\/(mp4|quicktime|webm)/i.test(a.mime) || /\.(mp4|mov|m4v|webm)$/i.test(a.name)) return 'video';
  if (/^audio\//i.test(a.mime)) return 'audio';
  return 'file';
}

export function AttachmentView({ m, a: raw, i }: { m: Message; a: Attachment; i: number }) {
  const a = { ...raw, kind: effKind(raw) };
  const url = attachmentUrl(m, i);
  const [failed, setFailed] = useState(false);
  const pending = m.status === 'pending';
  if (failed) return <FileCard m={m} a={a} i={i} note="Vorschau nicht verfügbar" />;
  if (a.kind === 'image' || a.kind === 'sticker') {
    // Größe bekannt: Breite und Seitenverhältnis fest vorgeben, damit beim Laden nichts springt
    const sized = a.width && a.height ? { aspectRatio: `${a.width} / ${a.height}`, width: a.width } : undefined;
    return (
      <a className={`att-img ${a.kind}`} href={pending ? undefined : url} style={sized}
        onClick={(e) => { e.preventDefault(); if (!pending) openLightbox({ src: url, name: a.name, download: attachmentUrl(m, i, true) }); }}>
        {!pending && <img src={thumbUrl(m, i)} alt={a.name} loading="lazy" onError={() => setFailed(true)} />}
      </a>
    );
  }
  if (a.kind === 'video') return <video className="att-video" src={pending ? undefined : url} controls preload="none" playsInline
    style={a.width && a.height ? { aspectRatio: `${a.width} / ${a.height}`, width: a.width } : undefined} />;
  if (a.kind === 'voice' || a.kind === 'audio') return <VoicePlayer m={m} i={i} url={pending ? null : `${url}&play=1`} dur={a.durationSec} voice={a.kind === 'voice'} name={a.name} />;
  return <FileCard m={m} a={a} i={i} />;
}

function FileCard({ m, a, i, note }: { m: Message; a: Attachment; i: number; note?: string }) {
  return (
    <a className="att-file" href={attachmentUrl(m, i, true)} download={a.name}>
      <span className="att-file-icon"><Icon name="file" /></span>
      <span className="att-file-main"><b>{a.name}</b><small>{note ?? fileSize(a.size)}</small></span>
      <Icon name="download" size={20} />
    </a>
  );
}

function VoicePlayer({ m, i, url, dur, voice, name }: { m: Message; i: number; url: string | null; dur?: number; voice: boolean; name: string }) {
  const p = usePlayer();
  const key = `${m.id}:${i}`;
  const mine = p.track?.key === key;
  const total = mine ? p.total || dur || 0 : dur ?? 0;
  const pos = mine ? p.pos : 0;
  const start = () => url && player.play({ key, url, chatId: m.chatId, sender: m.fromMe ? 'Du' : m.senderName, voice, dur });
  return (
    <div className="voice">
      <button className="voice-play" onClick={start} disabled={!url} aria-label={mine && p.playing ? 'Pause' : 'Abspielen'}><Icon name={mine && p.playing ? 'pause' : 'play'} size={18} /></button>
      <div className="voice-track" onClick={(e) => {
        if (!mine || !total) return start();
        const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
        player.seek(((e.clientX - r.left) / r.width) * total);
      }}>
        <div className="voice-bar" style={{ width: total ? `${(pos / total) * 100}%` : '0%' }} />
      </div>
      <span className="voice-time">{duration(mine && (p.playing || pos) ? pos : total)}</span>
      {voice && mine && <button className="voice-rate" onClick={() => player.cycleRate()}>{p.rate}×</button>}
      {!voice && <small className="voice-name">{name}</small>}
    </div>
  );
}

const URL_RE = /(https?:\/\/[^\s<]+[^\s<.,;:!?)\]'"])/g;
function linkify(text: string) {
  const parts = text.split(URL_RE);
  return parts.map((p, i) => (i % 2 ? <a key={i} href={p} target="_blank" rel="noreferrer noopener">{p}</a> : p));
}
