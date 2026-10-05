/* ============================================================
   HashPlayer · library.js — import, metadata pipeline, storage,
   grid rendering, playlists, search / sort / filter
   ============================================================ */
(function (w) {
  'use strict';
  const HP = w.HP, S = HP.S, DB = HP.DB, $ = HP.$, $$ = HP.$$, el = HP.el, icon = HP.icon;

  const L = {
    tracks: new Map(), playlists: [], ready: false, view: null,
    needsRelink: 0, rendering: 0, pageSize: 90
  };

  /* ---------------- persistence ---------------- */
  const dehydrate = t => {
    const o = Object.assign({}, t);
    delete o._coverUrl; delete o._srcUrl; delete o._busy;
    return o;
  };
  const saveTrack = t => DB.put('tracks', dehydrate(t));
  const saveSoon = HP.debounce(() => DB.bulkPut('tracks', Array.from(L.tracks.values()).map(dehydrate)), 900);
  L.saveTrack = saveTrack;

  L.load = async function () {
    let rows = [];
    try { rows = (await DB.all('tracks')) || []; } catch (e) { console.warn(e); }
    rows.forEach(t => L.tracks.set(t.id, t));
    try { L.playlists = (await DB.all('playlists')) || []; } catch (e) { }
    L.ready = true;
    L.countRelink();
    HP.emit('library');
  };

  L.countRelink = function () {
    let n = 0;
    L.tracks.forEach(t => { if (!t.file && !t.handle && !t.nativeUri && t.source !== 'url') n++; });
    L.needsRelink = n;
    return n;
  };

  /* ---------------- importing ---------------- */
  const keyOf = f => (f.name + '|' + f.size);
  const byKey = () => { const m = new Map(); L.tracks.forEach(t => m.set(t.key, t)); return m; };

  async function makeTrack(file, extra) {
    const kind = HP.kindOf(file.name, file.type);
    if (kind !== 'audio' && kind !== 'video') return null;
    const g = HP.splitArtistTitle(file.name);
    return Object.assign({
      id: HP.uid(), key: keyOf(file), name: file.name, title: g.title, artist: g.artist || '',
      album: '', genre: '', year: '', trackNo: '', duration: 0, size: file.size, mime: file.type || '',
      kind, source: 'file', file, handle: null, nativeUri: null, url: null, cover: null,
      folder: (file.webkitRelativePath || '').split('/').slice(0, -1).join('/'),
      added: Date.now(), modified: file.lastModified || 0, plays: 0, lastPlayed: 0, fav: false,
      pos: 0, lrc: null, sub: null, bookmarks: [], tagged: false
    }, extra || {});
  }

  /* add File objects (+ .lrc/.srt sidecars) */
  L.addFiles = async function (files, opts) {
    opts = opts || {};
    const list = Array.from(files || []);
    if (!list.length) return [];
    const known = byKey(), added = [], sidecars = [];
    let dupes = 0, relinked = 0;

    for (const f of list) {
      const kind = HP.kindOf(f.name, f.type);
      if (kind === 'lrc' || kind === 'sub') { sidecars.push({ f, kind }); continue; }
      if (!kind) continue;
      const k = keyOf(f), ex = known.get(k);
      if (ex) {                                   // already known → refresh the file handle
        if (!ex.file) { ex.file = f; ex.source = 'file'; relinked++; saveTrack(ex); }
        else dupes++;
        continue;
      }
      const t = await makeTrack(f, opts.extra);
      if (!t) continue;
      if (opts.handles && opts.handles.get(f)) { t.handle = opts.handles.get(f); t.source = 'handle'; }
      L.tracks.set(t.id, t); known.set(k, t); added.push(t);
    }

    /* attach sidecars by matching base name */
    for (const sc of sidecars) {
      const base = HP.baseName(sc.f.name).toLowerCase();
      let hit = null;
      L.tracks.forEach(t => { if (!hit && HP.baseName(t.name).toLowerCase() === base) hit = t; });
      if (!hit) continue;
      try {
        const txt = await sc.f.text();
        if (sc.kind === 'lrc') hit.lrc = txt; else hit.sub = HP.Meta.toVTT(txt, sc.f.name);
        saveTrack(hit);
      } catch (e) { }
    }

    if (added.length) await DB.bulkPut('tracks', added.map(dehydrate));
    else if (relinked) saveSoon();
    L.countRelink();
    HP.emit('library');
    if (added.length) queueMeta(added);
    const msg = added.length
      ? added.length + ' added' + (dupes ? ' · ' + dupes + ' already in library' : '')
      : relinked ? relinked + ' tracks reconnected'
        : dupes ? 'Already in your library' : 'No playable media found';
    HP.toast(msg, added.length || relinked ? 'ok' : '');
    return added;
  };

  /* drag & drop (recurses into folders) */
  L.addDataTransfer = async function (dt) {
    const files = [];
    const items = dt.items ? Array.from(dt.items) : [];
    const entries = items.map(i => i.webkitGetAsEntry && i.webkitGetAsEntry()).filter(Boolean);
    if (entries.length) {
      const walk = async (entry, path) => {
        if (entry.isFile) {
          await new Promise(r => entry.file(f => {
            try { Object.defineProperty(f, 'webkitRelativePath', { value: path + f.name }); } catch (e) { }
            files.push(f); r();
          }, r));
        } else if (entry.isDirectory) {
          const rd = entry.createReader();
          let batch;
          do {
            batch = await new Promise(r => rd.readEntries(r, () => r([])));
            for (const e of batch) await walk(e, path + entry.name + '/');
          } while (batch.length);
        }
      };
      for (const e of entries) await walk(e, '');
    }
    if (!files.length && dt.files) Array.prototype.push.apply(files, Array.from(dt.files));
    return L.addFiles(files);
  };

  /* File System Access API (keeps permission across sessions on desktop) */
  L.pickWithHandles = async function (dir) {
    if (!HP.supportsFS) return null;
    const handles = new Map(), files = [];
    try {
      if (dir) {
        const d = await w.showDirectoryPicker({ id: 'hashplayer-media', mode: 'read' });
        const walk = async (h, path) => {
          for await (const [name, entry] of h.entries()) {
            if (entry.kind === 'file') {
              const k = HP.kindOf(name);
              if (!k) continue;
              const f = await entry.getFile();
              try { Object.defineProperty(f, 'webkitRelativePath', { value: path + name }); } catch (e) { }
              handles.set(f, entry); files.push(f);
            } else if (entry.kind === 'directory' && path.split('/').length < 7) {
              await walk(entry, path + name + '/');
            }
          }
        };
        await walk(d, d.name + '/');
      } else {
        const picked = await w.showOpenFilePicker({
          multiple: true, id: 'hashplayer-files',
          types: [{ description: 'Media', accept: { 'audio/*': ['.mp3', '.m4a', '.flac', '.wav', '.ogg', '.opus', '.aac'], 'video/*': ['.mp4', '.webm', '.mkv', '.mov', '.m4v'], 'text/plain': ['.lrc', '.srt', '.vtt'] } }]
        });
        for (const h of picked) { const f = await h.getFile(); handles.set(f, h); files.push(f); }
      }
    } catch (e) { if (e && e.name === 'AbortError') return []; console.warn(e); return null; }
    return L.addFiles(files, { handles });
  };

  /* remote URL */
  L.addUrl = async function (url) {
    url = String(url || '').trim();
    if (url && !/^[a-z]+:\/\//i.test(url)) url = 'https://' + url;

    /* YouTube links get their own kind of track — see js/yt.js */
    const yt = HP.YT && HP.YT.parse(url);
    if (yt) {
      const known = [...L.tracks.values()].find(t => t.ytId === yt.id);
      if (known) { HP.toast('Already in your library', 'ok'); return known; }
      const t = {
        id: HP.uid(), key: 'yt:' + yt.id, name: 'YouTube video', title: 'YouTube video',
        artist: 'YouTube', album: '', genre: '', year: '', trackNo: '',
        duration: 0, size: 0, mime: 'video/youtube', kind: 'video',
        source: 'yt', ytId: yt.id, thumb: HP.YT.thumb(yt.id), file: null, handle: null,
        nativeUri: null, url: yt.url, cover: null, folder: '', added: Date.now(),
        plays: 0, lastPlayed: 0, fav: false, pos: yt.start || 0, lrc: null, sub: null,
        bookmarks: [], tagged: true
      };
      L.tracks.set(t.id, t);
      await saveTrack(t);
      HP.emit('library');
      HP.toast('YouTube video added', 'ok');
      return t;
    }

    if (!/^https?:\/\//i.test(url)) { HP.toast('Enter a full http(s) link', 'err'); return null; }
    let parsed;
    try { parsed = new URL(url); } catch (e) { HP.toast('Enter a valid media URL', 'err'); return null; }
    const name = decodeURIComponent(parsed.pathname.split('/').pop() || '') || 'Stream';
    // Prefer the URL path because CDN links often have a generic display name.
    const guessedKind = HP.kindOf(name) || HP.kindOf(parsed.pathname);
    const kind = guessedKind === 'video' ? 'video' : 'audio';
    const g = HP.splitArtistTitle(name);
    const t = {
      id: HP.uid(), key: url, name, title: g.title || name, artist: g.artist || parsed.hostname,
      album: '', genre: '', year: '', trackNo: '', duration: 0, size: 0, mime: '', kind,
      source: 'url', file: null, handle: null, nativeUri: null, url, cover: null, folder: '',
      added: Date.now(), plays: 0, lastPlayed: 0, fav: false, pos: 0, lrc: null, sub: null,
      bookmarks: [], tagged: true
    };
    L.tracks.set(t.id, t);
    await saveTrack(t);
    HP.emit('library');
    HP.toast('Stream added', 'ok');
    return t;
  };

  /* ---------------- YouTube search results ----------------
     The same search box, extended online. Results are shown in their own
     section under the library and only become real tracks once you play one. */
  const YTS = L.yt = { query: '', rows: [], loading: false, error: '', seq: 0, off: false };

  L.ytSearch = function (query) {
    const q = String(query || '').trim();
    YTS.query = q;
    const mine = ++YTS.seq;
    const can = S.ytSearch !== false && !YTS.off && q.length >= 2 &&
      navigator.onLine !== false && HP.YT && HP.YT.canSearch();
    if (!can) { YTS.rows = []; YTS.loading = false; YTS.error = ''; L.renderYt(); return; }

    YTS.loading = true; YTS.error = ''; L.renderYt();
    HP.YT.search(q).then(rows => {
      if (mine !== YTS.seq) return;                 // a newer keystroke won
      YTS.rows = rows || []; YTS.loading = false; YTS.error = '';
      L.renderYt();
    }).catch(() => {
      if (mine !== YTS.seq) return;
      YTS.rows = []; YTS.loading = false;
      YTS.error = HP.t ? HP.t('ytOffline') : 'YouTube search is not reachable right now';
      L.renderYt();
    });
  };

  /** Turn a search result into a library track (or reuse the one we already have). */
  L.addYt = async function (row) {
    if (!row || !row.id) return null;
    const known = [...L.tracks.values()].find(t => t.ytId === row.id);
    if (known) {
      let dirty = false;
      if (row.title && known.title === 'YouTube video') { known.title = row.title; known.name = row.title; dirty = true; }
      if (row.author && !known.artist) { known.artist = row.author; dirty = true; }
      if (row.seconds && !known.duration) { known.duration = row.seconds; dirty = true; }
      if (dirty) { await saveTrack(known); HP.emit('library'); }
      return known;
    }
    const t = {
      id: HP.uid(), key: 'yt:' + row.id, name: row.title || 'YouTube video',
      title: row.title || 'YouTube video', artist: row.author || 'YouTube',
      album: '', genre: '', year: '', trackNo: '',
      duration: row.seconds || 0, size: 0, mime: 'video/youtube', kind: 'video',
      source: 'yt', ytId: row.id, thumb: row.thumb || HP.YT.thumb(row.id), file: null, handle: null,
      nativeUri: null, url: 'https://www.youtube.com/watch?v=' + row.id, cover: null, folder: '',
      added: Date.now(), plays: 0, lastPlayed: 0, fav: false, pos: 0, lrc: null, sub: null,
      bookmarks: [], tagged: true, live: !!row.live
    };
    L.tracks.set(t.id, t);
    await saveTrack(t);
    HP.emit('library');
    return t;
  };

  /** Metadata that came back from the native resolver — keep the row honest. */
  L.updateYt = async function (ytId, meta) {
    const t = [...L.tracks.values()].find(x => x.ytId === ytId);
    if (!t || !meta) return;
    let dirty = false;
    if (meta.title && (!t.title || t.title === 'YouTube video')) { t.title = meta.title; t.name = meta.title; dirty = true; }
    if (meta.author && (!t.artist || t.artist === 'YouTube')) { t.artist = meta.author; dirty = true; }
    if (meta.dur > 0 && Math.abs((t.duration || 0) - meta.dur) > 1) { t.duration = meta.dur; dirty = true; }
    if (!dirty) return;
    await saveTrack(t);
    HP.emit('track-updated', t);
    if (HP.Player && HP.Player.current && HP.Player.current.id === t.id && HP.Player.paintNowPlaying)
      HP.Player.paintNowPlaying(t);
  };

  L.playYt = async function (row) {
    const t = await L.addYt(row);
    if (!t) return;
    L.render();                                   // it is a library track now
    HP.Player.playTrack(t.id, [t.id]);
  };

  function ytRow(r) {
    const thumb = el('div', { class: 'yt-thumb' }, [
      el('img', { src: r.thumb, alt: '', loading: 'lazy', referrerpolicy: 'no-referrer' }),
      el('span', { class: 'dur' + (r.live ? ' live' : ''), text: r.live ? 'LIVE' : (r.duration || '—') })
    ]);
    const sub = [r.author, r.views, r.published].filter(Boolean).join(' · ');
    const node = el('div', { class: 'yt-row', tabindex: '0', role: 'button' }, [
      thumb,
      el('div', { class: 'yt-info' }, [
        el('div', { class: 'yt-title', text: r.title }),
        el('div', { class: 'yt-sub', text: sub })
      ]),
      el('div', { class: 'yt-go' }, [icon('play')])
    ]);
    const go = () => L.playYt(r);
    node.addEventListener('click', go);
    node.addEventListener('keydown', e => { if (e.key === 'Enter') go(); });
    return node;
  }

  L.renderYt = function () {
    const box = $('#yt-results'), list = $('#yt-list'), count = $('#yt-count');
    if (!box || !list) return;
    const show = !!YTS.query && (YTS.loading || YTS.rows.length > 0 || !!YTS.error);
    box.hidden = !show;
    if (!show) { list.innerHTML = ''; if (count) count.textContent = ''; return; }

    list.innerHTML = '';
    if (YTS.loading) {
      list.appendChild(el('div', { class: 'yt-state' }, [
        el('i', { class: 'yt-spin' }),
        el('span', { text: (HP.t ? HP.t('ytSearching') : 'Searching YouTube') + ' “' + YTS.query + '”…' })
      ]));
    } else if (YTS.error) {
      list.appendChild(el('div', { class: 'yt-state' }, [el('span', { text: YTS.error })]));
    } else {
      const frag = document.createDocumentFragment();
      YTS.rows.forEach(r => frag.appendChild(ytRow(r)));
      list.appendChild(frag);
    }
    if (count) count.textContent = YTS.loading || YTS.error ? '' : YTS.rows.length + '';
  };

  /* Android native scan (MediaStore via the APK bridge) */
  L.addNative = async function (items, opts) {
    opts = opts || {};
    const known = new Map(); L.tracks.forEach(t => { if (t.nativeUri) known.set(t.nativeUri, t); });
    const add = [];
    (items || []).forEach(it => {
      if (known.has(it.uri)) return;
      const g = HP.splitArtistTitle(it.name || 'Track');
      add.push({
        id: HP.uid(), key: it.uri, name: it.name || 'Track', title: it.title || g.title,
        artist: it.artist || g.artist || '', album: it.album || '', genre: '', year: '', trackNo: '',
        duration: (it.duration || 0) / 1000, size: it.size || 0, mime: it.mime || '',
        kind: it.kind || 'audio', source: 'native', file: null, handle: null, nativeUri: it.uri,
        url: null, cover: null, folder: it.folder || '', added: Date.now(), plays: 0, lastPlayed: 0,
        fav: false, pos: 0, lrc: null, sub: null, bookmarks: [], tagged: true
      });
    });
    add.forEach(t => L.tracks.set(t.id, t));
    if (add.length) await DB.bulkPut('tracks', add);
    HP.emit('library');
    L.requestArt();                       // native album art / video thumbnails
    if (!opts.quiet) HP.toast(add.length ? add.length + ' tracks found on device' : 'No new tracks found', add.length ? 'ok' : '');
    return add;
  };

  /**
   * Album art for device files can only be read natively (MediaStore /
   * MediaMetadataRetriever) — ask the shell for every tile that is still blank,
   * in small batches so a big library does not stall the UI.
   */
  L.requestArt = function () {
    const n = window.HashNative;
    if (!n || !n.requestArt) return;
    const want = [];
    L.tracks.forEach(t => { if (t.nativeUri && !t.thumb && !t.cover && !t.artAsked) { t.artAsked = true; want.push(t.nativeUri); } });
    if (!want.length) return;
    for (let i = 0; i < want.length; i += 40) {
      const chunk = want.slice(i, i + 40);
      setTimeout(() => { try { n.requestArt(JSON.stringify(chunk)); } catch (e) { } }, (i / 40) * 400);
    }
  };

  /* ---------------- background metadata pipeline ---------------- */
  let mq = [], working = false;
  function queueMeta(list) {
    mq = mq.concat(list.filter(t => !t.tagged));
    if (!working) runMeta();
  }
  L.queueMeta = queueMeta;
  async function runMeta() {
    working = true;
    let changed = 0;
    while (mq.length) {
      const t = mq.shift();
      if (!t || !L.tracks.has(t.id)) continue;
      try {
        const f = await fileOf(t);
        if (f) {
          const m = await HP.Meta.read(f);
          if (m.title) t.title = m.title;
          if (m.artist) t.artist = m.artist;
          if (m.album) t.album = m.album;
          if (m.genre) t.genre = m.genre;
          if (m.year) t.year = m.year;
          if (m.trackNo) t.trackNo = m.trackNo;
          if (m.cover) t.cover = m.cover;
          if (m.lyrics && !t.lrc) t.lrc = m.lyrics;
          if (m.duration) t.duration = m.duration;
        }
        if (!t.duration) {
          const src = await L.resolveSrc(t, true);
          if (src) t.duration = await HP.Meta.probe(src, t.kind === 'video');
        }
        t.tagged = true;
        changed++;
        saveTrack(t);
        HP.emit('track-updated', t);
      } catch (e) { t.tagged = true; }
      if (changed % 12 === 0) await new Promise(r => setTimeout(r, 16));
    }
    working = false;
    if (changed) HP.emit('library');
  }

  async function fileOf(t) {
    if (t.file) return t.file;
    if (t.handle) {
      try {
        const p = await t.handle.queryPermission({ mode: 'read' });
        if (p === 'granted') return await t.handle.getFile();
      } catch (e) { }
    }
    return null;
  }
  L.fileOf = fileOf;

  /* ---------------- source resolution ---------------- */
  const srcCache = new Map();           // id → objectURL
  const MAX_SRC = 6;
  L.resolveSrc = async function (t, silent) {
    if (!t) return null;
    if (t.source === 'yt') return 'yt:' + t.ytId;
    if (t.source === 'url') return t.url;
    if (t.nativeUri) return t.nativeUri;
    if (srcCache.has(t.id)) return srcCache.get(t.id);
    let f = t.file;
    if (!f && t.handle) {
      try {
        let p = await t.handle.queryPermission({ mode: 'read' });
        if (p === 'prompt' && !silent) p = await t.handle.requestPermission({ mode: 'read' });
        if (p === 'granted') f = await t.handle.getFile();
      } catch (e) { }
    }
    if (!f) return null;
    try { await f.slice(0, 1).arrayBuffer(); }    // verify the file still exists on disk
    catch (e) { t.file = null; L.countRelink(); HP.emit('library'); return null; }
    const u = URL.createObjectURL(f);
    srcCache.set(t.id, u);
    if (srcCache.size > MAX_SRC) {
      const k = srcCache.keys().next().value;
      if (k !== t.id) { URL.revokeObjectURL(srcCache.get(k)); srcCache.delete(k); }
    }
    return u;
  };

  /* cover art object URLs (LRU) */
  const coverCache = new Map();
  L.coverUrl = function (t) {
    if (!t) return null;
    if (!t.cover) return t.thumb || null;      // YouTube videos use their own thumbnail
    if (coverCache.has(t.id)) return coverCache.get(t.id);
    let u;
    try { u = URL.createObjectURL(t.cover); } catch (e) { return null; }
    coverCache.set(t.id, u);
    if (coverCache.size > 260) {
      const k = coverCache.keys().next().value;
      URL.revokeObjectURL(coverCache.get(k)); coverCache.delete(k);
    }
    return u;
  };

  /* ---------------- mutations ---------------- */
  L.get = id => L.tracks.get(id);
  L.toggleFav = function (id) {
    const t = L.tracks.get(id); if (!t) return;
    t.fav = !t.fav; saveTrack(t);
    HP.emit('track-updated', t);
    if (S.filter === 'fav' || L.view === 'favorites') L.render();
    HP.toast(t.fav ? '♥ Added to favourites' : 'Removed from favourites');
  };
  L.remove = async function (id) {
    const t = L.tracks.get(id); if (!t) return;
    L.tracks.delete(id);
    if (srcCache.has(id)) { URL.revokeObjectURL(srcCache.get(id)); srcCache.delete(id); }
    if (coverCache.has(id)) { URL.revokeObjectURL(coverCache.get(id)); coverCache.delete(id); }
    await DB.del('tracks', id);
    L.playlists.forEach(p => {
      const i = p.items.indexOf(id);
      if (i > -1) { p.items.splice(i, 1); DB.put('playlists', p); }
    });
    HP.emit('removed', id);
    HP.emit('library');
  };
  L.clearAll = async function () {
    srcCache.forEach(u => URL.revokeObjectURL(u)); srcCache.clear();
    coverCache.forEach(u => URL.revokeObjectURL(u)); coverCache.clear();
    L.tracks.clear(); L.playlists = [];
    await DB.clear('tracks'); await DB.clear('playlists'); await DB.clear('kv');
    HP.emit('library');
  };

  /* ---------------- playlists ---------------- */
  L.createPlaylist = async function (name, items) {
    const p = { id: HP.uid(), name: name || 'Playlist', items: items || [], created: Date.now() };
    L.playlists.push(p); await DB.put('playlists', p);
    HP.emit('library'); return p;
  };
  L.addToPlaylist = async function (pid, ids) {
    const p = L.playlists.find(x => x.id === pid); if (!p) return;
    ids.forEach(id => { if (p.items.indexOf(id) < 0) p.items.push(id); });
    await DB.put('playlists', p); HP.emit('library');
    HP.toast('Added to ' + p.name, 'ok');
  };
  L.deletePlaylist = async function (pid) {
    L.playlists = L.playlists.filter(p => p.id !== pid);
    await DB.del('playlists', pid); HP.emit('library');
  };

  /* ---------------- query ---------------- */
  L.query = function () {
    let list = Array.from(L.tracks.values());
    const q = (L.search || '').trim().toLowerCase();
    const f = L.view === 'favorites' ? 'fav' : (S.filter || 'all');
    if (f === 'audio' || f === 'video') list = list.filter(t => t.kind === f);
    else if (f === 'fav') list = list.filter(t => t.fav);
    else if (f === 'recent') list = list.filter(t => t.lastPlayed).sort((a, b) => b.lastPlayed - a.lastPlayed).slice(0, 60);
    else if (f === 'most') list = list.filter(t => t.plays).sort((a, b) => b.plays - a.plays).slice(0, 60);
    if (q) list = list.filter(t =>
      (t.title + ' ' + t.artist + ' ' + t.album + ' ' + t.name + ' ' + (t.genre || '')).toLowerCase().indexOf(q) > -1);
    if (f !== 'recent' && f !== 'most') {
      const s = S.sort;
      const cmp = {
        added: (a, b) => b.added - a.added,
        title: (a, b) => (a.title || a.name).localeCompare(b.title || b.name),
        artist: (a, b) => (a.artist || 'ÿ').localeCompare(b.artist || 'ÿ') || (a.album || '').localeCompare(b.album || '') || (+a.trackNo || 0) - (+b.trackNo || 0),
        album: (a, b) => (a.album || 'ÿ').localeCompare(b.album || 'ÿ') || (+a.trackNo || 0) - (+b.trackNo || 0),
        duration: (a, b) => (b.duration || 0) - (a.duration || 0),
        plays: (a, b) => (b.plays || 0) - (a.plays || 0),
        size: (a, b) => (b.size || 0) - (a.size || 0)
      }[s] || ((a, b) => b.added - a.added);
      list.sort(cmp);
    }
    return list;
  };

  L.stats = function () {
    let audio = 0, video = 0, dur = 0, size = 0;
    L.tracks.forEach(t => { t.kind === 'video' ? video++ : audio++; dur += t.duration || 0; size += t.size || 0; });
    return { total: L.tracks.size, audio, video, dur, size };
  };

  /* ---------------- rendering ---------------- */
  let shown = 0, lastList = [];
  function card(t) {
    const isVid = t.kind === 'video';
    const art = el('div', { class: 'card-art' });
    const cu = L.coverUrl(t);
    if (cu) art.appendChild(el('img', { src: cu, alt: '', loading: 'lazy' }));
    else art.appendChild(icon(isVid ? 'video' : 'music', 'ph'));
    const badges = el('div', { class: 'card-badges' });
    if (isVid) badges.appendChild(el('span', { class: 'badge v', text: 'VIDEO' }));
    if (t.source === 'url') badges.appendChild(el('span', { class: 'badge', text: 'LINK' }));
    if (!t.file && !t.handle && !t.nativeUri && t.source !== 'url') badges.appendChild(el('span', { class: 'badge', text: 'RELINK' }));
    art.appendChild(badges);
    art.appendChild(el('span', { class: 'badge dur', text: t.duration ? HP.fmtTime(t.duration) : '—' }));

    const fav = el('button', { class: 'card-fav' + (t.fav ? ' on' : ''), 'aria-label': 'Favourite' }, [icon('heart')]);
    fav.addEventListener('click', e => { e.stopPropagation(); L.toggleFav(t.id); fav.classList.toggle('on', !!t.fav); });
    const play = el('button', { class: 'card-play' }, [icon('play')]);
    play.addEventListener('click', e => { e.stopPropagation(); HP.Player.playTrack(t.id, L.contextIds()); });

    const info = el('div', { class: 'card-info' }, [
      el('div', { class: 'card-title', text: t.title || t.name }),
      el('div', { class: 'card-sub', text: (t.artist || (isVid ? 'Video' : 'Unknown artist')) + (t.album ? ' · ' + t.album : '') })
    ]);

    const c = el('div', { class: 'card', 'data-id': t.id, tabindex: '0' }, [art, fav, play, info]);
    if (HP.Player && HP.Player.current && HP.Player.current.id === t.id) c.classList.add('playing');
    c.addEventListener('click', () => HP.Player.playTrack(t.id, L.contextIds()));
    c.addEventListener('keydown', e => { if (e.key === 'Enter') HP.Player.playTrack(t.id, L.contextIds()); });
    c.addEventListener('contextmenu', e => { e.preventDefault(); HP.UI.trackMenu(t, e.clientX, e.clientY); });
    let lp;
    c.addEventListener('touchstart', e => {
      lp = setTimeout(() => {
        if (navigator.vibrate) navigator.vibrate(12);
        const x = e.touches[0].clientX, y = e.touches[0].clientY;
        HP.UI.trackMenu(t, x, y);
      }, 520);
    }, { passive: true });
    ['touchend', 'touchmove', 'touchcancel'].forEach(ev => c.addEventListener(ev, () => clearTimeout(lp), { passive: true }));
    return c;
  }

  function listRow(t) {
    const c = card(t);
    const right = el('div', { class: 'list-right' });
    right.appendChild(c.querySelector('.badge.dur'));
    right.appendChild(c.querySelector('.card-fav'));
    right.appendChild(c.querySelector('.card-play'));
    const dots = el('button', { class: 'icon-btn tiny' }, [icon('dots')]);
    dots.addEventListener('click', e => { e.stopPropagation(); const r = dots.getBoundingClientRect(); HP.UI.trackMenu(t, r.left, r.bottom); });
    right.appendChild(dots);
    c.appendChild(right);
    return c;
  }

  L.contextIds = () => lastList.map(t => t.id);

  L.render = function (reset) {
    const grid = $('#grid'), empty = $('#empty');
    if (!grid) return;
    if (reset !== false) { grid.innerHTML = ''; shown = 0; }
    lastList = L.query();
    grid.classList.toggle('list', S.viewMode === 'list');
    const slice = lastList.slice(shown, shown + L.pageSize);
    const frag = document.createDocumentFragment();
    slice.forEach((t, i) => {
      const n = S.viewMode === 'list' ? listRow(t) : card(t);
      n.style.animationDelay = Math.min(i * 10, 240) + 'ms';
      frag.appendChild(n);
    });
    grid.appendChild(frag);
    shown += slice.length;
    if (shown < lastList.length) {
      const more = el('div', { class: 'sentinel' });
      grid.appendChild(more);
      const io = new IntersectionObserver(es => {
        if (es[0].isIntersecting) { io.disconnect(); more.remove(); L.render(false); }
      }, { rootMargin: '600px' });
      io.observe(more);
    }
    const none = lastList.length === 0;
    empty.classList.toggle('show', none && !L.search);
    grid.hidden = none && !L.search;
    if (none && L.search) {
      const online = YTS.rows.length > 0 || YTS.loading;
      grid.appendChild(el('div', { class: 'no-results' }, [
        el('b', { text: 'Nothing in your library matched “' + L.search + '”' }),
        el('span', {
          text: online ? 'Have a look at the YouTube results below.'
            : 'Try a different word, or clear the search to see everything.'
        })
      ]));
    }
    const st = L.stats();
    $('#stat-count').textContent = st.total;
    const sub = $('#lib-sub');
    if (sub) sub.textContent = none && L.search ? 'No results for “' + L.search + '”'
      : st.total ? st.total + ' tracks · ' + st.audio + ' audio · ' + st.video + ' video · ' + HP.fmtTime(st.dur) + ' · ' + HP.fmtBytes(st.size)
        : 'Your library is empty';
    const rb = $('#relink-bar');
    if (rb) {
      const n = L.countRelink();
      rb.hidden = !n || L.relinkHidden;
      $('#relink-count').textContent = n;
    }
  };

  L.renderPlaylists = function () {
    const box = $('#playlist-grid'); if (!box) return;
    box.innerHTML = '';
    if (!L.playlists.length) {
      box.appendChild(el('p', { class: 'muted', text: 'No playlists yet — create one from the queue or any track menu.' }));
      return;
    }
    L.playlists.forEach(p => {
      const valid = p.items.filter(id => L.tracks.has(id));
      const c = el('div', { class: 'pl-card' }, [
        icon('queue'),
        el('b', { text: p.name }),
        el('small', { text: valid.length + ' tracks · ' + HP.fmtDate(p.created) })
      ]);
      c.addEventListener('click', () => HP.UI.openPlaylist(p.id));
      box.appendChild(c);
    });
  };

  HP.Lib = L;
})(window);
