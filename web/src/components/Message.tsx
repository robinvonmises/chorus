import { haptic } from '../haptics';
import { memo, useEffect, useRef, useState } from 'react';
import { openLightbox } from './Lightbox';
import { openFile, openMail } from './FileViewer';
import { attachmentUrl, thumbUrl, type Attachment, type Message } from '../api';
import { NETWORKS, adjLang, duration, fileSize, hue, isOnlyEmoji, msgTime } from '../util';
import type { Network } from '../api';
import { whenLabel } from './WhenPicker';
import { Icon } from './Icon';
import { Avatar } from './Rail';
import { player, usePlayer } from '../player';
import { T, lang, locale } from '../i18n';
import { justReacted } from '../effects';

const ATT_ICON = { image: '📷', video: '🎬', audio: '🎵', voice: '🎤', file: '📎', sticker: '' } as const;

export function previewOf(m: Message): string {
  if (m.deleted) return T('Nachricht gelöscht');
  const a = m.attachments[0];
  if (m.text) return (a && a.kind !== 'sticker' ? ATT_ICON[a.kind] + ' ' : '') + m.text;
  if (!a) return '';
  if (a.gif || /^image\/gif/i.test(a.mime)) return 'GIF';
  return { image: '📷 ' + T('Foto'), video: '🎬 ' + T('Video'), audio: '🎵 Audio', voice: '🎤 ' + T('Sprachnachricht'), file: '📎 ' + a.name, sticker: 'Sticker' }[a.kind];
}

