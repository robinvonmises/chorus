import { useEffect, useRef, useState } from 'react';
import { Icon } from './Icon';
import { attachmentUrl, mailHtmlUrl, type Message } from '../api';
import { fileSize } from '../util';
import { useStorage } from '../storageState';
import { openSaveAs } from './NextcloudBrowser';
import { T } from '../i18n';

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
/** E-Mail im Original (HTML) ansehen */
export const openMail = (m: Message) => openFile(m, -1);

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
  if (req.i < 0) return <MailViewer key={req.m.id} m={req.m} close={close} />;
  return <Viewer key={`${req.m.id}:${req.i}`} m={req.m} i={req.i} close={close} />;
}

/** Original-Mail in einem iframe ohne Skripte; breite Layouts (600 px) werden auf die Bildschirmbreite verkleinert */
function MailViewer({ m, close }: { m: Message; close: () => void }) {
  const [html, setHtml] = useState<string | null>(null);
  const [err, setErr] = useState(false);
  const ref = useRef<HTMLIFrameElement>(null);
  useEffect(() => {
    fetch(mailHtmlUrl(m)).then((r) => (r.ok ? r.text() : Promise.reject())).then(setHtml, () => setErr(true));
  }, [m.id]);
  const fit = () => {
    const f = ref.current; const d = f?.contentDocument;
    if (!f || !d?.documentElement) return;
    const de = d.documentElement as HTMLElement;
    de.style.zoom = '';
    const w = f.clientWidth; const sw = de.scrollWidth;
    if (sw > w + 2) de.style.zoom = String(w / sw);
  };
  return (
    <div className="fileview">
      <div className="fileview-bar">
        <button className="icon-btn" onClick={close} aria-label={T('Zurück zum Chat')} title={T('Zurück zum Chat')}><Icon name="close" /></button>
        <div className="fileview-title"><b>{m.senderName}</b><small>{new Date(m.ts).toLocaleString()}</small></div>
      </div>
      <div className="fileview-body mail">
        {err ? <div className="fileview-info"><small className="muted">{T('Das Original dieser E-Mail ist nicht verfügbar.')}</small></div>
          : html === null ? <div className="fileview-info"><small className="muted">{T('Wird geladen …')}</small></div>
          : <iframe ref={ref} srcDoc={html} title="E-Mail" sandbox="allow-same-origin allow-popups allow-popups-to-escape-sandbox" onLoad={() => { fit(); setTimeout(fit, 400); }} />}
      </div>
    </div>
  );
}

/** PDF-Seiten mit pdf.js als Bilder: iOS zeigt PDFs in iframes oft gar nicht oder nur die erste Seite */
function PdfView({ url }: { url: string }) {
  const box = useRef<HTMLDivElement>(null);
  const [state, setState] = useState<'load' | 'ok' | 'err'>('load');
  const [pages, setPages] = useState(0);
  useEffect(() => {
    let off = false; let doc: any = null;
    (async () => {
      try {
        const [pdfjs, worker] = await Promise.all([import('pdfjs-dist/legacy/build/pdf.mjs'), import('pdfjs-dist/legacy/build/pdf.worker.min.mjs?url')]);
        pdfjs.GlobalWorkerOptions.workerSrc = worker.default;
        const data = await fetch(url).then((r) => (r.ok ? r.arrayBuffer() : Promise.reject(new Error(String(r.status)))));
        doc = await pdfjs.getDocument({ data }).promise;
        if (off) return;
        setPages(doc.numPages); setState('ok');
        const el = box.current!;
        const width = Math.max(200, el.clientWidth - 16);
        const dpr = Math.min(window.devicePixelRatio || 1, 3);
        for (let n = 1; n <= Math.min(doc.numPages, 50) && !off; n++) {
          const page = await doc.getPage(n);
          const base = page.getViewport({ scale: 1 });
          // Auflösung begrenzen: iOS verweigert sehr große Canvas-Flächen
          let scale = (width / base.width) * dpr;
          const px = base.width * base.height * scale * scale;
          if (px > 8e6) scale *= Math.sqrt(8e6 / px);
          const vp = page.getViewport({ scale });
          const c = document.createElement('canvas');
          c.width = Math.floor(vp.width); c.height = Math.floor(vp.height);
          c.style.width = `${width}px`; c.style.aspectRatio = `${vp.width} / ${vp.height}`;
          el.appendChild(c);
          await page.render({ canvas: c, viewport: vp }).promise;
          page.cleanup();
        }
      } catch { if (!off) setState('err'); }
    })();
    return () => { off = true; doc?.destroy?.(); };
  }, [url]);
  return (
    <div className="fileview-pdf" ref={box}>
      {state === 'load' && <div className="fileview-info"><small className="muted">{T('Wird geladen …')}</small></div>}
      {state === 'err' && <div className="fileview-info"><small className="muted">{T('Dieses PDF lässt sich hier nicht anzeigen. Über „Teilen“ kannst du es in einer anderen App öffnen.')}</small></div>}
      {pages > 50 && <small className="muted">{T('Es werden nur die ersten 50 Seiten gezeigt.')}</small>}
    </div>
  );
}

