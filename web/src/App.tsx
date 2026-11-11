import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { syncPush } from './push';
import { setPlanned, usePlanned } from './plannedState';
import { Gallery } from './components/Gallery';
import { api, connectEvents, type Account, type Chat, type HubEvent, type Message, type Network, type ServerState } from './api';
import { keyStore, lastProfile } from './keys';
import { Lock } from './components/Lock';
import { ChatList } from './components/ChatList';
import { ChatView } from './components/ChatView';
import { AccountWizard } from './components/AccountWizard';
import { Settings } from './components/Settings';
import { NewChat } from './components/NewChat';
import { Lightbox } from './components/Lightbox';
import { PlayerBar } from './components/PlayerBar';
import { usePlayer } from './player';
import { Rail, Avatar } from './components/Rail';
import { previewOf } from './components/Message';

/**
 * Frisch geladene Liste mit der alten abgleichen: Unveränderte Einträge behalten ihr altes Objekt.
 * So zeichnet die Oberfläche nach dem Neuladen (z. B. App aus dem Hintergrund geholt) nur, was sich wirklich geändert hat.
 */
function keepSame<T extends { id: string }>(cur: T[] | undefined, next: T[]): T[] {
  if (!cur) return next;
  const old = new Map(cur.map((x) => [x.id, x]));
  let same = cur.length === next.length;
  const out = next.map((x, i) => {
    const o = old.get(x.id);
    const keep = o && JSON.stringify(o) === JSON.stringify(x) ? o : x;
    if (cur[i] !== keep) same = false;
    return keep;
  });
  return same ? cur : out;
}
const keepChats = (cur: Map<string, Chat>, cs: Chat[]) => new Map(keepSame([...cur.values()], cs).map((c) => [c.id, c]));

export type Filter = { nets: Network[]; unread: boolean; archived: boolean };
export type Panel = null | 'settings' | 'add' | 'new';

export default function App() {
  const [server, setServer] = useState<ServerState | null>(null);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState('');
  const [savedKey, setSavedKey] = useState<{ profileId: string; key: string } | null>(null);

  const boot = useCallback(async () => {
    setReady(false);
    try {
      let s = await api.state();
      setSavedKey(null);
      if (s.profiles.length && !s.authed) {
        // Auf diesem Gerät gespeicherten Schlüssel des zuletzt benutzten Profils versuchen
        const pid = lastProfile.get() ?? (s.profiles.length === 1 ? s.profiles[0].id : null);
        const prof = s.profiles.find((p) => p.id === pid && p.initialized);
        const k = prof ? await keyStore.get(prof.id) : undefined;
        if (prof && k) {
          try { await api.unlock(prof.id, k); s = await api.state(); }
          catch (e: any) {
            if (e.status === 401 && e.data?.need2fa) setSavedKey({ profileId: prof.id, key: k }); // Passwort stimmt, nur der Code fehlt
            else if (e.status === 401) await keyStore.clear(prof.id);
          }
        }
      }
      setServer(s);
      setError('');
    } catch (e: any) {
      setError('Server nicht erreichbar. Versuche es gleich nochmal.');
      setTimeout(boot, 3000);
    }
    setReady(true);
  }, []);

  useEffect(() => { boot(); }, [boot]);
  useEffect(() => {
    const h = () => boot();
    window.addEventListener('inbox:unauthorized', h);
    return () => window.removeEventListener('inbox:unauthorized', h);
  }, [boot]);
  useEffect(() => { if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {}); }, []);
  // Push-Abo bei jedem Start und beim Zurückkommen prüfen (verschwindet z. B. nach Neuinstallation still)
  useEffect(() => {
    if (!server?.authed) return;
    syncPush();
    const onVis = () => { if (document.visibilityState === 'visible') syncPush(); };
    document.addEventListener('visibilitychange', onVis);
    return () => document.removeEventListener('visibilitychange', onVis);
  }, [server?.authed]);

  if (!ready && !server) return <div className="splash"><img src="/icon.svg" width={64} alt="" /></div>;
  if (error && !server) return <div className="splash"><p>{error}</p></div>;
  if (!server!.authed) return <Lock state={server!} savedKey={savedKey} onDone={boot} />;
  return <Main server={server!} onLocked={boot} onRefresh={() => api.state().then(setServer).catch(() => {})} />;
}

