import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { api, serverText, type Account, type Chat, type Message, type Network } from '../api';
import type { Filter } from '../App';
import { NETWORKS, askMailDelete, dayLabel, listTime } from '../util';
import { Avatar } from './Rail';
import { Icon } from './Icon';
import { T } from '../i18n';
import { reducedMotion, useFx } from '../effects';

export function ChatList({ chats, accounts, filter, setFilter, active, onOpen, onAdd, onSettings, onNew, online, problems, onFixAccount, onChats, onRemove, onOpenMessage, onGallery }: {
  onOpenMessage: (m: Message) => void; onGallery: () => void;
  chats: Chat[]; accounts: Account[]; filter: Filter; setFilter: (f: Filter) => void; active: string | null;
  onOpen: (id: string) => void; onAdd: () => void; onSettings: () => void; onNew: () => void; online: boolean; problems: Account[];
  onFixAccount: () => void; previewOf: (m: Message) => string; onChats: (cs: Chat[]) => void; onRemove: (ids: string[]) => Promise<string>;
}) {
  const [q, setQ] = useState('');
  const [sel, setSel] = useState<Set<string> | null>(null);
  const [toast, setToast] = useState('');
  // Filterleiste ein-/ausblenden (Standard: aus), Zustand bleibt gespeichert
  const [showFilters, setShowFilters] = useState(() => localStorage.getItem('inbox:showFilters') === '1');
  const toggleFilters = () => setShowFilters((v) => { localStorage.setItem('inbox:showFilters', v ? '0' : '1'); return !v; });
  const filterActive = filter.unread || filter.nets.length > 0;
  const nets = [...new Set(accounts.map((a) => a.network))];
  const archivedCount = useMemo(() => chats.filter((c) => c.archived && c.lastTs > 0).length, [chats]);

  // Zusammengeführte Kontakte: nur eine Zeile pro Person (der zuletzt aktive Chat), Ungelesene zusammengezählt
  const groups = useMemo(() => {
    const g = new Map<string, Chat[]>();
    for (const c of chats) if (c.link) g.set(c.link, [...(g.get(c.link) ?? []), c]);
    return g;
  }, [chats]);
  // E-Mail: ein Kontakt pro Absender, darin die einzelnen Betreffe
  const [sender, setSender] = useState<string | null>(null);
  const mailKey = (c: Chat) => (c.peer ? `${c.accountId}|${c.peer.id}` : null);
  const shown = useMemo(() => {
    const s = q.trim().toLowerCase();
    const seen = new Set<string>();
    if (sender && !s) return chats.filter((c) => mailKey(c) === sender && (c.lastTs > 0 || c.id === active));
    const list = chats.filter((c) =>
      (c.lastTs > 0 || c.id === active || !!s) &&
      (s ? true : filter.archived ? !!c.archived : !c.archived) &&
      (!filter.unread || c.unread > 0) &&
      (!filter.nets.length || filter.nets.includes(c.network)) &&
      (!s || c.title.toLowerCase().includes(s) || (c.peer?.name ?? '').toLowerCase().includes(s) || (c.peer?.id ?? '').includes(s) || (c.netTitle ?? '').toLowerCase().includes(s) || c.lastText.toLowerCase().includes(s)))
      .filter((c) => { if (!c.link || (groups.get(c.link)?.length ?? 0) < 2) return true; if (seen.has(c.link)) return false; seen.add(c.link); return true; })
      .map((c) => {
        const g = c.link ? groups.get(c.link) : undefined;
        return g && g.length > 1 ? { ...c, unread: g.reduce((n, x) => n + x.unread, 0), linkedNets: [...new Set(g.map((x) => x.network))] } : c;
      });
    if (s) return list;
    // Mehrere Betreffe eines Absenders: eine Zeile mit dem Namen, Vorschau = neuester Betreff
    const mail = new Map<string, Chat[]>();
    for (const c of list) { const k = mailKey(c); if (k) mail.set(k, [...(mail.get(k) ?? []), c]); }
    const done = new Set<string>();
    return list.flatMap((c): (Chat & { mailGroup?: string; groupIds?: string[] })[] => {
      const k = mailKey(c);
      if (!k) return [c];
      if (done.has(k)) return [];
      done.add(k);
      const g = mail.get(k)!;
      return [{ ...c, title: c.peer!.name, lastText: `${c.title}: ${c.lastText}`, unread: g.reduce((n, x) => n + x.unread, 0), mailGroup: g.length > 1 ? k : undefined, groupIds: g.map((x) => x.id) }];
    });
  }, [chats, filter, q, active, groups, sender]); // eslint-disable-line react-hooks/exhaustive-deps
  const senderName = sender ? chats.find((c) => mailKey(c) === sender)?.peer?.name ?? '' : '';
  useEffect(() => { if (sender && !shown.length && !q) setSender(null); }, [sender, shown.length, q]);

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
    catch (e: any) { setAiRes({ q: s, answer: e.message ?? T('Fehler'), messages: [], scope: '' }); }
    finally { setAiBusy(false); }
  };

  const flash = (t: string) => { setToast(t); setTimeout(() => setToast(''), 2200); };
  const toggleNet = (n: Network) => setFilter({ ...filter, nets: filter.nets.includes(n) ? filter.nets.filter((x) => x !== n) : [...filter.nets, n] });

  // Aktionen für eine oder mehrere Chats
  const act = async (ids: string[], what: 'read' | 'unread' | 'archive' | 'unarchive' | 'mute' | 'unmute' | 'pin' | 'unpin' | 'delete'): Promise<boolean | void> => {
    if (what === 'delete') {
      const mail = ids.every((id) => chats.find((c) => c.id === id)?.network === 'email');
      const n = ids.length;
      if (!(mail && !askMailDelete()) && !confirm(mail ? (n > 1 ? T('{0} E-Mail-Unterhaltungen in den Papierkorb verschieben?', n) : T('Diese E-Mail-Unterhaltung in den Papierkorb verschieben?'))
        : (n > 1 ? T('{0} Chats löschen?', n) : T('Chat löschen?')) + T(' Er verschwindet aus Chorus, auf dem Handy bleibt er erhalten.'))) return false;
      setSel(null);
      // Sofort weg, der Rest läuft im Hintergrund; bei Fehler kommt der Chat zurück
      void onRemove(ids).then((err) => flash(err || (n > 1 ? T('{0} gelöscht', n) : T('Gelöscht'))));
      return true;
    }
    const out: Chat[] = [];
    let err = '';
    await Promise.all(ids.map(async (id) => {
      try {
        if (what === 'read') { await api.markRead(id); const c = chats.find((x) => x.id === id); if (c) out.push({ ...c, unread: 0 }); }
        else if (what === 'unread') out.push(await api.markUnread(id));
        else out.push(await api.patchChat(id, what === 'archive' || what === 'unarchive' ? { archived: what === 'archive' } : what === 'mute' || what === 'unmute' ? { muted: what === 'mute' } : { pinned: what === 'pin' }));
      } catch (e: any) { err = e?.message ?? T('Fehler'); }
    }));
    onChats(out);
    if (err) { flash(err); return; }
    if (what === 'archive') flash(ids.length > 1 ? T('{0} Chats archiviert', ids.length) : T('Archiviert'));
    if (what === 'unarchive') flash(ids.length > 1 ? T('{0} Chats zurückgeholt', ids.length) : T('Aus dem Archiv geholt'));
  };

  // Ausgewählte Absender-Zeilen stehen für alle ihre Betreffe
  const rowInfo = new Map(shown.map((c) => [c.id, c as Chat & { mailGroup?: string; groupIds?: string[] }]));
  const selIds = sel ? [...new Set([...sel].flatMap((id) => rowInfo.get(id)?.groupIds ?? [id]))] : [];
  const selChats = chats.filter((c) => selIds.includes(c.id));
  const senderIds = sender && !q ? shown.map((c) => c.id) : [];
  const allSel = !!sel && shown.length > 0 && shown.every((c) => sel.has(c.id));
  const toggleSel = (id: string) => setSel((s) => { const n = new Set(s ?? []); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  const done = () => setSel(null);
  // Feste Funktionen für die Zeilen: so wird nur die Zeile neu gezeichnet, in der sich etwas ändert
  const live = useRef({ act, sel, onOpen, rowInfo });
  live.current = { act, sel, onOpen, rowInfo };
  // Absender-Zeile: Aktionen gelten für alle Betreffe
  const rowAct = useCallback((id: string, what: 'read' | 'unread' | 'archive' | 'unarchive' | 'delete') => live.current.act(live.current.rowInfo.get(id)?.groupIds ?? [id], what), []);
  const rowClick = useCallback((id: string) => {
    const g = live.current.rowInfo.get(id)?.mailGroup;
    if (live.current.sel) toggleSel(id); else if (g) setSender(g); else live.current.onOpen(id);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const rowLong = useCallback((id: string) => { if (!live.current.sel) setSel(new Set([id])); }, []);

  const listRef = useRef<HTMLUListElement>(null);

  // „Neue Nachricht“ zeigt Text, solange er in den Listenkopf passt; sonst nur das Symbol.
  const headRef = useRef<HTMLElement>(null);
  const [newCompact, setNewCompact] = useState(false);
  const labelW = useRef(0);
  useLayoutEffect(() => {
    const h = headRef.current;
    const row = h?.querySelector<HTMLElement>(':scope > .row');
    if (!h || !row) return;
    const check = () => {
      const label = row.querySelector<HTMLElement>('.new-btn-label');
      if (!label) return;
      const cs = getComputedStyle(h);
      let used = row.scrollWidth;
      for (const el of Array.from(h.children) as HTMLElement[]) if (el !== row) used += el.offsetWidth;
      const free = h.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight) - used;
      setNewCompact((c) => {
        if (!c) { if (label.offsetWidth) labelW.current = label.offsetWidth; return free < 8; }
        return free - labelW.current - 8 < 8;
      });
    };
    check();
    const ro = new ResizeObserver(check);
    ro.observe(h); ro.observe(row);
    return () => ro.disconnect();
  });

  // Chor-Wellen: neue eingehende Nachricht (Chat neuer und mehr Ungelesene) lässt das Band aufschwingen
  const wavesOn = useFx('waves');
  const lastSeen = useRef<Map<string, { ts: number; unread: number }> | null>(null);
  const [wave, setWave] = useState<{ n: number; color: string } | null>(null);
  useEffect(() => {
    const prev = lastSeen.current;
    const next = new Map<string, { ts: number; unread: number }>();
    let hit: Chat | null = null;
    for (const c of chats) {
      next.set(c.id, { ts: c.lastTs, unread: c.unread });
      const o = prev?.get(c.id);
      if (prev && c.lastTs > (o?.ts ?? 0) && c.unread > (o?.unread ?? 0) && !c.muted && !c.archived && (!hit || c.lastTs > hit.lastTs)) hit = c;
    }
    lastSeen.current = next;
    if (hit && wavesOn && !reducedMotion()) setWave({ n: Date.now(), color: NETWORKS[hit.network]?.color ?? 'var(--accent)' });
  }, [chats, wavesOn]);

  // Gelesen-Moment: fällt die Zahl ungelesener Chats auf 0, schwingt das Logo einmal aus
  const zeroOn = useFx('inboxZero');
  const unreadTotal = useMemo(() => chats.reduce((n, c) => n + (!c.archived && !c.muted && c.unread > 0 ? 1 : 0), 0), [chats]);
  const prevUnread = useRef(unreadTotal);
  const [zero, setZero] = useState(0);
  useEffect(() => {
    const before = prevUnread.current; prevUnread.current = unreadTotal;
    if (!zeroOn || before === 0 || unreadTotal > 0 || reducedMotion()) return;
    setZero(Date.now());
  }, [unreadTotal, zeroOn]);
  useEffect(() => { if (!zero) return; const t = window.setTimeout(() => setZero(0), 2200); return () => clearTimeout(t); }, [zero]);

  return (
    <section className="pane-list">
      {zero > 0 && <div key={zero} className="fx-zero" aria-hidden="true"><img src="/icon.svg?v=3" alt="" width={56} height={56} /><span>{T('Alles gelesen')}</span></div>}
      {sel ? (
        <header className="list-head select-head">
          <button className="icon-btn" onClick={done} aria-label={T('Fertig')}><Icon name="close" /></button>
          <h1>{sel.size ? T('{0} ausgewählt', sel.size) : T('Auswählen')}</h1>
          <button className="btn small ghost" onClick={() => setSel(allSel ? new Set() : new Set(shown.map((c) => c.id)))}>{allSel ? 'Keine' : T('Alle')}</button>
        </header>
      ) : (
        <header className="list-head" ref={headRef}>
          {sender && !q ? (
            <><button className="icon-btn" onClick={() => setSender(null)} aria-label={T('Zurück')}><Icon name="back" /></button><h1 className="sender-head">{senderName}<small>{shown.length} {T('Betreffe')}</small></h1>
              <button className="icon-btn" onClick={() => void act(senderIds, 'archive')} title={T('Alle archivieren')} aria-label={T('Alle archivieren')}><Icon name="archive" /></button>
              <button className="icon-btn" onClick={() => void act(senderIds, 'delete')} title={T('Alle löschen')} aria-label={T('Alle löschen')}><Icon name="trash" /></button></>
          ) : filter.archived ? (
            <><button className="icon-btn" onClick={() => setFilter({ ...filter, archived: false })} aria-label={T('Zurück')}><Icon name="back" /></button><h1>{T('Archiv')}</h1></>
          ) : <h1>{T('Chats')}</h1>}
          {!(sender && !q) && <div className="row">
            <button className="icon-btn" onClick={onGallery} title={T('Medien, Dateien und Links')} aria-label={T('Galerie')}><Icon name="gallery" /></button>
            <button className={`icon-btn ${filterActive ? 'on' : ''} ${filterActive && !showFilters ? 'badge' : ''}`} onClick={toggleFilters} title={showFilters ? T('Filter ausblenden') : T('Filter einblenden')} aria-label="Filter" aria-pressed={showFilters}><Icon name="filter" /></button>
            <button className="icon-btn" onClick={() => setSel(new Set())} title={T('Auswählen')} aria-label={T('Auswählen')}><Icon name="select" /></button>
            {!filter.archived && archivedCount > 0 && <button className="icon-btn" onClick={() => setFilter({ ...filter, archived: true })} title={T('Archiv ({0})', archivedCount)} aria-label={T('Archiv')}><Icon name="archive" /></button>}
            <button className={`btn small primary new-btn ${newCompact ? 'compact' : ''}`} onClick={onNew} title={T('Neue Nachricht')} aria-label={T('Neue Nachricht')}><Icon name="edit" size={16} /><span className="new-btn-label">{T('Neue Nachricht')}</span></button>
            <button className="icon-btn mobile-only" onClick={onSettings} title={T('Einstellungen')} aria-label={T('Einstellungen')}><Icon name="settings" /></button>
          </div>}
        </header>
      )}
      {wavesOn && <Waves key={wave?.n ?? 0} color={wave?.color} />}
      <div className="search">
        <Icon name="search" size={18} />
        <input placeholder={T('Suchen')} value={q} onChange={(e) => setQ(e.target.value)} />
        {q && <button className="icon-btn small" onClick={() => setQ('')}><Icon name="close" size={16} /></button>}
      </div>
      {showFilters && <div className="filters" role="toolbar" aria-label="Filter">
        <button className={`pill ${!filter.unread && !filter.nets.length ? 'on' : ''}`} onClick={() => setFilter({ ...filter, unread: false, nets: [] })}>{T('Alle')}</button>
        <button className={`pill ${filter.unread ? 'on' : ''}`} onClick={() => setFilter({ ...filter, unread: !filter.unread })}>{T('Ungelesen')}</button>
        {nets.map((n) => (
          <button key={n} className={`pill ${filter.nets.includes(n) ? 'on' : ''}`} onClick={() => toggleNet(n)} aria-pressed={filter.nets.includes(n)}>
            <span className="dot" style={{ background: NETWORKS[n].color }} />{NETWORKS[n].name}
          </button>
        ))}
      </div>}
      {!online && <div className="banner warn">{T('Keine Verbindung zum Server. Chorus versucht es weiter …')}</div>}
      {problems.map((a) => (
        <button key={a.id} className="banner warn clickable" onClick={onFixAccount}>
          <Icon name="alert" size={18} />
          <span><b>{NETWORKS[a.network].name}</b>: {a.status.state === 'qr' || a.status.state === 'need_input' ? T('Anmeldung nicht abgeschlossen') : (a.status.message && serverText(a.status.message)) || T('nicht verbunden')}{T('. Tippen zum Beheben.')}</span>
        </button>
      ))}
      <ul className="chats" ref={listRef}>
        {shown.map((c) => <ChatListItem key={c.id} c={c} active={c.id === active || (!!active && !!(c as { groupIds?: string[] }).groupIds?.includes(active))} selecting={!!sel} selected={!!sel?.has(c.id)} onAct={rowAct} onClick={rowClick} onLong={rowLong} />)}
        {q.trim().length >= 2 && (
          <li className="search-results">
            {q.trim().length >= 3 && (
              <button className="ai-ask" onClick={askAi} disabled={aiBusy}>
                <Icon name="sparkle" size={18} /><span>{aiBusy ? T('KI sucht …') : <>{T('KI fragen:')}{' '}<b>„{q.trim()}“</b></>}</span>
              </button>
            )}
            {aiRes && (
              <div className="ai-answer">
                <p>{aiRes.answer}</p>
                {aiRes.messages.map((m) => <HitRow key={m.id} m={m} chat={byId.get(m.chatId)} onOpen={onOpenMessage} />)}
                {aiRes.scope === 'ai' && <small className="muted">{T('Gesucht in Chats mit eingeschalteter KI. In den KI-Einstellungen kannst du die Suche für alle Chats erlauben.')}</small>}
              </div>
            )}
            {hits.length > 0 && <h4 className="results-head">{T('Nachrichten')}</h4>}
            {hits.map((m) => <HitRow key={m.id} m={m} chat={byId.get(m.chatId)} q={q.trim()} onOpen={onOpenMessage} />)}
          </li>
        )}
        {!shown.length && !hits.length && (
          <li className="list-empty">
            {accounts.length ? (q ? T('Nichts gefunden.') : filter.archived ? T('Das Archiv ist leer.') : T('Keine Chats in dieser Ansicht.')) : (
              <>
                <p>{T('Noch kein Messenger verbunden.')}</p>
                <button className="btn primary" onClick={onAdd}>{T('Jetzt verbinden')}</button>
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
            const run = async (w: Parameters<typeof act>[1]) => { if ((await act(selIds, w)) !== false) done(); };
            return <>
              <button disabled={dis} onClick={() => run(anyUnread ? 'read' : 'unread')}><Icon name={anyUnread ? 'checks' : 'dot'} size={20} />{anyUnread ? T('Gelesen') : T('Ungelesen')}</button>
              <button disabled={dis} onClick={() => run(allArchived ? 'unarchive' : 'archive')}><Icon name="archive" size={20} />{allArchived ? T('Zurückholen') : 'Archivieren'}</button>
              <button disabled={dis} onClick={() => run(allMuted ? 'unmute' : 'mute')}><Icon name={allMuted ? 'bell' : 'belloff'} size={20} />{allMuted ? T('Ton an') : T('Stumm')}</button>
              <button disabled={dis} onClick={() => run(allPinned ? 'unpin' : 'pin')}><Icon name="pin" size={20} />{allPinned ? T('Lösen') : 'Anheften'}</button>
              {selChats.length > 0 && <button onClick={() => run('delete')}><Icon name="trash" size={20} />{T('Löschen')}</button>}
            </>;
          })()}
        </div>
      )}
      {toast && <div className="toast">{toast}</div>}
      {accounts.length > 0 && !sel && <button className="fab mobile-only" onClick={onNew} aria-label={T('Neue Nachricht')}><Icon name="edit" /></button>}
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
        <span className="chat-bottom"><span className="chat-preview">{m.fromMe ? T('Du: ') : chat?.kind !== 'direct' ? `${m.senderName}: ` : ''}{parts.map((p, j) => (j % 2 ? <mark key={j}>{p}</mark> : p))}</span></span>
      </span>
    </button>
  );
}

const ChatListItem = memo(function ChatListItem({ c, active, selecting, selected, onAct, onClick, onLong }: {
  c: Chat & { linkedNets?: Network[] }; active: boolean; selecting: boolean; selected: boolean;
  onAct: (id: string, what: 'read' | 'unread' | 'archive' | 'unarchive' | 'delete') => Promise<boolean | void>; onClick: (id: string) => void; onLong: (id: string) => void;
}) {
  return (
    <li>
      <SwipeRow disabled={selecting}
        left={{ icon: 'trash', label: T('Löschen'), color: 'var(--danger)', run: () => onAct(c.id, 'delete') }}
        right={{ icon: 'archive', label: c.archived ? T('Zurückholen') : 'Archivieren', color: 'var(--ink-2)', run: () => onAct(c.id, c.archived ? 'unarchive' : 'archive') }}
        far={{ icon: c.unread ? 'checks' : 'dot', label: c.unread ? T('Gelesen') : T('Ungelesen'), color: 'var(--accent)', run: () => onAct(c.id, c.unread ? 'read' : 'unread') }}>
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
      <Avatar name={c.peer?.name ?? c.title} src={c.avatar} />
      <span className="chat-main">
        <span className="chat-top">
          <span className="chat-title">{c.title}</span>
          <span className={`chat-time ${c.unread && !c.muted ? 'accent' : ''}`}>{listTime(c.lastTs)}</span>
        </span>
        <span className="chat-bottom">
          <span className="chat-preview">{(c.lastText && T(c.lastText)) || ' '}</span>
          {c.autopilot?.on && <span title={T('Autobot an')}>🤖</span>}
          {c.pinned && <Icon name="pin" size={14} className="muted-icon" />}
          {c.muted && <Icon name="belloff" size={14} className="muted-icon" />}
          {c.unread > 0 && <span className={`badge ${c.muted ? 'muted' : ''}`}>{c.unread > 99 ? '99+' : c.unread}</span>}
        </span>
      </span>
    </button>
  );
}

type SwipeAction = { icon: string; label: string; color: string; run: () => unknown };

/** Zeile zum Wischen: nach links löschen, nach rechts archivieren, weit nach rechts gelesen/ungelesen */
function SwipeRow({ children, left, right, far, disabled }: { children: React.ReactNode; left: SwipeAction; right: SwipeAction; far: SwipeAction; disabled?: boolean }) {
  const [dx, setDx] = useState(0);
  const [anim, setAnim] = useState(false);
  const s = useRef<{ x: number; y: number; dir: 0 | 1 | 2 } | null>(null); // dir: 0 offen, 1 waagrecht, 2 senkrecht
  const W = 84;
  const FAR = Math.max(170, Math.round(window.innerWidth * 0.5));
  const onStart = (e: React.TouchEvent) => { if (disabled) return; const t = e.touches[0]; s.current = { x: t.clientX, y: t.clientY, dir: 0 }; setAnim(false); };
  const onMove = (e: React.TouchEvent) => {
    const st = s.current; if (!st) return;
    const t = e.touches[0]; const ddx = t.clientX - st.x, ddy = t.clientY - st.y;
    if (st.dir === 0) { if (Math.abs(ddx) > 10 && Math.abs(ddx) > Math.abs(ddy) * 1.3) st.dir = 1; else if (Math.abs(ddy) > 10) st.dir = 2; }
    if (st.dir !== 1) return;
    setDx(Math.max(-220, Math.min(FAR + 60, ddx)));
  };
  // Zeile hinausschieben, dann Aktion; bei Abbruch (z.B. Rückfrage verneint) zurück
  const out = (to: number, run: () => unknown) => {
    setDx(to);
    setTimeout(async () => { const r = await run(); setAnim(r === false); setDx(0); }, 220);
  };
  const onEnd = () => {
    const st = s.current; s.current = null; setAnim(true);
    if (!st || st.dir !== 1) { setDx(0); return; }
    if (dx < -W) out(-window.innerWidth, left.run);
    else if (dx > FAR) { far.run(); setDx(0); }
    else if (dx > W) out(window.innerWidth, right.run);
    else setDx(0);
  };
  const act = dx < 0 ? left : dx > FAR ? far : right;
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

/** Chor-Wellen: ruhiges Band; mit Farbe schwingt es einmal auf (nur transform/opacity) */
const WAVE_PATH = (() => {
  let d = 'M0 6';
  for (let x = 0; x < 800; x += 20) d += ` Q${x + 5} 1 ${x + 10} 6 T${x + 20} 6`;
  return d;
})();
function Waves({ color }: { color?: string }) {
  return (
    <div className={`fx-waves${color ? ' go' : ''}`} style={color ? { color } : undefined} aria-hidden="true">
      <svg width="800" height="12" viewBox="0 0 800 12"><path d={WAVE_PATH} fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" /></svg>
    </div>
  );
}
