/* ============================================================
   HashPlayer · ytbrowse.js — search, browse, play and download
   YouTube without ever leaving the app.

   HashPlayer has no Google API key and no server of its own, so the
   catalogue comes from the public, open-source YouTube front-end APIs
   (Piped and Invidious). They are plain CORS-enabled JSON endpoints:
   we ask the first one that answers, and remember it for next time.

   Playback itself still runs through YouTube's own IFrame player
   (js/yt.js) — that is the only way an embed is allowed to play, and
   it keeps the uploader's view count honest. Downloads use the stream
   URLs the same APIs hand out, passed to Android's download manager.
   ============================================================ */
(function (w) {
  'use strict';
  const HP = w.HP, S = HP.S, $ = HP.$, $$ = HP.$$, el = HP.el, icon = HP.icon;
  const T = {};
  HP.Tube = T;

  /* ---------------- instances ---------------- */
  const PIPED = [
    'https://pipedapi.kavin.rocks',
    'https://pipedapi.leptons.xyz',
    'https://pipedapi.nosebs.ru',
    'https://pipedapi-libre.kavin.rocks',
    'https://piped-api.privacy.com.de',
    'https://pipedapi.adminforge.de',
    'https://api.piped.yt',
    'https://pipedapi.drgns.space',
    'https://pipedapi.owo.si',
    'https://pipedapi.ducks.party',
    'https://piped-api.codespace.cz',
    'https://pipedapi.reallyaweso.me',
    'https://api.piped.private.coffee',
    'https://pipedapi.darkness.services',
    'https://pipedapi.orangenet.cc'
  ];
  /* Invidious only works here when the instance enables both its API and CORS. */
  const INVIDIOUS = [
    'https://invidious.f5.si',
    'https://inv.nadeko.net',
    'https://invidious.nerdvpn.de',
    'https://yewtu.be'
  ];
  const LS_API = 'hashplayer.yt.api';

  function remembered() {
    try { return JSON.parse(localStorage.getItem(LS_API) || 'null'); } catch (e) { return null; }
  }
  function remember(kind, base) {
    try { localStorage.setItem(LS_API, JSON.stringify({ kind, base, at: Date.now() })); } catch (e) { }
  }
  T.forget = () => { try { localStorage.removeItem(LS_API); } catch (e) { } };
  T.current = () => remembered();

  function order() {
    const list = [];
    const mine = (S.ytApi || '').trim().replace(/\/+$/, '');
    if (mine) list.push({ kind: /invidious|yewtu|inv\./i.test(mine) ? 'inv' : 'piped', base: mine });
    const r = remembered();
    if (r && r.base) list.push(r);
    PIPED.forEach(b => list.push({ kind: 'piped', base: b }));
    INVIDIOUS.forEach(b => list.push({ kind: 'inv', base: b }));
    const seen = new Set();
    return list.filter(x => x && x.base && !seen.has(x.base) && seen.add(x.base));
  }

  async function getJSON(url, ms) {
    const ctl = new AbortController();
    const to = setTimeout(() => ctl.abort(), ms || 9000);
    try {
      const r = await fetch(url, { signal: ctl.signal, headers: { accept: 'application/json' } });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return await r.json();
    } finally { clearTimeout(to); }
  }

  /** Try each instance in turn until one answers with usable data. */
  async function ask(path, parse) {
    if (!navigator.onLine) throw new Error('offline');
    let lastErr = null;
    for (const inst of order()) {
      const url = path(inst);
      if (!url) continue;
      try {
        const data = await getJSON(url);
        const out = parse(data, inst);
        if (out && (!Array.isArray(out) || out.length)) { remember(inst.kind, inst.base); return out; }
        lastErr = new Error('empty');
      } catch (e) { lastErr = e; }
    }
    throw lastErr || new Error('no instance answered');
  }

  /* ---------------- shaping the two API dialects ---------------- */
  const secs = v => (typeof v === 'number' && v > 0 ? v : 0);

  function fromPiped(items) {
    return (items || [])
      .filter(i => (i.type ? i.type === 'stream' : true) && (i.url || i.id))
      .map(i => {
        const id = (i.url || '').split('v=')[1] || i.id || '';
        if (!id) return null;
        return {
          id,
          title: i.title || 'Untitled',
          author: i.uploaderName || i.uploader || '',
          duration: secs(i.duration),
          views: i.views || 0,
          thumb: i.thumbnail || HP.YT.thumb(id),
          uploaded: i.uploadedDate || ''
        };
      }).filter(Boolean);
  }

  function fromInvidious(items) {
    return (items || [])
      .filter(i => (i.type ? i.type === 'video' : true) && i.videoId)
      .map(i => ({
        id: i.videoId,
        title: i.title || 'Untitled',
        author: i.author || '',
        duration: secs(i.lengthSeconds),
        views: i.viewCount || 0,
        thumb: (i.videoThumbnails && i.videoThumbnails.length
          ? (i.videoThumbnails.find(t => t.quality === 'medium') || i.videoThumbnails[0]).url
          : HP.YT.thumb(i.videoId)),
        uploaded: i.publishedText || ''
      }));
  }

  T.search = function (q) {
    const term = encodeURIComponent(String(q || '').trim());
    return ask(
      inst => inst.kind === 'piped'
        ? inst.base + '/search?q=' + term + '&filter=videos'
        : inst.base + '/api/v1/search?q=' + term + '&type=video',
      (d, inst) => inst.kind === 'piped' ? fromPiped(d.items || d) : fromInvidious(d)
    );
  };

  T.trending = function (region) {
    const r = (region || 'US').toUpperCase();
    return ask(
      inst => inst.kind === 'piped'
        ? inst.base + '/trending?region=' + r
        : inst.base + '/api/v1/trending?region=' + r,
      (d, inst) => inst.kind === 'piped' ? fromPiped(d) : fromInvidious(d)
    );
  };

  /** Direct media URLs for one video — used for downloading. */
  T.streams = function (id) {
    return ask(
      inst => inst.kind === 'piped'
        ? inst.base + '/streams/' + id
        : inst.base + '/api/v1/videos/' + id,
      (d, inst) => {
        if (inst.kind === 'piped') {
          const video = (d.videoStreams || []).filter(v => !v.videoOnly && v.url).map(v => ({
            label: (v.quality || '') + ' ' + (v.format || ''),
            height: parseInt(v.quality, 10) || 0,
            url: v.url, mime: v.mimeType || 'video/mp4', size: v.contentLength || 0
          }));
          const audio = (d.audioStreams || []).filter(a => a.url).map(a => ({
            label: Math.round((a.bitrate || 0) / 1000) + ' kbps ' + (a.format || ''),
            bitrate: a.bitrate || 0,
            url: a.url, mime: a.mimeType || 'audio/mp4', size: a.contentLength || 0
          }));
          if (!video.length && !audio.length) return null;
          return { title: d.title || '', author: d.uploader || '', duration: secs(d.duration), video, audio };
        }
        const video = (d.formatStreams || []).filter(v => v.url).map(v => ({
          label: (v.qualityLabel || v.quality || '') + ' mp4',
          height: parseInt(v.qualityLabel, 10) || 0,
          url: v.url, mime: v.type || 'video/mp4', size: +v.clen || 0
        }));
        const audio = (d.adaptiveFormats || [])
          .filter(a => a.url && String(a.type || '').indexOf('audio') === 0)
          .map(a => ({
            label: Math.round((+a.bitrate || 0) / 1000) + ' kbps',
            bitrate: +a.bitrate || 0,
            url: a.url, mime: a.type || 'audio/mp4', size: +a.clen || 0
          }));
        if (!video.length && !audio.length) return null;
        return { title: d.title || '', author: d.author || '', duration: secs(d.lengthSeconds), video, audio };
      }
    );
  };

  /* =========================================================
     library glue
     ========================================================= */
  T.toTrack = async function (item) {
    const t = await HP.Lib.addUrl('https://www.youtube.com/watch?v=' + item.id);
    if (!t) return null;
    let dirty = false;
    if (item.title && t.title !== item.title) { t.title = item.title; t.name = item.title; dirty = true; }
    if (item.author && t.artist !== item.author) { t.artist = item.author; dirty = true; }
    if (item.duration && !t.duration) { t.duration = item.duration; dirty = true; }
    if (item.thumb && t.thumb !== item.thumb) { t.thumb = item.thumb; dirty = true; }
    if (dirty) { HP.Lib.saveTrack(t); HP.emit('track-updated', t); }
    return t;
  };

  T.play = async function (item) {
    const t = await T.toTrack(item);
    if (!t) { HP.toast('Could not open that video', 'err'); return; }
    HP.Lib.render();
    HP.Player.context = 'YouTube';
    await HP.Player.playTrack(t.id, [t.id]);
    HP.UI.openNP(true);
  };

  /* =========================================================
     downloading
     ========================================================= */
  const safeName = s => String(s || 'video').replace(/[\\/:*?"<>|\r\n\t]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 90);

  T.downloadSheet = async function (item) {
    const box = $('#ytdl-body');
    $('#ytdl-title').textContent = item.title || 'Download';
    box.innerHTML = '';
    box.appendChild(el('p', { class: 'muted', text: 'Fetching available formats…' }));
    HP.UI.sheet('sheet-ytdl');
    let info;
    try { info = await T.streams(item.id); }
    catch (e) {
      box.innerHTML = '';
      box.appendChild(el('p', { class: 'muted', text: 'No download source answered. Try again, or set a different instance in Settings → YouTube.' }));
      return;
    }
    box.innerHTML = '';

    const pick = (label, sub, stream, kind) => {
      const b = el('button', { class: 'yt-dl-row' }, [
        icon(kind === 'audio' ? 'music' : 'video'),
        el('span', {}, [el('b', { text: label }), el('i', { text: sub })]),
        icon('install')
      ]);
      b.addEventListener('click', () => {
        HP.UI.closeAll();
        T.grab(stream.url, safeName(item.title) + (kind === 'audio' ? '.m4a' : '.mp4'), stream.mime || (kind === 'audio' ? 'audio/mp4' : 'video/mp4'));
      });
      box.appendChild(b);
    };

    const vids = (info.video || []).sort((a, b) => (b.height || 0) - (a.height || 0)).slice(0, 5);
    const auds = (info.audio || []).sort((a, b) => (b.bitrate || 0) - (a.bitrate || 0)).slice(0, 2);
    if (!vids.length && !auds.length) {
      box.appendChild(el('p', { class: 'muted', text: 'This video offers no downloadable stream.' }));
      return;
    }
    vids.forEach(v => pick('Video · ' + (v.label || v.height + 'p'), v.size ? HP.fmtBytes(v.size) : 'mp4', v, 'video'));
    auds.forEach(a => pick('Audio only · ' + a.label, a.size ? HP.fmtBytes(a.size) : 'm4a', a, 'audio'));
    box.appendChild(el('p', { class: 'muted small', text: 'Downloads are saved to Music/HashPlayer or Movies/HashPlayer and appear in your library after the next scan.' }));
  };

  T.grab = function (url, name, mime) {
    if (HP.Native && HP.Native.available && HP.Native.call('canDownload')) {
      const ok = HP.Native.call('download', url, name, mime || '');
      if (ok === false) HP.toast('Download could not be started', 'err');
      return;
    }
    try {
      const a = document.createElement('a');
      a.href = url; a.download = name; a.rel = 'noopener'; a.target = '_blank';
      document.body.appendChild(a); a.click(); a.remove();
      HP.toast('Saving “' + name + '”…');
    } catch (e) { HP.toast('Download is only available in the Android app', 'err'); }
  };

  /** Download whatever is playing right now (used by the now-playing menu). */
  T.downloadCurrent = function () {
    const t = HP.Player.current;
    if (!t) { HP.toast('Play something first'); return; }
    if (t.source === 'yt') {
      T.downloadSheet({ id: t.ytId, title: t.title || t.name });
      return;
    }
    if (t.source === 'url' && t.url) {
      T.grab(t.url, safeName(t.title || t.name) + (t.kind === 'video' ? '.mp4' : '.mp3'), '');
      return;
    }
    HP.toast('That file is already on your device', 'ok');
  };

  /* =========================================================
     the view
     ========================================================= */
  let lastQuery = '', busy = false, results = [];

  function statusLine(msg, spin) {
    const box = $('#yt-status');
    if (!box) return;
    box.hidden = !msg;
    box.innerHTML = '';
    if (!msg) return;
    if (spin) box.appendChild(el('span', { class: 'spinner' }));
    box.appendChild(el('span', { text: msg }));
  }

  function resultCard(item) {
    const art = el('div', { class: 'yt-art' }, [
      el('img', { src: item.thumb, alt: '', loading: 'lazy', decoding: 'async' }),
      item.duration ? el('span', { class: 'badge dur', text: HP.fmtTime(item.duration) }) : null
    ].filter(Boolean));

    const dl = el('button', { class: 'icon-btn tiny', title: 'Download' }, [icon('install')]);
    dl.addEventListener('click', e => { e.stopPropagation(); T.downloadSheet(item); });
    const add = el('button', { class: 'icon-btn tiny', title: 'Add to library' }, [icon('plus')]);
    add.addEventListener('click', async e => {
      e.stopPropagation();
      const t = await T.toTrack(item);
      if (t) { HP.Lib.render(); HP.toast('Added to library', 'ok'); }
    });

    const c = el('div', { class: 'yt-card', tabindex: '0' }, [
      art,
      el('div', { class: 'yt-meta' }, [
        el('div', { class: 'yt-title', text: item.title }),
        el('div', { class: 'yt-sub', text: (item.author || 'YouTube') + (item.views ? ' · ' + HP.fmtCount(item.views) + ' views' : '') })
      ]),
      el('div', { class: 'yt-actions' }, [add, dl])
    ]);
    c.addEventListener('click', () => T.play(item));
    c.addEventListener('keydown', e => { if (e.key === 'Enter') T.play(item); });
    return c;
  }

  function renderResults(list) {
    const grid = $('#yt-grid');
    grid.innerHTML = '';
    results = list || [];
    results.forEach(i => grid.appendChild(resultCard(i)));
    const empty = $('#yt-empty');
    empty.classList.toggle('show', !results.length);
    empty.hidden = !!results.length;
  }

  T.run = async function (q) {
    if (busy) return;
    const term = String(q || '').trim();
    busy = true;
    statusLine(term ? 'Searching YouTube…' : 'Loading trending videos…', true);
    try {
      const list = term ? await T.search(term) : await T.trending(S.ytRegion || 'US');
      lastQuery = term;
      renderResults(list);
      statusLine('');
      if (!list.length) statusLine('Nothing found for “' + term + '”');
    } catch (e) {
      renderResults([]);
      statusLine(
        navigator.onLine
          ? 'No YouTube source answered. Tap Retry, pick another source in Settings → YouTube, or open the YouTube app and use Share → HashPlayer.'
          : 'You are offline — YouTube needs a connection.'
      );
      if (navigator.onLine) {
        const b = el('button', { class: 'btn small', text: 'Open YouTube app' });
        b.addEventListener('click', () => {
          if (HP.Native && HP.Native.available) HP.Native.call('openExternal', 'https://m.youtube.com');
          else w.open('https://m.youtube.com', '_blank', 'noopener');
        });
        $('#yt-status').appendChild(b);
      }
    } finally { busy = false; }
  };

  /** Called once from app.js boot. */
  T.init = function () {
    const input = $('#yt-search');
    if (!input) return;
    const go = () => T.run(input.value);
    $('#yt-go').addEventListener('click', go);
    input.addEventListener('keydown', e => { if (e.key === 'Enter') go(); });
    $('#yt-clear').addEventListener('click', () => { input.value = ''; T.run(''); input.focus(); });
    $('#yt-refresh').addEventListener('click', () => { T.forget(); T.run(input.value); });
    $('#yt-paste').addEventListener('click', async () => {
      let text = '';
      try { text = await navigator.clipboard.readText(); } catch (e) { }
      if (!text) { HP.UI.sheet('sheet-url'); setTimeout(() => $('#url-input').focus(), 300); return; }
      const yt = HP.YT.parse(text);
      if (yt) T.play({ id: yt.id, title: 'YouTube video', thumb: HP.YT.thumb(yt.id) });
      else { input.value = text; T.run(text); }
    });
    $$('#yt-chips .chip').forEach(c => c.addEventListener('click', () => {
      $$('#yt-chips .chip').forEach(x => x.classList.toggle('active', x === c));
      const q = c.dataset.q || '';
      input.value = q;
      T.run(q);
    }));
  };

  /** First time the tab is opened, fill it with something to look at. */
  T.opened = function () {
    if (!results.length && !busy) T.run(lastQuery);
  };
})(window);
