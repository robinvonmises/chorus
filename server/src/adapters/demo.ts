import type { Adapter, AdapterEvents, OutgoingFile } from '../types.js';
import type { AdapterFactory } from '../hub.js';

/** Demo-Messenger zum Ausprobieren der Oberfläche ohne echtes Konto (nur mit DEMO=1) */
export class DemoAdapter implements Adapter {
  readonly network = 'demo' as const;
  private n = 1000;
  private timers: NodeJS.Timeout[] = [];
  constructor(private ev: AdapterEvents) {}

  async start() {
    this.ev.status({ state: 'connected', self: '+49 170 0000000' });
    const now = Date.now();
    const chats = [
      { remoteId: 'anna', title: 'Anna Berger', kind: 'direct' as const },
      { remoteId: 'familie', title: 'Familie', kind: 'group' as const },
      { remoteId: 'tom', title: 'Tom', kind: 'direct' as const },
      { remoteId: 'verein', title: 'Laufgruppe Sonntag', kind: 'group' as const },
    ];
    const script: Record<string, [string, string, number][]> = {
      anna: [['Anna', 'Hey! Kommst du heute Abend noch vorbei?', 50], ['me', 'Ja, so gegen 19 Uhr 🙂', 48], ['Anna', 'Super, bring gern was zu trinken mit', 47]],
      familie: [['Mama', 'Wer kommt Sonntag zum Essen?', 300], ['Papa', 'Ich natürlich 😄', 290], ['Lena', 'Bin dabei, bringe Nachtisch mit', 200], ['me', 'Ich auch!', 120]],
      tom: [['Tom', 'Hast du die Unterlagen schon angeschaut?', 1500]],
      verein: [['Jonas', 'Treffpunkt wie immer 9 Uhr am Parkplatz', 3000], ['Sarah', '👍', 2900]],
    };
    for (const c of chats) {
      const msgs = script[c.remoteId];
      const last = msgs.at(-1)!;
      this.ev.chat({ ...c, lastTs: now - last[2] * 60_000, lastText: last[1], unread: last[0] === 'me' ? 0 : 1 });
      for (const [who, text, minAgo] of msgs) {
        this.ev.message({
          chatRemoteId: c.remoteId, remoteId: String(this.n++), senderId: who, senderName: who === 'me' ? 'Ich' : who,
          fromMe: who === 'me', ts: now - minAgo * 60_000, text, edited: false, deleted: false, attachments: [],
          status: who === 'me' ? 'read' : 'received', reactions: c.remoteId === 'familie' && text.startsWith('Bin dabei') ? [{ emoji: '❤️', senderId: 'Mama', fromMe: false }] : [],
        });
      }
    }
  }
  async stop() { this.timers.forEach(clearTimeout); }
  async input() {}
  private reply(chat: string, text: string) {
    this.timers.push(setTimeout(() => {
      this.ev.message({
        chatRemoteId: chat, remoteId: String(this.n++), senderId: chat, senderName: chat === 'anna' ? 'Anna' : chat === 'tom' ? 'Tom' : 'Lena',
        fromMe: false, ts: Date.now(), text, edited: false, deleted: false, attachments: [], status: 'received',
      });
    }, 1500));
  }
  async sendText(chat: string, text: string) {
    const id = String(this.n++);
    this.reply(chat, text.includes('?') ? 'Gute Frage, ich schau nach 🤔' : 'Alles klar 👍');
    return id;
  }
  async sendFile(chat: string, f: OutgoingFile) {
    this.reply(chat, f.voice ? 'Danke für die Sprachnachricht!' : 'Danke, hab die Datei bekommen');
    return String(this.n++);
  }
  async react() {}
  async edit() {}
  async delete() {}
  async markRead() {}
  async loadHistory() {}
  async fetchAttachment(): Promise<Buffer> { throw new Error('Keine Datei'); }
  async contactInfo(remote: string, kind: string) { return kind === "direct" ? { phone: "+49 170 " + (1000000 + remote.length * 12345), about: "Hey, ich nutze Chorus" } : { description: "Demo-Gruppe", members: 5 }; }
  async resync() {}
  async logout() {}
}

export const demoFactory: AdapterFactory = ({ events }) => new DemoAdapter(events);
