import type { Adapter, AdapterEvents, OutgoingFile } from '../types.js';
import type { AdapterFactory } from '../hub.js';
import { deflateSync } from 'node:zlib';

/** Einfarbiges PNG in gewünschter Größe (für Demo-Bilder) */
function demoPng(w: number, h: number, rgb: [number, number, number]): Buffer {
  const crcT = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
  const crc = (b: Buffer) => { let c = 0xffffffff; for (const x of b) c = crcT[(c ^ x) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const chunk = (t: string, d: Buffer) => { const len = Buffer.alloc(4); len.writeUInt32BE(d.length); const td = Buffer.concat([Buffer.from(t), d]); const c = Buffer.alloc(4); c.writeUInt32BE(crc(td)); return Buffer.concat([len, td, c]); };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
  const row = Buffer.concat([Buffer.from([0]), Buffer.concat(Array.from({ length: w }, () => Buffer.from(rgb)))]);
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(Buffer.concat(Array.from({ length: h }, () => row)))), chunk('IEND', Buffer.alloc(0))]);
}

/** Demo-Messenger zum Ausprobieren der Oberfläche ohne echtes Konto (nur mit DEMO=1) */
export class DemoAdapter implements Adapter {
  readonly network = 'demo' as const;
  private n = 1000;
  /** Neue Nachrichten brauchen IDs, die auch nach einem Neustart frei sind (die Startnachrichten zählen ab 1000) */
  private uid() { return `d${Date.now().toString(36)}${(this.n++).toString(36)}`; }
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
      { remoteId: 'emma', title: 'Emma (London)', kind: 'direct' as const },
      { remoteId: 'bram', title: 'Bram (Utrecht)', kind: 'direct' as const },
    ];
    const script: Record<string, [string, string, number][]> = {
      anna: [['Anna', 'Hey! Kommst du heute Abend noch vorbei?', 50], ['me', 'Ja, so gegen 19 Uhr 🙂', 48], ['Anna', 'Super, bring gern was zu trinken mit', 47]],
      familie: [['Mama', 'Wer kommt Sonntag zum Essen?', 300], ['Papa', 'Ich natürlich 😄', 290], ['Lena', 'Bin dabei, bringe Nachtisch mit', 200], ['me', 'Ich auch!', 120]],
      tom: [['Tom', 'Hast du die Unterlagen schon angeschaut?', 1500]],
      verein: [['Jonas', 'Treffpunkt wie immer 9 Uhr am Parkplatz', 3000], ['Sarah', '👍', 2900]],
      emma: [['Emma', 'Hi! Are you still coming to London next month?', 4000], ['Emma', 'Let me know your dates, you can stay with us 😊', 3990]],
      bram: [['me', 'Hoi Bram, stuur me even een berichtje als je tijd hebt 😅', 5]],
    };
    // DEMO_BULK=1: viele Chats und ein langer Verlauf, um zu messen, wie flüssig die Oberfläche bleibt
    if (process.env.DEMO_BULK) {
      const words = ['Klar', 'bis später', 'ich schau mal', 'das klingt gut', 'meld dich einfach', 'wie besprochen', 'haha 😄', 'ok', 'danke dir!', 'passt für mich'];
      const line = (i: number) => Array.from({ length: 1 + (i * 7) % 9 }, (_, k) => words[(i + k * 3) % words.length]).join(', ');
      script.anna = [...Array.from({ length: 600 }, (_, i): [string, string, number] => [i % 3 ? 'Anna' : 'me', line(i), 5000 - i * 8]), ...script.anna];
      for (let i = 0; i < 150; i++) {
        chats.push({ remoteId: `bulk${i}`, title: `Kontakt ${i + 1}`, kind: 'direct' as const });
        script[`bulk${i}`] = [[`Kontakt ${i + 1}`, line(i), 6000 + i * 30]];
      }
    }
    for (const c of chats) {
      const msgs = script[c.remoteId];
      const last = msgs.at(-1)!;
      this.ev.chat({ ...c, lastTs: now - last[2] * 60_000, lastText: last[1], unread: last[0] === 'me' ? 0 : 1 });
      for (const [who, text, minAgo] of msgs) {
        // Im Messmodus trägt jede 15. Nachricht ein Bild (abwechselnd mit und ohne bekannte Größe)
        const k = this.n - 1000;
        const pic = process.env.DEMO_BULK && c.remoteId === 'anna' && k % 15 === 7;
        const [w, h] = k % 2 ? [900, 1200] : [1200, 800];
        this.ev.message({
          chatRemoteId: c.remoteId, remoteId: String(this.n++), senderId: who, senderName: who === 'me' ? 'Ich' : who,
          fromMe: who === 'me', ts: now - minAgo * 60_000, text, edited: false, deleted: false,
          attachments: pic ? [{ fileId: null, name: `bild-${k}.png`, mime: 'image/png', size: 0, kind: 'image', ...(k % 30 === 7 ? {} : { width: w, height: h }), remoteRef: `${w}x${h}` }] : [],
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
        chatRemoteId: chat, remoteId: this.uid(), senderId: chat, senderName: chat === 'anna' ? 'Anna' : chat === 'tom' ? 'Tom' : chat === 'emma' ? 'Emma' : chat === 'bram' ? 'Bram' : 'Lena',
        fromMe: false, ts: Date.now(), text, edited: false, deleted: false, attachments: [], status: 'received',
      });
    }, 1500));
  }
  async sendText(chat: string, text: string) {
    const id = this.uid();
    this.reply(chat, chat === 'bram' ? 'Hoi! Alles goed hier, en met jou?' : chat === 'emma' ? (text.includes('?') ? 'Good question, let me check 🤔' : 'Sounds great, see you soon!') : text.includes('?') ? 'Gute Frage, ich schau nach 🤔' : 'Alles klar 👍');
    return id;
  }
  async sendFile(chat: string, f: OutgoingFile) {
    this.reply(chat, f.voice ? 'Danke für die Sprachnachricht!' : 'Danke, hab die Datei bekommen');
    return this.uid();
  }
  async react() {}
  async edit() {}
  async delete() {}
  async markRead() {}
  async loadHistory() {}
  async fetchAttachment(_c: string, _r: string, _i: number, att?: { remoteRef?: string }): Promise<Buffer> {
    const m = /^(\d+)x(\d+)$/.exec(att?.remoteRef ?? '');
    if (!m) throw new Error('Keine Datei');
    await new Promise((r) => setTimeout(r, 150));
    return demoPng(Number(m[1]), Number(m[2]), [96 + (Number(m[1]) % 90), 140, 200]);
  }
  async contactInfo(remote: string, kind: string) { return kind === "direct" ? { phone: remote === "bram" ? "+31 6 12345678" : "+49 170 " + (1000000 + remote.length * 12345), about: "Hey, ich nutze Chorus" } : { description: "Demo-Gruppe", members: 5 }; }
  async resync() {}
  async logout() {}
}

export const demoFactory: AdapterFactory = ({ events }) => new DemoAdapter(events);