export const MessageBubble = memo(function MessageBubble({ m, album, group, showName, senderAvatar, replied, onAction, onReact, onJump, onTranscribe, reminder, trLang }: {
  m: Message; group: boolean; showName: boolean; replied?: Message | null;
  /** Mehrere kurz nacheinander geschickte Foto-Nachrichten desselben Absenders, als eine Blase gezeigt (m = erste) */
  album?: Message[];
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
  const [showHist, setShowHist] = useState(false);
  // Vom Gegenüber gelöscht, Inhalt aber behalten
  const kept = m.deleted && !!(m.text || m.attachments.length || m.transcript);
  const hist = !m.deleted && m.edited ? m.history ?? [] : [];
  const big = !m.deleted && !m.attachments.length && isOnlyEmoji(m.text);
  const msgs = album ?? [m];
  const last = msgs[msgs.length - 1];
  // Fotos/Videos aus allen Nachrichten des Albums: ab zwei Stück als Mosaik
  const tiles = msgs.flatMap((x) => x.attachments.map((a, i) => ({ m: x, a, i })).filter((t) => isTile(t.a)));
  const mosaic = tiles.length >= 2;
  const media = mosaic || (m.attachments.length > 0 && ['image', 'video', 'sticker'].includes(effKind(m.attachments[0])));

  const startPress = (e: React.TouchEvent) => {
    const t = e.touches[0];
    press.current = window.setTimeout(() => { haptic(); onAction(m, { x: t.clientX, y: t.clientY }); }, 450);
  };
  const endPress = () => { if (press.current) clearTimeout(press.current); press.current = null; };

  // Reaktionen gruppieren
  const groups = new Map<string, { n: number; mine: boolean }>();
  for (const r of msgs.flatMap((x) => x.reactions)) {
    const g = groups.get(r.emoji) ?? { n: 0, mine: false };
    g.n++; g.mine ||= r.fromMe;
    groups.set(r.emoji, g);
  }
  const myReaction = m.reactions.find((r) => r.fromMe)?.emoji ?? null;

  return (
    <div className={`msg ${m.fromMe ? 'out' : 'in'}${showName ? ' first' : ''}${senderAvatar !== undefined ? ' with-av' : ''}`} data-remote={m.remoteId} data-id={m.id}
      onContextMenu={(e) => { e.preventDefault(); onAction(m, { x: e.clientX, y: e.clientY }); }}
      onTouchStart={startPress} onTouchEnd={endPress} onTouchMove={endPress}
      onDoubleClick={() => !m.deleted && onReact(m, myReaction === '❤️' ? null : '❤️')}>
      {senderAvatar !== undefined && showName && <span className="msg-av"><Avatar name={m.senderName || '?'} src={senderAvatar} size={32} /></span>}
      <div className={`bubble ${big ? 'big-emoji' : ''} ${media && !m.text ? 'media-only' : ''} ${media && m.text ? 'has-media' : ''} ${m.deleted ? (kept ? 'kept-deleted' : 'deleted') : ''}`}>
        {showName && group && !m.fromMe && <div className="sender" style={{ color: `hsl(${hue(m.senderName)} 50% 42%)` }}>{m.senderName}</div>}
        {replied !== undefined && m.replyToRemoteId && (
          <button className="quote" onClick={() => onJump(m.replyToRemoteId!)}>
            <b>{replied ? (replied.fromMe ? T('Du') : replied.senderName) : T('Nachricht')}</b>
            <span>{replied ? previewOf(replied) : T('Ältere Nachricht')}</span>
          </button>
        )}
        {kept && <div className="del-tag"><Icon name="ban" size={12} /> {T('Gelöscht')}</div>}
        {showHist && hist.length > 0 && (
          <div className="edit-hist">
            {hist.map((h, i) => <div key={i}><small>{i === 0 ? T('Original') : T('Fassung {0}', String(i + 1))}</small>{h.text}</div>)}
          </div>
        )}
        {m.deleted && !kept ? <i>{T('Diese Nachricht wurde gelöscht.')}</i> : <>
          {mosaic && <Mosaic tiles={tiles} lead={m} />}
          {m.attachments.map((a, i) => mosaic && isTile(a) ? null : <AttachmentView key={i} m={m} a={a} i={i} />)}
          {hasAudio(m) && <Transcript m={m} onTranscribe={onTranscribe} />}
          {m.text && <div className="text">{linkify(m.text)}</div>}
          {m.html && <button className="mail-orig" onClick={() => openMail(m)}><Icon name="file" size={14} />{T('Original-E-Mail ansehen')}</button>}
          {m.translation && (() => {
            // Eigene, übersetzt gesendete Nachricht: darunter steht das deutsche Original. Sonst die deutsche Übersetzung.
            const orig = m.fromMe && !m.translationFrom;
            const from = m.translationFrom ? adjLang(m.translationFrom) : trLang;
            return <div className={`translation ${orig ? 'orig' : ''}`}><Icon name="globe" size={13} /> <span>{orig ? <><small>{T('Original')}</small>{m.translation}</> : <>{from && <small>{T('Aus dem')}{' '}{from}</small>}{m.translation}</>}</span></div>;
          })()}
        </>}
        <span className="meta">
          {reminder && <span className="remind-tag" title={T('Erinnerung')}>⏰ {whenLabel(reminder)}</span>}
          {m.edited && !m.deleted && (hist.length
            ? <button className="edited-btn" onClick={(e) => { e.stopPropagation(); setShowHist((v) => !v); }} title={T('Frühere Fassungen zeigen')}>{T('bearbeitet')}</button>
            : <span>{T('bearbeitet')}</span>)}
          <span>{msgTime(last.ts)}</span>
          {last.fromMe && (last.status === 'failed'
            ? <button className="st failed" title={T('Nicht gesendet – tippen für „Erneut senden“')} aria-label={T('Nicht gesendet, Optionen')} onClick={(e) => { e.stopPropagation(); onAction(last, { x: e.clientX, y: e.clientY }); }}><Icon name="alert" size={14} /></button>
            : <StatusIcon s={last.status} />)}
        </span>
      </div>
      {!m.deleted && (
        <div className="hover-actions">
          <button className="icon-btn small" title={T("Reagieren")} onClick={(e) => onAction(m, { x: e.clientX, y: e.clientY })}><Icon name="smile" size={18} /></button>
          <button className="icon-btn small" title={T('Mehr')} onClick={(e) => onAction(m, { x: e.clientX, y: e.clientY })}><Icon name="more" size={18} /></button>
        </div>
      )}
      {groups.size > 0 && (
        <div className="reactions">
          {[...groups].map(([emoji, g]) => (
            <button key={emoji} className={`reaction ${g.mine ? 'mine' : ''}${g.mine && justReacted(m.id, emoji) ? ' fx-pop' : ''}`} onClick={() => onReact(m, g.mine ? null : emoji)} title={g.mine ? T('Reaktion entfernen') : T('Auch reagieren')}>
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
      {busy ? <><span className="spinner" /> {T('Wird transkribiert …')}</> : <><Icon name="file" size={14} /> {T('Transkribieren')}</>}
    </button>
  );
}

function StatusIcon({ s }: { s: Message['status'] }) {
  if (s === 'pending') return <Icon name="clock" size={14} className="st" />;
  if (s === 'failed') return <span className="st failed" title={T('Nicht gesendet')}><Icon name="alert" size={14} /></span>;
  if (s === 'read') return <Icon name="checks" size={16} className="st read" />;
  if (s === 'delivered') return <Icon name="checks" size={16} className="st" />;
  return <Icon name="check" size={14} className="st" />;
}

/** Kommt ins Mosaik: Foto oder Video (keine Sticker, keine GIF-Animationen) */
function isTile(a: Attachment) { const k = effKind(a); return !a.gif && ((k === 'image' && !/gif/i.test(a.mime)) || k === 'video'); }

/** Ist die Nachricht ein reines Foto/Video ohne Text, Zitat o. ä.? Dann darf sie sich einem Album anschließen. */
export function albumable(m: Message, lead = false) {
  if (m.deleted || m.status === 'failed' || !m.attachments.length || !m.attachments.every(isTile)) return false;
  return lead || (!m.text && !m.replyToRemoteId && !m.translation && !m.transcript);
}

/** Mehrere Fotos/Videos als Raster wie bei Signal: 2 nebeneinander, 3 = eins groß + zwei klein, ab 4 als 2×2 mit „+N“ */
function Mosaic({ tiles, lead }: { tiles: { m: Message; a: Attachment; i: number }[]; lead: Message }) {
  const items = tiles.map((t) => ({ src: attachmentUrl(t.m, t.i), name: t.a.name, download: attachmentUrl(t.m, t.i, true), video: effKind(t.a) === 'video', ref: { m: t.m, i: t.i } }));
  const more = tiles.length - 4;
  return (
    <div className={`mosaic n${Math.min(tiles.length, 4)}`}>
      {tiles.slice(0, 4).map((t, k) => {
        const pending = t.m.status === 'pending';
        return (
          <a key={`${t.m.id}:${t.i}`} className="mosaic-tile" href={pending ? undefined : items[k].src} data-remote={t.m !== lead ? t.m.remoteId : undefined}
            onClick={(e) => { e.preventDefault(); if (!pending) openLightbox(items[k], items, k); }}>
            {!pending && <MediaThumb m={t.m} a={{ ...t.a, kind: effKind(t.a) }} i={t.i} />}
            {k === 3 && more > 0 && <span className="mosaic-more">+{more}</span>}
          </a>
        );
      })}
    </div>
  );
}

/** Kleine Vorschau vom Server (?thumb=1); falls es keine gibt, das Original */
export function MediaThumb({ m, a, i }: { m: Message; a: Attachment; i: number }) {
  const [failed, setFailed] = useState(false);
  if (failed && a.kind === 'video') return <><video src={`${attachmentUrl(m, i)}#t=0.1`} muted playsInline preload="metadata" /><span className="gallery-play"><Icon name="play" size={18} /></span></>;
  return <>
    <img src={failed ? attachmentUrl(m, i) : thumbUrl(m, i)} alt="" loading="lazy" decoding="async" onError={() => !failed && setFailed(true)} />
    {a.kind === 'video' && <span className="gallery-play"><Icon name="play" size={18} /></span>}
  </>;
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
  if (failed) return <FileCard m={m} a={a} i={i} note={T('Vorschau nicht verfügbar')} />;
  if (a.kind === 'image' || a.kind === 'sticker') {
    // Größe bekannt: Breite und Seitenverhältnis fest vorgeben, damit beim Laden nichts springt
    const sized = a.width && a.height ? { aspectRatio: `${a.width} / ${a.height}`, width: a.width } : undefined;
    return (
      <a className={`att-img ${a.kind}`} href={pending ? undefined : url} style={sized}
        onClick={(e) => { e.preventDefault(); if (!pending) openLightbox({ src: url, name: a.name, download: attachmentUrl(m, i, true), ref: { m, i } }); }}>
        {!pending && <img src={/^image\/gif/i.test(a.mime) ? url : thumbUrl(m, i)} alt={a.name} loading="lazy" onError={() => setFailed(true)} />}
      </a>
    );
  }
  // GIF als Video (WhatsApp, Telegram): stumm in Schleife wie ein Bild, Tippen öffnet die Großansicht
  if (a.kind === 'video' && a.gif) return <GifVideo url={pending ? undefined : url} a={a} onOpen={() => !pending && openLightbox({ src: url, name: a.name, download: attachmentUrl(m, i, true), video: true, ref: { m, i } })} />;
  // Video: nur Standbild mit Play-Symbol; Tippen spielt es im Vollbild ab (Lightbox startet es noch in der Tipp-Geste, also mit Ton)
  if (a.kind === 'video') return (
    <a className="att-img att-vid" href={pending ? undefined : url}
      style={a.width && a.height ? { aspectRatio: `${a.width} / ${a.height}`, width: a.width } : undefined}
      onClick={(e) => { e.preventDefault(); if (!pending) openLightbox({ src: url, name: a.name, download: attachmentUrl(m, i, true), video: true, ref: { m, i } }); }}>
      {!pending && <MediaThumb m={m} a={a} i={i} />}
      <span className="att-vid-play"><Icon name="play" size={26} /></span>
      {a.durationSec ? <span className="att-vid-dur">{duration(a.durationSec)}</span> : null}
    </a>
  );
  if (a.kind === 'voice' || a.kind === 'audio') return <VoicePlayer m={m} i={i} url={pending ? null : `${url}&play=1`} dur={a.durationSec} voice={a.kind === 'voice'} name={a.name} />;
  return <FileCard m={m} a={a} i={i} />;
}

/** Läuft nur, solange es sichtbar ist (spart Akku und Speicher in langen Chats) */
function GifVideo({ url, a, onOpen }: { url?: string; a: Attachment; onOpen: () => void }) {
  const v = useRef<HTMLVideoElement>(null);
  useEffect(() => {
    const el = v.current; if (!el || !url) return;
    const io = new IntersectionObserver((e) => { if (e[0].isIntersecting) el.play().catch(() => {}); else el.pause(); }, { rootMargin: '100px' });
    io.observe(el); return () => io.disconnect();
  }, [url]);
  return <video ref={v} className="att-video att-gif" src={url} muted loop playsInline preload="metadata" disableRemotePlayback onClick={onOpen}
    style={a.width && a.height ? { aspectRatio: `${a.width} / ${a.height}`, width: a.width } : undefined} />;
}

function FileCard({ m, a, i, note }: { m: Message; a: Attachment; i: number; note?: string }) {
  return (
    <a className="att-file" href={attachmentUrl(m, i, true)} onClick={(e) => { e.preventDefault(); if (m.status !== 'pending') openFile(m, i); }}>
      <span className="att-file-icon"><Icon name="file" /></span>
      <span className="att-file-main"><b>{a.name}</b><small>{note ?? fileSize(a.size)}</small></span>
      <Icon name="back" size={18} className="rot-180" />
    </a>
  );
}

function VoicePlayer({ m, i, url, dur, voice, name }: { m: Message; i: number; url: string | null; dur?: number; voice: boolean; name: string }) {
  const p = usePlayer();
  const key = `${m.id}:${i}`;
  const mine = p.track?.key === key;
  const total = mine ? p.total || dur || 0 : dur ?? 0;
  const pos = mine ? p.pos : 0;
  const start = () => url && player.play({ key, url, chatId: m.chatId, sender: m.fromMe ? T('Du') : m.senderName, voice, dur });
  return (
    <div className="voice">
      <button className="voice-play" onClick={start} disabled={!url} aria-label={mine && p.playing ? T('Pause') : T('Abspielen')}><Icon name={mine && p.playing ? 'pause' : 'play'} size={18} /></button>
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
