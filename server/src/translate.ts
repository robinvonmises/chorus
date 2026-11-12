import type { Hub } from './hub.js';
import type { Ai } from './ai.js';
import type { Chat, Message } from './types.js';

/** Ländervorwahl → Sprache, als Vorschlag, solange das Gegenüber noch nichts geschrieben hat.
 *  Länder mit mehreren Landessprachen (z. B. Belgien, Schweiz) bleiben bewusst weg. */
const PREFIX_LANG: [string, string, string][] = [
  ['31', 'nl', 'Niederländisch'], ['33', 'fr', 'Französisch'], ['34', 'es', 'Spanisch'], ['39', 'it', 'Italienisch'],
  ['44', 'en', 'Englisch'], ['353', 'en', 'Englisch'], ['1', 'en', 'Englisch'], ['61', 'en', 'Englisch'], ['64', 'en', 'Englisch'],
  ['48', 'pl', 'Polnisch'], ['90', 'tr', 'Türkisch'], ['351', 'pt', 'Portugiesisch'], ['55', 'pt', 'Portugiesisch'],
  ['380', 'uk', 'Ukrainisch'], ['7', 'ru', 'Russisch'], ['45', 'da', 'Dänisch'], ['46', 'sv', 'Schwedisch'], ['47', 'no', 'Norwegisch'],
  ['358', 'fi', 'Finnisch'], ['30', 'el', 'Griechisch'], ['420', 'cs', 'Tschechisch'], ['36', 'hu', 'Ungarisch'], ['40', 'ro', 'Rumänisch'],
  ['385', 'hr', 'Kroatisch'], ['421', 'sk', 'Slowakisch'], ['386', 'sl', 'Slowenisch'],
];
export function guessLang(chat: Chat): { lang: string; langName: string } | null {
  if (chat.kind !== 'direct') return null;
  // WhatsApp-„@lid“-Kennungen sehen aus wie Nummern, sind aber keine
  const raw = chat.info?.phone ?? (chat.network !== 'telegram' && !chat.remoteId.endsWith('@lid') ? chat.remoteId : '');
  const n = String(raw ?? '').split('@')[0].replace(/^00/, '+');
  if (!/^\+?\d{8,15}$/.test(n.replace(/[\s()-]/g, ''))) return null;
  const d = n.replace(/\D/g, '');
  // Längste passende Vorwahl zuerst
  const hit = [...PREFIX_LANG].sort((a, b) => b[0].length - a[0].length).find(([p]) => d.startsWith(p));
  return hit ? { lang: hit[1], langName: hit[2] } : null;
}

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
    hub.own.add((chat, msg) => this.onIncoming(chat, msg));
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
      // Sprache des Gegenübers zählt zuerst. Eigene fremdsprachige Nachrichten nur, wenn er (in diesem Schub) nichts Fremdes schrieb.
      const theirs = new Map<string, { lang: string; langName: string; n: number }>();
      const mine = new Map<string, { lang: string; langName: string; n: number }>();
      for (const r of res) {
        const m = msgs.find((x) => x.id === r.id);
        if (!m) continue;
        // Inzwischen anders belegt (z. B. eigene Nachricht wurde übersetzt gesendet): nicht überschreiben
        if (store.getMessage(m.id)?.translation != null) continue;
        // Leere Zeichenkette = geprüft, keine Übersetzung nötig (z. B. schon Deutsch)
        const upd = store.patchMessage(m.id, { translation: r.translation ?? '', translationFrom: r.translation ? r.langName || null : null });
        if (upd) this.hub.emit({ type: 'message', message: upd });
        if (r.lang && r.lang !== this.ai.lang && r.langName) {
          const map = m.fromMe ? mine : theirs;
          const e = map.get(r.lang) ?? { lang: r.lang, langName: r.langName, n: 0 }; e.n++; map.set(r.lang, e);
        }
      }
      const top = [...(theirs.size ? theirs : mine).values()].sort((a, b) => b.n - a.n)[0];
      const chat = store.getChat(chatId);
      if (top && chat?.translate && !chat.translate.fixed && chat.translate.lang !== top.lang) {
        store.setTranslate(chatId, { ...chat.translate, lang: top.lang, langName: top.langName });
        this.hub.emit({ type: 'chat', chat: store.getChat(chatId)! });
      }
    } catch (e: any) {
      console.warn('[translate]', e?.message ?? e);
    } finally { this.busy.delete(chatId); }
  }
}
