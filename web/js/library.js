/* ============================================================
   HashPlayer · library.js — import, metadata pipeline, storage,
   grid rendering, playlists, search / sort / filter,
   and YouTube / stream resolution.
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
      kind, source: 'file', file, handle: null, nativeUri: null, url: null, cover: null, coverUrl: null,
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
      if (ex) {
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

  /* remote URL & YouTube links */
  L.addUrl = async function (url) {
    url = String(url || '').trim();
    if (!/^https?:\/\//i.test(url)) { HP.toast('Enter a valid link (http/https)', 'err'); return null; }

    // Check if YouTube
    if (HP.Meta.isYouTube(url)) {
      HP.toast('Resolving YouTube stream…');
      const yt = await HP.Meta.resolveYouTube(url);
      if (yt) {
        const t = {
          id: HP.uid(), key: url, name: yt.title, title: yt.title, artist: yt.artist || 'YouTube',
          album: 'YouTube', genre: '', year: '', trackNo: '', duration: yt.duration || 0, size: 0,
          mime: 'video/mp4', kind: 'video', source: 'url', file: null, handle: null, nativeUri: null,
          url: yt.streamUrl, origUrl: url, coverUrl: yt.cover, isEmbed: !!yt.isEmbed, youtubeId: yt.id,
          folder: '', added: Date.now(), plays: 0, lastPlayed: 0, fav: false, pos: 0, lrc: null,
          sub: null, bookmarks: [], tagged: true
        };
        L.tracks.set(t.id, t);
        await saveTrack(t);
        HP.emit('library');
        HP.toast('YouTube video added 🎉', 'ok');
        return t;
      }
    }

    const name = decodeURIComponent(url.split('/').pop().split('?')[0]) || 'Stream';
    const kind = HP.kindOf(name) === 'video' ? 'video' : (HP.kindOf(name) || 'audio');
    const g = HP.splitArtistTitle(name);
    const t = {
      id: HP.uid(), key: url, name, title: g.title || name, artist: g.artist || new URL(url).hostname,
      album: '', genre: '', year: '', trackNo: '', duration: 0, size: 0, mime: '', kind,
      source: 'url', file: null, handle: null, nativeUri: null, url, origUrl: url, cover: null, coverUrl: null,
      folder: '', added: Date.now(), plays: 0, lastPlayed: 0, fav: false, pos: 0, lrc: null,
      sub: null, bookmarks: [], tagged: true
    };
    L.tracks.set(t.id, t);
    await saveTrack(t);
    HP.emit('library');
    HP.toast('Stream added', 'ok');
    return t;
  };

  L.addAndPlayUrl = async function (url) {
    const t = await L.addUrl(url);
    if (t) {
      await HP.Player.playTrack(t.id, [t.id]);
      if (HP.UI) HP.UI.openNP(true);
    }
  };

  /* Android native scan (MediaStore via APK bridge) */
  L.addNative = async function (items) {
    const known = new Map(); L.tracks.forEach(t => { if (t.nativeUri) known.set(t.nativeUri, t); });
    const add = [];
    (items || []).forEach(it => {
      if (known.has(it.uri)) return;
      const g = HP.splitArtistTitle(it.name || 'Track');
      const thumbUrl = it.thumb || (it.uri ? it.uri.replace('/media/', '/thumbnail/') : null);
      add.push({
        id: HP.uid(), key: it.uri, name: it.name || 'Track', title: it.title || g.title,
        artist: it.artist || g.artist || '', album: it.album || '', genre: '', year: '', trackNo: '',
        duration: (it.duration || 0) / 1000, size: it.size || 0, mime: it.mime || '',
        kind: it.kind || 'audio', source: 'native', file: null, handle: null, nativeUri: it.uri,
        url: null, coverUrl: thumbUrl, cover: null, folder: it.folder || '', added: Date.now(),
        plays: 0, lastPlayed: 0, fav: false, pos: 0, lrc: null, sub: null, bookmarks: [], tagged: true
      });
    });
    add.forEach(t => L.tracks.set(t.id, t));
    if (add.length) await DB.bulkPut('tracks', add);
    HP.emit('library');
    if (add.length) {
      HP.toast(add.length + ' tracks found on device', 'ok');
    }
    return add;
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
          if (m.duration && !t.duration) t.duration = m.duration;
          t.tagged = true;
          changed++;
          if (changed % 4 === 0) saveSoon();
          HP.emit('track-updated', t);
        }
      } catch (e) { }
    }
    if (changed) saveSoon();
    working = false;
  }

  async function fileOf(t) {
    if (t.file) return t.file;
    if (t.handle) {
      try {
        const f = await t.handle.getFile();
        t.file = f;
        return f;
      } catch (e) { return null; }
    }
    return null;
  }

  /* ---------------- resolution for <audio>/<video> src ---------------- */
  const srcCache = new Map();
  L.resolveSrc = async function (t) {
    if (!t) return null;
    if (t.nativeUri) return t.nativeUri;
    if (t.source === 'url' && t.url) {
      // Re-resolve YouTube stream if needed
      if (t.youtubeId && (!t.url || t.url.includes('googlevideo.com'))) {
        try {
          const fresh = await HP.Meta.resolveYouTube(t.origUrl || t.youtubeId);
          if (fresh && fresh.streamUrl) {
            t.url = fresh.streamUrl;
            t.isEmbed = fresh.isEmbed;
            saveTrack(t);
          }
        } catch (_) {}
      }
      return t.url;
    }
    if (srcCache.has(t.id)) return srcCache.get(t.id);
    const f = await fileOf(t);
    if (!f) return null;
    let u;
    try { u = URL.createObjectURL(f); } catch (e) { return null; }
    srcCache.set(t.id, u);
    if (srcCache.size > 20) {
      const k = srcCache.keys().next().value;
      URL.revokeObjectURL(srcCache.get(k)); srcCache.delete(k);
    }
    return u;
  };

  /* cover art object URLs (LRU) */
  const coverCache = new Map();
  L.coverUrl = function (t) {
    if (!t) return null;
    if (t.coverUrl) return t.coverUrl;
    if (!t.cover) return null;
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
    if (cu) {
      const img = el('img', { src: cu, alt: '', loading: 'lazy' });
      img.onerror = () => {
        img.remove();
        if (!art.querySelector('.ph')) {
          art.appendChild(icon(isVid ? 'video' : 'music', 'ph'));
        }
      };
      art.appendChild(img);
    } else {
      art.appendChild(icon(isVid ? 'video' : 'music', 'ph'));
    }

    const badges = el('div', { class: 'card-badges' });
    if (isVid) badges.appendChild(el('span', { class: 'badge v', text: 'VIDEO' }));
    if (t.source === 'url') badges.appendChild(el('span', { class: 'badge', text: t.album === 'YouTube' ? 'YT' : 'LINK' }));
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
      grid.appendChild(el('div', { class: 'no-results' }, [
        el('b', { text: 'Nothing matched “' + L.search + '”' }),
        el('span', { text: 'Try a different word, or clear the search to see everything.' })
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
