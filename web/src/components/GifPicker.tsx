import { useEffect, useRef, useState } from 'react';
import { api, type GifItem, type GifSettings } from '../api';
import { Icon } from './Icon';
import { T } from '../i18n';

const KEY_LINKS = { giphy: 'https://developers.giphy.com/dashboard/', klipy: 'https://partner.klipy.com/' };

/** GIFs suchen (leer = Trends) und mit einem Tippen senden */
export function GifPicker({ onClose, onPick }: { onClose: () => void; onPick: (g: GifItem) => void }) {
  const [cfg, setCfg] = useState<GifSettings | null>(null);
  const [setup, setSetup] = useState(false);
  const [q, setQ] = useState('');
  const [query, setQuery] = useState('');
  const [items, setItems] = useState<GifItem[]>([]);
  const [next, setNext] = useState<number | null>(1);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState('');
  const gen = useRef(0);

  useEffect(() => { api.gifSettings().then((s) => { setCfg(s); setSetup(!s.enabled); }, (e: any) => setErr(e.message ?? T('Fehler'))); }, []);

  const load = async (page: number, reset = false) => {
    const g = reset ? ++gen.current : gen.current;
    setLoading(true); setErr('');
    try {
      const r = await api.gifs(query, page);
      if (g !== gen.current) return;
      setItems((x) => (reset ? r.items : [...x, ...r.items])); setNext(r.next);
    } catch (e: any) { if (g === gen.current) { setErr(e.message ?? T('Fehler')); setNext(null); } }
    finally { if (g === gen.current) setLoading(false); }
  };
  const ready = !!cfg?.enabled && !setup;
  useEffect(() => { if (ready) { setItems([]); setNext(1); void load(1, true); } }, [ready, query]); // eslint-disable-line react-hooks/exhaustive-deps

  // Bei der Eingabe kurz warten, dann suchen
  useEffect(() => { const t = setTimeout(() => setQuery(q.trim()), 450); return () => clearTimeout(t); }, [q]);

  const end = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = end.current; if (!el || !ready) return;
    const io = new IntersectionObserver((e) => { if (e[0].isIntersecting && next && !loading) void load(next); }, { rootMargin: '400px' });
    io.observe(el); return () => io.disconnect();
  });

  return (
    <div className="modal-bg nc-top" onClick={onClose}>
      <div className="modal wide im-sheet" onClick={(e) => e.stopPropagation()} role="dialog" aria-label="GIF">
        <header className="modal-head">
          {cfg?.enabled && setup && <button className="icon-btn" onClick={() => setSetup(false)} aria-label={T('Zurück')}><Icon name="back" /></button>}
          <h2>GIF</h2>
          {ready && <button className="icon-btn" onClick={() => setSetup(true)} aria-label={T('GIF-Dienst einrichten')}><Icon name="settings" /></button>}
          <button className="icon-btn" onClick={onClose} aria-label={T('Schließen')}><Icon name="close" /></button>
        </header>
        <div className="modal-body">
          {setup && cfg ? <GifSetup cfg={cfg} onSaved={(s) => { setCfg(s); setSetup(!s.enabled); }} /> : <>
            <input className="input" type="search" enterKeyHint="search" autoComplete="off" placeholder={T('GIFs suchen')} value={q} onChange={(e) => setQ(e.target.value)} />
            <div className="im-scroll">
              <div className="gif-grid">
                {items.map((g) => (
                  <button key={g.id} className="gif-tile" onClick={() => onPick(g)} aria-label={g.title || 'GIF'}>
                    <img src={g.preview} alt="" loading="lazy" decoding="async" referrerPolicy="no-referrer" />
                  </button>
                ))}
              </div>
              {!loading && ready && !items.length && !err && <p className="muted center">{T('Keine GIFs gefunden')}</p>}
              <div ref={end} style={{ height: 1 }} />
              {loading && <p className="muted center">{T('Lädt …')}</p>}
            </div>
            {cfg && <small className="muted center">{cfg.provider === 'klipy' ? 'Powered by KLIPY' : 'Powered by GIPHY'}</small>}
          </>}
          {err && <p className="error">{err}</p>}
        </div>
      </div>
    </div>
  );
}

function GifSetup({ cfg, onSaved }: { cfg: GifSettings; onSaved: (s: GifSettings) => void }) {
  const [provider, setProvider] = useState(cfg.provider);
  const [key, setKey] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const save = async (k: string | null) => {
    setBusy(true); setErr('');
    try {
      const s = await api.setGifSettings({ provider, key: k });
      if (s.enabled && k) await api.gifs('', 1); // Schlüssel gleich prüfen
      onSaved(s);
    } catch (e: any) { setErr(e.message ?? T('Fehler')); }
    finally { setBusy(false); }
  };
  return (
    <form className="gif-setup" onSubmit={(e) => { e.preventDefault(); if (key.trim()) void save(key.trim()); }}>
      <p>{T('Für die GIF-Suche brauchst du einen kostenlosen API-Schlüssel von GIPHY oder KLIPY. Er bleibt auf deinem Server.')}</p>
      <div className="seg">
        <button type="button" className={provider === 'giphy' ? 'on' : ''} onClick={() => setProvider('giphy')}>GIPHY</button>
        <button type="button" className={provider === 'klipy' ? 'on' : ''} onClick={() => setProvider('klipy')}>KLIPY</button>
      </div>
      <a href={KEY_LINKS[provider]} target="_blank" rel="noreferrer">{T('Schlüssel bei {0} holen', provider === 'giphy' ? 'GIPHY' : 'KLIPY')}</a>
      <input className="input" autoComplete="off" spellCheck={false} placeholder={T('API-Schlüssel')} value={key} onChange={(e) => setKey(e.target.value)} />
      {cfg.server && !cfg.own && <small className="muted">{T('Auf diesem Server ist bereits ein Schlüssel hinterlegt. Ein eigener hat Vorrang.')}</small>}
      <div className="row">
        <button className="btn primary" disabled={busy || !key.trim()}>{T('Speichern')}</button>
        {cfg.own && <button type="button" className="btn" disabled={busy} onClick={() => void save(null)}>{T('Schlüssel entfernen')}</button>}
      </div>
      {err && <p className="error">{err}</p>}
    </form>
  );
}
