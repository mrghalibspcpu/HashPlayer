/* ============================================================
   HashPlayer · native.js — ExoPlayer-backed playback (Android app)

   A WebView <video> tag can only decode what Chromium ships, and every
   device file has to be streamed back into it through the asset loader.
   That combination is why mkv/avi/hevc videos never started, why odd
   files died with "can't be decoded" and why a song could stop after a
   few seconds and refuse to resume.

   Inside the Android app we therefore hand device files to the real
   ExoPlayer engine — exactly what MX Player and friends use — and wrap it
   in something that quacks like an HTMLMediaElement so the rest of the
   player (transport, seek bar, queue, lyrics, sleep timer, Media Session)
   does not need to know the difference.

   The video image is a SurfaceView drawn *behind* the WebView; we simply
   tell the native side where the stage is on screen.
   ============================================================ */
(function (w) {
  'use strict';
  const HP = (w.HP = w.HP || {});
  const N = {};
  HP.NativeMedia = N;

  const bridge = () => w.HashNative;

  /** True only inside the Android shell that ships the ExoPlayer engine. */
  N.available = function () {
    const n = bridge();
    try { return !!(n && n.nativeEngine && n.nativeEngine()); } catch (e) { return false; }
  };

  /** Device-backed tracks (MediaStore scan, "open with") play natively. */
  N.handles = t => !!(t && t.nativeUri && N.available());

  function ranges(end) {
    return { length: end > 0 ? 1 : 0, start: () => 0, end: () => end };
  }

  function NativeMedia() {
    const self = this;
    const bus = document.createDocumentFragment();

    let uri = '', isVideo = false, viewActive = false;
    let pos = 0, dur = 0, buffered = 0, paused = true, ended = false;
    let rate = 1, vol = 1, muted = false, ready = false, failed = null;
    let resizeMode = 'contain', rectTimer = 0, playResolve = null;

    this.__native = true;

    this.addEventListener = (k, fn, o) => bus.addEventListener(k, fn, o);
    this.removeEventListener = (k, fn, o) => bus.removeEventListener(k, fn, o);
    function fire(name) { try { bus.dispatchEvent(new Event(name)); } catch (e) { } }

    /* element-ish no-ops so shared code stays shared */
    this.load = function () { };
    this.removeAttribute = function () { };
    this.setAttribute = function () { };
    this.appendChild = function () { };
    this.requestPictureInPicture = function () { return Promise.reject(new Error('unsupported')); };
    Object.defineProperty(this, 'textTracks', { get: () => ({ length: 0 }) });
    Object.defineProperty(this, 'style', { get: () => ({ setProperty() { } }) });
    Object.defineProperty(this, 'error', { get: () => failed });
    Object.defineProperty(this, 'videoWidth', { get: () => self.vw || 0 });
    Object.defineProperty(this, 'videoHeight', { get: () => self.vh || 0 });
    Object.defineProperty(this, 'readyState', { get: () => (ready ? 4 : 0) });
    Object.defineProperty(this, 'buffered', { get: () => ranges(buffered) });
    Object.defineProperty(this, 'seekable', { get: () => ranges(dur) });
    Object.defineProperty(this, 'paused', { get: () => paused });
    Object.defineProperty(this, 'ended', { get: () => ended });
    Object.defineProperty(this, 'duration', { get: () => dur || NaN });
    Object.defineProperty(this, 'src', { get: () => uri, set: () => { } });
    Object.defineProperty(this, 'preservesPitch', { get: () => true, set: () => { } });
    Object.defineProperty(this, 'crossOrigin', { get: () => null, set: () => { } });

    Object.defineProperty(this, 'currentTime', {
      get: () => pos,
      set: v => {
        pos = Math.max(0, +v || 0);
        try { bridge().nSeek(pos); } catch (e) { }
        fire('timeupdate');
      }
    });
    Object.defineProperty(this, 'volume', {
      get: () => vol,
      set: v => { vol = Math.max(0, Math.min(1, +v || 0)); applyVol(); }
    });
    Object.defineProperty(this, 'muted', {
      get: () => muted,
      set: v => { muted = !!v; applyVol(); }
    });
    Object.defineProperty(this, 'playbackRate', {
      get: () => rate,
      set: v => {
        rate = +v || 1;
        try { bridge().nRate(rate); } catch (e) { }
        fire('ratechange');
      }
    });

    function applyVol() {
      try { bridge().nVolume(muted ? 0 : vol); } catch (e) { }
      fire('volumechange');
    }

    /* ---------- where to draw the video ---------- */
    function pushRect() {
      if (!isVideo) return;
      const stage = document.getElementById('stage');
      if (!stage) return;
      const r = stage.getBoundingClientRect();
      if (r.width < 2 || r.height < 2) return;
      try { bridge().nRect(r.left, r.top, r.width, r.height); } catch (e) { }
    }
    self.pushRect = pushRect;

    function watchRect(on) {
      clearInterval(rectTimer);
      if (!on) return;
      pushRect();
      /* the stage moves with rotation, cinema mode, PiP and panel animations —
         a cheap poll keeps the surface glued to it without hooking every one */
      rectTimer = setInterval(pushRect, 300);
    }

    /** Mount/unmount the native picture with the now-playing route. */
    this.setViewActive = function (on) {
      viewActive = !!on && isVideo;
      document.body.classList.toggle('nv-mode', viewActive);
      watchRect(viewActive);
      try { bridge().nVideoVisible(viewActive); } catch (e) { }
      if (viewActive) requestAnimationFrame(pushRect);
    };

    this.setResizeMode = function (mode) {
      resizeMode = ['cover', 'fill'].indexOf(mode) > -1 ? mode : 'contain';
      try { bridge().nResizeMode(resizeMode); } catch (e) { }
      if (viewActive) pushRect();
    };

    /* ---------- commands ---------- */
    this.setTrack = function (t, startAt, autoplay) {
      const sub = (t.kind === 'video' && t.sub) ? String(t.sub) : '';
      uri = t.nativeUri;
      isVideo = t.kind === 'video';
      pos = startAt || 0; dur = t.duration || 0;
      buffered = 0; ended = false; ready = false; failed = null;
      paused = !autoplay;
      resizeMode = 'contain';
      viewActive = isVideo;
      document.body.classList.toggle('nv-mode', viewActive);
      try { bridge().nLoad(uri, pos, !!autoplay, isVideo, sub); } catch (e) { }
      try {
        bridge().nResizeMode(resizeMode);
        bridge().nRate(rate);
        bridge().nVolume(muted ? 0 : vol);
      } catch (e) { }
      N.pushEq();
      N.pushVis();
      watchRect(viewActive);
      return Promise.resolve(self);
    };

    this.play = function () {
      try { bridge().nPlay(); } catch (e) { return Promise.reject(e); }
      return new Promise(res => { playResolve = res; setTimeout(() => { if (playResolve) { playResolve(); playResolve = null; } }, 400); });
    };
    this.pause = function () {
      paused = true;
      try { bridge().nPause(); } catch (e) { }
    };
    this.stop = function () {
      watchRect(false);
      paused = true;
      viewActive = false;
      document.body.classList.remove('nv-mode');
      showCues('');
      if (HP.Vis && HP.Vis.clearFeed) HP.Vis.clearFeed();
      try { bridge().nVis(false); } catch (e) { }
      try { bridge().nStop(); } catch (e) { }
    };

    /* ---------- state in, from ExoPlayer ---------- */
    this.onState = function (s) {
      if (!s) return;
      if (s.uri && uri && s.uri !== uri) return;        // a stale event from the previous track
      const hadDur = dur;
      if (s.dur > 0) dur = s.dur;
      if (typeof s.pos === 'number') pos = s.pos;
      if (typeof s.buffered === 'number') buffered = s.buffered;
      self.vw = s.vw || 0; self.vh = s.vh || 0;

      switch (s.e) {
        case 'ready':
          ready = true;
          document.body.classList.remove('buffering');
          if (!hadDur || Math.abs(dur - hadDur) > .4) fire('durationchange');
          fire('loadedmetadata');
          fire('canplay');
          pushRect();
          break;
        case 'waiting':
          fire('waiting');
          break;
        case 'play':
          paused = false; ended = false;
          if (playResolve) { playResolve(); playResolve = null; }
          document.body.classList.remove('buffering');
          fire('playing'); fire('play');
          break;
        case 'pause':
          paused = true;
          fire('pause');
          break;
        case 'ended':
          paused = true; ended = true;
          fire('ended');
          break;
        case 'timeupdate':
        case 'tick':
          fire('timeupdate'); fire('progress');
          break;
        case 'seeked':
          fire('timeupdate');
          break;
        case 'resize':
          fire('resize'); pushRect();
          break;
        case 'cues':
          showCues(s.detail || '');
          break;
        case 'fft':
          if (HP.Vis && HP.Vis.feed) HP.Vis.feed(s.fft, s.wave);
          break;
        case 'error':
          failed = { code: 4, message: s.detail || 'playback error' };
          fire('error');
          break;
      }
    };
  }

  /* ---------- subtitle overlay ----------
     ExoPlayer decodes the subtitle track (embedded in the mkv, or the .srt the
     user attached) and hands us the lines; we draw them over the video with the
     same look the <video> cues had. */
  function showCues(text) {
    let box = document.getElementById('nv-cc');
    if (!box) {
      const stage = document.getElementById('stage');
      if (!stage) return;
      box = document.createElement('div');
      box.id = 'nv-cc';
      box.className = 'nv-cc';
      stage.appendChild(box);
    }
    box.textContent = text || '';
    box.hidden = !text;
  }
  N.showCues = showCues;

  /** Mirror the 10-band equaliser onto the device's own audio effects. */
  N.pushEq = function () {
    const n = bridge(); if (!n || !n.nEq) return;
    const S = HP.S || {};
    try { n.nEq(!!S.eqOn, JSON.stringify(S.eqGains || [])); } catch (e) { }
  };

  /** Ask for the spectrum only while a visualiser mode is actually on screen. */
  N.pushVis = function () {
    const n = bridge(); if (!n || !n.nVis) return;
    const want = (HP.S && HP.S.vis && HP.S.vis !== 'off');
    try { n.nVis(!!want); } catch (e) { }
  };

  N.setSubtitles = function (on) {
    const n = bridge(); if (!n || !n.nSubs) return;
    try { n.nSubs(!!on); } catch (e) { }
    if (!on) showCues('');
  };

  N.create = function () { return new NativeMedia(); };
})(window);
