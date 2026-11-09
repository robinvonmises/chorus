// Screenshots für das README mit Beispieldaten (keine echten Chats).
// Start: Chorus lokal laufen lassen (z. B. DEMO=1 PORT=8099), dann:  node docs/screenshots/capture.cjs http://localhost:8099
const { chromium, devices } = require('playwright');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');

const BASE = process.argv[2] || 'http://localhost:8099';
const OUT = __dirname;
const now = Date.now();
const min = 60_000, h = 60 * min;
const img = (f) => readFileSync(join(OUT, f));

const accounts = [
  { id: 'sig', network: 'signal', label: 'Signal', status: { state: 'connected' }, createdAt: 0 },
  { id: 'wa', network: 'whatsapp', label: 'WhatsApp', status: { state: 'connected' }, createdAt: 0 },
  { id: 'tg', network: 'telegram', label: 'Telegram', status: { state: 'connected' }, createdAt: 0 },
];
const chat = (id, accountId, network, title, kind, ago, lastText, unread = 0, extra = {}) =>
  ({ id, accountId, network, remoteId: id, title, kind, lastTs: now - ago, lastText, unread, pinned: false, muted: false, aiEnabled: true, ...extra });
const chats = [
  chat('mia', 'sig', 'signal', 'Mia Chen', 'direct', 2 * min, 'Look at this sunset 😍', 0, { pinned: true }),
  chat('family', 'wa', 'whatsapp', 'Family 🏡', 'group', 14 * min, 'Dad: Dinner at 7?', 3),
  chat('dev', 'tg', 'telegram', 'Dev Team', 'group', 41 * min, 'Lena: Deploy is green ✅', 5),
  chat('jonas', 'wa', 'whatsapp', 'Jonas', 'direct', 2 * h, 'See you tomorrow!'),
  chat('climb', 'sig', 'signal', 'Climbing Crew', 'group', 5 * h, 'Sam: Saturday 10am at the gym?', 1),
  chat('sarah', 'tg', 'telegram', 'Sarah Klein', 'direct', 26 * h, 'Thanks for the notes 🙏'),
  chat('book', 'wa', 'whatsapp', 'Book Club', 'group', 50 * h, 'Next pick: Project Hail Mary'),
  chat('max', 'sig', 'signal', 'Max', 'direct', 80 * h, 'Voice message'),
];
const msg = (id, fromMe, ago, text, extra = {}) => ({
  id, chatId: 'mia', remoteId: id, senderId: fromMe ? 'me' : 'mia', senderName: fromMe ? 'Du' : 'Mia Chen', fromMe, ts: now - ago,
  text, edited: false, deleted: false, attachments: [], reactions: [], status: fromMe ? 'read' : 'received', ...extra,
});
const messages = [
  msg('m1', false, 58 * min, 'Hey! Are you still up for the hike on Sunday?'),
  msg('m2', true, 55 * min, 'Absolutely! Which trail were you thinking of?'),
  msg('m3', false, 54 * min, 'The coastal one, it should be stunning this time of year 🌊'),
  msg('m4', false, 53 * min, '', { attachments: [{ fileId: 'f1', name: 'sea.jpg', mime: 'image/jpeg', size: 13000, kind: 'image', width: 720, height: 900 }] }),
  msg('m5', true, 40 * min, 'Wow, count me in. I’ll bring snacks 🥨', { replyToRemoteId: 'm3', reactions: [{ emoji: '❤️', senderId: 'mia', fromMe: false }] }),
  msg('m6', false, 20 * min, '', { attachments: [{ fileId: 'f3', name: 'voice.ogg', mime: 'audio/ogg', size: 9000, kind: 'voice', durationSec: 14 }], transcript: 'Quick reminder: we meet at the parking lot at 8, bring water!' }),
  msg('m7', false, 2 * min, 'Look at this sunset 😍', { attachments: [{ fileId: 'f2', name: 'sunset.jpg', mime: 'image/jpeg', size: 11000, kind: 'image', width: 960, height: 640 }] }),
];
const server = {
  version: '0.1.0', networks: ['telegram', 'signal', 'whatsapp'], authed: true,
  profiles: [{ id: 'p1', name: 'Alex', initialized: true, invite: false, totp: true, avatar: null, kdf: null }],
  profile: { id: 'p1', name: 'Alex', admin: true, comfort: true, totp: true, avatar: null },
};
const ai = { model: 'claude', models: [], hasAnthropicKey: true, hasElevenKey: true, voiceId: 'v', voiceName: 'Alex', features: { text: true, transcribe: true, voice: true } };

async function mock(page, dark) {
  await page.emulateMedia({ colorScheme: dark ? 'dark' : 'light' });
  await page.routeWebSocket(/\/api\/ws/, () => { /* offen lassen, keine Ereignisse */ });
  await page.route(/\/api\//, (r) => {
    const u = new URL(r.request().url()), p = u.pathname;
    const json = (b) => r.fulfill({ contentType: 'application/json', body: JSON.stringify(b) });
    if (p === '/api/state') return json(server);
    if (p === '/api/accounts') return json(accounts);
    if (p === '/api/chats' || p === '/api/sync') return json(chats);
    if (p === '/api/chats/mia/messages') return json(u.searchParams.has('before') ? [] : messages);
    if (/\/messages$/.test(p)) return json([]);
    if (p === '/api/ai' || p === '/api/ai/settings') return json(ai);
    if (p === '/api/attachment' || /attachments/.test(p)) {
      const m = u.searchParams.get('m') || p.split('/')[3];
      if (m === 'm4') return r.fulfill({ contentType: 'image/jpeg', body: img('sea.jpg') });
      if (m === 'm7') return r.fulfill({ contentType: 'image/jpeg', body: img('sunset.jpg') });
      return r.fulfill({ status: 404, body: '' });
    }
    return json({});
  });
}

(async () => {
  const b = await chromium.launch();
  for (const dark of [false, true]) {
    const sfx = dark ? '-dark' : '';
    // Desktop
    const d = await b.newContext({ viewport: { width: 1360, height: 820 }, deviceScaleFactor: 2, serviceWorkers: 'block' });
    const dp = await d.newPage();
    dp.on('pageerror', (e) => console.log('ERR', e.message));
    await mock(dp, dark);
    await dp.goto(BASE);
    await dp.waitForSelector('.chat-item');
    await dp.locator('.chat-item', { hasText: 'Mia Chen' }).click();
    await dp.waitForTimeout(1200);
    await dp.screenshot({ path: join(OUT, `desktop${sfx}.png`) });
    await d.close();
    // Handy
    const m = await b.newContext({ ...devices['iPhone 13'], serviceWorkers: 'block' });
    const mp = await m.newPage();
    await mock(mp, dark);
    await mp.goto(BASE);
    await mp.waitForSelector('.chat-item');
    await mp.waitForTimeout(600);
    await mp.screenshot({ path: join(OUT, `mobile-list${sfx}.png`) });
    await mp.locator('.chat-item', { hasText: 'Mia Chen' }).click();
    await mp.waitForTimeout(1200);
    await mp.screenshot({ path: join(OUT, `mobile-chat${sfx}.png`) });
    if (!dark) {
      await mp.goBack().catch(() => {});
      await mp.locator('button[aria-label="Zurück"]').first().click().catch(() => {});
      await mp.waitForTimeout(500);
      await mp.locator('button[aria-label="Einstellungen"]').first().click();
      await mp.waitForTimeout(900);
      await mp.screenshot({ path: join(OUT, 'mobile-settings.png') });
    }
    await m.close();
  }
  await b.close();
})();
