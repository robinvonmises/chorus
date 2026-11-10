import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api, type Account, type Chat, type Message, type Network } from '../api';
import type { Filter } from '../App';
import { NETWORKS, dayLabel, listTime } from '../util';
import { Avatar } from './Rail';
import { Icon } from './Icon';

export function ChatList({ chats, accounts, filter, setFilter, active, onOpen, onAdd, onSettings, onNew, online, problems, onFixAccount, onReload, onChats, onOpenMessage, onGallery }: {
  onOpenMessage: (m: Message) => void; onGallery: () => void;
  chats: Chat[]; accounts: Account[]; filter: Filter; setFilter: (f: Filter) => void; active: string | null;
  onOpen: (id: string) => void; onAdd: () => void; onSettings: () => void; onNew: () => void; online: boolean; problems: Account[];
  onFixAccount: () => void; previewOf: (m: Message) => string; onReload: () => Promise<void>; onChats: (cs: Chat[]) => void;
}) {
  const [q, setQ] = useState('');
  const [sel, setSel] = useState<Set<string> | null>(null);
  const [toast, setToast] = useState('');
  const nets = [...new Set(accounts.map((a) => a.network))];
  const archivedCount = useMemo(() => chats.filter((c) => c.archived && c.lastTs > 0).length, [chats]);
  const archivedUnread = useMemo(() => chats.filter((c) => c.archived && c.unread > 0 && !c.muted).length, [chats]);

  // Zusammengeführte Kontakte: nur eine Zeile pro Person (der zuletzt aktive Chat), Ungelesene zusammengezählt
  const groups = useMemo(() => {
    const g = new Map<string, Chat[]>();
    for (const c of chats) if (c.link) g.set(c.link, [...(g.get(c.link) ?? []), c]);
    return g;
  }, [chats]);
  const shown = useMemo(() => {
    const s = q.trim().toLowerCase();
    const seen = new Set<string>();
    return chats.filter((c) =>
      (c.lastTs > 0 || c.id === active || !!s) &&
      (s ? true : filter.archived ? !!c.archived : !c.archived) &&
      (!filter.unread || c.unread > 0) &&
      (!filter.nets.length || filter.nets.includes(c.network)) &&
      (!s || c.title.toLowerCase().includes(s) || (c.netTitle ?? '').toLowerCase().includes(s) || c.lastText.toLowerCase().includes(s)))
      .filter((c) => { if (!c.link || (groups.get(c.link)?.length ?? 0) < 2) return true; if (seen.has(c.link)) return false; seen.add(c.link); return true; })
      .map((c) => {
        const g = c.link ? groups.get(c.link) : undefined;
        return g && g.length > 1 ? { ...c, unread: g.reduce((n, x) => n + x.unread, 0), linkedNets: [...new Set(g.map((x) => x.network))] } : c;
      });
  }, [chats, filter, q, active, groups]);

  // Nachrichten durchsuchen (ab 2 Zeichen) und KI-Suche
  const [hits, setHits] = useState<Message[]>([]);
  const [aiRes, setAiRes] = useState<{ q: string; answer: string; messages: Message[]; scope: string } | null>(null);
  const [aiBusy, setAiBusy] = useState(false);
  const byId = useMemo(() => new Map(chats.map((c) => [c.id, c])), [chats]);
  useEffect(() => {
    const s = q.trim();
    if (s.length < 2) { setHits([]); return; }
    const t = setTimeout(() => api.search(s).then(setHits).catch(() => setHits([])), 250);
    return () => clearTimeout(t);
  }, [q]);
  useEffect(() => { if (aiRes && aiRes.q !== q.trim()) setAiRes(null); }, [q]); // eslint-disable-line react-hooks/exhaustive-deps
  const askAi = async () => {
    const s = q.trim(); if (s.length < 3 || aiBusy) return;
    setAiBusy(true);
    try { const r = await api.aiSearch(s); setAiRes({ q: s, ...r }); }
    catch (e: any) { setAiRes({ q: s, answer: e.message ?? 'Fehler', messages: [], scope: '' }); }
    finally { setAiBusy(false); }
  };

  const flash = (t: string) => { setToast(t); setTimeout(() => setToast(''), 2200); };
  const toggleNet = (n: Network) => setFilter({ ...filter, nets: filter.nets.includes(n) ? filter.nets.filter((x) => x !== n) : [...filter.nets, n] });

  // Aktionen für eine oder mehrere Chats
  const act = async (ids: string[], what: 'read' | 'unread' | 'archive' | 'unarchive' | 'mute' | 'unmute' | 'pin' | 'unpin') => {
    const out: Chat[] = [];
    await Promise.all(ids.map(async (id) => {
      try {
        if (what === 'read') { await api.markRead(id); const c = chats.find((x) => x.id === id); if (c) out.push({ ...c, unread: 0 }); }
        else if (what === 'unread') out.push(await api.markUnread(id));
        else out.push(await api.patchChat(id, what === 'archive' || what === 'unarchive' ? { archived: what === 'archive' } : what === 'mute' || what === 'unmute' ? { muted: what === 'mute' } : { pinned: what === 'pin' }));
      } catch { /* einzelne Fehler ignorieren */ }
    }));
    onChats(out);
    if (what === 'archive') flash(ids.length > 1 ? `${ids.length} Chats archiviert` : 'Archiviert');
    if (what === 'unarchive') flash(ids.length > 1 ? `${ids.length} Chats zurückgeholt` : 'Aus dem Archiv geholt');
  };

  const selIds = sel ? [...sel] : [];
  const selChats = chats.filter((c) => sel?.has(c.id));
  const allSel = !!sel && shown.length > 0 && shown.every((c) => sel.has(c.id));
  const toggleSel = (id: string) => setSel((s) => { const n = new Set(s ?? []); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  const done = () => setSel(null);
  // Feste Funktionen für die Zeilen: so wird nur die Zeile neu gezeichnet, in der sich etwas ändert
  const live = useRef({ act, sel, onOpen });
  live.current = { act, sel, onOpen };
  const rowAct = useCallback((id: string, what: 'read' | 'unread' | 'archive' | 'unarchive') => { void live.current.act([id], what); }, []);
  const rowClick = useCallback((id: string) => { if (live.current.sel) toggleSel(id); else live.current.onOpen(id); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const rowLong = useCallback((id: string) => { if (!live.current.sel) setSel(new Set([id])); }, []);

  // Ziehen zum Aktualisieren
  const listRef = useRef<HTMLUListElement>(null);
  const [pull, setPull] = useState(0);
  const [refreshing, setRefreshing] = useState(false);
  // Archiv-Zeile erscheint erst nach dem Herunterziehen und verschwindet beim Weiterscrollen wieder
  const [showArchive, setShowArchive] = useState(false);
  const pullStart = useRef<number | null>(null);
  const onTouchStart = (e: React.TouchEvent) => { if ((listRef.current?.scrollTop ?? 1) <= 0 && !refreshing) pullStart.current = e.touches[0].clientY; };
  const onTouchMove = (e: React.TouchEvent) => {
    if (pullStart.current === null) return;
    const d = e.touches[0].clientY - pullStart.current;
    // Finger geht nach oben oder Liste ist schon gescrollt: Geste gehört dem normalen Scrollen
    if (d < 0 || (listRef.current?.scrollTop ?? 0) > 0) { pullStart.current = null; setPull(0); return; }
    if (d < 12) return;
    setPull(Math.min(110, (d - 12) * 0.5));
  };
  const onTouchEnd = async () => {
    if (pullStart.current === null) return;
    pullStart.current = null;
    if (pull >= 40) setShowArchive(true);
    if (pull >= 64) {
      setRefreshing(true); setPull(56);
      await onReload().catch(() => {});
      setRefreshing(false);
    }
    setPull(0);
  };

  return (
    <section className="pane-list">
      {sel ? (
        <header className="list-head select-head">
          <button className="icon-btn" onClick={done} aria-label="Fertig"><Icon name="close" /></button>
          <h1>{sel.size ? `${sel.size} ausgewählt` : 'Auswählen'}</h1>
          <button className="btn small ghost" onClick={() => setSel(allSel ? new Set() : new Set(shown.map((c) => c.id)))}>{allSel ? 'Keine' : 'Alle'}</button>
        </header>
      ) : (
        <header className="list-head">
          {filter.archived ? (
            <><button className="icon-btn" onClick={() => setFilter({ ...filter, archived: false })} aria-label="Zurück"><Icon name="back" /></button><h1>Archiv</h1></>
          ) : <h1>Chats</h1>}
          <div className="row">
            <button className="icon-btn" onClick={onGallery} title="Medien, Dateien und Links" aria-label="Galerie"><Icon name="gallery" /></button>
            <button className="icon-btn" onClick={() => setSel(new Set())} title="Auswählen" aria-label="Auswählen"><Icon name="select" /></button>
            <button className="btn small primary new-btn" onClick={onNew} title="Neue Nachricht"><Icon name="edit" size={16} /> Neue Nachricht</button>
            <button className="icon-btn mobile-only" onClick={onSettings} title="Einstellungen" aria-label="Einstellungen"><Icon name="settings" /></button>
          </div>
        </header>
      )}
      <div className="search">
        <Icon name="search" size={18} />
        <input placeholder="Suchen" value={q} onChange={(e) => setQ(e.target.value)} />
        {q && <button className="icon-btn small" onClick={() => setQ('')}><Icon name="close" size={16} /></button>}
      </div>
      <div className="filters" role="toolbar" aria-label="Filter">
        <button className={`pill ${!filter.unread && !filter.nets.length ? 'on' : ''}`} onClick={() => setFilter({ ...filter, unread: false, nets: [] })}>Alle</button>
        <button className={`pill ${filter.unread ? 'on' : ''}`} onClick={() => setFilter({ ...filter, unread: !filter.unread })}>Ungelesen</button>
        {nets.map((n) => (
          <button key={n} className={`pill ${filter.nets.includes(n) ? 'on' : ''}`} onClick={() => toggleNet(n)} aria-pressed={filter.nets.includes(n)}>
            <span className="dot" style={{ background: NETWORKS[n].color }} />{NETWORKS[n].name}
          </button>
        ))}
      </div>
      {!online && <div className="banner warn">Keine Verbindung zum Server. Chorus versucht es weiter …</div>}
      {problems.map((a) => (
        <button key={a.id} className="banner warn clickable" onClick={onFixAccount}>
          <Icon name="alert" size={18} />
          <span><b>{NETWORKS[a.network].name}</b>: {a.status.state === 'qr' || a.status.state === 'need_input' ? 'Anmeldung nicht abgeschlossen' : a.status.message || 'nicht verbunden'}. Tippen zum Beheben.</span>
        </button>
      ))}
      <div className="pull" style={{ height: pull, opacity: Math.min(1, pull / 56) }} aria-hidden={!pull}>
        <span className={`pull-spin ${refreshing ? 'on' : ''}`} style={{ transform: refreshing ? undefined : `rotate(${pull * 4}deg)` }}><Icon name="refresh" size={20} /></span>
      </div>
      <ul className="chats" ref={listRef} onScroll={(e) => { if (showArchive && e.currentTarget.scrollTop > 90) setShowArchive(false); }} onTouchStart={onTouchStart} onTouchMove={onTouchMove} onTouchEnd={onTouchEnd}
        style={{ transition: pull ? 'none' : undefined }}>
        {!filter.archived && !q && archivedCount > 0 && showArchive && (
          <li>
            <button className="chat-item archive-row reveal" onClick={() => setFilter({ ...filter, archived: true })}>
              <span className="avatar archive-icon" style={{ width: 48, height: 48 }}><Icon name="archive" /></span>
              <span className="chat-main"><span className="chat-top"><span className="chat-title">Archiv</span></span>
                <span className="chat-bottom"><span className="chat-preview">{archivedCount} {archivedCount === 1 ? 'Chat' : 'Chats'}</span>
                  {archivedUnread > 0 && <span className="badge muted">{archivedUnread}</span>}</span></span>
            </button>
          </li>
        )}
        {shown.map((c) => <ChatListItem key={c.id} c={c} active={c.id === active} selecting={!!sel} selected={!!sel?.has(c.id)} onAct={rowAct} onClick={rowClick} onLong={rowLong} />)}
        {q.trim().length >= 2 && (
          <li className="search-results">
            {q.trim().length >= 3 && (
              <button className="ai-ask" onClick={askAi} disabled={aiBusy}>
                <Icon name="sparkle" size={18} /><span>{aiBusy ? 'KI sucht …' : <>KI fragen: <b>„{q.trim()}“</b></>}</span>
              </button>
            )}
            {aiRes && (
              <div className="ai-answer">
                <p>{aiRes.answer}</p>
                {aiRes.messages.map((m) => <HitRow key={m.id} m={m} chat={byId.get(m.chatId)} onOpen={onOpenMessage} />)}
                {aiRes.scope === 'ai' && <small className="muted">Gesucht in Chats mit eingeschalteter KI. In den KI-Einstellungen kannst du die Suche für alle Chats erlauben.</small>}
              </div>
            )}
            {hits.length > 0 && <h4 className="results-head">Nachrichten</h4>}
            {hits.map((m) => <HitRow key={m.id} m={m} chat={byId.get(m.chatId)} q={q.trim()} onOpen={onOpenMessage} />)}
          </li>
        )}
        {!shown.length && !hits.length && (
          <li className="list-empty">
            {accounts.length ? (q ? 'Nichts gefunden.' : filter.archived ? 'Das Archiv ist leer.' : 'Keine Chats in dieser Ansicht.') : (
              <>
                <p>Noch kein Messenger verbunden.</p>
                <button className="btn primary" onClick={onAdd}>Jetzt verbinden</button>
              </>
            )}
          </li>
        )}
      </ul>
      {sel && (
        <div className="select-bar">
          {(() => {
            const dis = !sel.size;
            const anyUnread = selChats.some((c) => c.unread > 0);
            const allArchived = selChats.length > 0 && selChats.every((c) => c.archived);
            const allMuted = selChats.length > 0 && selChats.every((c) => c.muted);
            const allPinned = selChats.length > 0 && selChats.every((c) => c.pinned);
            const run = async (w: Parameters<typeof act>[1]) => { await act(selIds, w); done(); };
            return <>
              <button disabled={dis} onClick={() => run(anyUnread ? 'read' : 'unread')}><Icon name={anyUnread ? 'checks' : 'dot'} size={20} />{anyUnread ? 'Gelesen' : 'Ungelesen'}</button>
              <button disabled={dis} onClick={() => run(allArchived ? 'unarchive' : 'archive')}><Icon name="archive" size={20} />{allArchived ? 'Zurückholen' : 'Archivieren'}</button>
              <button disabled={dis} onClick={() => run(allMuted ? 'unmute' : 'mute')}><Icon name={allMuted ? 'bell' : 'belloff'} size={20} />{allMuted ? 'Ton an' : 'Stumm'}</button>
              <button disabled={dis} onClick={() => run(allPinned ? 'unpin' : 'pin')}><Icon name="pin" size={20} />{allPinned ? 'Lösen' : 'Anheften'}</button>
            </>;
          })()}
        </div>
      )}
      {toast && <div className="toast">{toast}</div>}
      {accounts.length > 0 && !sel && <button className="fab mobile-only" onClick={onNew} aria-label="Neue Nachricht"><Icon name="edit" /></button>}
    </section>
  );
}

/** Suchtreffer: Chat, Datum und Ausschnitt mit hervorgehobenem Suchwort */
function HitRow({ m, chat, q, onOpen }: { m: Message; chat?: Chat; q?: string; onOpen: (m: Message) => void }) {
  const text = m.text || m.transcript || m.translation || m.attachments.map((a) => a.name).join(', ');
  let snip = text;
  const i = q ? text.toLowerCase().indexOf(q.toLowerCase()) : -1;
  if (i > 40) snip = '…' + text.slice(i - 30);
  const parts = q && i >= 0 ? snip.split(new RegExp(`(${q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})`, 'i')) : [snip];
  return (
    <button className="chat-item hit" onClick={() => onOpen(m)}>
      <Avatar name={chat?.title ?? '?'} src={chat?.avatar} size={40} />
      <span className="chat-main">
        <span className="chat-top"><span className="chat-title">{chat?.title ?? 'Chat'}</span><span className="chat-time">{dayLabel(m.ts)}</span></span>
        <span className="chat-bottom"><span className="chat-preview">{m.fromMe ? 'Du: ' : chat?.kind !== 'direct' ? `${m.senderName}: ` : ''}{parts.map((p, j) => (j % 2 ? <mark key={j}>{p}</mark> : p))}</span></span>
      </span>
    </button>
  );
}

const ChatListItem = memo(function ChatListItem({ c, active, selecting, selected, onAct, onClick, onLong }: {
  c: Chat & { linkedNets?: Network[] }; active: boolean; selecting: boolean; selected: boolean;
  onAct: (id: string, what: 'read' | 'unread' | 'archive' | 'unarchive') => void; onClick: (id: string) => void; onLong: (id: string) => void;
}) {
  return (
    <li>
      <SwipeRow disabled={selecting}
        left={{ icon: c.unread ? 'checks' : 'dot', label: c.unread ? 'Gelesen' : 'Ungelesen', color: 'var(--accent)', run: () => onAct(c.id, c.unread ? 'read' : 'unread') }}
        right={{ icon: 'archive', label: c.archived ? 'Zurückholen' : 'Archivieren', color: 'var(--ink-2)', run: () => onAct(c.id, c.archived ? 'unarchive' : 'archive') }}>
        <ChatRow c={c} active={active} selecting={selecting} selected={selected} onClick={() => onClick(c.id)} onLong={() => onLong(c.id)} />
      </SwipeRow>
    </li>
  );
});

function ChatRow({ c, active, selecting, selected, onClick, onLong }: {
  c: Chat & { linkedNets?: Network[] }; active: boolean; selecting: boolean; selected: boolean; onClick: () => void; onLong: () => void;
}) {
  const t = useRef<number | null>(null);
  const longFired = useRef(false);
  const start = () => { longFired.current = false; t.current = window.setTimeout(() => { longFired.current = true; navigator.vibrate?.(10); onLong(); }, 480); };
  const cancel = () => { if (t.current) { clearTimeout(t.current); t.current = null; } };
  useEffect(() => cancel, []);
  return (
    <button className={`chat-item ${active ? 'on' : ''} ${selected ? 'selected' : ''}`}
      onClick={() => { if (longFired.current) { longFired.current = false; return; } onClick(); }}
      onTouchStart={start} onTouchEnd={cancel} onTouchMove={cancel} onContextMenu={(e) => { e.preventDefault(); onLong(); }}>
      {selecting && <span className={`sel-check ${selected ? 'on' : ''}`}>{selected && <Icon name="check" size={14} />}</span>}
      <Avatar name={c.title} src={c.avatar} />
      <span className="chat-main">
        <span className="chat-top">
          <span className="chat-title">{c.title}</span>
          <span className={`chat-time ${c.unread && !c.muted ? 'accent' : ''}`}>{listTime(c.lastTs)}</span>
        </span>
        <span className="chat-bottom">
          <span className="chat-preview">{c.lastText || ' '}</span>
          {c.autopilot?.on && <span title="Autobot an">🤖</span>}
          {c.pinned && <Icon name="pin" size={14} className="muted-icon" />}
          {c.muted && <Icon name="belloff" size={14} className="muted-icon" />}
          {c.unread > 0 && <span className={`badge ${c.muted ? 'muted' : ''}`}>{c.unread > 99 ? '99+' : c.unread}</span>}
        </span>
      </span>
    </button>
  );
}

type SwipeAction = { icon: string; label: string; color: string; run: () => void };

/** Zeile zum Wischen: nach links archivieren, nach rechts gelesen/ungelesen */
function SwipeRow({ children, left, right, disabled }: { children: React.ReactNode; left: SwipeAction; right: SwipeAction; disabled?: boolean }) {
  const [dx, setDx] = useState(0);
  const [anim, setAnim] = useState(false);
  const s = useRef<{ x: number; y: number; dir: 0 | 1 | 2 } | null>(null); // dir: 0 offen, 1 waagrecht, 2 senkrecht
  const W = 84;
  const onStart = (e: React.TouchEvent) => { if (disabled) return; const t = e.touches[0]; s.current = { x: t.clientX, y: t.clientY, dir: 0 }; setAnim(false); };
  const onMove = (e: React.TouchEvent) => {
    const st = s.current; if (!st) return;
    const t = e.touches[0]; const ddx = t.clientX - st.x, ddy = t.clientY - st.y;
    if (st.dir === 0) { if (Math.abs(ddx) > 10 && Math.abs(ddx) > Math.abs(ddy) * 1.3) st.dir = 1; else if (Math.abs(ddy) > 10) st.dir = 2; }
    if (st.dir !== 1) return;
    setDx(Math.max(-220, Math.min(220, ddx)));
  };
  const onEnd = () => {
    const st = s.current; s.current = null; setAnim(true);
    if (!st || st.dir !== 1) { setDx(0); return; }
    if (dx < -W) { setDx(-window.innerWidth); setTimeout(() => { right.run(); setAnim(false); setDx(0); }, 220); }
    else if (dx > W) { left.run(); setDx(0); }
    else setDx(0);
  };
  const act = dx < 0 ? right : left;
  const armed = Math.abs(dx) > W;
  return (
    <div className="swipe">
      {dx !== 0 && (
        <div className={`swipe-bg ${dx < 0 ? 'to-left' : 'to-right'} ${armed ? 'armed' : ''}`} style={{ background: act.color }}>
          <span><Icon name={act.icon as any} size={20} />{act.label}</span>
        </div>
      )}
      <div className="swipe-fg" style={{ transform: dx ? `translateX(${dx}px)` : undefined, transition: anim ? 'transform .22s var(--ease-out)' : 'none' }}
        onTouchStart={onStart} onTouchMove={onMove} onTouchEnd={onEnd} onTouchCancel={onEnd}>
        {children}
      </div>
    </div>
  );
}
