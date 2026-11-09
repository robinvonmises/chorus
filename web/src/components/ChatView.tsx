import { Fragment, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { api, attachmentUrl, type Account, type Chat, type Message } from '../api';
import { NETWORKS, QUICK_REACTIONS, dayLabel } from '../util';
import { Avatar } from './Rail';
import { Icon } from './Icon';
import { MessageBubble, previewOf } from './Message';
import { Composer } from './Composer';
import { EmojiPicker } from './EmojiPicker';
import { AiPanel } from './AiPanel';
import { useExit } from '../useExit';
import { useAi } from '../aiState';
import { ContactSheet } from './ContactSheet';
import { outbox, useOutbox, type Outgoing } from '../outbox';

export function ChatView({ chat, account, messages, onBack, loadOlder, onPatchChat, onChat }: {
  chat: Chat; account?: Account; messages?: Message[]; onBack: () => void; loadOlder: () => Promise<boolean>;
  onPatchChat: (p: Partial<Pick<Chat, 'pinned' | 'muted' | 'archived'>>) => Promise<void>; onChat: (c: Chat) => void;
}) {
  const [contact, setContact] = useState(false);
  const scroller = useRef<HTMLDivElement>(null);
  const [replyTo, setReplyTo] = useState<Message | null>(null);
  const [editing, setEditing] = useState<Message | null>(null);
  const [menu, setMenu] = useState<{ m: Message; x: number; y: number; picker?: boolean } | null>(null);
  const [headMenu, setHeadMenu] = useState(false);
  const [toast, setToast] = useState('');
  const [loadingOld, setLoadingOld] = useState(false);
  const [atBottom, setAtBottom] = useState(true);
  const [aiOpen, setAiOpen] = useState(false);
  const aiAnim = useExit(aiOpen, 240);
  const menuAnim = useExit(!!menu, 180);
  const [menuShown, setMenuShown] = useState<typeof menu>(null);
  useEffect(() => { if (menu) setMenuShown(menu); }, [menu]);
  useEffect(() => {
    if (!aiOpen) return;
    const esc = (e: KeyboardEvent) => e.key === 'Escape' && setAiOpen(false);
    window.addEventListener('keydown', esc);
    return () => window.removeEventListener('keydown', esc);
  }, [aiOpen]);
  const [inject, setInject] = useState<{ text: string; n: number } | null>(null);
  const ai = useAi();
  const canTranscribe = !!ai?.features.transcribe && !!chat.aiEnabled;
  const prevLen = useRef(0);
  const prevFirst = useRef<string | null>(null);
  const prevHeight = useRef(0);

  const pending = useOutbox(chat.id);
  useLayoutEffect(() => { const el = scroller.current; if (el && pending.length) el.scrollTop = el.scrollHeight; }, [pending.length]);
  const byRemote = useMemo(() => new Map((messages ?? []).map((m) => [m.remoteId, m])), [messages]);
  const group = chat.kind !== 'direct';
  const connected = account?.status.state === 'connected';

  // Scrollposition: unten bleiben bei neuen Nachrichten, Position halten beim Nachladen
  useLayoutEffect(() => {
    const el = scroller.current;
    if (!el || !messages) return;
    const first = messages[0]?.id ?? null;
    if (prevFirst.current && first !== prevFirst.current && messages.length > prevLen.current) {
      el.scrollTop = el.scrollHeight - prevHeight.current + el.scrollTop; // älteres oben eingefügt
    } else if (prevLen.current === 0 || atBottom || messages.at(-1)?.fromMe) {
      el.scrollTop = el.scrollHeight;
    }
    prevLen.current = messages.length;
    prevFirst.current = first;
    prevHeight.current = el.scrollHeight;
  }, [messages]);

  // Bilder/Vorschauen laden nach: unten bleiben, statt dass der Chat ruckelnd nach oben rutscht
  const inner = useRef<HTMLDivElement>(null);
  const bottomRef = useRef(true);
  bottomRef.current = atBottom;
  useEffect(() => {
    const el = scroller.current, box = inner.current;
    if (!el || !box || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(() => { if (bottomRef.current) el.scrollTop = el.scrollHeight; prevHeight.current = el.scrollHeight; });
    ro.observe(box);
    ro.observe(el); // Tastatur auf/zu: Chat bleibt unten und gleitet mit
    return () => ro.disconnect();
  }, []);

  const onScroll = useCallback(async () => {
    const el = scroller.current!;
    prevHeight.current = el.scrollHeight;
    setAtBottom(el.scrollHeight - el.scrollTop - el.clientHeight < 80);
    if (el.scrollTop < 200 && !loadingOld && messages?.length) {
      setLoadingOld(true);
      await loadOlder().catch(() => false);
      setLoadingOld(false);
    }
  }, [loadOlder, loadingOld, messages?.length]);

  const flash = (t: string) => { setToast(t); setTimeout(() => setToast(''), 2500); };
  const guard = async (fn: () => Promise<unknown>) => { try { await fn(); } catch (e: any) { flash(e.message ?? 'Fehler'); } };

  const react = (m: Message, emoji: string | null) => guard(() => api.react(m.id, emoji));
  const transcribe = useCallback((m: Message) => api.ai.transcribe(m.id).then(() => {}).catch((e: any) => flash(e.message ?? 'Fehler')), []);
  const jump = (remoteId: string) => {
    const el = scroller.current?.querySelector(`[data-remote="${CSS.escape(remoteId)}"]`);
    if (el) { el.scrollIntoView({ block: 'center', behavior: 'smooth' }); el.classList.add('flash'); setTimeout(() => el.classList.remove('flash'), 1200); }
  };

  const items = useMemo(() => {
    const out: { m: Message; day?: string; showName: boolean }[] = [];
    let lastDay = '', lastSender = '';
    for (const m of messages ?? []) {
      const d = new Date(m.ts).toDateString();
      const day = d !== lastDay ? dayLabel(m.ts) : undefined;
      out.push({ m, day, showName: !!day || m.senderId !== lastSender });
      lastDay = d; lastSender = m.senderId;
    }
    return out;
  }, [messages]);

  return (
    <div className="chat-view" data-net={chat.network} onDragOver={(e) => e.preventDefault()}>
      <header className="chat-head">
        <button className="icon-btn back" onClick={onBack} aria-label="Zurück"><Icon name="back" /></button>
        <button className="chat-head-who" onClick={() => setContact(true)} aria-label="Profil anzeigen">
        <Avatar name={chat.title} size={40} src={chat.avatar} />
        <div className="chat-head-main">
          <b>{chat.title}</b>
          <small><span className="dot" style={{ background: NETWORKS[chat.network].color }} />{NETWORKS[chat.network].name}{account && account.label !== NETWORKS[chat.network].name ? ` · ${account.label}` : ''}{!connected && ' · nicht verbunden'}{chat.autopilot?.on && <span className="autopilot-tag"> · 🤖 Autopilot ({chat.autopilot.max - chat.autopilot.used} übrig)</span>}</small>
        </div>
        </button>
        <div className="menu-wrap">
          <button className="icon-btn" onClick={() => setHeadMenu((v) => !v)} aria-label="Chat-Menü"><Icon name="more" /></button>
          {headMenu && <div className="menu-catcher" onClick={() => setHeadMenu(false)} onTouchStart={() => setHeadMenu(false)} />}
          {headMenu && (
            <div className="menu right">
              <button onClick={() => { setHeadMenu(false); onPatchChat({ pinned: !chat.pinned }); }}><Icon name="pin" size={18} />{chat.pinned ? 'Lösen' : 'Anheften'}</button>
              <button onClick={() => { setHeadMenu(false); onPatchChat({ muted: !chat.muted }); }}><Icon name={chat.muted ? 'bell' : 'belloff'} size={18} />{chat.muted ? 'Ton an' : 'Stummschalten'}</button>
              <button onClick={() => { setHeadMenu(false); setContact(true); }}><Icon name="user" size={18} />{chat.kind === 'direct' ? 'Kontaktprofil' : 'Gruppeninfo'}</button>
              <button onClick={() => { setHeadMenu(false); onPatchChat({ archived: !chat.archived }); }}><Icon name="archive" size={18} />{chat.archived ? 'Aus dem Archiv holen' : 'Archivieren'}</button>
              <a href={`/api/export?chat=${encodeURIComponent(chat.id)}`} download onClick={() => { setHeadMenu(false); flash('Export wird erstellt, der Download startet gleich …'); }}><Icon name="download" size={18} />Chat herunterladen</a>
            </div>
          )}
        </div>
      </header>

      <div className="messages" ref={scroller} onScroll={onScroll}>
        <div className="messages-inner" ref={inner}>
        {loadingOld && <div className="loading-old">Lade ältere Nachrichten …</div>}
        {!messages && <div className="loading-old">Lade …</div>}
        {messages && !messages.length && <div className="loading-old">Noch keine Nachrichten.</div>}
        {items.map(({ m, day, showName }) => (
          <Fragment key={m.id}>
            {day && <div className="day"><span>{day}</span></div>}
            <MessageBubble m={m} group={group} showName={showName} replied={m.replyToRemoteId ? byRemote.get(m.replyToRemoteId) ?? null : undefined}
              onAction={(mm, p) => setMenu({ m: mm, ...p })} onReact={react} onJump={jump}
              onTranscribe={canTranscribe ? transcribe : undefined} />
          </Fragment>
        ))}
        {pending.map((o) => <PendingBubble key={o.id} o={o} />)}
        </div>
      </div>
      {!atBottom && <button className="to-bottom" onClick={() => scroller.current?.scrollTo({ top: scroller.current.scrollHeight, behavior: 'smooth' })}><Icon name="back" className="rot-270" /></button>}

      {aiAnim.mounted && <div className={`ai-backdrop ${aiAnim.closing ? 'out' : ''}`} onClick={() => setAiOpen(false)} />}
      <div className={`chat-dock ${aiAnim.mounted ? 'ai-on' : ''}`}>
        {aiAnim.mounted && <div className={`ai-sheet ${aiAnim.closing ? 'out' : ''}`}>
          <AiPanel chat={chat} replyTo={replyTo} onClose={() => setAiOpen(false)} onError={flash}
            onUse={(text) => { setInject({ text, n: Date.now() }); setAiOpen(false); }} />
        </div>}
        <Composer chat={chat} disabled={!connected} replyTo={replyTo} editing={editing} inject={inject} onAi={() => setAiOpen((v) => !v)} aiOpen={aiOpen}
          onCancel={() => { setReplyTo(null); setEditing(null); }}
          onSent={() => { setReplyTo(null); setEditing(null); }} onError={flash} />
      </div>

      {menuAnim.mounted && menuShown && ((menu => (
        <div className={`overlay ${menuAnim.closing ? 'out' : ''}`} onClick={() => setMenu(null)}>
          <div className="msg-menu" style={menuPos(menu)} onClick={(e) => e.stopPropagation()}>
            {menu.picker ? (
              <EmojiPicker onPick={(e) => { react(menu.m, e); setMenu(null); }} />
            ) : (<>
              <div className="quick-reactions">
                {QUICK_REACTIONS.map((e) => {
                  const mine = menu.m.reactions.some((r) => r.fromMe && r.emoji === e);
                  return <button key={e} className={mine ? 'on' : ''} onClick={() => { react(menu.m, mine ? null : e); setMenu(null); }}>{e}</button>;
                })}
                <button className="more" onClick={() => setMenu({ ...menu, picker: true })} title="Weitere"><Icon name="plus" size={18} /></button>
              </div>
              <div className="menu-list">
                <button onClick={() => { setReplyTo(menu.m); setEditing(null); setMenu(null); }}><Icon name="reply" size={18} />Antworten</button>
                {menu.m.text && <button onClick={() => { navigator.clipboard?.writeText(menu.m.text); setMenu(null); flash('Kopiert'); }}><Icon name="copy" size={18} />Text kopieren</button>}
                {menu.m.attachments.map((a, i) => (
                  <a key={i} href={attachmentUrl(menu.m, i, true)} download={a.name} onClick={() => setMenu(null)}><Icon name="download" size={18} />{a.kind === 'image' ? 'Bild speichern' : 'Herunterladen'}</a>
                ))}
                {menu.m.fromMe && menu.m.text && !menu.m.attachments.length && <button onClick={() => { setEditing(menu.m); setReplyTo(null); setMenu(null); }}><Icon name="edit" size={18} />Bearbeiten</button>}
                {menu.m.fromMe && <button className="danger" onClick={() => { const m = menu.m; setMenu(null); if (confirm('Für alle löschen?')) guard(() => api.remove(m.id, true)); }}><Icon name="trash" size={18} />Für alle löschen</button>}
                <button className="danger" onClick={() => { const m = menu.m; setMenu(null); guard(() => api.remove(m.id, false)); }}><Icon name="trash" size={18} />Für mich löschen</button>
              </div>
            </>)}
          </div>
        </div>
      ))(menu ?? menuShown))}
      {toast && <div className="toast">{toast}</div>}
      {contact && <ContactSheet chat={chat} account={account} onClose={() => setContact(false)} onChat={onChat} />}
    </div>
  );
}

function menuPos(m: { x: number; y: number; picker?: boolean }): React.CSSProperties {
  if (window.innerWidth < 640) return { left: 8, right: 8, bottom: 8, position: 'fixed' };
  const w = m.picker ? 340 : 300, h = m.picker ? 360 : 330;
  return { position: 'fixed', left: Math.max(8, Math.min(m.x, window.innerWidth - w - 8)), top: Math.max(8, Math.min(m.y, window.innerHeight - h - 8)) };
}

export { previewOf };

/** Datei, die gerade gesendet wird: erscheint sofort, mit Fortschritt */
function PendingBubble({ o }: { o: Outgoing }) {
  const label = o.phase === 'error' ? 'Nicht gesendet' : o.phase === 'work' ? (o.kind === 'video' ? 'Wird verarbeitet …' : 'Wird gesendet …') : `Wird hochgeladen … ${Math.round(o.progress * 100)} %`;
  const ring = o.phase === 'upload' ? o.progress : null;
  return (
    <div className="msg out pending">
      <div className={`bubble ${o.url && !o.caption ? "media-only" : ""} ${o.caption && o.url ? "has-media" : ""}`}>
        {o.url ? (
          <div className="pending-media">
            {o.kind === 'video' ? <video src={`${o.url}#t=0.1`} muted playsInline preload="metadata" /> : <img src={o.url} alt="" />}
            <span className="pending-ring">{o.phase === 'error' ? <Icon name="close" size={22} /> : <Ring p={ring} />}</span>
          </div>
        ) : (
          <div className="pending-file"><span className="pending-ring small">{o.phase === 'error' ? <Icon name="close" size={16} /> : <Ring p={ring} />}</span><span className="pending-name">{o.name}</span></div>
        )}
        {o.caption && <div className="text">{o.caption}</div>}
        <span className="meta pending-meta">{label}</span>
        {o.phase === 'error' && <button className="pending-x" onClick={() => outbox.remove(o.id)}>Ausblenden</button>}
      </div>
    </div>
  );
}

function Ring({ p }: { p: number | null }) {
  const r = 15, c = 2 * Math.PI * r;
  return (
    <svg viewBox="0 0 36 36" className={p == null ? 'spin' : ''}>
      <circle cx="18" cy="18" r={r} fill="none" stroke="currentColor" strokeOpacity=".25" strokeWidth="3" />
      <circle cx="18" cy="18" r={r} fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round"
        strokeDasharray={c} strokeDashoffset={p == null ? c * 0.7 : c * (1 - Math.max(0.03, p))} transform="rotate(-90 18 18)" style={{ transition: 'stroke-dashoffset .2s linear' }} />
    </svg>
  );
}