function Viewer({ m, i, close }: Req & { close: () => void }) {
  const a = m.attachments[i];
  const url = attachmentUrl(m, i);
  const pdf = /pdf/i.test(a.mime) || /\.pdf$/i.test(a.name);
  const image = !pdf && (/^image\/(jpe?g|png|gif|webp|avif|bmp|svg\+xml|heic|heif)$/i.test(a.mime) || /\.(jpe?g|png|gif|webp|avif|bmp|heic)$/i.test(a.name));
  const video = !pdf && !image && (/^video\//i.test(a.mime) || /\.(mp4|mov|m4v|webm)$/i.test(a.name));
  const audio = !pdf && !image && !video && (/^audio\//i.test(a.mime) || /\.(mp3|m4a|aac|wav|ogg|opus)$/i.test(a.name));
  const text = !pdf && !image && !video && !audio && a.size <= TEXT_MAX && (/^text\//i.test(a.mime) || /json|xml|csv|calendar|vcard/i.test(a.mime) || TEXT_EXT.test(a.name));
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
    try { if (!(await sh.share())) { if (standalone) flash(T('Teilen ist hier nicht möglich')); else download(); } }
    catch (e: any) { flash(e?.message ?? T('Teilen fehlgeschlagen')); }
  };
  return (
    <div className="fileview">
      <div className="fileview-bar">
        <button className="icon-btn" onClick={close} aria-label={T('Zurück zum Chat')} title={T('Zurück zum Chat')}><Icon name="close" /></button>
        <div className="fileview-title"><b>{a.name}</b><small>{fileSize(a.size)}</small></div>
      </div>
      <div className="fileview-body">
        {pdf ? <PdfView url={url} />
          : image ? <img className="fileview-img" src={url} alt={a.name} />
          : video ? <video className="fileview-media" src={url} controls playsInline preload="metadata" />
          : audio ? <div className="fileview-info"><span className="att-file-icon big"><Icon name="file" size={40} /></span><b>{a.name}</b><audio src={`${url}&play=1`} controls preload="metadata" /></div>
          : text ? <pre className="fileview-text">{body ?? T('Wird geladen …')}</pre>
          : <div className="fileview-info"><span className="att-file-icon big"><Icon name="file" size={40} /></span><b>{a.name}</b><small>{a.mime || T('Datei')} · {fileSize(a.size)}</small><small className="muted">{T(/(word|excel|powerpoint|officedocument|opendocument|msword|ms-excel|rtf)/i.test(a.mime) || /\.(docx?|xlsx?|pptx?|od[tsp]|rtf|pages|numbers|key)$/i.test(a.name) ? 'Office-Dateien kann Chorus nicht selbst anzeigen. Über „Teilen“ öffnest du sie z. B. in Word, Pages oder Dateien.' : 'Für diese Datei gibt es keine Vorschau. Über „Teilen“ kannst du sie in einer anderen App öffnen oder in Dateien sichern.')}</small></div>}
      </div>
      <div className="fileview-actions">
        {(sh.can || !standalone) && <button className="btn" onClick={share} disabled={!sh.ready}><Icon name="share" size={18} />{sh.ready ? (sh.can ? T('Teilen / Sichern') : 'Herunterladen') : T('Wird geladen …')}</button>}
        {storage?.nextcloud.enabled && <button className="btn" onClick={() => openSaveAs(m, i)}><Icon name="folder" size={18} />{T('In Nextcloud speichern …')}</button>}
      </div>
      {note && <div className="toast">{note}</div>}
    </div>
  );
}
