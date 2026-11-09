import { useEffect, useState } from 'react';
import { api } from '../api';
import { Icon } from './Icon';

/** Sicherung: alle Chats als HTML mit Medien herunterladen, Medien automatisch speichern */
export function BackupSection() {
  const [auto, setAuto] = useState<boolean | null>(null);
  const [started, setStarted] = useState(false);
  useEffect(() => { api.media().then((r) => setAuto(r.autoSave)).catch(() => {}); }, []);
  return (
    <section className="set-section">
      <h3>Sicherung</h3>
      <small className="muted">Lädt alle Chats als ZIP herunter: eine schöne HTML-Seite pro Chat, dazu alle Bilder, Videos und Sprachnachrichten. Lässt sich in jedem Browser öffnen, auch ohne Chorus.</small>
      <a className="btn" href="/api/export" download onClick={() => setStarted(true)}><Icon name="download" size={18} /> Alle Chats herunterladen</a>
      {started && <small className="muted">Der Export wird erstellt. Bei vielen Medien dauert es einen Moment, bis der Download startet.</small>}
      {auto !== null && (
        <label className="toggle">
          <input type="checkbox" checked={auto} onChange={async (e) => setAuto((await api.setMedia(e.target.checked)).autoSave)} />
          <span><b>Medien automatisch speichern</b><small>Neue Bilder, Videos und Sprachnachrichten sofort verschlüsselt auf dem Server ablegen. Messenger halten Anhänge nur begrenzt bereit, ohne diese Option fehlen sie später in der Sicherung.</small></span>
        </label>
      )}
      <small className="muted">Hinweis: Chorus ist bei Signal und WhatsApp ein verknüpftes Gerät und kennt Nachrichten erst ab der Kopplung (WhatsApp überträgt dabei einen Teil der letzten Chats). Ältere Verläufe stehen nur auf dem Handy.</small>
    </section>
  );
}
