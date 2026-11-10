import type { Hub } from './hub.js';
import type { Ai } from './ai.js';
import type { Chat, Message } from './types.js';

/**
 * Live-Übersetzung: Eingehende Nachrichten in freigegebenen Chats werden ins Deutsche übersetzt
 * und unter der Blase gezeigt. Dabei wird die Sprache des Chatpartners erkannt und gemerkt,
 * damit eigene Nachrichten beim Senden in diese Sprache übersetzt werden können.
 */
export class Translator {
  private timers = new Map<string, NodeJS.Timeout>();
  private busy = new Set<string>();

  constructor(private hub: Hub, private ai: Ai) {
    hub.incoming.add((chat, msg) => this.onIncoming(chat, msg));
  }

  private active(chat: Chat | null): chat is Chat {
    return !!chat?.translate?.on && !!chat.aiEnabled && this.ai.publicSettings().features.text;
  }

  private onIncoming(chat: Chat, msg: Message) {
    if (!this.active(chat) || !(msg.text || msg.transcript)) return;
    // Kurz sammeln, damit mehrere Nachrichten am Stück in einem Aufruf übersetzt werden
    clearTimeout(this.timers.get(chat.id));
    this.timers.set(chat.id, setTimeout(() => void this.run(chat.id, 10), 1200));
  }

  /** Offene Nachrichten eines Chats übersetzen (auch beim Einschalten für die letzten Nachrichten) */
  async run(chatId: string, limit: number) {
    this.timers.delete(chatId);
    if (this.busy.has(chatId)) { this.timers.set(chatId, setTimeout(() => void this.run(chatId, limit), 3000)); return; }
    const store = this.hub.store;
    if (!this.active(store.getChat(chatId))) return;
    const msgs = store.untranslated(chatId, limit);
    if (!msgs.length) return;
    this.busy.add(chatId);
    try {
      const res = await this.ai.translateIn(msgs.map((m) => ({ id: m.id, text: [m.text, m.transcript].filter(Boolean).join('\n') })));
      const langs = new Map<string, { lang: string; langName: string; n: number }>();
      for (const r of res) {
        const m = msgs.find((x) => x.id === r.id);
        if (!m) continue;
        // Leere Zeichenkette = geprüft, keine Übersetzung nötig (z. B. schon Deutsch)
        const upd = store.patchMessage(m.id, { translation: r.translation ?? '' });
        if (upd) this.hub.emit({ type: 'message', message: upd });
        if (r.lang && r.lang !== 'de' && r.langName) {
          const e = langs.get(r.lang) ?? { lang: r.lang, langName: r.langName, n: 0 }; e.n++; langs.set(r.lang, e);
        }
      }
      const top = [...langs.values()].sort((a, b) => b.n - a.n)[0];
      const chat = store.getChat(chatId);
      if (top && chat?.translate && chat.translate.lang !== top.lang) {
        store.setTranslate(chatId, { ...chat.translate, lang: top.lang, langName: top.langName });
        this.hub.emit({ type: 'chat', chat: store.getChat(chatId)! });
      }
    } catch (e: any) {
      console.warn('[translate]', e?.message ?? e);
    } finally { this.busy.delete(chatId); }
  }
}
