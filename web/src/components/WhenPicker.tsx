import { useMemo, useState } from 'react';
import { Icon } from './Icon';

const pad = (n: number) => String(n).padStart(2, '0');
const localInput = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
export const whenLabel = (ts: number) => {
  const d = new Date(ts), now = new Date();
  const tomorrow = new Date(now); tomorrow.setDate(now.getDate() + 1);
  const time = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  if (d.toDateString() === now.toDateString()) return `heute ${time}`;
  if (d.toDateString() === tomorrow.toDateString()) return `morgen ${time}`;
  return d.toLocaleDateString('de-DE', { weekday: 'short', day: 'numeric', month: 'numeric' }) + ` ${time}`;
};

/** Zeitpunkt wählen: schnelle Vorschläge oder eigenes Datum mit Uhrzeit */
export function WhenPicker({ title, hint, onPick, onClose, confirm }: {
  title: string; hint?: string; confirm: string; onPick: (ts: number) => void; onClose: () => void;
}) {
  const quick = useMemo(() => {
    const now = new Date();
    const at = (days: number, h: number, m = 0) => { const d = new Date(now); d.setDate(d.getDate() + days); d.setHours(h, m, 0, 0); return d.getTime(); };
    const list: { label: string; ts: number }[] = [
      { label: 'In 1 Stunde', ts: Date.now() + 3600_000 },
      { label: 'In 3 Stunden', ts: Date.now() + 3 * 3600_000 },
    ];
    if (now.getHours() < 18) list.push({ label: 'Heute Abend', ts: at(0, 19) });
    list.push({ label: 'Morgen früh', ts: at(1, 8) });
    list.push({ label: 'Morgen Abend', ts: at(1, 19) });
    const toMon = ((8 - now.getDay()) % 7) || 7;
    list.push({ label: 'Nächste Woche', ts: at(toMon, 8) });
    return list;
  }, []);
  const [custom, setCustom] = useState(() => localInput(new Date(Date.now() + 3600_000)));
  const customTs = new Date(custom).getTime();
  const valid = !Number.isNaN(customTs) && customTs > Date.now();
  return (
    <div className="modal-bg" onClick={onClose}>
      <div className="modal when-sheet" onClick={(e) => e.stopPropagation()} role="dialog" aria-label={title}>
        <header className="modal-head"><h2>{title}</h2><button className="icon-btn" onClick={onClose} aria-label="Schließen"><Icon name="close" /></button></header>
        <div className="modal-body">
        {hint && <p className="muted when-hint">{hint}</p>}
        <div className="when-quick">
          {quick.map((q) => (
            <button key={q.label} onClick={() => onPick(q.ts)}><b>{q.label}</b><span>{whenLabel(q.ts)}</span></button>
          ))}
        </div>
        <label className="when-custom">
          <span>Eigene Zeit</span>
          <input type="datetime-local" value={custom} min={localInput(new Date())} onChange={(e) => setCustom(e.target.value)} />
        </label>
        <button className="btn primary block" disabled={!valid} onClick={() => valid && onPick(customTs)}>{confirm} · {valid ? whenLabel(customTs) : 'Zeit wählen'}</button>
        </div>
      </div>
    </div>
  );
}
