import { haptic } from '../haptics';
import { saveAttachment, TARGET_LABEL, targetsFor, useStorage } from '../storageState';
import { openSaveAs } from './NextcloudBrowser';
import { openFile, standalone } from './FileViewer';
import { Fragment, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { api, attachmentUrl, type Account, type Chat, type Message, type Planned } from '../api';
import { WhenPicker, whenLabel } from './WhenPicker';
import { NETWORKS, QUICK_REACTIONS, adjLang, askMailDelete, dayLabel } from '../util';
import { TranslateSheet } from './TranslateSheet';
import { ChatThemeSheet } from './ChatThemeSheet';
import { chatThemeStyle, loadChatTheme } from '../bubbles';
import { Avatar } from './Rail';
import { Icon } from './Icon';
import { MessageBubble, albumable, previewOf } from './Message';
import { Composer } from './Composer';
import { EmojiPicker } from './EmojiPicker';
import { AiPanel } from './AiPanel';
import { OrganizeSheet } from './OrganizeSheet';
import { useExit } from '../useExit';
import { useAi } from '../aiState';
import { ContactSheet } from './ContactSheet';
import { ForwardSheet } from './ForwardSheet';
import { outbox, useOutbox, type Outgoing } from '../outbox';
import { rise, takeRise } from '../sendAnim';
import { T } from '../i18n';
import { animoji, burst, useTypingAny } from '../effects';

const TTLS: [number, string][] = [[0, T('Nie')], [3600, T('1 Std.')], [86400, T('1 Tag')], [7 * 86400, T('1 Woche')], [30 * 86400, T('30 Tage')]];

/** „Englisch“ → „Englischen“ (aus dem Englischen) */

export function ChatView({ chat, account, messages, onBack, loadOlder, onPatchChat, onChat, linked = [chat], accounts = [], focus, planned = [], onGallery, onOpenMessage, onRemove }: {
  chat: Chat; account?: Account; messages?: Message[]; onBack: () => void; loadOlder: () => Promise<boolean>;
  linked?: Chat[]; accounts?: Account[]; focus?: { id: string; remoteId: string; n: number } | null; planned?: Planned[];
  onGallery?: () => void; onOpenMessage?: (m: Message) => void; onRemove: () => void;
  onPatchChat: (p: Partial<Pick<Chat, 'pinned' | 'muted' | 'archived'>>) => Promise<void>; onChat: (c: Chat) => void;
}) {
  const [contact, setContact] = useState(false);
  const scroller = useRef<HTMLDivElement>(null);
  const [replyTo, setReplyTo] = useState<Message | null>(null);
  const [editing, setEditing] = useState<Message | null>(null);
  const [menu, setMenu] = useState<{ m: Message; x: number; y: number; picker?: boolean } | null>(null);
  const [headMenu, setHeadMenu] = useState(false);
  // Notizen an mich: Lebensdauer neuer Notizen (gilt für alle Geräte)
  const notes = chat.network === 'notes';
  const [ttl, setTtl] = useState(0);
  useEffect(() => { if (notes) api.notes().then((r) => setTtl(r.ttl)).catch(() => {}); }, [notes, headMenu]);
  const [toast, setToast] = useState('');
  const [loadingOld, setLoadingOld] = useState(false);
  const loadingRef = useRef(false);
  const exhausted = useRef<string | null>(null);
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
  const [draftEmpty, setDraftEmpty] = useState(true);
  const ai = useAi();
  // Transkribieren ist ein ausdrücklicher Klick pro Nachricht: braucht nur den ElevenLabs-Schlüssel, nicht die KI-Freigabe des Chats
  // (sonst fehlte der Knopf in Chats ohne KI-Opt-in, z. B. bei zusammengeführten WhatsApp-Kontakten).
  const canTranscribe = !!ai?.features.transcribe;
  const [organizeFor, setOrganizeFor] = useState<Message | null>(null);
  // „Was hab ich verpasst?“: Zahl der Ungelesenen beim Öffnen merken (danach gilt der Chat als gelesen)
  const [missed, setMissed] = useState<{ n: number; text?: string; busy?: boolean } | null>(() => {
    const n = linked.reduce((k, c) => k + (c.unread || 0), 0);
    return n >= CATCHUP_MIN ? { n } : null;
  });
  const prevLen = useRef(0);
  const prevFirst = useRef<string | null>(null);
  const prevHeight = useRef(0);

  const pending = useOutbox(chat.id);
  const prevPending = useRef(0);
  useLayoutEffect(() => {
    const el = scroller.current;
    if (el && pending.length) el.scrollTop = el.scrollHeight;
    // Neue Datei-/Sprachblasen (kommen nur vom eigenen Senden): aus dem Eingabefeld aufsteigen lassen
    if (el && pending.length > prevPending.current) [...el.querySelectorAll('.msg.pending')].slice(prevPending.current - pending.length).forEach(rise);
    prevPending.current = pending.length;
  }, [pending.length]);
  const byRemote = useMemo(() => new Map((messages ?? []).map((m) => [m.remoteId, m])), [messages]);
  const group = chat.kind !== 'direct';
  // Zusammengeführter Kontakt: Senden über den im Kontaktprofil gewählten Messenger, sonst über den, über den zuletzt etwas kam
  const multi = linked.length > 1;
  const netOf = useMemo(() => new Map(linked.map((c) => [c.id, c.network])), [linked]);
  const via = linked.find((c) => c.sendVia)?.sendVia ?? null;
  const lastIn = useMemo(() => [...(messages ?? [])].reverse().find((m) => !m.fromMe)?.chatId, [messages]);
  const sendChat = linked.find((c) => c.id === (via ?? lastIn)) ?? chat;
  const sendAccount = multi ? accounts.find((a) => a.id === sendChat.accountId) : account;
  const connected = sendAccount?.status.state === 'connected';
  const ids = useMemo(() => new Set(linked.map((c) => c.id)), [linked]);
  const mine = planned.filter((p) => ids.has(p.chatId));
  const scheduled = mine.filter((p) => p.kind === 'send');
  const reminders = useMemo(() => new Map(mine.filter((p) => p.kind === 'remind' && p.messageId).map((p) => [p.messageId!, p.at])), [mine]);
  const [showPlanned, setShowPlanned] = useState(false);
  const [remindFor, setRemindFor] = useState<Message | null>(null);
  const [forward, setForward] = useState<Message | null>(null);
  const tr = chat.translate;
  const [trSheet, setTrSheet] = useState(false);
  const [themeSheet, setThemeSheet] = useState(false);
  const [theme, setTheme] = useState(() => loadChatTheme(chat.id));
  useEffect(() => {
    setTheme(loadChatTheme(chat.id));
    const h = () => setTheme(loadChatTheme(chat.id));
    window.addEventListener('chorus:theme', h);
    return () => window.removeEventListener('chorus:theme', h);
  }, [chat.id]);

  // Scrollposition: unten bleiben bei neuen Nachrichten, Position halten beim Nachladen
  const prevLast = useRef<string | null>(null);
  useLayoutEffect(() => {
    const el = scroller.current;
    if (!el || !messages) return;
    const first = messages[0]?.id ?? null;
    if (prevLen.current && messages.length > prevLen.current && (first !== prevFirst.current || messages.at(-1)?.id === prevLast.current)) {
      el.scrollTop = el.scrollHeight - prevHeight.current + el.scrollTop; // älteres oben eingefügt (bei verknüpften Chats auch mittendrin)
    } else if (prevLen.current === 0 || atBottom || (messages.at(-1)?.fromMe && messages.at(-1)?.id !== prevLast.current)) {
      // Nur bei einer wirklich neuen eigenen Nachricht nach unten springen, nicht bei jeder Aktualisierung
      // (Lesebestätigung, Reaktion …), sonst reißt es einen beim Hochscrollen immer wieder nach unten
      el.scrollTop = el.scrollHeight;
    }
    const last = messages.at(-1);
    if (prevLen.current && last?.fromMe && last.id !== prevLast.current && takeRise()) rise(el.querySelector(`[data-remote="${CSS.escape(last.remoteId)}"]`));
    prevLast.current = last?.id ?? null;
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
    // Ältere Nachrichten nachladen. Gibt es keine mehr (z. B. Signal ohne alten Verlauf), nicht immer wieder fragen:
    // jedes erfolglose Nachladen ließ den Chat oben springen.
    if (el.scrollTop < 200 && !loadingRef.current && messages?.length && exhausted.current !== chat.id) {
      loadingRef.current = true;
      const t = setTimeout(() => setLoadingOld(true), 300); // Hinweis nur, wenn es dauert
      const more = await loadOlder().catch(() => false);
      clearTimeout(t); setLoadingOld(false);
      if (!more) exhausted.current = chat.id;
      loadingRef.current = false;
    }
  }, [loadOlder, messages?.length, chat.id]);

  const storage = useStorage();
  const flash = (t: string) => { setToast(t); setTimeout(() => setToast(''), 2500); };
  const guard = async (fn: () => Promise<unknown>) => { try { await fn(); } catch (e: any) { flash(e.message ?? T('Fehler')); } };

  // Feste Funktionen für die Blasen: Sonst zeichnet jede Kleinigkeit (auch eine Nachricht in einem anderen Chat) alle Blasen neu
  const react = useCallback((m: Message, emoji: string | null) => { haptic(); if (emoji) { burst(m.id, emoji); animoji(m.id, emoji); } void api.react(m.id, emoji).catch((e: any) => flash(e.message ?? T('Fehler'))); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const openMenu = useCallback((mm: Message, p: { x: number; y: number }) => setMenu({ m: mm, ...p }), []);
  const transcribe = useCallback((m: Message) => api.ai.transcribe(m.id).then(() => {}).catch((e: any) => flash(e.message ?? T('Fehler'))), []);
  const summarizeVoice = useCallback((m: Message) => api.ai.voiceSummary(m.id).then(() => {}).catch((e: any) => flash(e.message ?? T('Fehler'))), []);
  const detect = useCallback((m: Message) => setOrganizeFor(m), []);
  const catchUp = async () => {
    if (!missed || missed.busy) return;
    if (!chat.aiEnabled) {
      if (!confirm(T('Für die Zusammenfassung gehen die neuen Nachrichten dieses Chats an die KI. KI für diesen Chat erlauben?'))) return;
      try { onChat(await api.ai.setChat(chat.id, true)); } catch (e: any) { flash(e.message ?? T('Fehler')); return; }
    }
    setMissed({ ...missed, busy: true });
    try { setMissed({ n: missed.n, text: (await api.ai.catchUp(chat.id, missed.n)).text }); }
    catch (e: any) { flash(e.message ?? T('Fehler')); setMissed({ n: missed.n }); }
  };
  const jump = useCallback((remoteId: string) => {
    const el = scroller.current?.querySelector(`[data-remote="${CSS.escape(remoteId)}"]`);
    if (el) { el.scrollIntoView({ block: 'center', behavior: 'smooth' }); el.classList.add('flash'); setTimeout(() => el.classList.remove('flash'), 1200); }
  }, []);

  // Gesprungen aus Suche, Galerie oder Erinnerung
  useEffect(() => {
    if (!focus || !messages?.some((m) => m.id === focus.id)) return;
    requestAnimationFrame(() => requestAnimationFrame(() => jump(focus.remoteId)));
  }, [focus?.n, messages?.length]); // eslint-disable-line react-hooks/exhaustive-deps

  // Gruppen: Profilbilder der Absender (wie bei Signal neben der ersten Nachricht einer Folge)
  const [senderAv, setSenderAv] = useState<Record<string, string>>({});
  const sendersKey = useMemo(() => group ? [...new Set((messages ?? []).filter((m) => !m.fromMe).map((m) => m.senderId))].sort().join('|') : '', [group, messages]);
  useEffect(() => {
    if (!group) { setSenderAv({}); return; }
    let alive = true; let timer = 0;
    const load = (tries: number) => api.senderAvatars(chat.id).then((r) => {
      if (!alive) return;
      setSenderAv((old) => JSON.stringify(old) === JSON.stringify(r.avatars) ? old : r.avatars);
      // Fehlende Bilder holt der Server langsam nach: ein paar Mal später erneut nachsehen
      if (r.pending && tries < 3) timer = window.setTimeout(() => load(tries + 1), 20_000 * (tries + 1));
    }).catch(() => {});
    load(0);
    return () => { alive = false; clearTimeout(timer); };
  }, [chat.id, group, sendersKey]);

  const items = useMemo(() => {
    const out: { m: Message; day?: string; showName: boolean; album?: Message[] }[] = [];
    let lastDay = '', lastSender = '';
    for (const m of messages ?? []) {
      const d = new Date(m.ts).toDateString();
      const day = d !== lastDay ? dayLabel(m.ts) : undefined;
      // Mehrere Fotos kurz hintereinander (z. B. WhatsApp schickt jedes einzeln): an die vorige Blase anhängen
      const prev = out[out.length - 1];
      const tail = prev?.album?.[prev.album.length - 1] ?? prev?.m;
      if (prev && tail && !day && m.senderId === tail.senderId && m.fromMe === tail.fromMe && m.ts - tail.ts < 3 * 60_000
        && albumable(m) && (prev.album ? true : albumable(prev.m, true))) {
        prev.album = [...(prev.album ?? [prev.m]), m];
        continue;
      }
      out.push({ m, day, showName: !!day || m.senderId !== lastSender });
      lastDay = d; lastSender = m.senderId;
    }
    return out;
  }, [messages]);

  // Wie bei iMessage: Wer im Verlauf mit dem Finger nach unten wischt (also nach oben scrollt), schließt die Tastatur
  const touchY = useRef<number | null>(null);
  const touchStart = (e: React.TouchEvent) => { touchY.current = e.touches[0]?.clientY ?? null; };
  const touchMove = (e: React.TouchEvent) => {
    const y = e.touches[0]?.clientY;
    if (touchY.current == null || y == null || y - touchY.current < 12) return;
    touchY.current = null;
    const a = document.activeElement as HTMLElement | null;
    if (a?.matches('textarea, input')) a.blur();
  };

  return (
    <div className={`chat-view${theme.bg ? ' own-bg' : ''}`} style={chatThemeStyle(theme) as React.CSSProperties | undefined} data-net={chat.network} onDragOver={(e) => e.preventDefault()}>
      <header className="chat-head">
        <button className="icon-btn back" onClick={onBack} aria-label={T('Zurück')}><Icon name="back" /></button>
        <button className="chat-head-who" onClick={() => setContact(true)} aria-label={T('Profil anzeigen')}>
        <Avatar name={chat.peer?.name ?? chat.title} size={40} src={chat.avatar} />
        <div className="chat-head-main">
          <b>{chat.title}</b>
          <small>{chat.peer ? <><span className="dot" style={{ background: NETWORKS.email.color }} />{chat.peer.name !== chat.peer.id ? chat.peer.name : chat.peer.id}</> : multi ? linked.map((c) => <Fragment key={c.id}><span className="dot" style={{ background: NETWORKS[c.network].color }} />{NETWORKS[c.network].name} </Fragment>) : notes ? <>{T('Nur für dich, auf allen Geräten')}{ttl ? ` · ⏳ ${TTLS.find((x) => x[0] === ttl)?.[1] ?? ''}` : ''}</> : <><span className="dot" style={{ background: NETWORKS[chat.network].color }} />{NETWORKS[chat.network].name}{account && account.label !== NETWORKS[chat.network].name ? ` · ${account.label}` : ''}</>}{!connected && T(' · nicht verbunden')}{tr?.on && <span> · 🌐 {tr.langName ?? T('Übersetzung an')}</span>}{chat.autopilot?.on && <span className="autopilot-tag"> {T('· 🤖 Autobot (')}{chat.autopilot.max - chat.autopilot.used} {T('übrig)')}</span>}</small>
        </div>
        </button>
        <button className={`icon-btn ai-compose ${aiOpen ? 'on' : ''}`} onClick={() => setAiOpen((v) => !v)} aria-label={T('KI-Assistent')} title={T('KI: Nachricht schreiben lassen, zusammenfassen, Antworten vorschlagen')}><Icon name="robot" /></button>
        <div className="menu-wrap">
          <button className="icon-btn" onClick={() => setHeadMenu((v) => !v)} aria-label={T('Chat-Menü')}><Icon name="more" /></button>
          {headMenu && <div className="menu-catcher" onClick={() => setHeadMenu(false)} onTouchStart={() => setHeadMenu(false)} />}
          {headMenu && (
            <div className="menu right">
              <button onClick={() => { setHeadMenu(false); onPatchChat({ pinned: !chat.pinned }); }}><Icon name="pin" size={18} />{chat.pinned ? T('Lösen') : 'Anheften'}</button>
              <button onClick={() => { setHeadMenu(false); onPatchChat({ muted: !chat.muted }); }}><Icon name={chat.muted ? 'bell' : 'belloff'} size={18} />{chat.muted ? T('Ton an') : 'Stummschalten'}</button>
              {notes ? <>
                <div className="menu-label">{T('Neue Notizen verschwinden nach')}</div>
                <div className="menu-pills">
                  {TTLS.map(([sec, label]) => <button key={sec} className={`pill${ttl === sec ? ' on' : ''}`} onClick={() => { setTtl(sec); void api.setNotes(sec).then((r) => setTtl(r.ttl)).catch(() => {}); }}>{label}</button>)}
                </div>
              </> : <>
              <button onClick={() => { setHeadMenu(false); setContact(true); }}><Icon name="user" size={18} />{chat.kind === 'direct' ? 'Kontaktprofil' : 'Gruppeninfo'}</button>
              <button onClick={() => { setHeadMenu(false); setTrSheet(true); }}><Icon name="globe" size={18} />{tr?.on ? T('Übersetzung · {0}', tr.langName ?? 'an') : T('Live-Übersetzung')}</button>
              </>}
              <button onClick={() => { setHeadMenu(false); setThemeSheet(true); }}><Icon name="palette" size={18} />{T('Chat-Design')}</button>
              {onGallery && <button onClick={() => { setHeadMenu(false); onGallery(); }}><Icon name="gallery" size={18} />{T('Medien, Dateien & Links')}</button>}
              <button onClick={() => { setHeadMenu(false); onPatchChat({ archived: !chat.archived }); }}><Icon name="archive" size={18} />{chat.archived ? T('Aus dem Archiv holen') : 'Archivieren'}</button>
              {chat.network === 'email' && <button onClick={async () => {
                setHeadMenu(false);
                if (askMailDelete() && !confirm(T('Alle E-Mails zu „{0}“ in den Papierkorb verschieben?', chat.title))) return;
                onRemove();
              }}><Icon name="trash" size={18} />{T('E-Mails löschen')}</button>}
              <a href={`/api/export?chat=${encodeURIComponent(chat.id)}`} download onClick={() => { setHeadMenu(false); flash(T('Export wird erstellt, der Download startet gleich …')); }}><Icon name="download" size={18} />{T('Chat herunterladen')}</a>
            </div>
          )}
        </div>
      </header>

      {missed && ai?.features.text && ai.catchUp !== false && (
        missed.text
          ? <div className="catchup-card"><Icon name="sparkle" size={16} /><span>{missed.text}</span><button className="icon-btn small" onClick={() => setMissed(null)} aria-label={T('Schließen')}><Icon name="close" size={14} /></button></div>
          : <div className="catchup-pill"><button onClick={catchUp} disabled={missed.busy}>{missed.busy ? <span className="spinner" /> : <Icon name="sparkle" size={15} />} {T('Was hab ich verpasst?')} <small>{T('{0} neu', missed.n)}</small></button>
              <button className="icon-btn small" onClick={() => setMissed(null)} aria-label={T('Ausblenden')}><Icon name="close" size={13} /></button></div>
      )}
      {loadingOld && <div className="loading-old floating">{T('Lade ältere Nachrichten …')}</div>}
      <div className="messages" ref={scroller} onScroll={onScroll} onTouchStart={touchStart} onTouchMove={touchMove}>
        <div className="messages-inner" ref={inner}>
        {!messages && <div className="loading-old">{T('Lade …')}</div>}
        {messages && !messages.length && <div className="loading-old">{T('Noch keine Nachrichten.')}</div>}
        {items.map(({ m, day, showName, album }) => (
          <Fragment key={m.id}>
            {day && <div className="day"><span>{day}</span></div>}
            <MessageBubble m={m} album={album} group={group} showName={showName} senderAvatar={group && !m.fromMe ? senderAv[m.senderId] ?? null : undefined} replied={m.replyToRemoteId ? byRemote.get(m.replyToRemoteId) ?? null : undefined}
              reminder={reminders.get(m.id)} trLang={tr?.langName ? adjLang(tr.langName) : null}
              onAction={openMenu} onReact={react} onJump={jump}
              onTranscribe={canTranscribe ? transcribe : undefined}
              onSummarize={ai?.features.text ? summarizeVoice : undefined}
              onDetect={ai?.features.text && ai.detectHints !== false ? detect : undefined} />
          </Fragment>
        ))}
        {pending.map((o) => <PendingBubble key={o.id} o={o} />)}
        <TypingBubble ids={linked.length ? linked.map((c) => c.id) : [chat.id]} />
        </div>
      </div>
      {!atBottom && <button className="to-bottom" onClick={() => scroller.current?.scrollTo({ top: scroller.current.scrollHeight, behavior: 'smooth' })}><Icon name="back" className="rot-270" /></button>}

      {aiAnim.mounted && <div className={`ai-backdrop ${aiAnim.closing ? 'out' : ''}`} onClick={() => setAiOpen(false)} />}
      <div className={`chat-dock ${aiAnim.mounted ? 'ai-on' : ''}`}>
        {aiAnim.mounted && <div className={`ai-sheet ${aiAnim.closing ? 'out' : ''}`}>
          <AiPanel chat={chat} replyTo={replyTo} onClose={() => setAiOpen(false)} onError={flash}
            onUse={(text) => { setInject({ text, n: Date.now() }); setAiOpen(false); }} />
        </div>}
        {scheduled.length > 0 && (
          <div className="planned-bar">
            <button className="planned-toggle" onClick={() => setShowPlanned((v) => !v)}>
              <Icon name="clock" size={16} /><span>{scheduled.length === 1 ? T('1 geplante Nachricht · {0}', whenLabel(scheduled[0].at)) : T('{0} geplante Nachrichten', scheduled.length)}</span>
              <Icon name="back" size={14} className={showPlanned ? 'rot-90' : 'rot-270'} />
            </button>
            {showPlanned && scheduled.map((p) => (
              <div key={p.id} className={`planned-item ${p.error ? 'err' : ''}`}>
                <span className="planned-text"><b>{p.error ? T('Nicht gesendet') : whenLabel(p.at)}{multi ? ` · ${NETWORKS[netOf.get(p.chatId) ?? 'demo'].name}` : ''}{p.translate ? ' · 🌐' : ''}</b>{p.text}</span>
                <button className="btn small ghost" onClick={() => guard(() => api.planNow(p.id))}>{T('Jetzt senden')}</button>
                <button className="icon-btn small" onClick={() => guard(() => api.unplan(p.id))} aria-label={T('Löschen')}><Icon name="trash" size={16} /></button>
              </div>
            ))}
          </div>
        )}
        {!aiOpen && !editing && draftEmpty && ai?.features.text && ai.quickReplies !== false && chat.aiEnabled && (
          <QuickReplies chatId={chat.id} last={messages?.at(-1)} onUse={(t) => setInject({ text: t, n: Date.now() })} />
        )}
        <Composer onEmpty={setDraftEmpty} chat={sendChat.id === chat.id ? chat : { ...sendChat, translate: chat.translate }} onPickLang={() => setTrSheet(true)} placeholder={multi ? T('Nachricht über {0}', NETWORKS[sendChat.network].name) : undefined} draftId={chat.id} onInfo={flash} onResize={() => { const el = scroller.current; if (el && bottomRef.current) el.scrollTop = el.scrollHeight; }} disabled={!connected} replyTo={replyTo} editing={editing} inject={inject}
          onCancel={() => { setReplyTo(null); setEditing(null); }}
          onSent={() => { setReplyTo(null); setEditing(null); }} onError={flash} />
      </div>

      {menuAnim.mounted && menuShown && ((menu => (
        <div className={`overlay ${menuAnim.closing ? 'out' : ''}`} onClick={() => setMenu(null)}>
          <div className="msg-menu" style={menuPos(menu)} onClick={(e) => e.stopPropagation()}>
            {menu.m.status === 'failed' && menu.m.fromMe ? (
              // Nicht gesendet: nur das, was hier Sinn ergibt
              <div className="menu-list">
                <div className="menu-note">{T('Nicht gesendet')}{menu.m.error ? `: ${menu.m.error}` : '.'}</div>
                {menu.m.remoteId.startsWith('local-') && <button onClick={() => { const m = menu.m; setMenu(null); guard(() => api.retry(m.id)); }}><Icon name="refresh" size={18} />{T('Erneut senden')}</button>}
                {menu.m.text && <button onClick={() => { navigator.clipboard?.writeText(menu.m.text); setMenu(null); flash(T('Kopiert')); }}><Icon name="copy" size={18} />{T('Text kopieren')}</button>}
                <button className="danger" onClick={() => { const m = menu.m; setMenu(null); guard(() => m.remoteId.startsWith('local-') ? api.discard(m.id) : api.remove(m.id, false)); }}><Icon name="trash" size={18} />{T('Löschen')}</button>
              </div>
            ) : menu.picker ? (
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
                <button onClick={() => { setReplyTo(menu.m); setEditing(null); setMenu(null); }}><Icon name="reply" size={18} />{T('Antworten')}</button>
                {!menu.m.deleted && (menu.m.text || menu.m.attachments.length > 0) && <button onClick={() => { setForward(menu.m); setMenu(null); }}><Icon name="forward" size={18} />{T('Weiterleiten')}</button>}
                {reminders.has(menu.m.id)
                  ? <button onClick={() => { const m = menu.m; setMenu(null); const p = mine.find((x) => x.kind === 'remind' && x.messageId === m.id); if (p) guard(async () => { await api.unplan(p.id); flash(T('Erinnerung gelöscht')); }); }}><Icon name="alarm" size={18} />{T('Erinnerung löschen')}</button>
                  : <button onClick={() => { setRemindFor(menu.m); setMenu(null); }}><Icon name="alarm" size={18} />{T('Erinnern …')}</button>}
                {ai?.features.text && !menu.m.deleted && !menu.m.translation && (menu.m.text || menu.m.transcript) && <button onClick={() => { const m = menu.m; setMenu(null); flash(T('Wird übersetzt …')); api.ai.translateOne(m.id).then((r) => { if (r.already) flash(T('Die Nachricht ist schon Deutsch.')); }).catch((e: any) => flash(e.message ?? T('Fehler'))); }}><Icon name="globe" size={18} />{T('Übersetzen')}</button>}
                {ai?.features.text && !menu.m.deleted && (menu.m.text || menu.m.transcript) && <button onClick={() => { setOrganizeFor(menu.m); setMenu(null); }}><Icon name="sparkle" size={18} />{T('Termin, Aufgabe, Einkauf …')}</button>}
                {menu.m.text && <button onClick={() => { navigator.clipboard?.writeText(menu.m.text); setMenu(null); flash(T('Kopiert')); }}><Icon name="copy" size={18} />{T('Text kopieren')}</button>}
                {menu.m.attachments.map((a, i) => standalone || !['image', 'sticker', 'video'].includes(a.kind)
                  // Als Home-Bildschirm-App führt ein Download-Link auf eine Seite ohne Rückweg: in der eigenen Vorschau öffnen
                  ? <button key={i} onClick={() => { const m = menu.m; setMenu(null); openFile(m, i); }}><Icon name="share" size={18} />{a.kind === 'file' ? T('Öffnen / Teilen') : T('Teilen / Sichern')}{menu.m.attachments.length > 1 ? ` (${a.name})` : ''}</button>
                  : <a key={i} href={attachmentUrl(menu.m, i, true)} download={a.name} onClick={() => setMenu(null)}><Icon name="download" size={18} />{a.kind === 'image' ? T('Bild speichern') : 'Herunterladen'}</a>
                )}
                {!menu.m.deleted && menu.m.attachments.flatMap((a, i) => targetsFor(storage, a).map((t) => (
                  <button key={`${t}${i}`} onClick={() => { const m = menu.m; setMenu(null); if (t === 'nextcloud') { openSaveAs(m, i); return; } flash(T('Wird gespeichert …')); saveAttachment(m, i, t).then(flash, (e: any) => flash(e.message ?? T('Fehler'))); }}>
                    <Icon name={t === 'nextcloud' ? 'folder' : 'cloud'} size={18} />{t === 'nextcloud' ? T('In Nextcloud speichern …') : TARGET_LABEL[t]}{menu.m.attachments.length > 1 ? ` (${a.name})` : ''}</button>
                )))}
                {menu.m.fromMe && menu.m.text && !menu.m.attachments.length && <button onClick={() => { setEditing(menu.m); setReplyTo(null); setMenu(null); }}><Icon name="edit" size={18} />{T('Bearbeiten')}</button>}
                {menu.m.fromMe && <button className="danger" onClick={() => { const m = menu.m; setMenu(null); if (confirm(T('Für alle löschen?'))) guard(() => api.remove(m.id, true)); }}><Icon name="trash" size={18} />{T('Für alle löschen')}</button>}
                <button className="danger" onClick={() => { const m = menu.m; setMenu(null); guard(() => api.remove(m.id, false)); }}><Icon name="trash" size={18} />{T('Für mich löschen')}</button>
              </div>
            </>)}
          </div>
        </div>
      ))(menu ?? menuShown))}
      {remindFor && <WhenPicker title={T('Erinnern')} confirm={T('Erinnern')} hint={T('Chorus erinnert dich an diese Nachricht, auch wenn die App geschlossen ist.')}
        onClose={() => setRemindFor(null)}
        onPick={(at) => { const m = remindFor; setRemindFor(null); guard(async () => { await api.plan({ kind: 'remind', chatId: m.chatId, at, messageId: m.id, text: previewOf(m).slice(0, 200) }); flash(T('Erinnerung {0}', whenLabel(at))); }); }} />}
      {organizeFor && <OrganizeSheet m={organizeFor} chatTitle={chat.title} onClose={() => setOrganizeFor(null)} onInfo={flash} />}
      {forward && <ForwardSheet message={forward} onClose={() => setForward(null)} onDone={(t) => { setForward(null); flash(t); }} />}
      {toast && <div className="toast">{toast}</div>}
      {themeSheet && <ChatThemeSheet chat={chat} onClose={() => setThemeSheet(false)} />}
      {trSheet && <TranslateSheet chat={chat} onChat={onChat} onClose={() => setTrSheet(false)} onError={flash} />}
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

/** Ab so vielen Ungelesenen bietet der Chat „Was hab ich verpasst?“ an */
const CATCHUP_MIN = 8;

/** Gemerkte Vorschläge je Chat und letzter Nachricht (der Server merkt sie sich ebenfalls) */
const quickSeen = new Map<string, string[]>();
const quickDismissed = new Set<string>();
const QUICK_MAX_AGE = 3 * 24 * 3600_000;

/** KI-Antwortvorschläge über dem Eingabefeld: drei kurze Antworten auf die neueste eingehende Nachricht.
 *  Geladen wird nur, wenn die letzte Nachricht vom Gegenüber kommt und frisch ist, kurz verzögert (mehrere Nachrichten am Stück = eine Anfrage). */
function QuickReplies({ chatId, last, onUse }: { chatId: string; last?: Message; onUse: (t: string) => void }) {
  const want = !!last && !last.fromMe && !last.deleted && Date.now() - last.ts < QUICK_MAX_AGE;
  const key = want ? `${chatId}|${last!.id}` : '';
  const [list, setList] = useState<string[]>(() => quickSeen.get(key) ?? []);
  const [, force] = useState(0);
  useEffect(() => {
    if (!key || quickDismissed.has(key)) { setList([]); return; }
    const seen = quickSeen.get(key);
    if (seen) { setList(seen); return; }
    setList([]);
    let alive = true;
    const t = window.setTimeout(() => {
      api.ai.quick(chatId).then((r) => {
        const s = r.suggestions.slice(0, 3);
        quickSeen.set(key, s);
        if (quickSeen.size > 100) quickSeen.delete(quickSeen.keys().next().value!);
        if (alive) setList(s);
      }).catch(() => {}); // still: Vorschläge sind ein Extra
    }, 1500);
    return () => { alive = false; clearTimeout(t); };
  }, [key, chatId]);
  if (!key || !list.length || quickDismissed.has(key)) return null;
  const done = () => { quickDismissed.add(key); force((n) => n + 1); };
  return (
    <div className="quick-replies" role="group" aria-label={T('Antwortvorschläge')}>
      {list.map((s, i) => <button key={i} className="quick-chip" onClick={() => { onUse(s.trim()); done(); }} title={T('Ins Eingabefeld übernehmen')}>{s}</button>)}
      <button className="icon-btn small quick-x" onClick={done} aria-label={T('Vorschläge ausblenden')}><Icon name="close" size={14} /></button>
    </div>
  );
}

/** Datei, die gerade gesendet wird: erscheint sofort, mit Fortschritt */
function PendingBubble({ o }: { o: Outgoing }) {
  const label = o.phase === 'error' ? T('Nicht gesendet') : o.phase === 'work' || o.kind === 'voice' ? (o.kind === 'video' ? T('Wird verarbeitet …') : T('Wird gesendet …')) : T('Wird hochgeladen … {0} %', Math.round(o.progress * 100));
  const ring = o.phase === 'upload' ? o.progress : null;
  return (
    <div className="msg out pending">
      <div className={`bubble ${o.url && !o.caption ? "media-only" : ""} ${o.caption && o.url ? "has-media" : ""}`}>
        {o.kind === 'voice' ? (
          <div className="pending-file pending-voice"><span className="pending-ring small">{o.phase === 'error' ? <Icon name="close" size={16} /> : <Ring p={ring} />}</span><Icon name="mic" size={18} /><span className="pending-name">{Math.floor((o.duration ?? 0) / 60)}:{String((o.duration ?? 0) % 60).padStart(2, '0')}</span></div>
        ) : o.url ? (
          <div className="pending-media">
            {o.kind === 'video' ? <video src={`${o.url}#t=0.1`} muted playsInline preload="metadata" /> : <img src={o.url} alt="" />}
            <span className="pending-ring">{o.phase === 'error' ? <Icon name="close" size={22} /> : <Ring p={ring} />}</span>
          </div>
        ) : (
          <div className="pending-file"><span className="pending-ring small">{o.phase === 'error' ? <Icon name="close" size={16} /> : <Ring p={ring} />}</span><span className="pending-name">{o.name}</span></div>
        )}
        {o.caption && <div className="text">{o.caption}</div>}
        <span className="meta pending-meta">{label}</span>
        {o.phase === 'error' && <button className="pending-x" onClick={() => outbox.remove(o.id)}>{T('Ausblenden')}</button>}
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

/** Jemand tippt: Sprechblase mit drei Punkten unten im Chat */
function TypingBubble({ ids }: { ids: string[] }) {
  const on = useTypingAny(ids);
  if (!on) return null;
  return <div className="msg in typing-msg" aria-label={T('schreibt …')}><div className="bubble typing-dots"><i /><i /><i /></div></div>;
}
