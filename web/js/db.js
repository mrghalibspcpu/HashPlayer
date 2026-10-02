/* ============================================================
   HashPlayer · db.js — IndexedDB (tracks, playlists, blobs, kv)
   ============================================================ */
(function (w) {
  'use strict';
  const HP = w.HP;
  const NAME = 'hashplayer', VER = 1;
  let dbp = null;

  function open() {
    if (dbp) return dbp;
    dbp = new Promise((res, rej) => {
      if (!w.indexedDB) return rej(new Error('IndexedDB unavailable'));
      const rq = indexedDB.open(NAME, VER);
      rq.onupgradeneeded = e => {
        const db = rq.result;
        if (!db.objectStoreNames.contains('tracks')) {
          const s = db.createObjectStore('tracks', { keyPath: 'id' });
          s.createIndex('key', 'key', { unique: false });
          s.createIndex('added', 'added');
        }
        if (!db.objectStoreNames.contains('playlists')) db.createObjectStore('playlists', { keyPath: 'id' });
        if (!db.objectStoreNames.contains('kv')) db.createObjectStore('kv', { keyPath: 'k' });
      };
      rq.onsuccess = () => { rq.result.onversionchange = () => rq.result.close(); res(rq.result); };
      rq.onerror = () => rej(rq.error);
    }).catch(e => { console.warn('[db] unavailable, memory fallback', e); return null; });
    return dbp;
  }

  /* memory fallback so the app still runs in private mode */
  const mem = { tracks: new Map(), playlists: new Map(), kv: new Map() };
  const keyOf = (store, v) => store === 'kv' ? v.k : v.id;

  async function tx(store, mode, fn) {
    const db = await open();
    if (!db) return fn(null);
    return new Promise((res, rej) => {
      const t = db.transaction(store, mode), s = t.objectStore(store);
      let out;
      try { out = fn(s); } catch (e) { return rej(e); }
      t.oncomplete = () => res(out && out.__req ? out.__req.result : out);
      t.onerror = () => rej(t.error);
      t.onabort = () => rej(t.error);
    });
  }
  const wrap = rq => { const o = { __req: rq }; return o; };

  const DB = {
    open,
    async put(store, val) {
      const db = await open();
      if (!db) { mem[store].set(keyOf(store, val), val); return val; }
      await tx(store, 'readwrite', s => wrap(s.put(val)));
      return val;
    },
    async bulkPut(store, arr) {
      if (!arr.length) return;
      const db = await open();
      if (!db) { arr.forEach(v => mem[store].set(keyOf(store, v), v)); return; }
      await tx(store, 'readwrite', s => { arr.forEach(v => s.put(v)); });
    },
    async get(store, key) {
      const db = await open();
      if (!db) return mem[store].get(key);
      return tx(store, 'readonly', s => wrap(s.get(key)));
    },
    async all(store) {
      const db = await open();
      if (!db) return Array.from(mem[store].values());
      return tx(store, 'readonly', s => wrap(s.getAll()));
    },
    async del(store, key) {
      const db = await open();
      if (!db) { mem[store].delete(key); return; }
      return tx(store, 'readwrite', s => wrap(s.delete(key)));
    },
    async clear(store) {
      const db = await open();
      if (!db) { mem[store].clear(); return; }
      return tx(store, 'readwrite', s => wrap(s.clear()));
    },
    async kvGet(k, def) { const r = await DB.get('kv', k); return r ? r.v : def; },
    async kvSet(k, v) { return DB.put('kv', { k, v }); },
    async kvDel(k) { return DB.del('kv', k); },
    async estimate() {
      try { const e = await navigator.storage.estimate(); return e; } catch (x) { return null; }
    },
    async persist() {
      try { return await navigator.storage.persist(); } catch (x) { return false; }
    },
    async persisted() {
      try { return await navigator.storage.persisted(); } catch (x) { return false; }
    }
  };

  HP.DB = DB;
})(window);
