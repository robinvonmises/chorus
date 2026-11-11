import { useEffect, useRef, useState } from 'react';
import { api, type ImmichAlbum, type ImmichAsset } from '../api';
import { Icon } from './Icon';

/** Fotos und Videos aus Immich zum Anhängen auswählen: neueste zuerst, Alben, Suche */
export function ImmichPicker({ onClose, onPick }: { onClose: () => void; onPick: (files: File[]) => void }) {
  const [tab, setTab] = useState<'recent' | 'albums'>('recent');
  const [album, setAlbum] = useState<ImmichAlbum | null>(null);
  const [albums, setAlbums] = useState<ImmichAlbum[] | null>(null);
  const [q, setQ] = useState('');
  const [query, setQuery] = useState('');
  const [items, setItems] = useState<ImmichAsset[]>([]);
  const [next, setNext] = useState<number | null>(1);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState('');
  const [sel, setSel] = useState<ImmichAsset[]>([]);
  const [busy, setBusy] = useState(false);
  const gen = useRef(0);

  const showGrid = tab === 'recent' || !!album;
  const load = async (page: number, reset = false) => {
    const g = reset ? ++gen.current : gen.current;
    setLoading(true); setErr('');
    try {
      const r = await api.immichAssets({ page, album: album?.id, q: query || undefined });
      if (g !== gen.current) return;
      setItems((x) => (reset ? r.items : [...x, ...r.items])); setNext(r.next);
    } catch (e: any) { if (g === gen.current) setErr(e.message ?? 'Fehler'); }
    finally { if (g === gen.current) setLoading(false); }
  };
  useEffect(() => { if (showGrid) { setItems([]); setNext(1); void load(1, true); } }, [tab, album?.id, query]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { if (tab === 'albums' && !albums) api.immichAlbums().then(setAlbums, (e: any) => setErr(e.message ?? 'Fehler')); }, [tab]); // eslint-disable-line react-hooks/exhaustive-deps

  // Nachladen, sobald das Ende der Liste in Sicht kommt
  const end = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = end.current; if (!el || !showGrid) return;
    const io = new IntersectionObserver((e) => { if (e[0].isIntersecting && next && !loading) void load(next); }, { rootMargin: '400px' });
    io.observe(el); return () => io.disconnect();
  });

  const toggle = (a: ImmichAsset) => setSel((s) => (s.some((x) => x.id === a.id) ? s.filter((x) => x.id !== a.id) : [...s, a]));
  const attach = async () => {
    setBusy(true); setErr('');
    try { onPick(await Promise.all(sel.map((a) => api.immichFile(a)))); onClose(); }
    catch (e: any) { setErr(e.message ?? 'Fehler'); setBusy(false); }
  };

  return (
    <div className="modal-bg nc-top" onClick={onClose}>
      <div className="modal wide im-sheet" onClick={(e) => e.stopPropagation()} role="dialog" aria-label="Aus Immich anhängen">
        <header className="modal-head">
          {album && <button className="icon-btn" onClick={() => setAlbum(null)} aria-label="Zurück"><Icon name="back" /></button>}
          <h2>{album ? album.name : 'Immich'}</h2>
          <button className="icon-btn" onClick={onClose} aria-label="Schließen"><Icon name="close" /></button>
        </header>
        <div className="modal-body">
          {!album && <div className="seg">
            <button className={tab === 'recent' ? 'on' : ''} onClick={() => setTab('recent')}>Fotos</button>
            <button className={tab === 'albums' ? 'on' : ''} onClick={() => setTab('albums')}>Alben</button>
          </div>}
          {tab === 'recent' && !album && (
            <form className="row" onSubmit={(e) => { e.preventDefault(); setQuery(q.trim()); }}>
              <input className="input" type="search" enterKeyHint="search" autoComplete="off" placeholder="Suchen, z. B. „Strand“ oder „Hund“" value={q}
                onChange={(e) => { setQ(e.target.value); if (!e.target.value) setQuery(''); }} />
            </form>
          )}
          <div className="im-scroll">
            {showGrid ? (
              <div className="im-grid">
                {items.map((a) => {
                  const k = sel.findIndex((x) => x.id === a.id);
                  return (
                    <button key={a.id} className={`im-tile${k >= 0 ? ' on' : ''}`} onClick={() => toggle(a)} aria-label={a.name}>
                      <img src={api.immichThumb(a.id)} alt="" loading="lazy" decoding="async" />
                      {a.video && <span className="im-vid"><Icon name="play" size={12} />{a.duration}</span>}
                      {k >= 0 && <span className="im-num">{k + 1}</span>}
                    </button>
                  );
                })}
              </div>
            ) : (
              <div className="im-albums">
                {albums?.map((al) => (
                  <button key={al.id} onClick={() => setAlbum(al)}>
                    {al.cover ? <img src={api.immichThumb(al.cover)} alt="" loading="lazy" /> : <span className="im-nocover"><Icon name="photos" /></span>}
                    <b>{al.name}</b><small>{al.count}</small>
                  </button>
                ))}
                {albums && !albums.length && <p className="muted small">Keine Alben.</p>}
              </div>
            )}
            <div ref={end} />
            {(loading || (tab === 'albums' && !album && !albums && !err)) && <p className="muted small">Lädt …</p>}
            {showGrid && !loading && !items.length && !err && <p className="muted small">{query ? 'Nichts gefunden.' : 'Keine Fotos.'}</p>}
          </div>
          {err && <p className="muted small">{err}</p>}
          <button className="btn primary" disabled={busy || !sel.length} onClick={() => void attach()}>
            <Icon name="attach" size={18} />{busy ? 'Wird geladen …' : sel.length > 1 ? `${sel.length} anhängen` : 'Anhängen'}
          </button>
        </div>
      </div>
    </div>
  );
}
