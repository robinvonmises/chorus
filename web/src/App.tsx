import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { syncPush } from './push';
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
      if (e.message.chatId === activeRef.current && !e.message.fromMe && document.visibilityState === 'visible') api.markRead(e.message.chatId).catch(() => {});
    } else if (e.type === 'notify') {
      // App offen: kein System-Hinweis, nur ein dezentes Banner für andere Chats
      if (document.visibilityState === 'visible') { if (e.chat.id !== activeRef.current) showBanner(e.chat, e.message); }
      else notify(e.chat, e.message);
    }
  }, onlineStatus, onLocked, () => refreshRef.current()), [onLocked]);

  const [banner, setBanner] = useState<{ chat: Chat; text: string; n: number } | null>(null);
  const bannerTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  function showBanner(c: Chat, m: Message) {
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

  // Nachrichten des aktiven Chats laden
  useEffect(() => {
    if (!active) return;
    let cancelled = false;
    loaded.current.add(active);
    api.messages(active).then((ms) => {
      if (cancelled) return;
      setMessages((m) => {
        const cur = m.get(active);
        if (cur && cur.length === ms.length && cur.at(-1)?.id === ms.at(-1)?.id) return m; // unverändert: nicht neu zeichnen
        return new Map(m).set(active, ms);
      });
      if (ms.length < 20) api.history(active).catch(() => {});
    });
    api.markRead(active).catch(() => {});
    return () => { cancelled = true; };
  }, [active]);

  const loadOlder = useCallback(async () => {
    if (!active) return false;
    const list = messages.get(active) ?? [];
    const older = await api.messages(active, list[0]?.ts);
    if (older.length) { setMessages((m) => new Map(m).set(active, [...older, ...(m.get(active) ?? [])])); return true; }
    await api.history(active).catch(() => {});
    const again = await api.messages(active, list[0]?.ts);
    if (again.length) setMessages((m) => new Map(m).set(active, [...again, ...(m.get(active) ?? [])]));
    return again.length > 0;
  }, [active, messages]);

  // Nach dem Wiederverbinden (z. B. App aus dem Hintergrund geholt): Chatliste und offenen Chat frisch laden
  const refreshRef = useRef<() => void>(() => {});
  refreshRef.current = () => {
    api.chats().then((cs) => setChats(new Map(cs.map((c) => [c.id, c])))).catch(() => {});
    api.accounts().then(setAccounts).catch(() => {});
    loaded.current.clear(); // andere Chats beim Öffnen neu holen
    const id = activeRef.current;
    if (id) {
      loaded.current.add(id);
      api.messages(id).then((ms) => setMessages((m) => {
        const cur = m.get(id);
        if (cur && cur.length === ms.length && cur.at(-1)?.id === ms.at(-1)?.id && cur.at(-1)?.status === ms.at(-1)?.status) return m;
        return new Map(m).set(id, ms);
      })).catch(() => {});
      if (document.visibilityState === 'visible') api.markRead(id).catch(() => {});
    }
  };

  const reload = useCallback(async () => {
    const [as, cs] = await Promise.all([api.accounts(), api.sync().catch(() => api.chats())]);
    setAccounts(as);
    setChats(new Map(cs.map((c) => [c.id, c])));
    if (activeRef.current) api.messages(activeRef.current).then((ms) => setMessages((m) => new Map(m).set(activeRef.current!, ms))).catch(() => {});
  }, []);

  const sortedChats = useMemo(() => [...chats.values()].sort((a, b) => Number(b.pinned) - Number(a.pinned) || b.lastTs - a.lastTs), [chats]);
  const unreadTotal = useMemo(() => sortedChats.reduce((n, c) => n + (c.muted || c.archived ? 0 : c.unread), 0), [sortedChats]);
  useEffect(() => { document.title = unreadTotal ? `(${unreadTotal}) Chorus` : 'Chorus'; (navigator as any).setAppBadge?.(unreadTotal || undefined)?.catch?.(() => {}); }, [unreadTotal]);

  const chat = active ? chats.get(active) ?? null : null;
  const account = chat ? accounts.find((a) => a.id === chat.accountId) : undefined;
  const problems = accounts.filter((a) => a.status.state !== 'connected' && a.status.state !== 'connecting');

  const playing = !!usePlayer().track;
  return (
    <div className={`app ${chat ? 'has-chat' : ''} ${playing ? 'with-player' : ''}`}>
      <PlayerBar chatTitle={(id) => chats.get(id)?.title ?? ''} onOpen={openChat} />
      <Rail filter={filter} setFilter={setFilter} accounts={accounts} chats={sortedChats} onSettings={() => setPanel('settings')} />
      <ChatList
        chats={sortedChats} accounts={accounts} filter={filter} setFilter={setFilter} active={active} onOpen={openChat}
        onAdd={() => setPanel('add')} onSettings={() => setPanel('settings')} onNew={() => setPanel('new')} online={online} problems={problems}
        onFixAccount={() => setPanel('settings')} previewOf={previewOf} onReload={reload}
        onChats={(cs) => setChats((m) => { const n = new Map(m); for (const c of cs) n.set(c.id, c); return n; })}
      />
      <main className="pane-chat">
        {chat ? (
          <ChatView key={chat.id} chat={chat} account={account} messages={messages.get(chat.id)} onBack={() => openChat(null)} loadOlder={loadOlder}
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
      {panel === 'new' && <NewChat chats={sortedChats} accounts={accounts} onOpen={openChat} onClose={() => setPanel(null)} />}
      <Lightbox />
      {banner && (
        <button key={banner.n} className="in-app-banner" onClick={() => { setBanner(null); openChat(banner.chat.id); }}>
          <Avatar name={banner.chat.alias || banner.chat.title} src={banner.chat.avatar} network={banner.chat.network} size={36} />
          <span className="iab-text"><b>{banner.chat.alias || banner.chat.title}</b><span>{banner.text}</span></span>
        </button>
      )}
      {panel === 'settings' && <Settings server={server} accounts={accounts} onClose={() => setPanel(null)} onAdd={() => setPanel('add')} onLocked={onLocked} onProfileChanged={onRefresh} />}
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
