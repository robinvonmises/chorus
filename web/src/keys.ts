/**
 * Browser-Schlüssel: wird aus dem Passwort abgeleitet (PBKDF2-SHA256) und verlässt
 * den Browser nur, um den Tresor auf dem Server zu entsperren. Gespeichert wird er
 * (wenn gewünscht) in IndexedDB dieses Geräts – nie auf dem Server.
 */
const b64 = (u: ArrayBuffer | Uint8Array) => btoa(String.fromCharCode(...new Uint8Array(u)));
const unb64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

export function newSalt(): string {
  return b64(crypto.getRandomValues(new Uint8Array(16)));
}

export async function deriveKey(password: string, saltB64: string, iterations: number): Promise<string> {
  if (!crypto?.subtle) {
    // Ohne HTTPS (z. B. http://192.168…) gibt es kein WebCrypto. Dann gleiche Rechnung in JavaScript (etwas langsamer).
    const [{ pbkdf2Async }, { sha256 }] = await Promise.all([import('@noble/hashes/pbkdf2.js'), import('@noble/hashes/sha2.js')]);
    return b64(await pbkdf2Async(sha256, new TextEncoder().encode(password), unb64(saltB64), { c: iterations, dkLen: 32, asyncTick: 25 }));
  }
  const base = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt: unb64(saltB64), iterations }, base, 256);
  return b64(bits);
}

const DB = 'inbox-keys';
function idb(): Promise<IDBDatabase> {
  return new Promise((res, rej) => {
    const r = indexedDB.open(DB, 1);
    r.onupgradeneeded = () => r.result.createObjectStore('k');
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
}
async function tx<T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const db = await idb();
  return new Promise((res, rej) => {
    const r = fn(db.transaction('k', mode).objectStore('k'));
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
}

const get = (name: string) => tx<string | undefined>('readonly', (s) => s.get(name) as IDBRequest<string | undefined>).catch(() => undefined);

/** Gespeicherter Schlüssel pro Profil. Ältere Versionen hatten nur einen Schlüssel („vault“), der wird einmalig übernommen. */
export const keyStore = {
  get: async (profileId: string) => (await get(`vault:${profileId}`)) ?? (await get('vault')),
  set: async (profileId: string, k: string) => { await tx('readwrite', (s) => s.put(k, `vault:${profileId}`)); await tx('readwrite', (s) => s.delete('vault')).catch(() => {}); },
  clear: async (profileId: string) => { await tx('readwrite', (s) => s.delete(`vault:${profileId}`)).catch(() => {}); await tx('readwrite', (s) => s.delete('vault')).catch(() => {}); },
};

/** Zuletzt benutztes Profil auf diesem Gerät */
export const lastProfile = {
  get: () => localStorage.getItem('inbox:profile'),
  set: (id: string) => localStorage.setItem('inbox:profile', id),
  clear: () => localStorage.removeItem('inbox:profile'),
};

/** Merkzettel „Diesem Gerät 30 Tage vertrauen“ (zusätzlich zum Cookie, falls der Browser Cookies verliert) */
export const trustStore = {
  get: (profileId: string) => localStorage.getItem(`inbox:trust:${profileId}`) ?? undefined,
  set: (profileId: string, t?: string) => { if (t) localStorage.setItem(`inbox:trust:${profileId}`, t); },
};
