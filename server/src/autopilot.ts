import type { Hub } from './hub.js';
import type { Ai } from './ai.js';
import type { Autopilot, Chat, Message } from './types.js';

const DEBOUNCE_MS = Number(process.env.AUTOPILOT_DELAY_MS ?? 20_000);

/**
 * Autopilot: Claude antwortet in freigegebenen Chats selbst, höchstens `max` Mal.
 * In Gruppen nur, wenn jemand eine Frage stellt, den Nutzer erwähnt oder direkt auf ihn antwortet.
 * Kurz warten, damit mehrere Nachrichten am Stück nur eine Antwort auslösen.
 */
export class AutopilotRunner {
  private timers = new Map<string, NodeJS.Timeout>();
  private busy = new Set<string>();

  constructor(private hub: Hub, private ai: Ai) {
    hub.incoming.add((chat, msg) => this.onIncoming(chat, msg));
  }

  /** Gruppe: Frage, Erwähnung (Nummer/@Name) oder Antwort auf eine eigene Nachricht */
  private concernsMe(chat: Chat, msg: Message): boolean {
    const t = msg.text ?? '';
    if (t.includes('?')) return true;
    if (msg.replyToRemoteId && this.hub.store.getMessage(`${chat.id}:${msg.replyToRemoteId}`)?.fromMe) return true;
    const self = this.hub.selfOf(chat.accountId)?.replace(/[^\d]/g, '');
    if (self && self.length > 6 && t.replace(/[\s+]/g, '').includes(self.slice(-9))) return true;
    return false;
  }

  private onIncoming(chat: Chat, msg: Message) {
    const a = chat.autopilot;
    if (!a?.on || !chat.aiEnabled || chat.kind === 'channel' || a.used >= a.max) return;
    if (chat.kind === 'group' && !this.concernsMe(chat, msg)) return;
    clearTimeout(this.timers.get(chat.id));
    this.timers.set(chat.id, setTimeout(() => this.reply(chat.id), DEBOUNCE_MS));
  }

  private async reply(chatId: string) {
    this.timers.delete(chatId);
    if (this.busy.has(chatId)) return;
    this.busy.add(chatId);
    try {
      const chat = this.hub.store.getChat(chatId);
      const a = chat?.autopilot;
      if (!chat || !a?.on || !chat.aiEnabled || a.used >= a.max) return;
      const text = await this.ai.autoReply(chatId, a.note, a.max - a.used);
      if (!text) return;
      // Kennzeichnung: 🤖 als Reaktion auf die eigene Nachricht; Telegram erlaubt 🤖 nicht als Reaktion, dort „– 🤖“ anhängen
      const suffix = a.mark && chat.network === 'telegram';
      const sent = await this.hub.sendText(chatId, suffix ? `${text} – 🤖` : text);
      if (a.mark && !suffix) await this.hub.markBot(sent);
      const used = a.used + 1;
      this.set(chatId, { ...a, used, on: used < a.max });
    } catch (e: any) {
      console.error('[autopilot]', chatId, e?.message ?? e);
    } finally {
      this.busy.delete(chatId);
    }
  }

  set(chatId: string, a: Autopilot | null) {
    if (!a?.on) { clearTimeout(this.timers.get(chatId)); this.timers.delete(chatId); }
    this.hub.store.setAutopilot(chatId, a);
    return this.hub.emitChat(chatId);
  }

  stop() { for (const t of this.timers.values()) clearTimeout(t); this.timers.clear(); }
}
