/* ============================================================
   HashPlayer · player.js — playback engine, now-playing UI,
   queue, gestures, lyrics, subtitles, Media Session
   ============================================================ */
(function (w) {
  'use strict';
  const HP = w.HP, S = HP.S, $ = HP.$, $$ = HP.$$, el = HP.el, icon = HP.icon, clamp = HP.clamp;
  const L = () => HP.Lib, E = () => HP.Engine;

  const P = {
    a: null, b: null, active: null, current: null,
    queue: [], order: [], index: -1, context: 'Library',
    ab: { a: null, b: null }, sleep: null, wake: null, lyrics: null, lrcIndex: -1, wantPlaying: false,
    pendingSrc: null, crossing: false, speedHold: false, brightness: 1, zoom: 1
  };

  /* =========================================================
     setup
     ========================================================= */
  P.init = function () {
    P.a = $('#media');
    P.b = el('audio', { preload: 'none', playsinline: '' });
    P.b.style.display = 'none';
    document.body.appendChild(P.b);
    P.active = P.a;
    P.y = HP.YT ? HP.YT.media($('#yt-mount')) : null;     // YouTube embed, disguised as a media element
    [P.a, P.b].forEach(bind);
    if (P.y) bind(P.y);
    P.a.volume = 1; P.b.volume = 1;
    HP.Vis.init($('#vis'));
    HP.Vis.visible = () => $('#np').classList.contains('on') && !document.body.classList.contains('yt-mode');
    HP.Vis.Energy.attach($('#energy'));
    HP.Vis.setMode(S.vis);
    bindUI();
    bindGestures();
    mediaSession();
    tick();
  };

  function bind(m) {
    m.addEventListener('play', () => { if (m === P.active) onPlay(); });
    m.addEventListener('pause', () => { if (m === P.active) onPause(); });
    m.addEventListener('ended', () => { if (m === P.active) onEnded(); });
    m.addEventListener('timeupdate', () => { if (m === P.active) onTime(); });
    m.addEventListener('progress', () => { if (m === P.active) drawBuffer(); });
    m.addEventListener('loadedmetadata', () => { if (m === P.active) onMeta(); });
    m.addEventListener('error', () => { if (m === P.active) onError(); });
    m.addEventListener('waiting', () => { if (m === P.active) document.body.classList.add('buffering'); });
    m.addEventListener('stalled', () => { if (m === P.active) Heal.stalledAt = Date.now(); });
    m.addEventListener('abort', () => { if (m === P.active && P.wantPlaying) heal('abort'); });
    m.addEventListener('playing', () => document.body.classList.remove('buffering'));
    m.addEventListener('ratechange', () => { if (m === P.active) updateSpeedLabel(); });
    m.addEventListener('volumechange', () => { });
  }

  /* =========================================================
     self-healing playback  —  why this exists
     ---------------------------------------------------------
     On Android the audio/video bytes travel from a content:// file
     through the shell's loopback HTTP server into the WebView. Any
     hiccup on that path (the OS trimming memory, the device dozing,
     a provider dropping a descriptor) used to surface as a dead media
     element and a scary "re-open the file" message. A native player
     would simply re-open the stream and carry on at the same second —
     so that is exactly what HashPlayer does now.
     ========================================================= */
  const Heal = { tries: 0, last: 0, busy: false, stalledAt: 0, pos: 0, moved: 0, resumed: 0 };
  P.Heal = Heal;

  async function heal(why) {
    const t = P.current;
    if (!t || Heal.busy || P.crossing) return false;
    const m = P.active;
    if (!m || isYT(m) || t.source === 'yt') return false;
    const err = m.error;
    if (err && err.code === 4 && !Heal.tries) {            // genuinely unsupported format
      HP.toast('This file’s format is not supported', 'err');
      return false;
    }
    const dur = m.duration || t.duration || 0;
    const pos = m.currentTime || t.pos || 0;
    if (dur && pos >= dur - 1.2) return false;             // it really did reach the end
    if (!t.nativeUri && t.source !== 'url' && !t.file && !t.handle) return false;

    const now = Date.now();
    if (now - Heal.last > 30000) Heal.tries = 0;
    if (Heal.tries >= 5) {
      Heal.tries = 0; Heal.last = now;
      HP.toast('Playback keeps dropping — skipping to the next track', 'err');
      setTimeout(() => P.next(true), 400);
      return false;
    }
    Heal.tries++; Heal.last = now; Heal.busy = true;
    const wasPlaying = P.wantPlaying;
    console.warn('[heal]', why, 'at', pos.toFixed(1) + 's', 'attempt', Heal.tries);

    let src = null;
    try { src = await L().resolveSrc(t, true, true); } catch (e) { }
    if (!src) { Heal.busy = false; return false; }

    const done = () => {
      try { if (pos > 0.6) m.currentTime = Math.max(0, pos - 0.3); } catch (e) { }
      if (wasPlaying) { const pr = m.play(); if (pr && pr.catch) pr.catch(() => { }); }
      Heal.busy = false; Heal.moved = Date.now(); Heal.stalledAt = 0;
    };
    try {
      m.src = src;
      m.load();
      if (m.readyState >= 1) done();
      else m.addEventListener('loadedmetadata', done, { once: true });
    } catch (e) { Heal.busy = false; }
    setTimeout(() => { Heal.busy = false; }, 9000);        // never get stuck "healing"
    return true;
  }
  P.heal = heal;

  /* A heartbeat that runs even when the screen is off (rAF does not). */
  setInterval(function watchdog() {
    const t = P.current, m = P.active;
    if (!t || !m || isYT(m)) return;
    const now = Date.now();

    /* 1. we think we are playing but the element went quiet by itself */
    if (P.wantPlaying && m.paused && !Heal.busy && !P.crossing) {
      if (now - Heal.resumed > 2500) {
        Heal.resumed = now;
        const pr = m.play();
        if (pr && pr.catch) pr.catch(() => { });
      }
      return;
    }
    if (!P.wantPlaying || m.paused) { Heal.pos = m.currentTime || 0; Heal.moved = now; return; }

    /* 2. the clock is frozen although nothing is paused → the stream died */
    const cur = m.currentTime || 0;
    if (Math.abs(cur - Heal.pos) > 0.08) { Heal.pos = cur; Heal.moved = now; return; }
    const stuckFor = now - (Heal.moved || now);
    const buffering = document.body.classList.contains('buffering') || m.readyState < 3;
    if (stuckFor > (buffering ? 9000 : 6000)) { Heal.moved = now; heal(buffering ? 'stall' : 'frozen'); }
  }, 1500);

  /* Coming back from PiP / lock screen: pick playback straight back up. */
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) return;
    const m = P.active;
    if (P.wantPlaying && m && !isYT(m) && m.paused && !Heal.busy) {
      const pr = m.play(); if (pr && pr.catch) pr.catch(() => { });
    }
  });

  /* =========================================================
     loading & playback
     ========================================================= */
  const isYT = m => !!(m && m.__yt);
  function gain(m, v) { if (!isYT(m)) E().elementGain(m, v); }
  function fade(m, to, ms) { return isYT(m) ? Promise.resolve() : E().fadeElement(m, to, ms); }

  async function ensureAudio() {
    await E().resume();
    E().attach(P.a); E().attach(P.b);
    E().applyAll();
  }

  P.playTrack = async function (id, ids, startAt) {
    const t = L().get(id);
    if (!t) return;
    if (ids && ids.length) { P.queue = ids.slice(); buildOrder(); }
    if (P.queue.indexOf(id) < 0) { P.queue.push(id); buildOrder(); }
    P.index = P.queue.indexOf(id);
    await load(t, true, startAt);
    renderQueue();
  };

  P.playList = function (ids, shuffle) {
    if (!ids || !ids.length) { HP.toast('Nothing to play'); return; }
    P.queue = ids.slice();
    if (shuffle) { S.shuffle = true; HP.save(); }
    buildOrder();
    const first = S.shuffle ? P.order[0] : 0;
    P.index = first;
    load(L().get(P.queue[first]), true);
    renderQueue(); syncToggles();
  };

  function buildOrder() {
    const n = P.queue.length;
    P.order = Array.from({ length: n }, (_, i) => i);
    if (S.shuffle) {
      /* weighted shuffle — favourites and rarely played first, current stays put */
      const score = i => {
        const t = L().get(P.queue[i]) || {};
        return Math.random() * (1 + (t.fav ? .45 : 0) + 1 / (1 + (t.plays || 0)));
      };
      P.order.sort((x, y) => score(y) - score(x));
    }
  }

  async function load(t, autoplay, startAt) {
    if (!t) return;
    const src = await L().resolveSrc(t);
    if (!src) {
      HP.toast('“' + (t.title || t.name) + '” needs to be re-opened', 'err');
      HP.Lib.countRelink(); HP.Lib.render();
      return;
    }
    await ensureAudio();

    const isVideo = t.kind === 'video';
    const yt = t.source === 'yt';

    if (yt && !P.y) { HP.toast('YouTube playback is unavailable here', 'err'); return; }
    if (!yt && P.y) P.y.stop();                     // leaving YouTube → tear the embed down
    document.body.classList.toggle('yt-mode', yt);

    if (yt) {
      P.a.pause(); if (P.b) P.b.pause();
      P.current = t; P.active = P.y;
      document.body.classList.add('has-video');
      paintNowPlaying(t);
      if (HP.UI && !$('#np').classList.contains('on')) HP.UI.openNP(true);
      loadLyrics(t);
      P.ab = { a: null, b: null }; updateAB(); renderMarks();
      HP.emit('track-changed', t);
      highlightCards(); renderQueue();
      try {
        await P.y.setVideo(t.ytId, startAt != null ? startAt : (S.resume ? t.pos || 0 : 0));
        P.y.playbackRate = S.speed;
        P.y.volume = S.volume; P.y.muted = S.muted;
        if (autoplay) await P.y.play();
        const info = P.y.info();
        if (info && info.title && t.title !== info.title) {
          t.title = info.title; t.name = info.title;
          t.artist = info.author || t.artist;
          L().saveTrack(t); paintNowPlaying(t); HP.emit('track-updated', t);
        }
      } catch (err) {
        const why = (err && err.message) || 'failed';
        HP.toast(why === 'offline' || why === 'blocked'
          ? 'YouTube needs an internet connection'
          : 'This video ' + why, 'err');
      }
      return;
    }

    let target = P.a;
    if (!isVideo && P.crossing && P.active === P.a) target = P.b;     // crossfade lands on B
    if (!P.crossing) {
      if (target === P.a && P.b && !P.b.paused) P.b.pause();
      if (target === P.b && !P.a.paused) P.a.pause();
    }

    P.current = t;
    P.active = target;
    target.playbackRate = S.speed;
    if ('preservesPitch' in target) target.preservesPitch = S.pitch;
    /* native files now arrive from the loopback server (a different origin), so the
       element needs CORS for the Web Audio graph — the server allows it explicitly. */
    if (t.source === 'url' || t.nativeUri) target.crossOrigin = 'anonymous';
    else target.removeAttribute('crossorigin');
    if (target.src !== src) { target.src = src; target.load(); }
    Heal.tries = 0; Heal.busy = false; Heal.pos = -1; Heal.moved = Date.now(); Heal.stalledAt = 0;
    P.wantPlaying = !!autoplay;

    document.body.classList.toggle('has-video', isVideo);
    gain(target, S.fade && autoplay ? 0 : 1);

    const pos = startAt != null ? startAt : (S.resume && t.pos > 3 && (!t.duration || t.pos < t.duration - 8) ? t.pos : 0);
    const go = () => {
      try { if (pos) target.currentTime = pos; } catch (e) { }
      if (autoplay) target.play().then(() => {
        if (S.fade) fade(target, 1, 420); else gain(target, 1);
      }).catch(err => {
        console.warn('[play]', err);
        if (err && err.name === 'NotAllowedError') HP.toast('Tap play to start (browser autoplay rules)');
      });
    };
    if (target.readyState >= 1) go();
    else target.addEventListener('loadedmetadata', go, { once: true });

    /* subtitles */
    $$('track', P.a).forEach(n => n.remove());
    if (isVideo && t.sub) addSubtitle(t.sub);
    /* lyrics */
    loadLyrics(t);
    /* energy timeline */
    HP.Vis.Energy.load(t.id, await HP.DB.kvGet('energy:' + t.id, null));
    /* bookmarks + a/b */
    P.ab = { a: null, b: null }; updateAB();
    renderMarks();

    paintNowPlaying(t);
    /* a video you cannot see is just an awkward podcast — open the player for it */
    if (isVideo && HP.UI && !$('#np').classList.contains('on')) HP.UI.openNP(true);
    HP.emit('track-changed', t);
    highlightCards();
    renderQueue();
  }
  P.load = load;

  function reportVideo() {
    try {
      const n = window.HashNative;
      if (!n || !n.setVideoState) return;
      const v = document.body.classList.contains('has-video');
      n.setVideoState(v, P.a.videoWidth || 1280, P.a.videoHeight || 720);
    } catch (e) { }
  }
  P.reportVideo = reportVideo;

  function onMeta() {
    const t = P.current; if (!t) return;
    reportVideo();
    const m = P.active;
    if (isFinite(m.duration) && m.duration > 0 && Math.abs((t.duration || 0) - m.duration) > .6) {
      t.duration = m.duration; L().saveTrack(t); HP.emit('track-updated', t);
    }
    if (t.kind === 'video' && m.videoWidth) {
      const r = m.videoWidth / m.videoHeight;
      document.body.style.setProperty('--rotscale', clamp(1 / r, .35, 1).toFixed(3));
    }
    updateTimes();
  }

  function onError() {
    const t = P.current; if (!t) return;
    const err = P.active.error;
    console.warn('[media error]', err && err.code, t.name);
    /* Device files and links are re-opened automatically — a dropped stream is not
       the user's problem, and it is certainly not a reason to forget the file. */
    if (t.nativeUri || t.source === 'url' || t.file || t.handle) {
      heal('error').then(ok => {
        /* only a browser-handed file that really vanished still needs the user */
        if (!ok && !t.nativeUri && t.source !== 'url' && P.current === t) {
          t.file = null;
          HP.Lib.countRelink(); HP.Lib.render();
          HP.toast('File unavailable — re-open it from your device', 'err');
        }
      });
      return;
    }
    HP.Lib.countRelink(); HP.Lib.render();
    HP.toast('File unavailable — re-open it from your device', 'err');
  }

  P.toggle = function () {
    if (!P.current) {
      const ids = L().contextIds();
      if (ids.length) P.playList(ids);
      return;
    }
    P.active.paused ? P.play() : P.pause();
  };
  P.play = async function () {
    if (!P.current) return;
    P.wantPlaying = true;
    await ensureAudio();
    try {
      await P.active.play();
      if (S.fade) fade(P.active, 1, 300);
    } catch (e) { HP.toast('Tap play again to allow audio'); }
  };
  P.pause = function () {
    if (!P.current) return;
    P.wantPlaying = false;
    if (S.fade && E().ready && !isYT(P.active)) {
      fade(P.active, 0, 220).then(() => { P.active.pause(); gain(P.active, 1); });
      onPause();
    } else P.active.pause();
  };
  P.stop = function () {
    P.wantPlaying = false;
    P.active.pause(); try { P.active.currentTime = 0; } catch (e) { }
  };

  function onPlay() {
    document.body.classList.add('playing');
    $$('#btn-play use, #mini-play use').forEach(u => u.setAttribute('href', '#i-pause'));
    HP.Vis.start();
    if ('mediaSession' in navigator) navigator.mediaSession.playbackState = 'playing';
    keepAwake(true);
    HP.Native && HP.Native.notify && HP.Native.notify(true);
    HP.emit('playing', true);
  }
  function onPause() {
    document.body.classList.remove('playing');
    $$('#btn-play use, #mini-play use').forEach(u => u.setAttribute('href', '#i-play'));
    if ('mediaSession' in navigator) navigator.mediaSession.playbackState = 'paused';
    keepAwake(false);
    savePos();
    HP.Native && HP.Native.notify && HP.Native.notify(false);
    HP.emit('playing', false);
  }
  function onEnded() {
    const m = P.active, cur = (m && m.currentTime) || 0;
    const full = (m && m.duration) || (P.current && P.current.duration) || 0;
    if (P.current && full > 5 && cur < full - 2.5 && !isYT(m)) {
      if (heal('early-end')) return;               // the file "ended" 4 minutes early → reopen it
    }
    const t = P.current;
    if (t) { t.pos = 0; t.plays = (t.plays || 0) + 1; t.lastPlayed = Date.now(); L().saveTrack(t); }
    saveEnergy();
    if (P.sleep && P.sleep.endTrack) { P.cancelSleep(); HP.toast('Sleep timer: stopped'); return; }
    if (S.repeat === 'one') { P.seek(0); P.play(); return; }
    P.next(true);
  }

  /* =========================================================
     navigation
     ========================================================= */
  P.next = function (auto) {
    if (!P.queue.length) return;
    const oi = P.order.indexOf(P.index);
    let ni = oi + 1;
    if (ni >= P.order.length) {
      if (S.repeat === 'all' || !auto) { buildOrder(); ni = 0; }
      else { P.pause(); HP.toast('End of queue'); return; }
    }
    if (auto && !S.autoplayNext) { P.pause(); return; }
    P.index = P.order[ni];
    load(L().get(P.queue[P.index]), true);
  };
  P.prev = function () {
    if (!P.queue.length) return;
    if (P.active.currentTime > 4) { P.seek(0); return; }
    const oi = P.order.indexOf(P.index);
    const ni = oi - 1 < 0 ? P.order.length - 1 : oi - 1;
    P.index = P.order[ni];
    load(L().get(P.queue[P.index]), true);
  };
  P.seek = function (t) {
    if (!P.current) return;
    const d = P.active.duration || P.current.duration || 0;
    try { P.active.currentTime = clamp(t, 0, d ? d - .15 : t); } catch (e) { }
    onTime();
  };
  P.seekBy = function (d) {
    if (!P.current) return;
    P.seek((P.active.currentTime || 0) + d);
    flashGfx(d > 0 ? 'ff' : 'rw', (d > 0 ? '+' : '') + Math.round(d) + 's');
  };
  P.setSpeed = function (v) {
    S.speed = clamp(v, .25, 4); HP.save();
    [P.a, P.b, P.y].forEach(m => { if (!m) return; m.playbackRate = S.speed; if ('preservesPitch' in m) m.preservesPitch = S.pitch; });
    updateSpeedLabel();
  };
  function updateSpeedLabel() {
    const l = $('#speed-label'); if (l) l.textContent = S.speed.toFixed(S.speed % 1 ? (S.speed * 100 % 10 ? 2 : 1) : 1).replace(/0$/, '0') + '×';
    const t = $('#t-speed'); if (t) t.classList.toggle('on', S.speed !== 1);
    const r = $('#speed-range'); if (r) { r.value = Math.round(S.speed * 100); rangeFill(r); }
    $$('#speed-chips .chip').forEach(c => c.classList.toggle('active', +c.dataset.sp === S.speed));
  }
  P.cycleRepeat = function () {
    S.repeat = S.repeat === 'off' ? 'all' : S.repeat === 'all' ? 'one' : 'off';
    HP.save(); syncToggles();
    HP.toast('Repeat: ' + (S.repeat === 'off' ? 'off' : S.repeat === 'all' ? 'all tracks' : 'this track'));
  };
  P.toggleShuffle = function () {
    S.shuffle = !S.shuffle; HP.save(); buildOrder(); syncToggles();
    HP.toast('Shuffle ' + (S.shuffle ? 'on — smart order' : 'off'));
    renderQueue();
  };
  function syncToggles() {
    const r = $('#btn-rep'), s = $('#btn-shuf');
    if (r) { r.classList.toggle('on', S.repeat !== 'off'); r.querySelector('use').setAttribute('href', S.repeat === 'one' ? '#i-repeat1' : '#i-repeat'); }
    if (s) s.classList.toggle('on', S.shuffle);
  }
  P.syncToggles = syncToggles;

  /* =========================================================
     queue
     ========================================================= */
  P.addNext = function (id) {
    const at = P.index + 1;
    P.queue.splice(at, 0, id); buildOrder(); renderQueue();
    HP.toast('Playing next');
  };
  P.addLast = function (id) {
    P.queue.push(id); buildOrder(); renderQueue();
    HP.toast('Added to queue');
  };
  P.removeFromQueue = function (i) {
    if (i === P.index) return;
    P.queue.splice(i, 1);
    if (i < P.index) P.index--;
    buildOrder(); renderQueue();
  };
  P.clearQueue = function () {
    const cur = P.queue[P.index];
    P.queue = cur ? [cur] : []; P.index = cur ? 0 : -1; buildOrder(); renderQueue();
  };

  function renderQueue() {
    const box = $('#q-list'); if (!box) return;
    box.innerHTML = '';
    $('#q-count').textContent = P.queue.length;
    if (!P.queue.length) {
      box.appendChild(el('div', { class: 'q-empty', text: 'Queue is empty. Play something from your library.' }));
      return;
    }
    const seq = S.shuffle ? P.order.slice() : P.queue.map((_, i) => i);
    seq.forEach(qi => {
      const t = L().get(P.queue[qi]); if (!t) return;
      const cu = L().coverUrl(t);
      const art = cu ? el('img', { class: 'q-art', src: cu, alt: '' }) : el('div', { class: 'q-art' }, [icon(t.kind === 'video' ? 'video' : 'music')]);
      const rm = el('button', { class: 'icon-btn' }, [icon('x')]);
      rm.addEventListener('click', e => { e.stopPropagation(); P.removeFromQueue(qi); });
      const row = el('div', {
        class: 'q-item' + (qi === P.index ? ' now' : ''), draggable: 'true', 'data-i': qi
      }, [
        el('span', { class: 'q-handle' }, [icon('drag')]), art,
        el('div', { class: 'q-meta' }, [
          el('b', { text: t.title || t.name }),
          el('small', { text: (t.artist || '—') + ' · ' + (t.duration ? HP.fmtTime(t.duration) : '—') })
        ]), rm
      ]);
      row.addEventListener('click', () => { P.index = qi; load(t, true); });
      dragRow(row, box);
      box.appendChild(row);
    });
  }
  P.renderQueue = renderQueue;

  let dragSrc = null;
  function dragRow(row, box) {
    row.addEventListener('dragstart', e => { dragSrc = +row.dataset.i; row.classList.add('dragging'); e.dataTransfer.effectAllowed = 'move'; });
    row.addEventListener('dragend', () => { row.classList.remove('dragging'); $$('.q-item', box).forEach(r => r.classList.remove('drag-over')); });
    row.addEventListener('dragover', e => { e.preventDefault(); row.classList.add('drag-over'); });
    row.addEventListener('dragleave', () => row.classList.remove('drag-over'));
    row.addEventListener('drop', e => {
      e.preventDefault(); row.classList.remove('drag-over');
      const to = +row.dataset.i;
      if (dragSrc == null || dragSrc === to) return;
      const cur = P.queue[P.index];
      const [m] = P.queue.splice(dragSrc, 1);
      P.queue.splice(to, 0, m);
      P.index = P.queue.indexOf(cur);
      buildOrder(); renderQueue();
    });
  }

  /* =========================================================
     now playing UI
     ========================================================= */
  function paintNowPlaying(t) {
    const cu = L().coverUrl(t);
    $('#np-title').textContent = t.title || t.name;
    $('#np-artist').textContent = [t.artist, t.album].filter(Boolean).join(' · ') || (t.kind === 'video' ? 'Video' : 'Unknown artist');
    $('#np-context').textContent = P.context;
    $('#mini-title').textContent = t.title || t.name;
    $('#mini-artist').textContent = t.artist || (t.kind === 'video' ? 'Video' : 'Unknown artist');
    $('#minibar').hidden = false;
    $('#np-fav').classList.toggle('on', !!t.fav);
    $('#mini-fav').classList.toggle('on', !!t.fav);

    const disc = $('#art-disc'), img = $('#art-img'), mini = $('#mini-art'), mimg = $('#mini-img'), bg = $('#np-bg-img');
    if (cu) {
      img.src = cu; disc.classList.add('has-img');
      mimg.src = cu; mini.classList.add('has-img');
      bg.src = cu; bg.classList.add('on');
      if (S.autoTheme) tintFrom(img);
    } else {
      img.removeAttribute('src'); disc.classList.remove('has-img');
      mimg.removeAttribute('src'); mini.classList.remove('has-img');
      bg.classList.remove('on');
      if (S.autoTheme) clearTint();
    }
    mini.classList.toggle('has-vid', t.kind === 'video' && !cu);
    updateTimes();
    setMediaSession(t, cu);
  }

  let tintTimer;
  function tintFrom(img) {
    clearTimeout(tintTimer);
    tintTimer = setTimeout(() => {
      const run = () => {
        const pal = HP.paletteFrom(img);
        if (!pal) return clearTint();
        document.body.style.setProperty('--a1', pal[0]);
        document.body.style.setProperty('--a2', pal[1]);
        HP.emit('theme');
      };
      img.complete && img.naturalWidth ? run() : img.addEventListener('load', run, { once: true });
    }, 60);
  }
  function clearTint() {
    document.body.style.removeProperty('--a1');
    document.body.style.removeProperty('--a2');
    HP.emit('theme');
  }
  P.clearTint = clearTint;

  function highlightCards() {
    $$('.card.playing').forEach(c => c.classList.remove('playing'));
    if (!P.current) return;
    const c = $('.card[data-id="' + P.current.id + '"]');
    if (c) c.classList.add('playing');
  }
  P.highlightCards = highlightCards;

  /* ---------- progress loop ---------- */
  let lastSave = 0, lastEnergy = 0, lastMini = 0, lastPaint = 0, R = null;
  function refs() {
    return R || (R = {
      fill: $('#seek-fill'), knob: $('#seek-knob'), mini: $('#mini-prog-fill'), np: $('#np')
    });
  }
  let lastTick = 0, lastPct = -1;
  function tick() {
    requestAnimationFrame(tick);
    const m = P.active;
    if (!m || !P.current || document.hidden) return;
    const now = performance.now();
    /* The progress bar only needs ~20 updates a second. Spending a whole
       60 Hz budget on style writes is exactly what makes playback hitch. */
    if (now - lastTick < (m.paused ? 240 : 48)) return;
    lastTick = now;
    const cur = m.currentTime || 0, dur = m.duration || P.current.duration || 0;
    const r = refs();

    if (!P.seeking) {
      const p = dur ? cur / dur : 0;
      const pct = Math.round(p * 2000) / 20;              // 0.05% resolution
      if (pct !== lastPct) {
        lastPct = pct;
        const npOpen = r.np.classList.contains('on');
        if (npOpen) { r.fill.style.width = pct + '%'; r.knob.style.left = pct + '%'; }
        r.mini.style.width = pct + '%';
      }
      if (now - lastPaint > 120 && r.np.classList.contains('on')) { lastPaint = now; HP.Vis.Energy.draw(p); }
    }
    if (now - lastEnergy > 240 && !m.paused) {
      lastEnergy = now;
      HP.Vis.Energy.push(cur, dur);
    }
    if (now - lastMini > 110) { lastMini = now; miniVideoFrame(); }
    syncLyrics(cur);
    checkAB(cur);
    checkCrossfade(cur, dur);
    if (now - lastSave > 4000) { lastSave = now; savePos(); }
    if (P.sleep && P.sleep.at) tickSleep();
  }

  function onTime() { updateTimes(); }
  function updateTimes() {
    const m = P.active, cur = m.currentTime || 0;
    const dur = m.duration || (P.current && P.current.duration) || 0;
    $('#t-cur').textContent = HP.fmtTime(cur);
    $('#t-rem').textContent = dur ? '-' + HP.fmtTime(Math.max(0, dur - cur)) : HP.fmtTime(cur);
    if ('mediaSession' in navigator && navigator.mediaSession.setPositionState && dur && isFinite(dur)) {
      try { navigator.mediaSession.setPositionState({ duration: dur, position: clamp(cur, 0, dur), playbackRate: m.playbackRate || 1 }); } catch (e) { }
    }
  }
  function drawBuffer() {
    const m = P.active, dur = m.duration;
    if (!dur || !m.buffered.length) return;
    let end = 0;
    for (let i = 0; i < m.buffered.length; i++) if (m.buffered.start(i) <= m.currentTime) end = m.buffered.end(i);
    $('#seek-buf').style.width = clamp(end / dur * 100, 0, 100) + '%';
  }
  function savePos() {
    const t = P.current; if (!t) return;
    const c = P.active.currentTime || 0;
    if (Math.abs((t.pos || 0) - c) < 2) return;
    t.pos = c; L().saveTrack(t);
    S.lastId = t.id; S.lastPos = c; HP.save();
    saveEnergy();
  }
  const saveEnergy = HP.throttle(() => {
    const t = P.current, d = HP.Vis.Energy.data();
    if (t && d) HP.DB.kvSet('energy:' + t.id, d);
  }, 9000);

  function miniVideoFrame() {
    const mini = $('#mini-art');
    if (!P.current || P.current.kind !== 'video' || !mini || $('#np').classList.contains('on')) return;
    if (!mini.classList.contains('has-vid')) return;
    if (P.current.source === 'yt' || document.hidden) return;
    const c = $('#mini-vid'), v = P.a;
    if (!v.videoWidth || v.paused) return;
    const ctx = c.getContext('2d');
    try { ctx.drawImage(v, 0, 0, c.width, c.height); } catch (e) { }
  }

  /* =========================================================
     A-B loop, bookmarks, sleep timer
     ========================================================= */
  P.markAB = function () {
    const t = P.active.currentTime || 0;
    if (P.ab.a === null) { P.ab.a = t; HP.toast('Loop start set at ' + HP.fmtTime(t)); }
    else if (P.ab.b === null) {
      if (t <= P.ab.a + .5) { HP.toast('Loop end must be after the start', 'err'); return; }
      P.ab.b = t; HP.toast('A-B loop on · ' + HP.fmtTime(P.ab.a) + ' → ' + HP.fmtTime(t));
    } else { P.ab = { a: null, b: null }; HP.toast('A-B loop cleared'); }
    updateAB();
  };
  function updateAB() {
    const bar = $('#seek-ab'), lbl = $('#ab-label'), tool = $('#t-ab');
    const dur = P.active.duration || (P.current && P.current.duration) || 0;
    if (P.ab.a !== null && P.ab.b !== null && dur) {
      bar.hidden = false;
      bar.style.left = (P.ab.a / dur * 100) + '%';
      bar.style.width = ((P.ab.b - P.ab.a) / dur * 100) + '%';
      lbl.textContent = 'A-B'; tool.classList.add('on');
    } else {
      bar.hidden = true; tool.classList.toggle('on', P.ab.a !== null);
      lbl.textContent = P.ab.a !== null ? 'A…' : 'A-B';
    }
  }
  function checkAB(cur) {
    if (P.ab.a !== null && P.ab.b !== null && cur >= P.ab.b) P.seek(P.ab.a);
  }
  P.addBookmark = function () {
    const t = P.current; if (!t) return;
    const time = P.active.currentTime || 0;
    t.bookmarks = t.bookmarks || [];
    const near = t.bookmarks.findIndex(b => Math.abs(b.t - time) < 2);
    if (near > -1) { t.bookmarks.splice(near, 1); HP.toast('Bookmark removed'); }
    else { t.bookmarks.push({ t: time, label: HP.fmtTime(time) }); t.bookmarks.sort((a, b) => a.t - b.t); HP.toast('Bookmark at ' + HP.fmtTime(time), 'ok'); }
    L().saveTrack(t); renderMarks();
  };
  function renderMarks() {
    const box = $('#seek-marks'); if (!box) return;
    box.innerHTML = '';
    const t = P.current, dur = (P.active && P.active.duration) || (t && t.duration) || 0;
    if (!t || !t.bookmarks || !dur) return;
    t.bookmarks.forEach(b => {
      const i = el('i', { style: 'left:' + clamp(b.t / dur * 100, 0, 100) + '%', title: b.label });
      box.appendChild(i);
    });
  }
  P.renderMarks = renderMarks;

  P.setSleep = function (val) {
    P.cancelSleep();
    if (val === 0 || val === '0') { HP.toast('Sleep timer off'); updateSleepUI(); return; }
    if (val === 'endtrack') { P.sleep = { endTrack: true }; HP.toast('Will stop at the end of this track'); }
    else { P.sleep = { at: Date.now() + val * 60000, mins: val }; HP.toast('Sleep timer: ' + val + ' min'); }
    $('#t-sleep').classList.add('on');
    updateSleepUI();
  };
  P.cancelSleep = function () { P.sleep = null; $('#t-sleep').classList.remove('on'); E().applyVolume(); updateSleepUI(); };
  function tickSleep() {
    const left = P.sleep.at - Date.now();
    if (left <= 0) {
      P.pause(); P.cancelSleep(); HP.toast('Sleep timer — good night 🌙');
      return;
    }
    if (left < 15000 && E().ready) {                 // gentle fade in the last 15s
      E().master.gain.value = (S.muted ? 0 : S.volume * (S.boost / 100)) * (left / 15000);
    }
    updateSleepUI(left);
  }
  function updateSleepUI(left) {
    const box = $('#sleep-state'); if (!box) return;
    if (!P.sleep) { box.hidden = true; return; }
    box.hidden = false;
    box.textContent = P.sleep.endTrack ? 'Stopping at the end of this track'
      : 'Stopping in ' + HP.fmtTime(Math.max(0, (left != null ? left : P.sleep.at - Date.now()) / 1000));
    $$('#sleep-chips .chip').forEach(c => c.classList.toggle('active',
      P.sleep && (P.sleep.endTrack ? c.dataset.min === 'endtrack' : +c.dataset.min === P.sleep.mins)));
  }

  /* =========================================================
     crossfade
     ========================================================= */
  function checkCrossfade(cur, dur) {
    const xf = S.crossfade | 0;
    if (!xf || !dur || P.crossing || P.active.paused || isYT(P.active)) return;
    if (S.repeat === 'one' || !S.autoplayNext) return;
    if (dur - cur > xf || dur - cur <= 0) return;
    const oi = P.order.indexOf(P.index), ni = oi + 1;
    if (ni >= P.order.length && S.repeat !== 'all') return;
    const nextId = P.queue[P.order[ni % P.order.length]];
    const nt = L().get(nextId);
    if (!nt || nt.kind === 'video' || P.current.kind === 'video') return;
    P.crossing = true;
    const from = P.active;
    E().fadeElement(from, 0, xf * 1000);
    load(nt, true).then(() => {
      P.index = P.queue.indexOf(nextId);
      setTimeout(() => { try { from.pause(); E().elementGain(from, 1); } catch (e) { } P.crossing = false; }, xf * 1000 + 120);
    });
  }

  /* =========================================================
     lyrics
     ========================================================= */
  function loadLyrics(t) {
    P.lyrics = t.lrc ? HP.Meta.parseLRC(t.lrc) : null;
    P.lrcIndex = -1;
    const box = $('#lyrics-scroll');
    box.innerHTML = '';
    if (!P.lyrics || !P.lyrics.lines.length) {
      box.appendChild(el('p', { class: 'lrc-empty', text: 'No lyrics loaded. Open the Lyrics tool to add an .lrc file or paste the words.' }));
    } else {
      P.lyrics.lines.forEach((l, i) => {
        const n = el('p', { class: 'lrc-line', text: l.text || '♪' });
        if (l.t !== null) n.addEventListener('click', e => { e.stopPropagation(); P.seek(l.t + (P.lyrics.offset || 0)); });
        box.appendChild(n);
      });
    }
    $('#t-lyrics').classList.toggle('on', !!t.lrc);
  }
  P.loadLyrics = loadLyrics;
  function syncLyrics(cur) {
    if (!P.lyrics || !P.lyrics.synced || $('#lyrics').hidden) return;
    const off = P.lyrics.offset || 0, lines = P.lyrics.lines;
    let i = P.lrcIndex;
    while (i + 1 < lines.length && lines[i + 1].t + off <= cur) i++;
    while (i >= 0 && lines[i].t + off > cur) i--;
    if (i === P.lrcIndex) return;
    P.lrcIndex = i;
    const box = $('#lyrics-scroll'), kids = box.children;
    for (let k = 0; k < kids.length; k++) {
      kids[k].classList.toggle('active', k === i);
      kids[k].classList.toggle('near', Math.abs(k - i) === 1);
    }
    const a = kids[i];
    if (a) box.scrollTo({ top: a.offsetTop - box.clientHeight / 2 + a.clientHeight / 2, behavior: 'smooth' });
  }

  /* =========================================================
     subtitles
     ========================================================= */
  function addSubtitle(vtt) {
    try {
      const blob = new Blob([vtt], { type: 'text/vtt' });
      const tr = el('track', { kind: 'subtitles', label: 'Subtitles', srclang: 'en', default: 'default', src: URL.createObjectURL(blob) });
      P.a.appendChild(tr);
      setTimeout(() => { if (P.a.textTracks[0]) P.a.textTracks[0].mode = 'showing'; }, 60);
      $('#v-cc').classList.add('on');
    } catch (e) { }
  }
  P.addSubtitle = addSubtitle;
  P.toggleCC = function () {
    const tt = P.a.textTracks;
    if (!tt || !tt.length) { HP.toast('No subtitles loaded — add a .srt / .vtt file'); return; }
    const on = tt[0].mode === 'showing';
    for (let i = 0; i < tt.length; i++) tt[i].mode = on ? 'disabled' : 'showing';
    $('#v-cc').classList.toggle('on', !on);
    HP.toast('Subtitles ' + (on ? 'off' : 'on'));
  };

  /* =========================================================
     Media Session + wake lock
     ========================================================= */
  function mediaSession() {
    if (!('mediaSession' in navigator)) return;
    const ms = navigator.mediaSession;
    const set = (k, fn) => { try { ms.setActionHandler(k, fn); } catch (e) { } };
    set('play', () => P.play());
    set('pause', () => P.pause());
    set('previoustrack', () => P.prev());
    set('nexttrack', () => P.next());
    set('seekbackward', d => P.seekBy(-(d && d.seekOffset || S.seekStep)));
    set('seekforward', d => P.seekBy(d && d.seekOffset || S.seekStep));
    set('seekto', d => { if (d && d.seekTime != null) P.seek(d.seekTime); });
    set('stop', () => P.stop());
  }
  function setMediaSession(t, cover) {
    if (!('mediaSession' in navigator)) return;
    try {
      const art = [];
      if (cover) [96, 192, 512].forEach(s => art.push({ src: cover, sizes: s + 'x' + s, type: t.cover.type || 'image/jpeg' }));
      else [192, 512].forEach(s => art.push({ src: 'icons/icon-' + (s === 192 ? '192' : '512') + '.png', sizes: s + 'x' + s, type: 'image/png' }));
      navigator.mediaSession.metadata = new MediaMetadata({
        title: t.title || t.name, artist: t.artist || 'HashPlayer',
        album: t.album || 'HashPlayer', artwork: art
      });
    } catch (e) { }
  }
  async function keepAwake(on) {
    if (!S.keepAwake) return;
    try {
      const n = window.HashNative;
      if (n && n.keepAwake) { n.keepAwake(!!on); return; }   // real window flag beats the web API
    } catch (e) { }
    if (!('wakeLock' in navigator)) return;
    try {
      if (on && !P.wake) { P.wake = await navigator.wakeLock.request('screen'); P.wake.addEventListener('release', () => P.wake = null); }
      else if (!on && P.wake) { await P.wake.release(); P.wake = null; }
    } catch (e) { }
  }
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && !P.active.paused) keepAwake(true);
  });

  /* =========================================================
     seek bar + UI bindings
     ========================================================= */
  function rangeFill(r) {
    const p = (r.value - r.min) / ((r.max - r.min) || 1) * 100;
    r.style.setProperty('--p', p + '%');
  }
  P.rangeFill = rangeFill;

  function bindUI() {
    const seek = $('#seek'), tip = $('#seek-tip');
    const ratio = e => {
      const r = seek.getBoundingClientRect();
      return clamp(((e.clientX - r.left) / r.width), 0, 1);
    };
    const dur = () => P.active.duration || (P.current && P.current.duration) || 0;
    seek.addEventListener('pointerdown', e => {
      if (!P.current) return;
      P.seeking = true; seek.setPointerCapture(e.pointerId); seek.classList.add('drag');
      move(e);
    });
    seek.addEventListener('pointermove', e => {
      if (!P.current) return;
      const r = ratio(e), d = dur();
      tip.hidden = false; tip.style.left = (r * 100) + '%'; tip.textContent = HP.fmtTime(r * d);
      if (P.seeking) move(e);
    });
    seek.addEventListener('pointerleave', () => { if (!P.seeking) tip.hidden = true; });
    seek.addEventListener('pointerup', e => {
      if (!P.seeking) return;
      P.seeking = false; seek.classList.remove('drag'); tip.hidden = true;
      P.seek(ratio(e) * dur());
    });
    seek.addEventListener('pointercancel', () => { P.seeking = false; seek.classList.remove('drag'); tip.hidden = true; });
    function move(e) {
      const r = ratio(e), d = dur();
      $('#seek-fill').style.width = (r * 100) + '%';
      $('#seek-knob').style.left = (r * 100) + '%';
      $('#t-cur').textContent = HP.fmtTime(r * d);
      HP.Vis.Energy.draw(r);
    }

    $('#btn-play').addEventListener('click', () => P.toggle());
    $('#mini-play').addEventListener('click', e => { e.stopPropagation(); P.toggle(); });
    $('#btn-next').addEventListener('click', () => P.next());
    $('#mini-next').addEventListener('click', e => { e.stopPropagation(); P.next(); });
    $('#btn-prev').addEventListener('click', () => P.prev());
    $('#mini-prev').addEventListener('click', e => { e.stopPropagation(); P.prev(); });
    $('#btn-ff').addEventListener('click', () => P.seekBy(S.seekStep));
    $('#btn-rw').addEventListener('click', () => P.seekBy(-S.seekStep));
    $('#btn-rep').addEventListener('click', () => P.cycleRepeat());
    $('#btn-shuf').addEventListener('click', () => P.toggleShuffle());
    $('#np-fav').addEventListener('click', () => { if (P.current) { L().toggleFav(P.current.id); $('#np-fav').classList.toggle('on', P.current.fav); $('#mini-fav').classList.toggle('on', P.current.fav); } });
    $('#mini-fav').addEventListener('click', e => { e.stopPropagation(); if (P.current) { L().toggleFav(P.current.id); $('#np-fav').classList.toggle('on', P.current.fav); $('#mini-fav').classList.toggle('on', P.current.fav); } });

    const vol = $('#mini-vol');
    vol.value = Math.round(S.volume * 100); rangeFill(vol);
    vol.addEventListener('input', () => { E().setVolume(vol.value / 100); rangeFill(vol); S.muted = false; updateMuteIcon(); });
    $('#mini-mute').addEventListener('click', () => { S.muted = !S.muted; HP.save(); E().applyVolume(); updateMuteIcon(); });
    function updateMuteIcon() {
      $('#mini-mute use').setAttribute('href', S.muted || !S.volume ? '#i-mute' : '#i-vol');
    }
    updateMuteIcon();
    HP.on('volume', v => { if (document.activeElement !== vol) { vol.value = Math.round(v * 100); rangeFill(vol); } updateMuteIcon(); });

    /* video tools */
    $('#v-pip').addEventListener('click', () => P.pip());
    $('#v-full').addEventListener('click', () => P.toggleFullscreen());
    const ytOut = $('#v-yt');
    if (ytOut) ytOut.addEventListener('click', () => {
      const t = P.current;
      if (!t || t.source !== 'yt') return;
      const u = 'https://www.youtube.com/watch?v=' + t.ytId;
      if (window.HashNative && window.HashNative.openExternal) window.HashNative.openExternal(u);
      else window.open(u, '_blank', 'noopener');
    });
    $('#v-cc').addEventListener('click', () => P.toggleCC());
    $('#v-shot').addEventListener('click', () => P.screenshot());
    $('#v-mirror').addEventListener('click', () => {
      document.body.classList.toggle('mirror');
      $('#v-mirror').classList.toggle('on', document.body.classList.contains('mirror'));
    });
    const FITS = ['contain', 'cover', 'fill'];
    let fitI = 0;
    $('#v-aspect').addEventListener('click', () => {
      fitI = (fitI + 1) % FITS.length;
      document.body.classList.remove('fit-cover', 'fit-fill');
      if (FITS[fitI] !== 'contain') document.body.classList.add('fit-' + FITS[fitI]);
      HP.toast('Fit: ' + FITS[fitI]);
    });
    let rot = 0;
    $('#v-rotate').addEventListener('click', () => {
      rot = (rot + 90) % 360;
      document.body.classList.remove('rot-90', 'rot-180', 'rot-270');
      if (rot) document.body.classList.add('rot-' + rot);
      HP.toast('Rotated ' + rot + '°');
    });

    $('#t-ab').addEventListener('click', () => P.markAB());
    $('#t-mark').addEventListener('click', () => P.addBookmark());
    $('#t-queue').addEventListener('click', () => HP.UI.toggleQueue());
    $('#mini-queue').addEventListener('click', e => { e.stopPropagation(); HP.UI.toggleQueue(); });
    $('#t-lyrics').addEventListener('click', () => P.toggleLyrics());
    $('#lyrics').addEventListener('click', () => P.toggleLyrics(false));

    syncToggles(); updateSpeedLabel();
  }

  P.toggleLyrics = function (force) {
    const box = $('#lyrics');
    const show = force === undefined ? box.hidden : force;
    box.hidden = !show;
    S.lyricsOn = show; HP.save();
    if (show) { P.lrcIndex = -1; syncLyrics(P.active.currentTime || 0); }
  };

  /**
   * Picture-in-picture.
   * Inside the Android app a WebView cannot do document-PiP, so we ask the
   * Activity to shrink into a real system PiP window instead.
   */
  P.pip = async function () {
    const n = window.HashNative;
    if (n && n.enterPip) {
      try {
        if (n.pipSupported && !n.pipSupported()) { HP.toast('This device has no picture-in-picture', 'err'); return; }
        P.reportVideo();
        n.enterPip();
        return;
      } catch (e) { }
    }
    try {
      if (document.pictureInPictureElement) { await document.exitPictureInPicture(); return; }
      if (P.a.requestPictureInPicture && P.a.videoWidth) { await P.a.requestPictureInPicture(); return; }
      HP.toast('Picture-in-picture is not supported here', 'err');
    } catch (e) { HP.toast('PiP unavailable for this video', 'err'); }
  };

  /** Landscape / portrait lock — real on Android, best-effort in a browser. */
  P.setOrientation = function (mode) {
    const n = window.HashNative;
    if (n && n.setOrientation) { try { n.setOrientation(mode); return true; } catch (e) { } }
    try {
      if (mode === 'auto') { screen.orientation && screen.orientation.unlock && screen.orientation.unlock(); }
      else if (screen.orientation && screen.orientation.lock) screen.orientation.lock(mode).catch(() => { });
      return true;
    } catch (e) { return false; }
  };

  P.toggleFullscreen = function () {
    const node = $('#np');
    if (!document.fullscreenElement) {
      const req = node.requestFullscreen || node.webkitRequestFullscreen;
      if (req) { try { req.call(node); } catch (e) { } }
      document.body.classList.add('cinema');
      try { window.HashNative && window.HashNative.setFullscreen && window.HashNative.setFullscreen(true); } catch (e) { }
      if (P.current && P.current.kind === 'video') P.setOrientation('landscape');
    } else {
      document.exitFullscreen && document.exitFullscreen();
      document.body.classList.remove('cinema');
      try { window.HashNative && window.HashNative.setFullscreen && window.HashNative.setFullscreen(false); } catch (e) { }
      P.setOrientation('auto');
    }
  };
  document.addEventListener('fullscreenchange', () => {
    const fs = !!document.fullscreenElement;
    document.body.classList.toggle('cinema', fs);
    try { window.HashNative && window.HashNative.setFullscreen && window.HashNative.setFullscreen(fs); } catch (e) { }
    $('#v-full').querySelector('use').setAttribute('href', fs ? '#i-collapse' : '#i-expand');
  });
  HP.on('fullscreen-ui', fs => {
    $('#v-full').querySelector('use').setAttribute('href', fs ? '#i-collapse' : '#i-expand');
  });

  P.screenshot = function () {
    const v = P.a;
    if (P.current && P.current.source === 'yt') { HP.toast('YouTube blocks frame capture', 'err'); return; }
    if (!v.videoWidth) { HP.toast('Screenshots work on video only', 'err'); return; }
    try {
      const c = document.createElement('canvas');
      c.width = v.videoWidth; c.height = v.videoHeight;
      c.getContext('2d').drawImage(v, 0, 0);
      c.toBlob(b => {
        if (!b) return HP.toast('Could not capture frame', 'err');
        const a = el('a', { href: URL.createObjectURL(b), download: (HP.baseName(P.current.name) + '_' + Math.floor(v.currentTime) + 's.png') });
        document.body.appendChild(a); a.click();
        setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 2000);
        HP.toast('Frame saved', 'ok');
      }, 'image/png');
    } catch (e) { HP.toast('This video blocks frame capture', 'err'); }
  };

  /* =========================================================
     gestures on the stage
     ========================================================= */
  function flashGfx(ic, text) {
    const g = $('#gfx');
    g.querySelector('use').setAttribute('href', '#i-' + ic);
    $('#gfx-text').textContent = text;
    g.classList.add('on');
    clearTimeout(g._t); g._t = setTimeout(() => g.classList.remove('on'), 650);
  }
  P.flashGfx = flashGfx;
  function showBar(ic, val, pct) {
    const b = $('#gbar');
    $('#gbar-icon').querySelector('use').setAttribute('href', '#i-' + ic);
    $('#gbar-fill').style.width = clamp(pct, 0, 100) + '%';
    $('#gbar-val').textContent = val;
    b.classList.add('on');
    clearTimeout(b._t); b._t = setTimeout(() => b.classList.remove('on'), 800);
  }

  function bindGestures() {
    const stage = $('#stage');
    let st = null, lastTap = 0, tapTimer = null, holdTimer = null, pts = new Map(), pinch0 = 0;

    stage.addEventListener('pointerdown', e => {
      if (e.target.closest('.vtools') || e.target.closest('.lyrics-scroll')) return;
      pts.set(e.pointerId, e);
      if (pts.size === 2) {
        const [p1, p2] = Array.from(pts.values());
        pinch0 = Math.hypot(p1.clientX - p2.clientX, p1.clientY - p2.clientY) / (P.zoom || 1);
        st = null; return;
      }
      const r = stage.getBoundingClientRect();
      st = {
        x: e.clientX, y: e.clientY, t: Date.now(), axis: null,
        side: (e.clientX - r.left) / r.width, w: r.width, h: r.height,
        time0: P.active.currentTime || 0, vol0: S.volume, br0: P.brightness, moved: false
      };
      try { stage.setPointerCapture(e.pointerId); } catch (x) { }
      holdTimer = setTimeout(() => {
        if (st && !st.moved && P.current) {
          P.speedHold = true;
          P.active.playbackRate = Math.min(4, S.speed * 2);
          $('#speed-badge').hidden = false;
          $('#speed-badge').textContent = P.active.playbackRate.toFixed(1) + '× fast forward';
          if (navigator.vibrate) navigator.vibrate(14);
        }
      }, 520);
    });

    stage.addEventListener('pointermove', e => {
      if (pts.has(e.pointerId)) pts.set(e.pointerId, e);
      if (pts.size === 2 && pinch0) {
        if (document.body.classList.contains('yt-mode')) return;   // the embed owns its own frame
        const [p1, p2] = Array.from(pts.values());
        const d = Math.hypot(p1.clientX - p2.clientX, p1.clientY - p2.clientY);
        P.zoom = clamp(d / pinch0, .6, 3);
        P.a.style.transform = 'scale(' + P.zoom.toFixed(3) + ')';
        return;
      }
      if (!st || !S.gestures || !P.current) return;
      const dx = e.clientX - st.x, dy = e.clientY - st.y;
      if (!st.axis) {
        if (Math.abs(dx) > 14 || Math.abs(dy) > 14) {
          st.axis = Math.abs(dx) > Math.abs(dy) ? 'x' : 'y';
          st.moved = true; clearTimeout(holdTimer);
        } else return;
      }
      if (st.axis === 'x') {
        const dur = P.active.duration || P.current.duration || 0;
        const delta = (dx / st.w) * Math.min(180, Math.max(45, dur * .35));
        P.pendingSeek = clamp(st.time0 + delta, 0, dur || 0);
        flashGfx(delta > 0 ? 'ff' : 'rw', (delta > 0 ? '+' : '') + Math.round(delta) + 's · ' + HP.fmtTime(P.pendingSeek));
      } else {
        const frac = -dy / (st.h * .7);
        if (st.side > .5) {
          const v = clamp(st.vol0 + frac, 0, 1);
          E().setVolume(v); S.muted = false;
          showBar(v ? 'vol' : 'mute', Math.round(v * 100) + '%', v * 100);
        } else {
          P.brightness = clamp(st.br0 + frac, .2, 1.8);
          applyBrightness();
          showBar('sun', Math.round(P.brightness * 100) + '%', (P.brightness / 1.8) * 100);
        }
      }
    });

    const end = e => {
      pts.delete(e.pointerId);
      if (pts.size < 2) pinch0 = 0;
      clearTimeout(holdTimer);
      if (P.speedHold) { P.speedHold = false; P.active.playbackRate = S.speed; $('#speed-badge').hidden = true; st = null; return; }
      if (!st) return;
      if (st.axis === 'x' && P.pendingSeek != null) { P.seek(P.pendingSeek); P.pendingSeek = null; st = null; return; }
      if (st.axis) { st = null; return; }
      /* taps */
      const now = Date.now();
      if (now - lastTap < 300) {
        clearTimeout(tapTimer); lastTap = 0;
        const step = +S.seekStep || 10;
        if (st.side < .38) { P.seekBy(-step); ripple('l'); }
        else if (st.side > .62) { P.seekBy(step); ripple('r'); }
        else P.toggle();
      } else {
        lastTap = now;
        const side = st.side;
        tapTimer = setTimeout(() => {
          if (P.current && P.current.kind === 'video') toggleVideoUI();
          else P.toggle();
        }, 280);
      }
      st = null;
    };
    stage.addEventListener('pointerup', end);
    stage.addEventListener('pointercancel', end);
    stage.addEventListener('dblclick', e => e.preventDefault());

    function ripple(side) {
      const n = $('#ripple-' + side);
      n.classList.remove('flash'); void n.offsetWidth; n.classList.add('flash');
    }
  }
  function applyBrightness() {
    const f = P.brightness === 1 ? '' : 'brightness(' + P.brightness + ')';
    P.a.style.filter = f;
    $('#art-disc').style.filter = f;
    const ym = $('#yt-mount'); if (ym) ym.style.filter = f;   // dim the embed too
  }
  let uiTimer;
  function toggleVideoUI() {
    const v = $('#vtools');
    const on = v.classList.toggle('show');
    document.body.classList.toggle('ui-show', on);
    clearTimeout(uiTimer);
    if (on) uiTimer = setTimeout(() => { v.classList.remove('show'); document.body.classList.remove('ui-show'); }, 3600);
  }
  P.toggleVideoUI = toggleVideoUI;

  HP.Player = P;
})(window);
