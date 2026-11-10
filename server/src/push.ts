import webpush from 'web-push';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Store } from './db.js';
import type { Chat, Message } from './types.js';
import { previewText } from './hub.js';

const host = (u: string) => { try { return new URL(u).host; } catch { return '?'; } };

type Sub = { endpoint: string; keys: { p256dh: string; auth: string }; ua?: string; created: number };

/**
 * Echte Push-Benachrichtigungen (Web Push mit VAPID): kommen auch an, wenn Chorus geschlossen ist
 * (iPhone: nur als installierte App vom Home-Bildschirm). Die Inhalte sind Ende-zu-Ende verschlüsselt
 * bis zum Gerät; Apple/Google sehen sie nicht.
 */
export class Push {
  readonly publicKey: string;
  constructor(dataDir: string) {
    const f = join(dataDir, 'vapid.json');
    let k: { publicKey: string; privateKey: string };
    if (existsSync(f)) k = JSON.parse(readFileSync(f, 'utf8'));
    else { k = webpush.generateVAPIDKeys(); writeFileSync(f, JSON.stringify(k), { mode: 0o600 }); }
    this.publicKey = k.publicKey;
    webpush.setVapidDetails(process.env.PUSH_SUBJECT ?? 'mailto:chorus@example.com', k.publicKey, k.privateKey);
  }

  subs(store: Store): Sub[] { return store.getSetting<Sub[]>('pushSubs', []); }
  add(store: Store, s: Sub) {
    if (!this.subs(store).some((x) => x.endpoint === s.endpoint)) console.log('[push] neues Gerät angemeldet', host(s.endpoint));
    store.setSetting('pushSubs', [...this.subs(store).filter((x) => x.endpoint !== s.endpoint), s].slice(-20)); }
  remove(store: Store, endpoint: string) { store.setSetting('pushSubs', this.subs(store).filter((x) => x.endpoint !== endpoint)); }
  preview(store: Store): boolean { return store.getSetting('pushPreview', true); }
  /** iOS hängt an jeden Titel „from Chorus“ an. Ohne Titel steht der Absender stattdessen vorne im Text. */
  noTitle(store: Store): boolean { return store.getSetting('pushNoTitle', false); }
  /** Titel und Text passend zur Einstellung: ohne Titel wird „Titel: Text“ zum Text. */
  shape(store: Store, title: string, body: string) {
    return this.noTitle(store) ? { title: '', body: title ? `${title}: ${body}` : body } : { title, body };
  }

  async send(store: Store, payload: Record<string, unknown>, only?: string) {
    let ok = 0, gone = 0, fail = 0;
    for (const s of this.subs(store)) {
      if (only && s.endpoint !== only) continue;
      try { await webpush.sendNotification(s, JSON.stringify(payload), { TTL: 6 * 3600, urgency: 'high' }); ok++; }
      catch (e: any) {
        if (e?.statusCode === 404 || e?.statusCode === 410) { gone++; this.remove(store, s.endpoint); } // abgemeldet/abgelaufen
        else { fail++; console.warn('[push] Fehler', host(s.endpoint), e?.statusCode ?? '', e?.body ?? e?.message ?? e); }
      }
    }
    console.log(`[push] gesendet ${ok}${gone ? `, ${gone} abgelaufene Abos entfernt` : ''}${fail ? `, ${fail} fehlgeschlagen` : ''}`);
  }

  notify(store: Store, chat: Chat, m: Message) {
    if (!this.subs(store).length) { console.log('[push] übersprungen: keine Geräte angemeldet'); return; }
    const full = this.preview(store);
    const text = previewText(m);
    const t = full ? chat.title : 'Chorus';
    const b = full ? (chat.kind === 'direct' ? text : `${m.senderName}: ${text}`) : 'Neue Nachricht';
    const shaped = this.noTitle(store) && !full ? { title: '', body: 'Neue Nachricht' } : this.shape(store, t, b);
    void this.send(store, { ...shaped, chatId: chat.id, tag: chat.id });
  }
}
