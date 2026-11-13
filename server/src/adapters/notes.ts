import { randomUUID } from 'node:crypto';
import type { Adapter, AdapterEvents } from '../types.js';
import type { AdapterFactory } from '../hub.js';

/** Kennung des einen Chats „Notizen an mich“ */
export const NOTES_REMOTE = 'self';

/**
 * „Notizen an mich“: ein Chat, der nur auf dem eigenen Server liegt.
 * Senden heißt speichern; alle Geräte bekommen die Notiz live über die normale Verbindung.
 * Bearbeiten, Reagieren und Löschen erledigt die Zentrale lokal, hier ist nichts weiter zu tun.
 */
export class NotesAdapter implements Adapter {
  readonly network = 'notes' as const;
  constructor(private ev: AdapterEvents, private title: string) {}
  async start() {
    this.ev.status({ state: 'connected' });
    this.ev.chat({ remoteId: NOTES_REMOTE, title: this.title, kind: 'direct', lastTs: 0, lastText: '' });
  }
  async stop() {}
  async input() {}
  async sendText() { return 'n' + randomUUID(); }
  async sendFile() { return 'n' + randomUUID(); }
  async react() {}
  async edit() {}
  async delete() {}
  async markRead() {}
  async loadHistory() {}
  async fetchAttachment(): Promise<Buffer> { throw new Error('Anhang ist nicht mehr vorhanden'); }
  async logout() {}
}

export const notesFactory: AdapterFactory = ({ events, config }) => new NotesAdapter(events, String(config.title || 'Notizen an mich'));
