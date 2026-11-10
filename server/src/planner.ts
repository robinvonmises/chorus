import { randomUUID } from 'node:crypto';
import type { Hub } from './hub.js';

/** Geplante Dinge: zeitversetzt senden und Erinnerungen an Nachrichten */
export type Planned = {
  id: string; kind: 'send' | 'remind'; chatId: string; at: number; created: number;
  text: string;               // send: zu sendender Text; remind: Vorschau der Nachricht
  replyTo?: string | null;    // send: Antwort auf (remoteId)
  translate?: boolean;        // send: mit Live-Übersetzung senden
  messageId?: string | null;  // remind: Nachricht, an die erinnert wird
  note?: string;              // remind: eigene Notiz
  error?: string;             // send: letzter Fehler
  retryAt?: number;           // send: nächster Versuch nach einem Fehler
};

const KEY = 'planned';

export class Planner {
  private timer: NodeJS.Timeout;
  private running = false;

  constructor(private hub: Hub, private notify: (title: string, body: string, chatId: string) => void,
    private sendFn?: (p: Planned) => Promise<void>) {
    this.timer = setInterval(() => void this.tick(), 15_000);
    setTimeout(() => void this.tick(), 5_000);
  }
  stop() { clearInterval(this.timer); }
  setSender(fn: (p: Planned) => Promise<void>) { this.sendFn = fn; }

  list(): Planned[] { return this.hub.store.getSetting<Planned[]>(KEY, []).sort((a, b) => a.at - b.at); }
  private save(items: Planned[]) { this.hub.store.setSetting(KEY, items); this.hub.emit({ type: 'planned', items: this.list() }); }

  add(p: Omit<Planned, 'id' | 'created'>): Planned {
    if (!this.hub.store.getChat(p.chatId)) throw Object.assign(new Error('Chat nicht gefunden'), { statusCode: 404 });
    if (!(p.at > Date.now() - 60_000)) throw Object.assign(new Error('Der Zeitpunkt liegt in der Vergangenheit.'), { statusCode: 400 });
    const item: Planned = { ...p, id: randomUUID().slice(0, 12), created: Date.now() };
    this.save([...this.list(), item].slice(-500));
    return item;
  }
  update(id: string, patch: Partial<Pick<Planned, 'at' | 'text' | 'note'>>) {
    const items = this.list();
    const it = items.find((x) => x.id === id);
    if (!it) throw Object.assign(new Error('Nicht gefunden'), { statusCode: 404 });
    Object.assign(it, patch, { error: undefined, retryAt: undefined });
    this.save(items);
    return it;
  }
  remove(id: string) { this.save(this.list().filter((x) => x.id !== id)); }

  private async tick() {
    if (this.running) return;
    this.running = true;
    try {
      const now = Date.now();
      for (const it of this.list().filter((x) => (x.retryAt ?? x.at) <= now && !x.error)) {
        if (it.kind === 'remind') {
          this.remove(it.id);
          const chat = this.hub.store.getChat(it.chatId);
          this.hub.emit({ type: 'reminder', item: it, chat });
          this.notify(`⏰ ${chat?.title ?? 'Erinnerung'}`, it.note ? `${it.note}: ${it.text}` : it.text || 'Erinnerung', it.chatId);
        } else {
          try {
            if (!this.sendFn) throw new Error('Senden nicht bereit');
            await this.sendFn(it);
            this.remove(it.id);
          } catch (e: any) {
            // Nicht verbunden o. Ä.: nach 2 Minuten erneut versuchen, nach 6 Stunden aufgeben und anzeigen
            const items = this.list(); const x = items.find((y) => y.id === it.id);
            if (!x) continue;
            if (now - x.at > 6 * 3600_000) x.error = String(e?.message ?? e);
            else x.retryAt = now + 120_000;
            this.save(items);
            console.warn('[planner] Senden fehlgeschlagen:', e?.message ?? e);
          }
        }
      }
    } finally { this.running = false; }
  }
}
