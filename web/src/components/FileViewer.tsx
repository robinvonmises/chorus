import { useEffect, useRef, useState } from 'react';
import { Icon } from './Icon';
import { attachmentUrl, type Message } from '../api';
import { fileSize } from '../util';
import { useStorage } from '../storageState';
import { openSaveAs } from './NextcloudBrowser';

/** Als Web-App vom Home-Bildschirm: ohne Browserleiste gibt es nach einem Datei-Link keinen Weg zurück */
export const standalone = matchMedia('(display-mode: standalone)').matches || (navigator as any).standalone === true;

/** Bis zu dieser Größe wird die Datei beim Öffnen schon geladen: iOS erlaubt das Teilen nur direkt nach dem Tippen */
const PREFETCH_MAX = 60 * 1024 * 1024;
const TEXT_EXT = /\.(txt|md|csv|tsv|log|json|xml|ya?ml|ini|conf|cfg|vcf|ics|srt|vtt|js|ts|py|sh|css|sql)$/i;
const TEXT_MAX = 300 * 1024;

/** Datei holen und als File-Objekt bereitstellen, damit „Teilen“ beim Tippen sofort öffnen kann */
export function useShareFile(url: string | null, name: string, mime: string, size: number) {
  const [file, setFile] = useState<File | null>(null);
  const can = typeof navigator.share === 'function' && typeof navigator.canShare === 'function';
  useEffect(() => {
    setFile(null);
    if (!url || !can || size > PREFETCH_MAX) return;
    let off = false;
    fetch(url).then((r) => (r.ok ? r.blob() : Promise.reject())).then((b) => {
      if (!off) setFile(new File([b], name, { type: mime || b.type || 'application/octet-stream' }));
    }).catch(() => {});
    return () => { off = true; };
  }, [url]);
  /** true = Teilen-Menü geöffnet (oder abgebrochen), false = nicht möglich, Aufrufer lädt dann herunter */
  const share = async (): Promise<boolean> => {
    if (!can) return false;
    let f = file;
    if (!f && url) { // zu groß oder noch nicht da: jetzt laden, klappt nicht auf jedem Gerät
      const b = await fetch(url).then((r) => r.blob());
      f = new File([b], name, { type: mime || b.type });
    }
    if (!f || !navigator.canShare({ files: [f] })) return false;
    try { await navigator.share({ files: [f] }); } catch (e: any) { if (e?.name !== 'AbortError') throw e; }
    return true;
  };
  return { ready: !!file || !can || size > PREFETCH_MAX, share, can };
}

type Req = { m: Message; i: number };
const subs = new Set<(r: Req) => void>();
/** Datei aus dem Chat in der App ansehen statt zur Datei-Adresse zu springen */
export const openFile = (m: Message, i: number) => subs.forEach((f) => f({ m, i }));

/** Datei-Vorschau über dem Chat: PDF, Text oder Datei-Infos; Schließen führt immer zurück */
export function FileViewer() {
  const [req, setReq] = useState<Req | null>(null);
  useEffect(() => { const f = (r: Req) => setReq(r); subs.add(f); return () => { subs.delete(f); }; }, []);
  const open = !!req;
  useEffect(() => {
    if (!open) return;
    history.pushState({ fileViewer: 1 }, '');
    const pop = () => setReq(null);
    const k = (e: KeyboardEvent) => { if (e.key === 'Escape') close(); };
    addEventListener('popstate', pop); addEventListener('keydown', k);
    return () => { removeEventListener('popstate', pop); removeEventListener('keydown', k); };
  }, [open]);
  const close = () => { if (history.state?.fileViewer) history.back(); else setReq(null); };
  if (!req) return null;
  return <Viewer key={`${req.m.id}:${req.i}`} m={req.m} i={req.i} close={close} />;
}

function Viewer({ m, i, close }: Req & { close: () => void }) {
  const a = m.attachments[i];
  const url = attachmentUrl(m, i);
  const pdf = /pdf/i.test(a.mime) || /\.pdf$/i.test(a.name);
  const text = !pdf && a.size <= TEXT_MAX && (/^text\//i.test(a.mime) || /json|xml|csv|calendar|vcard/i.test(a.mime) || TEXT_EXT.test(a.name));
  const storage = useStorage();
  const sh = useShareFile(url, a.name, a.mime, a.size);
  const [body, setBody] = useState<string | null>(null);
  const [note, setNote] = useState('');
  const t = useRef(0);
  const flash = (s: string) => { setNote(s); clearTimeout(t.current); t.current = window.setTimeout(() => setNote(''), 2500); };
  useEffect(() => {
    if (!text) return;
    fetch(url).then((r) => (r.ok ? r.text() : Promise.reject())).then(setBody, () => setBody(''));
  }, [url]);
  const download = () => { const l = document.createElement('a'); l.href = attachmentUrl(m, i, true); l.download = a.name; l.click(); };
  const share = async () => {
    try { if (!(await sh.share())) { if (standalone) flash('Teilen ist hier nicht möglich'); else download(); } }
    catch (e: any) { flash(e?.message ?? 'Teilen fehlgeschlagen'); }
  };
  return (
    <div className="fileview">
      <div className="fileview-bar">
        <button className="icon-btn" onClick={close} aria-label="Zurück zum Chat" title="Zurück zum Chat"><Icon name="close" /></button>
        <div className="fileview-title"><b>{a.name}</b><small>{fileSize(a.size)}</small></div>
      </div>
      <div className="fileview-body">
        {pdf ? <iframe src={url} title={a.name} />
          : text ? <pre className="fileview-text">{body ?? 'Wird geladen …'}</pre>
          : <div className="fileview-info"><span className="att-file-icon big"><Icon name="file" size={40} /></span><b>{a.name}</b><small>{a.mime || 'Datei'} · {fileSize(a.size)}</small><small className="muted">Für diese Datei gibt es keine Vorschau. Über „Teilen“ kannst du sie in einer anderen App öffnen oder in Dateien sichern.</small></div>}
      </div>
      <div className="fileview-actions">
        {(sh.can || !standalone) && <button className="btn" onClick={share} disabled={!sh.ready}><Icon name="share" size={18} />{sh.ready ? (sh.can ? 'Teilen / Sichern' : 'Herunterladen') : 'Wird geladen …'}</button>}
        {storage?.nextcloud.enabled && <button className="btn" onClick={() => openSaveAs(m, i)}><Icon name="folder" size={18} />In Nextcloud speichern …</button>}
      </div>
      {note && <div className="toast">{note}</div>}
    </div>
  );
}
