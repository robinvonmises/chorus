import { useEffect, useState } from 'react';
import { api, type Message, type NcListing } from '../api';
import { storageState } from '../storageState';
import { fileSize } from '../util';
import { Icon } from './Icon';
import { T } from '../i18n';

const LAST = 'inbox:ncFolder';
const startFolder = () => localStorage.getItem(LAST) ?? storageState.get()?.nextcloud.folder ?? '';
const join = (a: string, b: string) => (a ? `${a}/${b}` : b);

/** Nextcloud durchsuchen: „Speichern unter“ (Ordner + Name wählen) oder Dateien zum Anhängen auswählen */
export function NextcloudBrowser({ mode, initialName, onClose, onSave, onPick }: {
  mode: 'save' | 'pick'; initialName?: string; onClose: () => void;
  onSave?: (folder: string, name: string) => Promise<void>; onPick?: (files: File[]) => void;
}) {
  const [path, setPath] = useState(startFolder);
  const [list, setList] = useState<NcListing | null>(null);
  const [err, setErr] = useState('');
  const [name, setName] = useState(initialName ?? '');
  const [sel, setSel] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [newDir, setNewDir] = useState<string | null>(null);

  const load = (p: string) => {
    setList(null); setErr('');
    api.ncList(p).then((l) => { setList(l); setPath(l.path); }).catch((e: any) => {
      // gemerkter Ordner gibt es nicht mehr → oben anfangen
      if (p) { localStorage.removeItem(LAST); load(''); } else setErr(e.message ?? T('Fehler'));
    });
  };
  useEffect(() => { load(path); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const parts = path ? path.split('/') : [];
  const go = (p: string) => { setSel([]); load(p); };
  const mkdir = async () => {
    const n = newDir?.trim(); if (!n) return;
    try { const r = await api.ncMkdir(join(path, n)); setNewDir(null); go(r.path); } catch (e: any) { setErr(e.message ?? T('Fehler')); }
  };
  const save = async () => {
    if (!onSave || !name.trim()) return;
    setBusy(true); setErr('');
    try { localStorage.setItem(LAST, path); await onSave(path, name.trim()); onClose(); }
    catch (e: any) { setErr(e.message ?? T('Fehler')); setBusy(false); }
  };
  const pick = async () => {
    if (!onPick || !sel.length) return;
    setBusy(true); setErr('');
    try { const files = await Promise.all(sel.map((p) => api.ncFile(p))); localStorage.setItem(LAST, path); onPick(files); onClose(); }
    catch (e: any) { setErr(e.message ?? T('Fehler')); setBusy(false); }
  };

  return (
    <div className="modal-bg nc-top" onClick={onClose}>
      <div className="modal nc-sheet" onClick={(e) => e.stopPropagation()} role="dialog" aria-label="Nextcloud">
        <header className="modal-head"><h2>{mode === 'save' ? T('In Nextcloud speichern') : T('Aus Nextcloud anhängen')}</h2><button className="icon-btn" onClick={onClose} aria-label={T('Schließen')}><Icon name="close" /></button></header>
        <div className="modal-body">
          <nav className="nc-crumbs">
            <button onClick={() => go('')}>{T('Nextcloud')}</button>
            {parts.map((p, k) => <span key={k}><span className="muted">/</span><button onClick={() => go(parts.slice(0, k + 1).join('/'))}>{p}</button></span>)}
          </nav>
          <ul className="nc-list">
            {parts.length > 0 && <li><button onClick={() => go(parts.slice(0, -1).join('/'))}><Icon name="back" size={18} /><b>{T('Zurück')}</b></button></li>}
            {list?.folders.map((f) => <li key={'d' + f}><button onClick={() => go(join(path, f))}><Icon name="folder" size={18} /><b>{f}</b><Icon name="chevron" size={16} /></button></li>)}
            {list?.files.map((f) => {
              const p = join(path, f.name), on = sel.includes(p);
              return mode === 'pick'
                ? <li key={'f' + f.name}><button className={on ? 'on' : ''} onClick={() => setSel((s) => (on ? s.filter((x) => x !== p) : [...s, p]))}><Icon name={on ? 'check' : 'file'} size={18} /><b>{f.name}</b><small>{fileSize(f.size)}</small></button></li>
                : <li key={'f' + f.name} className="nc-file" onClick={() => setName(f.name)}><Icon name="file" size={18} /><b>{f.name}</b><small>{fileSize(f.size)}</small></li>;
            })}
            {list && !list.folders.length && !list.files.length && <li className="muted small nc-empty">{T('Leerer Ordner')}</li>}
            {!list && !err && <li className="muted small nc-empty">{T('Lädt …')}</li>}
          </ul>
          {newDir !== null
            ? <div className="row"><input className="input" autoFocus autoComplete="off" placeholder={T('Name des Ordners')} value={newDir} onChange={(e) => setNewDir(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') void mkdir(); }} /><button className="btn" disabled={!newDir.trim()} onClick={() => void mkdir()}>{T('Anlegen')}</button></div>
            : <button className="btn ghost small" onClick={() => setNewDir('')}><Icon name="plus" size={16} /> {T('Neuer Ordner')}</button>}
          {err && <p className="muted small">{err}</p>}
          {mode === 'save'
            ? <>
                <input className="input" autoComplete="off" placeholder={T("Dateiname")} value={name} onChange={(e) => setName(e.target.value)} />
                <button className="btn primary" disabled={busy || !list || !name.trim()} onClick={() => void save()}><Icon name="check" size={18} />{busy ? T('Wird gespeichert …') : T('In „{0}“ speichern', parts[parts.length - 1] ?? 'Nextcloud')}</button>
              </>
            : <button className="btn primary" disabled={busy || !sel.length} onClick={() => void pick()}><Icon name="attach" size={18} />{busy ? T('Wird geladen …') : sel.length > 1 ? T('{0} Dateien anhängen', sel.length) : T('Anhängen')}</button>}
        </div>
      </div>
    </div>
  );
}

/** „Speichern unter“ von überall öffnen (Vollbild, Langdruck-Menü), Ergebnis als kurze Meldung */
type SaveReq = { m: Message; i: number };
const subs = new Set<(r: SaveReq) => void>();
export const openSaveAs = (m: Message, i: number) => subs.forEach((f) => f({ m, i }));
export function SaveAsHost() {
  const [req, setReq] = useState<SaveReq | null>(null);
  const [note, setNote] = useState('');
  useEffect(() => { const f = (r: SaveReq) => setReq(r); subs.add(f); return () => { subs.delete(f); }; }, []);
  return <>
    {req && <NextcloudBrowser mode="save" initialName={req.m.attachments[req.i]?.name} onClose={() => setReq(null)}
      onSave={async (folder, name) => { const r = await api.saveTo(req.m, req.i, 'nextcloud', { folder, name }); setNote(r.message); setTimeout(() => setNote(''), 2500); }} />}
    {note && <div className="toast nc-toast">{note}</div>}
  </>;
}
