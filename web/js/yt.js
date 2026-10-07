/* ============================================================
   HashPlayer · yt.js — YouTube support

   A YouTube page is not a media file: the actual audio/video is served as
   signed adaptive streams that a <video> tag cannot touch. The supported
   (and only reliable) way to play one is YouTube's own IFrame player, so
   that is what we embed — and then we wrap it in an object that quacks
   exactly like an HTMLMediaElement, so the rest of HashPlayer (transport,
   seek bar, queue, lyrics, sleep timer, media session…) keeps working
   without knowing anything about YouTube.

   What is NOT possible with an embed, by design, in any browser:
   the equaliser / visualiser / reverb — the audio never enters our
   Web Audio graph, so those controls are shown as unavailable.
   ============================================================ */
(function (w) {
  'use strict';
  const HP = (w.HP = w.HP || {});
  const YT = {};
  HP.YT = YT;

  const API = 'https://www.youtube.com/iframe_api';

  /* ---------------- url parsing ---------------- */
  YT.parse = function (raw) {
    const s = String(raw || '').trim();
    if (!s) return null;
    let u;
    try { u = new URL(s.indexOf('//') < 0 ? 'https://' + s : s); } catch (e) { return null; }
    const host = u.hostname.toLowerCase().replace(/^(?:www|m|music)\./, '');
    const yt = host === 'youtube.com' || host === 'youtu.be' || host === 'youtube-nocookie.com';
    if (!yt) return null;

    let id = '';
    if (host === 'youtu.be') id = u.pathname.slice(1).split('/')[0];
    else if (u.searchParams.get('v')) id = u.searchParams.get('v');
    else {
      const m = decodeURIComponent(u.pathname).match(/\/(?:shorts|embed|v|live)\/([^/?#]+)/i);
      if (m) id = m[1];
      // YouTube sometimes shares an attribution_link whose real watch URL is
      // carried in the `u` parameter rather than directly in `v`.
      if (!id) {
        const nested = u.searchParams.get('u') || '';
        const vm = nested.match(/[?&]v=([\w-]{6,20})/i);
        if (vm) id = vm[1];
      }
    }
    try { id = decodeURIComponent(id).split(/[?#&/]/)[0]; } catch (e) { }
    if (!/^[\w-]{6,20}$/.test(id)) return null;

    let t = 0;
    const tp = u.searchParams.get('t') || u.searchParams.get('start') || '';
    const tm = String(tp).match(/^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s?)?$/);
    if (tm) t = (+tm[1] || 0) * 3600 + (+tm[2] || 0) * 60 + (+tm[3] || 0);

    return { id, start: t, list: u.searchParams.get('list') || '', url: 'https://www.youtube.com/watch?v=' + id };
  };

  YT.isYouTube = url => !!YT.parse(url);
  YT.thumb = id => 'https://i.ytimg.com/vi/' + id + '/hqdefault.jpg';

  /* ============================================================
     online search

     Inside the Android app the shell asks YouTube's own API (no key, no
     account) and hands back the rows — no CORS, no proxy, no tracking.
     In a plain browser that request is blocked by CORS, so there we try a
     couple of public, CORS-enabled mirrors instead and quietly give up if
     none answer. Either way nothing is searched unless the user types.
     ============================================================ */
  const native = () => {
    const n = w.HashNative;
    try { return (n && typeof n.ytSearch === 'function') ? n : null; } catch (e) { return null; }
  };
  YT.canSearch = () => !!(native() || (typeof fetch === 'function'));

  const waiting = new Map();
  /** Called from Kotlin with the rows for one request id. */
  YT.deliver = function (reqId, json) {
    const job = waiting.get(reqId);
    if (!job) return;
    waiting.delete(reqId);
    clearTimeout(job.timer);
    let rows = [];
    try { rows = JSON.parse(json) || []; } catch (e) { }
    job.resolve(rows.map(normalise).filter(Boolean));
  };

  function normalise(r) {
    if (!r || !r.id) return null;
    return {
      id: String(r.id),
      title: String(r.title || 'YouTube video'),
      author: String(r.author || 'YouTube'),
      duration: String(r.duration || ''),
      seconds: +r.seconds || hms(r.duration),
      views: String(r.views || ''),
      published: String(r.published || ''),
      thumb: String(r.thumb || YT.thumb(r.id)),
      live: !!r.live
    };
  }
  function hms(s) {
    const parts = String(s || '').split(':').map(n => parseInt(n, 10));
    if (!parts.length || parts.some(isNaN)) return 0;
    return parts.reduce((a, b) => a * 60 + b, 0);
  }

  let seq = 0;
  function searchNative(q) {
    const n = native();
    if (!n) return Promise.reject(new Error('no bridge'));
    return new Promise((resolve, reject) => {
      const id = 'q' + (++seq);
      const timer = setTimeout(() => { waiting.delete(id); reject(new Error('timeout')); }, 12000);
      waiting.set(id, { resolve, timer });
      try { n.ytSearch(q, id); }
      catch (e) { waiting.delete(id); clearTimeout(timer); reject(e); }
    });
  }

  /* public mirrors for the browser/PWA build — best effort, never required */
  const MIRRORS = [
    { url: q => 'https://pipedapi.kavin.rocks/search?filter=videos&q=' + encodeURIComponent(q), map: pipedRows },
    { url: q => 'https://pipedapi.adminforge.de/search?filter=videos&q=' + encodeURIComponent(q), map: pipedRows },
    { url: q => 'https://inv.nadeko.net/api/v1/search?type=video&q=' + encodeURIComponent(q), map: invidiousRows }
  ];
  function pipedRows(d) {
    const list = (d && (d.items || d)) || [];
    return list.filter(x => x && (x.url || x.videoId)).map(x => {
      const id = x.videoId || String(x.url || '').split('v=')[1] || '';
      return {
        id, title: x.title, author: x.uploaderName || x.uploader, seconds: x.duration,
        duration: fmt(x.duration), views: x.views ? short(x.views) + ' views' : '',
        published: x.uploadedDate || '', thumb: x.thumbnail || YT.thumb(id),
        live: !!x.isLive || x.duration < 0
      };
    });
  }
  function invidiousRows(d) {
    return (d || []).filter(x => x && x.videoId).map(x => ({
      id: x.videoId, title: x.title, author: x.author, seconds: x.lengthSeconds,
      duration: fmt(x.lengthSeconds), views: x.viewCount ? short(x.viewCount) + ' views' : '',
      published: x.publishedText || '',
      thumb: (x.videoThumbnails && x.videoThumbnails[0] && x.videoThumbnails[0].url) || YT.thumb(x.videoId),
      live: !!x.liveNow
    }));
  }
  const fmt = s => {
    s = Math.max(0, Math.round(+s || 0));
    const h = Math.floor(s / 3600), m = Math.floor(s % 3600 / 60), x = s % 60;
    return (h ? h + ':' + String(m).padStart(2, '0') : m) + ':' + String(x).padStart(2, '0');
  };
  const short = n => n >= 1e9 ? (n / 1e9).toFixed(1) + 'B' : n >= 1e6 ? (n / 1e6).toFixed(1) + 'M'
    : n >= 1e3 ? (n / 1e3).toFixed(1) + 'K' : String(n);

  async function searchMirrors(q) {
    for (const m of MIRRORS) {
      try {
        const ctrl = typeof AbortController === 'function' ? new AbortController() : null;
        const t = setTimeout(() => ctrl && ctrl.abort(), 7000);
        const res = await fetch(m.url(q), { signal: ctrl ? ctrl.signal : undefined, mode: 'cors' });
        clearTimeout(t);
        if (!res.ok) continue;
        const rows = m.map(await res.json()).map(normalise).filter(Boolean);
        if (rows.length) return rows;
      } catch (e) { /* try the next mirror */ }
    }
    throw new Error('unreachable');
  }

  /** Search YouTube. Resolves with [] rather than throwing when simply nothing matched. */
  YT.search = async function (query) {
    const q = String(query || '').trim();
    if (q.length < 2) return [];
    if (native()) {
      try {
        const rows = await searchNative(q);
        if (rows.length) return rows;
      } catch (e) { /* fall through to the mirrors */ }
    }
    return searchMirrors(q);
  };

  /* ---------------- iframe api loader ---------------- */
  let apiPromise = null;
  function loadAPI() {
    if (apiPromise) return apiPromise;
    apiPromise = new Promise((resolve, reject) => {
      if (w.YT && w.YT.Player) return resolve(w.YT);
      const prev = w.onYouTubeIframeAPIReady;
      const timer = setTimeout(() => reject(new Error('offline')), 12000);
      w.onYouTubeIframeAPIReady = function () {
        clearTimeout(timer);
        if (typeof prev === 'function') { try { prev(); } catch (e) { } }
        resolve(w.YT);
      };
      const s = document.createElement('script');
      s.src = API;
      s.async = true;
      s.onerror = () => { clearTimeout(timer); reject(new Error('blocked')); };
      document.head.appendChild(s);
    });
    apiPromise.catch(() => { apiPromise = null; });   // allow a retry when the network returns
    return apiPromise;
  }
  YT.preload = () => { try { loadAPI(); } catch (e) { } };

  /* ---------------- fake TimeRanges ---------------- */
  function ranges(end) {
    return { length: end > 0 ? 1 : 0, start: () => 0, end: () => end };
  }

  /* ============================================================
     YTMedia — an HTMLMediaElement look-alike backed by the embed
     ============================================================ */
  function YTMedia(mount) {
    const self = this;
    const bus = document.createDocumentFragment();   // tiny event target that works everywhere

    let player = null, ready = false, videoId = '', wanted = null;
    let paused = true, ended = false, rate = 1, vol = 1, muted = false;
    let dur = 0, pos = 0, loaded = 0, pollId = 0, lastState = -1;
    let captionTracks = [], captionTimer = 0;

    this.__yt = true;
    this.mount = mount;
    this.captionsAvailable = () => captionTracks.length > 0;

    /* --- event plumbing (addEventListener / removeEventListener) --- */
    this.addEventListener = (k, fn, o) => bus.addEventListener(k, fn, o);
    this.removeEventListener = (k, fn, o) => bus.removeEventListener(k, fn, o);
    function fire(name) { try { bus.dispatchEvent(new Event(name)); } catch (e) { } }

    /* --- element-ish no-ops so shared code can stay shared --- */
    this.load = function () { };
    this.removeAttribute = function () { };
    this.setAttribute = function () { };
    this.appendChild = function () { };
    this.requestPictureInPicture = function () { return Promise.reject(new Error('unsupported')); };
    Object.defineProperty(this, 'textTracks', { get: () => ({ length: 0 }) });
    Object.defineProperty(this, 'error', { get: () => null });
    Object.defineProperty(this, 'videoWidth', { get: () => 1280 });
    Object.defineProperty(this, 'videoHeight', { get: () => 720 });
    Object.defineProperty(this, 'readyState', { get: () => (ready && dur > 0 ? 4 : 0) });
    Object.defineProperty(this, 'buffered', { get: () => ranges(loaded * dur) });
    Object.defineProperty(this, 'seekable', { get: () => ranges(dur) });
    Object.defineProperty(this, 'paused', { get: () => paused });
    Object.defineProperty(this, 'ended', { get: () => ended });
    Object.defineProperty(this, 'duration', { get: () => dur || NaN });
    Object.defineProperty(this, 'src', {
      get: () => videoId ? 'https://www.youtube.com/watch?v=' + videoId : '',
      set: () => { }
    });
    Object.defineProperty(this, 'style', { get: () => ({}) });

    Object.defineProperty(this, 'currentTime', {
      get: () => pos,
      set: v => {
        pos = Math.max(0, +v || 0);
        if (player && ready) { try { player.seekTo(pos, true); } catch (e) { } }
        else wanted = pos;
        fire('timeupdate');
      }
    });
    Object.defineProperty(this, 'volume', {
      get: () => vol,
      set: v => { vol = Math.max(0, Math.min(1, +v || 0)); apply(); }
    });
    Object.defineProperty(this, 'muted', {
      get: () => muted,
      set: v => { muted = !!v; apply(); }
    });
    Object.defineProperty(this, 'playbackRate', {
      get: () => rate,
      set: v => {
        rate = +v || 1;
        if (player && ready) { try { player.setPlaybackRate(rate); } catch (e) { } }
        fire('ratechange');
      }
    });

    function apply() {
      if (!player || !ready) return;
      try {
        player.setVolume(Math.round(vol * 100));
        if (muted) player.mute(); else player.unMute();
      } catch (e) { }
    }

    /** Query the IFrame API's own captions module. The module is loaded after
       video metadata, so retry a few short times before declaring no CC. */
    function scanCaptions(attempt) {
      if (!player || !ready) return;
      const forVideo = videoId;
      try { player.loadModule && player.loadModule('captions'); } catch (e) { }
      clearTimeout(captionTimer);
      captionTimer = setTimeout(() => {
        if (!player || !ready || videoId !== forVideo) return;
        let list = [];
        try {
          const value = player.getOption && player.getOption('captions', 'tracklist');
          if (Array.isArray(value)) list = value.filter(x => x && x.languageCode);
        } catch (e) { }
        if (!list.length && (attempt || 0) < 4) { scanCaptions((attempt || 0) + 1); return; }
        captionTracks = list;
        fire('captionschange');
      }, attempt ? 180 : 80);
    }

    /* --- polling: YouTube has no timeupdate event --- */
    function startPoll() {
      stopPoll();
      pollId = setInterval(() => {
        if (!player || !ready) return;
        try {
          const t = player.getCurrentTime() || 0;
          const d = player.getDuration() || 0;
          loaded = player.getVideoLoadedFraction() || 0;
          if (d && Math.abs(d - dur) > .4) { dur = d; fire('durationchange'); fire('loadedmetadata'); }
          if (Math.abs(t - pos) > .05) { pos = t; fire('timeupdate'); }
          fire('progress');
        } catch (e) { }
      }, 250);
    }
    function stopPoll() { if (pollId) { clearInterval(pollId); pollId = 0; } }

    function onState(e) {
      const s = e.data;
      if (s === lastState) return;
      lastState = s;
      if (s === 1) {              // playing
        paused = false; ended = false;
        document.body.classList.remove('buffering');
        fire('playing'); fire('play');
      } else if (s === 2) {       // paused
        paused = true; fire('pause');
      } else if (s === 0) {       // ended
        paused = true; ended = true; fire('ended');
      } else if (s === 3) {       // buffering
        document.body.classList.add('buffering');
        fire('waiting');
      } else if (s === 5) {
        fire('loadedmetadata');
      }
    }

    /** Point the embed at a video id. Resolves when the player is usable. */
    this.setVideo = function (id, startAt, autoplay) {
      videoId = id;
      pos = startAt || 0;
      dur = 0; loaded = 0; ended = false; lastState = -1;
      captionTracks = [];
      clearTimeout(captionTimer);
      self.mount.hidden = false;
      return loadAPI().then(api => new Promise((resolve, reject) => {
        const fail = setTimeout(() => reject(new Error('timeout')), 15000);
        const done = () => { clearTimeout(fail); resolve(self); };

        if (player && ready) {
          try {
            player.loadVideoById({ videoId: id, startSeconds: pos });
            apply();
            player.setPlaybackRate(rate);
            startPoll();
            scanCaptions(0);
            return done();
          } catch (e) { try { player.destroy(); } catch (e2) { } player = null; ready = false; }
        }

        const host = document.createElement('div');
        self.mount.innerHTML = '';
        self.mount.appendChild(host);
        player = new api.Player(host, {
          videoId: id,
          host: 'https://www.youtube.com',
          playerVars: {
            autoplay: autoplay ? 1 : 0, controls: 0, disablekb: 1, fs: 0, rel: 0,
            /* Captions are explicitly driven by HashPlayer's CC button. */
            cc_load_policy: 0, modestbranding: 1, iv_load_policy: 3, playsinline: 1,
            start: Math.floor(pos) || 0, origin: location.origin
          },
          events: {
            onReady: () => {
              ready = true;
              apply();
              try { player.setPlaybackRate(rate); } catch (e) { }
              try { dur = player.getDuration() || 0; } catch (e) { }
              if (wanted != null) { try { player.seekTo(wanted, true); } catch (e) { } wanted = null; }
              startPoll();
              scanCaptions(0);
              fire('loadedmetadata');
              done();
            },
            onStateChange: onState,
            onApiChange: () => { if (!captionTracks.length) scanCaptions(0); },
            onError: ev => {
              clearTimeout(fail);
              const why = { 2: 'bad link', 5: 'player error', 100: 'video removed or private', 101: 'embedding disabled by the uploader', 150: 'embedding disabled by the uploader' };
              reject(new Error(why[ev.data] || 'cannot be played'));
            }
          }
        });
      }));
    };

    this.play = function () {
      if (!player || !ready) return Promise.reject(new Error('not ready'));
      try { player.playVideo(); } catch (e) { return Promise.reject(e); }
      paused = false;
      return Promise.resolve();
    };
    this.pause = function () {
      paused = true;
      if (player && ready) { try { player.pauseVideo(); } catch (e) { } }
      fire('pause');
    };
    this.stop = function () {
      stopPoll();
      paused = true;
      self.mount.hidden = true;
      if (player) { try { player.stopVideo(); } catch (e) { } }
    };
    this.destroy = function () {
      stopPoll();
      if (player) { try { player.destroy(); } catch (e) { } }
      player = null; ready = false;
      self.mount.innerHTML = '';
      self.mount.hidden = true;
    };
    /**
     * Captions for the official IFrame fallback. This is YouTube's captions
     * module, not a downloaded/uploaded sidecar. The API exposes tracks only
     * after the module is loaded, so select the user's language on the next
     * task after asking it to load.
     */
    this.setCaptions = function (on) {
      if (!player || !ready) return false;
      try {
        if (!on) {
          player.unloadModule && player.unloadModule('captions');
          return true;
        }
        if (!captionTracks.length) return false;
        player.loadModule && player.loadModule('captions');
        try {
          const lang = String((navigator.language || 'en').split('-')[0]).toLowerCase();
          const track = captionTracks.find(x => String(x.languageCode || '').toLowerCase() === lang) ||
            captionTracks.find(x => String(x.languageCode || '').toLowerCase().startsWith('en')) || captionTracks[0];
          if (track && track.languageCode) player.setOption('captions', 'track', { languageCode: track.languageCode });
          player.setOption && player.setOption('captions', 'reload', true);
        } catch (e) { return false; }
        return true;
      } catch (e) { return false; }
    };

    /** Title reported by YouTube once loaded, so the library row is not just an id. */
    this.info = function () {
      try {
        const d = player && player.getVideoData && player.getVideoData();
        return d && d.title ? { title: d.title, author: d.author || '' } : null;
      } catch (e) { return null; }
    };
  }

  YT.media = mount => new YTMedia(mount);
})(window);