function Main({ server, onLocked, onRefresh }: { server: ServerState; onLocked: () => void; onRefresh: () => void }) {
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [chats, setChats] = useState<Map<string, Chat>>(new Map());
  const [messages, setMessages] = useState<Map<string, Message[]>>(new Map());
  const [active, setActive] = useState<string | null>(() => decodeURIComponent(location.hash.match(/chat=([^&]+)/)?.[1] ?? '') || null);
  const [filter, setFilterRaw] = useState<Filter>(() => {
    try { const f = JSON.parse(localStorage.getItem('inbox:filter') ?? ''); if (Array.isArray(f.nets)) return { nets: f.nets, unread: !!f.unread, archived: false }; } catch { /* ignore */ }
    return { nets: [], unread: false, archived: false };
  });
  const setFilter = useCallback((f: Filter) => { setFilterRaw(f); localStorage.setItem('inbox:filter', JSON.stringify({ nets: f.nets, unread: f.unread })); }, []);
  const [panel, setPanel] = useState<Panel>(null);
  const [online, setOnline] = useState(true);
  // Kurze Unterbrechungen (App im Hintergrund, Netzwechsel) nicht melden, nur wenn es länger nicht klappt
  const offTimer = useRef<number | null>(null);
  const onlineStatus = useCallback((on: boolean) => {
    if (on) { if (offTimer.current) clearTimeout(offTimer.current); offTimer.current = null; setOnline(true); }
    else if (!offTimer.current) offTimer.current = window.setTimeout(() => { offTimer.current = null; setOnline(false); }, 10_000);
  }, []);
  const activeRef = useRef(active);
  activeRef.current = active;

  // Erstes Laden
  useEffect(() => {
    api.planned().then(setPlanned).catch(() => {});
    api.accounts().then((a) => { setAccounts(a); if (!a.length) setPanel('add'); });
    api.chats().then(async (cs) => {
      setChats(new Map(cs.map((c) => [c.id, c])));
      // Die obersten Chats schon vorladen, damit sie beim Antippen sofort da sind
      const top = [...cs].sort((a, b) => Number(b.pinned) - Number(a.pinned) || b.lastTs - a.lastTs).slice(0, 25);
      for (const c of top) await prefetch(c.id);
    });
  }, []);

  const loaded = useRef(new Set<string>());
  const prefetch = useCallback(async (id: string) => {
    if (loaded.current.has(id)) return;
    loaded.current.add(id);
    try { const ms = await api.messages(id); setMessages((m) => (m.has(id) ? m : new Map(m).set(id, ms))); }
    catch { loaded.current.delete(id); }
  }, []);

  // Live-Ereignisse
  useEffect(() => connectEvents((e: HubEvent) => {
    if (e.type === 'account') setAccounts((as) => as.some((a) => a.id === e.account.id) ? as.map((a) => a.id === e.account.id ? e.account : a) : [...as, e.account]);
    else if (e.type === 'account_removed') {
      setAccounts((as) => as.filter((a) => a.id !== e.id));
      setChats((cs) => new Map([...cs].filter(([, c]) => c.accountId !== e.id)));
    } else if (e.type === 'chat_removed') {
      setChats((cs) => { const n = new Map(cs); n.delete(e.id); return n; });
      setActive((a) => (a === e.id ? null : a));
    } else if (e.type === 'chat') setChats((cs) => new Map(cs).set(e.chat.id, e.chat));
    else if (e.type === 'message') {
      setMessages((ms) => {
        const list = ms.get(e.message.chatId);
        if (!list) return ms;
        let next = e.replacedId ? list.filter((m) => m.id !== e.replacedId) : list;
        const i = next.findIndex((m) => m.id === e.message.id);
        if (i >= 0) next = next.map((m, j) => (j === i ? e.message : m));
        else { next = [...next, e.message]; next.sort((a, b) => a.ts - b.ts); }
        return new Map(ms).set(e.message.chatId, next);
      });
      if (linkedRef.current.includes(e.message.chatId) && !e.message.fromMe && document.visibilityState === 'visible') api.markRead(e.message.chatId).catch(() => {});
    } else if (e.type === 'planned') setPlanned(e.items);
    else if (e.type === 'reminder') {
      const c = e.chat;
      if (c) {
        setBanner((b) => ({ chat: c, text: `⏰ ${e.item.note ? e.item.note + ': ' : ''}${e.item.text || 'Erinnerung'}`, n: (b?.n ?? 0) + 1, msgId: e.item.messageId ?? undefined }));
        if (bannerTimer.current) clearTimeout(bannerTimer.current);
        reminderUntil.current = Date.now() + 12000;
        bannerTimer.current = setTimeout(() => setBanner(null), 12000);
      }
    } else if (e.type === 'notify') {
      // App offen: kein System-Hinweis, nur ein dezentes Banner für andere Chats
      if (document.visibilityState === 'visible') { if (e.chat.id !== activeRef.current) showBanner(e.chat, e.message); }
      else notify(e.chat, e.message);
    }
  }, onlineStatus, onLocked, () => refreshRef.current()), [onLocked]);

  const [banner, setBanner] = useState<{ chat: Chat; text: string; n: number; msgId?: string } | null>(null);
  const bannerTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const reminderUntil = useRef(0);
  function showBanner(c: Chat, m: Message) {
    if (Date.now() < reminderUntil.current) return; // Erinnerung nicht von normalen Hinweisen verdrängen lassen
    const text = c.kind === 'direct' ? previewOf(m) : `${m.senderName}: ${previewOf(m)}`;
    setBanner((b) => ({ chat: c, text, n: (b?.n ?? 0) + 1 }));
    if (bannerTimer.current) clearTimeout(bannerTimer.current);
    bannerTimer.current = setTimeout(() => setBanner(null), 4000);
  }

  // Hash-Navigation (Zurück-Taste am Handy schließt den Chat)
  useEffect(() => {
    const h = () => setActive(decodeURIComponent(location.hash.match(/chat=([^&]+)/)?.[1] ?? '') || null);
    window.addEventListener('hashchange', h);
    const sw = (ev: MessageEvent) => ev.data?.openChat && openChat(ev.data.openChat);
    navigator.serviceWorker?.addEventListener('message', sw);
    // Beim Aufwachen nachfragen, ob eine Benachrichtigung angetippt wurde (falls die Nachricht unterwegs verloren ging)
    const ask = () => { if (document.visibilityState === 'visible') navigator.serviceWorker?.controller?.postMessage({ type: 'pending-open' }); };
    document.addEventListener('visibilitychange', ask);
    window.addEventListener('focus', ask);
    ask();
    return () => {
      window.removeEventListener('hashchange', h); navigator.serviceWorker?.removeEventListener('message', sw);
      document.removeEventListener('visibilitychange', ask); window.removeEventListener('focus', ask);
    };
  }, []);

  useEffect(() => {
    const open = () => setPanel('settings');
    window.addEventListener('inbox:open-settings', open);
    return () => window.removeEventListener('inbox:open-settings', open);
  }, []);

  const openChat = useCallback((id: string | null) => {
    if (id) { if (location.hash !== '#chat=' + encodeURIComponent(id)) location.hash = 'chat=' + encodeURIComponent(id); }
    else if (location.hash) history.back();
    setActive(id);
  }, []);

  // Zusammengeführter Kontakt: alle Chats derselben Person gemeinsam anzeigen
  const linkedIds = useMemo(() => {
    const c = active ? chats.get(active) : null;
    if (!c?.link) return active ? [active] : [];
    return [c.id, ...[...chats.values()].filter((x) => x.link === c.link && x.id !== c.id).map((x) => x.id)];
  }, [active, chats]);
  const linkedRef = useRef<string[]>([]);
  linkedRef.current = linkedIds;
  useEffect(() => {
    for (const id of linkedIds.slice(1)) { void prefetch(id); api.markRead(id).catch(() => {}); }
  }, [linkedIds.join(',')]); // eslint-disable-line react-hooks/exhaustive-deps

  // Zu einer bestimmten Nachricht springen (Suche, Galerie, Erinnerung): Chat öffnen und bis dorthin nachladen
  const [focus, setFocus] = useState<{ id: string; remoteId: string; n: number } | null>(null);
  const [gallery, setGallery] = useState<{ ids?: string[]; title: string } | null>(null);
  const openAt = useCallback(async (m: Pick<Message, 'id' | 'chatId' | 'ts' | 'remoteId'>) => {
    const rep = chats.get(m.chatId);
    const target = rep?.link ? [...chats.values()].filter((x) => x.link === rep.link).sort((a, b) => b.lastTs - a.lastTs)[0]?.id ?? m.chatId : m.chatId;
    setGallery(null);
    openChat(target);
    let list = await api.messages(m.chatId).catch(() => [] as Message[]);
    for (let i = 0; i < 20 && list.length && list[0].ts > m.ts; i++) {
      const older = await api.messages(m.chatId, list[0].ts).catch(() => [] as Message[]);
      if (!older.length) break;
      list = [...older, ...list];
    }
    loaded.current.add(m.chatId);
    setMessages((mm) => new Map(mm).set(m.chatId, list));
    setFocus({ id: m.id, remoteId: m.remoteId, n: Date.now() });
  }, [chats]); // eslint-disable-line react-hooks/exhaustive-deps

  // Nachrichten des aktiven Chats laden
  useEffect(() => {
    if (!active) return;
    let cancelled = false;
    loaded.current.add(active);
    api.messages(active).then((ms) => {
      if (cancelled) return;
      setMessages((m) => {
        const cur = m.get(active), next = keepSame(cur, ms);
        return next === cur ? m : new Map(m).set(active, next); // unverändert: nicht neu zeichnen
      });
      if (ms.length < 20) api.history(active).catch(() => {});
    });
    api.markRead(active).catch(() => {});
    return () => { cancelled = true; };
  }, [active]);

  const loadOlderOne = useCallback(async (id: string) => {
    const list = messages.get(id) ?? [];
    const older = await api.messages(id, list[0]?.ts);
    if (older.length) { setMessages((m) => new Map(m).set(id, [...older, ...(m.get(id) ?? [])])); return true; }
    await api.history(id).catch(() => {});
    const again = await api.messages(id, list[0]?.ts);
    if (again.length) setMessages((m) => new Map(m).set(id, [...again, ...(m.get(id) ?? [])]));
    return again.length > 0;
  }, [messages]);
  const loadOlder = useCallback(async () => {
    if (!active) return false;
    const r = await Promise.all(linkedIds.map((id) => loadOlderOne(id).catch(() => false)));
    return r.some(Boolean);
  }, [active, linkedIds, loadOlderOne]);
  const merged = useMemo(() => {
    if (linkedIds.length < 2) return active ? messages.get(active) : undefined;
    const lists = linkedIds.map((id) => messages.get(id));
    if (!lists[0]) return undefined;
    return lists.flatMap((l) => l ?? []).sort((a, b) => a.ts - b.ts);
  }, [linkedIds, messages, active]);

  // Nach dem Wiederverbinden (z. B. App aus dem Hintergrund geholt): Chatliste und offenen Chat frisch laden
  const refreshRef = useRef<() => void>(() => {});
  refreshRef.current = () => {
    api.chats().then((cs) => setChats((cur) => keepChats(cur, cs))).catch(() => {});
    api.accounts().then(setAccounts).catch(() => {});
    loaded.current.clear(); // andere Chats beim Öffnen neu holen
    const id = activeRef.current;
    if (id) {
      loaded.current.add(id);
      api.messages(id).then((ms) => setMessages((m) => {
        const cur = m.get(id), next = keepSame(cur, ms);
        return next === cur ? m : new Map(m).set(id, next);
      })).catch(() => {});
      if (document.visibilityState === 'visible') api.markRead(id).catch(() => {});
    }
  };

  const reload = useCallback(async () => {
    const [as, cs] = await Promise.all([api.accounts(), api.sync().catch(() => api.chats())]);
    setAccounts(as);
    setChats((cur) => keepChats(cur, cs));
    if (activeRef.current) { const id = activeRef.current; api.messages(id).then((ms) => setMessages((m) => new Map(m).set(id, keepSame(m.get(id), ms)))).catch(() => {}); }
  }, []);

  // Gelöschte Chats verschwinden sofort, das Löschen beim Messenger läuft im Hintergrund
  const [gone, setGone] = useState<Set<string>>(() => new Set());
  const removeChats = useCallback(async (ids: string[]) => {
    setGone((g) => new Set([...g, ...ids]));
    setActive((a) => (a && ids.includes(a) ? null : a));
    const failed: string[] = []; let err = '';
    await Promise.all(ids.map((id) => api.deleteChat(id).catch((e: any) => { failed.push(id); err = e?.message ?? 'Fehler'; })));
    setGone((g) => { const n = new Set(g); for (const id of ids) n.delete(id); return n; });
    if (failed.length) return `Löschen fehlgeschlagen${err ? `: ${err}` : ''}`;
    setChats((cs) => { const n = new Map(cs); for (const id of ids) n.delete(id); return n; });
    return '';
  }, []);
  const sortedChats = useMemo(() => [...chats.values()].filter((c) => !gone.has(c.id)).sort((a, b) => Number(b.pinned) - Number(a.pinned) || b.lastTs - a.lastTs), [chats, gone]);
  const unreadTotal = useMemo(() => sortedChats.reduce((n, c) => n + (c.muted || c.archived ? 0 : c.unread), 0), [sortedChats]);
  useEffect(() => {
    document.title = unreadTotal ? `(${unreadTotal}) Chorus` : 'Chorus';
    const n = navigator as any; // setAppBadge() ohne Zahl zeigt einen Punkt, deshalb bei 0 ausdrücklich löschen
    (unreadTotal ? n.setAppBadge?.(unreadTotal) : n.clearAppBadge?.())?.catch?.(() => {});
  }, [unreadTotal]);
  // Gelesene Chats: ihre Benachrichtigungen aus der Mitteilungszentrale nehmen (Tag = Chat-ID, Erinnerungen bleiben).
  // Nur bekannte Chats, damit nichts verschwindet, bevor die Liste geladen ist.
  const readSig = useMemo(() => sortedChats.filter((c) => c.unread === 0 || c.id === active).map((c) => c.id).join('\n'), [sortedChats, active]);
  useEffect(() => {
    const read = new Set(readSig ? readSig.split('\n') : []);
    if (!read.size) return;
    const clean = () => {
      if (document.visibilityState !== 'visible') return;
      navigator.serviceWorker?.ready.then((reg) => reg.getNotifications()).then((ns) => {
        for (const x of ns) { const id = x.data?.chatId; if (id && x.tag === id && read.has(id)) x.close(); }
      }).catch(() => {});
    };
    clean();
    document.addEventListener('visibilitychange', clean);
    return () => document.removeEventListener('visibilitychange', clean);
  }, [readSig]);

  const chat = active ? chats.get(active) ?? null : null;
  const account = chat ? accounts.find((a) => a.id === chat.accountId) : undefined;
  const problems = accounts.filter((a) => a.status.state !== 'connected' && a.status.state !== 'connecting');

  const playing = !!usePlayer().track;
  const planned = usePlanned();
  return (
    <div className={`app ${chat ? 'has-chat' : ''} ${playing ? 'with-player' : ''}`}>
      <PlayerBar chatTitle={(id) => chats.get(id)?.title ?? ''} onOpen={openChat} />
      <Rail filter={filter} setFilter={setFilter} accounts={accounts} chats={sortedChats} onSettings={() => setPanel('settings')} />
      <ChatList
        chats={sortedChats} accounts={accounts} filter={filter} setFilter={setFilter} active={active} onOpen={openChat}
        onAdd={() => setPanel('add')} onSettings={() => setPanel('settings')} onNew={() => setPanel('new')} online={online} problems={problems}
        onFixAccount={() => setPanel('settings')} previewOf={previewOf}
        onChats={(cs) => setChats((m) => { const n = new Map(m); for (const c of cs) n.set(c.id, c); return n; })} onRemove={removeChats}
        onOpenMessage={openAt} onGallery={() => setGallery({ title: 'Medien, Dateien & Links' })}
      />
      <main className="pane-chat">
        {chat ? (
          <ChatView key={chat.id} chat={chat} account={account} messages={merged} onBack={() => openChat(null)} loadOlder={loadOlder}
            linked={linkedIds.map((id) => chats.get(id)!).filter(Boolean)} accounts={accounts} focus={focus} planned={planned}
            onGallery={() => setGallery({ ids: linkedIds, title: chat.title })} onOpenMessage={openAt}
            onRemove={() => { const id = chat.id; openChat(null); void removeChats([id]).then((err) => { if (err) alert(err); }); }}
            onPatchChat={async (p) => { const c = await api.patchChat(chat.id, p); setChats((cs) => new Map(cs).set(c.id, c)); }}
            onChat={(c) => setChats((cs) => new Map(cs).set(c.id, c))} />
        ) : (
          <div className="empty-chat">
            <img src="/icon.svg" width={72} alt="" />
            <h2>Chorus</h2>
            <p>Wähle links einen Chat aus.</p>
            {!accounts.length && <button className="btn primary" onClick={() => setPanel('add')}>Messenger verbinden</button>}
          </div>
        )}
      </main>
      {panel === 'add' && <AccountWizard server={server} accounts={accounts} onClose={() => setPanel(null)} />}
      {panel === 'new' && <NewChat chats={sortedChats} accounts={accounts} onOpen={openChat} onClose={() => setPanel(null)}
        onFound={(cs) => setChats((m) => { const n = new Map(m); for (const c of cs) if (!n.has(c.id)) n.set(c.id, c); return n; })} />}
      <Lightbox />
      {banner && (
        <button key={banner.n} className="in-app-banner" onClick={() => { setBanner(null); const mm = banner.msgId ? [...messages.values()].flat().find((x) => x.id === banner.msgId) : null; if (mm) void openAt(mm); else openChat(banner.chat.id); }}>
          <Avatar name={banner.chat.alias || banner.chat.title} src={banner.chat.avatar} network={banner.chat.network} size={36} />
          <span className="iab-text"><b>{banner.chat.alias || banner.chat.title}</b><span>{banner.text}</span></span>
        </button>
      )}
      {gallery && <Gallery chatIds={gallery.ids} title={gallery.title} chats={chats} onClose={() => setGallery(null)} onOpen={(m) => void openAt(m)} />}
      {panel === 'settings' && <Settings server={server} accounts={accounts} onClose={() => setPanel(null)} onAdd={() => setPanel('add')} onLocked={onLocked} onProfileChanged={onRefresh} onReload={reload} />}
    </div>
  );
}

function notify(chat: Chat, m: Message) {
  if (localStorage.getItem('inbox:push') === '1') return; // kommt per Push vom Server
  if (!('Notification' in window) || Notification.permission !== 'granted') return;
  const body = chat.kind === 'direct' ? previewOf(m) : `${m.senderName}: ${previewOf(m)}`;
  navigator.serviceWorker?.ready.then((reg) => reg.showNotification(chat.title, { body, tag: chat.id, data: { chatId: chat.id }, icon: '/icon-192.png' }))
    .catch(() => new Notification(chat.title, { body, tag: chat.id }));
}
