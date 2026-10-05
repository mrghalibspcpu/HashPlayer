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

    this.__yt = true;
    this.mount = mount;

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
            modestbranding: 1, iv_load_policy: 3, playsinline: 1,
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
              fire('loadedmetadata');
              done();
            },
            onStateChange: onState,
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
