/* ============================================================
   HashPlayer · player.js — playback engine, now-playing UI,
   queue, gestures, landscape video HUD, lyrics, subtitles,
   Media Session, and Picture-in-Picture.
   ============================================================ */
(function (w) {
  'use strict';
  const HP = w.HP, S = HP.S, $ = HP.$, $$ = HP.$$, el = HP.el, icon = HP.icon, clamp = HP.clamp;
  const L = () => HP.Lib, E = () => HP.Engine;

  const P = {
    a: null, b: null, active: null, current: null,
    queue: [], order: [], index: -1, context: 'Library',
    ab: { a: null, b: null }, sleep: null, wake: null, lyrics: null, lrcIndex: -1,
    pendingSrc: null, crossing: false, speedHold: false, brightness: 1, zoom: 1,
    locked: false, hudVisible: true, hudTimer: null
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
    [P.a, P.b].forEach(bind);
    P.a.volume = 1; P.b.volume = 1;
    HP.Vis.init($('#vis'));
    HP.Vis.visible = () => $('#np').classList.contains('on') && !document.body.classList.contains('has-video');
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
    m.addEventListener('playing', () => document.body.classList.remove('buffering'));
    m.addEventListener('ratechange', () => { if (m === P.active) updateSpeedLabel(); });
    m.addEventListener('volumechange', () => { });
  }

  /* =========================================================
     loading & playback
     ========================================================= */
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
    if (!src && !t.isEmbed) {
      HP.toast('“' + (t.title || t.name) + '” needs to be re-opened', 'err');
      HP.Lib.countRelink(); HP.Lib.render();
      return;
    }
    await ensureAudio();

    const isVideo = t.kind === 'video';
    let target = P.a;
    if (!isVideo && P.crossing && P.active === P.a) target = P.b;
    if (!P.crossing) {
      if (target === P.a && P.b && !P.b.paused) P.b.pause();
      if (target === P.b && !P.a.paused) P.a.pause();
    }

    P.current = t;
    P.active = target;
    target.playbackRate = S.speed;
    if ('preservesPitch' in target) target.preservesPitch = S.pitch;
    if (t.source === 'url' && !t.isEmbed) target.crossOrigin = 'anonymous'; else target.removeAttribute('crossorigin');

    // Handle YouTube embed fallback iframe
    const oldEmbed = $('#yt-embed');
    if (t.isEmbed && t.url) {
      if (!oldEmbed) {
        const ifr = el('iframe', {
          id: 'yt-embed',
          src: t.url,
          allow: 'autoplay; fullscreen; picture-in-picture',
          allowfullscreen: 'true'
        });
        $('#stage').appendChild(ifr);
      } else {
        oldEmbed.src = t.url;
        oldEmbed.style.display = 'block';
      }
      P.a.style.display = 'none';
    } else {
      if (oldEmbed) oldEmbed.style.display = 'none';
      P.a.style.display = isVideo ? 'block' : 'none';
      if (target.src !== src) { target.src = src; target.load(); }
    }

    document.body.classList.toggle('has-video', isVideo);
    E().elementGain(target, S.fade && autoplay ? 0 : 1);

    const pos = startAt != null ? startAt : (S.resume && t.pos > 3 && (!t.duration || t.pos < t.duration - 8) ? t.pos : 0);
    const go = () => {
      try { if (pos) target.currentTime = pos; } catch (e) { }
      if (autoplay && !t.isEmbed) target.play().then(() => {
        if (S.fade) E().fadeElement(target, 1, 420); else E().elementGain(target, 1);
      }).catch(err => {
        console.warn('[play]', err);
        if (err && err.name === 'NotAllowedError') HP.toast('Tap play to start (autoplay policy)');
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
    if (isVideo && HP.UI && !$('#np').classList.contains('on')) HP.UI.openNP(true);
    HP.emit('track-changed', t);
    highlightCards();
    renderQueue();
    P.showHud();
  }
  P.load = load;

  function onMeta() {
    const t = P.current; if (!t) return;
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
    if (t.source === 'url') {
      if (t.youtubeId && !t.isEmbed) {
        // Try fallback embed
        t.isEmbed = true;
        t.url = `https://www.youtube.com/embed/${t.youtubeId}?autoplay=1&playsinline=1`;
        load(t, true);
        return;
      }
      HP.toast('Could not stream that link', 'err');
    } else if (t.source === 'native' || t.nativeUri) {
      console.warn('[native error]', err);
      HP.toast('Could not stream file', 'err');
    } else {
      t.file = null;
      HP.Lib.countRelink(); HP.Lib.render();
      HP.toast('File unavailable — re-open from your device', 'err');
    }
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
    await ensureAudio();
    try {
      await P.active.play();
      if (S.fade) E().fadeElement(P.active, 1, 300);
    } catch (e) { HP.toast('Tap play again to allow audio'); }
  };
  P.pause = function () {
    if (!P.current) return;
    if (S.fade && E().ready) {
      E().fadeElement(P.active, 0, 220).then(() => { P.active.pause(); E().elementGain(P.active, 1); });
      onPause();
    } else P.active.pause();
  };
  P.stop = function () {
    P.active.pause(); try { P.active.currentTime = 0; } catch (e) { }
  };

  function onPlay() {
    document.body.classList.add('playing');
    $$('#btn-play use, #mini-play use, #v-play-center use').forEach(u => u.setAttribute('href', '#i-pause'));
    if (!document.body.classList.contains('has-video')) HP.Vis.start();
    if ('mediaSession' in navigator) navigator.mediaSession.playbackState = 'playing';
    keepAwake(true);
    HP.Native && HP.Native.notify && HP.Native.notify(true, P.current ? (P.current.title || P.current.name) : '', P.current ? P.current.artist : '', P.current && P.current.kind === 'video');
    HP.emit('playing', true);
    P.resetHudTimer();
  }
  function onPause() {
    document.body.classList.remove('playing');
    $$('#btn-play use, #mini-play use, #v-play-center use').forEach(u => u.setAttribute('href', '#i-play'));
    if ('mediaSession' in navigator) navigator.mediaSession.playbackState = 'paused';
    keepAwake(false);
    savePos();
    HP.Native && HP.Native.notify && HP.Native.notify(false, P.current ? (P.current.title || P.current.name) : '', P.current ? P.current.artist : '', P.current && P.current.kind === 'video');
    HP.emit('playing', false);
    P.showHud();
  }
  function onEnded() {
    const t = P.current;
    if (t) {
      t.plays = (t.plays || 0) + 1;
      t.lastPlayed = Date.now();
      t.pos = 0;
      L().saveTrack(t);
    }
    if (S.repeat === 'one') {
      P.active.currentTime = 0;
      P.play();
      return;
    }
    if (P.sleep === 'endtrack') {
      P.sleep = null;
      HP.toast('Sleep timer: stopped at end of track');
      return;
    }
    if (S.autoplayNext) P.next(true);
  }

  P.next = function (auto) {
    if (!P.queue.length) return;
    const n = P.queue.length;
    let nextI = P.index + 1;
    if (nextI >= n) {
      if (S.repeat === 'all') nextI = 0;
      else if (auto) { P.stop(); return; }
      else nextI = 0;
    }
    P.index = nextI;
    const realId = S.shuffle ? P.queue[P.order[nextI % n]] : P.queue[nextI];
    load(L().get(realId), true, 0);
  };

  P.prev = function () {
    if (!P.queue.length) return;
    if (P.active.currentTime > 3) { P.seek(0); return; }
    const n = P.queue.length;
    let prevI = P.index - 1;
    if (prevI < 0) prevI = S.repeat === 'all' ? n - 1 : 0;
    P.index = prevI;
    const realId = S.shuffle ? P.queue[P.order[prevI]] : P.queue[prevI];
    load(L().get(realId), true, 0);
  };

  P.seek = function (t) {
    if (!P.active) return;
    const dur = P.active.duration || (P.current && P.current.duration) || 0;
    const tgt = clamp(t, 0, dur || 99999);
    try { P.active.currentTime = tgt; } catch (e) { }
    onTime();
  };
  P.seekBy = function (delta) {
    P.seek((P.active.currentTime || 0) + delta);
  };

  /* =========================================================
     HUD Visibility (Landscape Video Player)
     ========================================================= */
  P.showHud = function () {
    P.hudVisible = true;
    document.body.classList.add('hud-show');
    P.resetHudTimer();
  };
  P.hideHud = function () {
    if (P.active && P.active.paused) return; // Keep visible when paused
    P.hudVisible = false;
    document.body.classList.remove('hud-show');
    clearTimeout(P.hudTimer);
  };
  P.toggleHud = function () {
    if (P.locked) return;
    P.hudVisible ? P.hideHud() : P.showHud();
  };
  P.resetHudTimer = function () {
    clearTimeout(P.hudTimer);
    if (document.body.classList.contains('has-video') && P.active && !P.active.paused && !P.locked) {
      P.hudTimer = setTimeout(() => P.hideHud(), 3600);
    }
  };

  /* =========================================================
     UI updates on time / progress
     ========================================================= */
  function onTime() {
    const cur = P.active.currentTime || 0, dur = P.active.duration || (P.current && P.current.duration) || 0;
    const pct = dur > 0 ? (cur / dur) * 100 : 0;
    $('#seek-fill').style.width = pct + '%';
    $('#seek-knob').style.left = pct + '%';
    $('#mini-fill').style.width = pct + '%';
    $('#t-cur').textContent = HP.fmtTime(cur);
    $('#t-rem').textContent = dur ? '-' + HP.fmtTime(Math.max(0, dur - cur)) : '0:00';

    if (P.lyrics && P.lyrics.synced && !$('#lyrics').hidden) syncLyrics(cur);
    if (P.ab.b && cur >= P.ab.b && P.ab.a != null) P.seek(P.ab.a);
  }

  function drawBuffer() {
    const m = P.active, dur = m.duration || (P.current && P.current.duration) || 0;
    if (!dur || !m.buffered.length) return;
    try {
      const end = m.buffered.end(m.buffered.length - 1);
      $('#seek-buf').style.width = clamp((end / dur) * 100, 0, 100) + '%';
    } catch (_) {}
  }

  function updateTimes() {
    const cur = P.active.currentTime || 0, dur = P.active.duration || (P.current && P.current.duration) || 0;
    $('#t-cur').textContent = HP.fmtTime(cur);
    $('#t-rem').textContent = dur ? '-' + HP.fmtTime(Math.max(0, dur - cur)) : '0:00';
  }

  function paintNowPlaying(t) {
    const title = t.title || t.name, artist = t.artist || (t.kind === 'video' ? 'Video' : 'Unknown artist');
    $('#np-title').textContent = title;
    $('#np-artist').textContent = artist + (t.album ? ' · ' + t.album : '');
    $('#np-context').textContent = P.context;
    $('#mini-title').textContent = title;
    $('#mini-artist').textContent = artist;
    $('#minibar').hidden = false;

    // Landscape HUD titles
    const vTitle = $('#v-title'), vSub = $('#v-sub');
    if (vTitle) vTitle.textContent = title;
    if (vSub) vSub.textContent = artist;

    $('#np-fav').classList.toggle('on', !!t.fav);
    $('#mini-fav').classList.toggle('on', !!t.fav);

    const cu = L().coverUrl(t);
    const disc = $('#art-disc'), img = $('#art-img'), miniArt = $('#mini-art'), miniImg = $('#mini-img'), bgImg = $('#np-bg-img');

    if (cu) {
      img.src = cu; disc.classList.add('has-img');
      miniImg.src = cu; miniArt.classList.add('has-img');
      bgImg.src = cu; bgImg.classList.add('on');
      if (S.autoTheme) {
        const i = new Image();
        i.onload = () => {
          const pal = HP.paletteFrom(i);
          if (pal) {
            document.documentElement.style.setProperty('--a1', pal[0]);
            document.documentElement.style.setProperty('--a2', pal[1]);
          }
        };
        i.src = cu;
      }
    } else {
      disc.classList.remove('has-img'); miniArt.classList.remove('has-img');
      bgImg.classList.remove('on');
      if (S.autoTheme) applyStoredTheme();
    }
  }

  function applyStoredTheme() {
    const map = {
      neon: ['#00e5ff', '#b61bff'], sunset: ['#ff9a3d', '#ff2d78'], matrix: ['#2bff95', '#00c2a8'],
      royal: ['#ffd166', '#8a5cff'], ice: ['#8ab4ff', '#c9f2ff']
    };
    const c = map[S.theme] || map.neon;
    document.documentElement.style.setProperty('--a1', c[0]);
    document.documentElement.style.setProperty('--a2', c[1]);
  }

  /* =========================================================
     lyrics & subtitles
     ========================================================= */
  function loadLyrics(t) {
    const box = $('#lyrics'), scroll = $('#lyrics-scroll');
    scroll.innerHTML = '';
    P.lyrics = null; P.lrcIndex = -1;

    if (!t || !t.lrc) {
      scroll.appendChild(el('div', { class: 'lyrics-empty-state' }, [
        icon('lyrics', 'ic ph'),
        el('h3', { text: 'No Lyrics Found' }),
        el('p', { class: 'muted', text: 'Search online with one tap to add synced lyrics.' }),
        el('button', {
          class: 'btn primary small',
          id: 'btn-lyrics-quick-search',
          onclick: (e) => { e.stopPropagation(); HP.UI.searchLyricsOnline(P.current); }
        }, [icon('search'), el('span', { text: 'Search Lyrics Online' })])
      ]));
      $('#t-lyrics').classList.remove('on');
      return;
    }

    $('#t-lyrics').classList.add('on');
    P.lyrics = HP.Meta.parseLRC(t.lrc);

    P.lyrics.lines.forEach((l, i) => {
      const line = el('div', { class: 'lrc-line', 'data-i': i, text: l.text || '♪' });
      if (l.t !== null) {
        line.addEventListener('click', e => {
          e.stopPropagation();
          P.seek(l.t + (P.lyrics.offset || 0));
        });
      }
      scroll.appendChild(line);
    });
  }
  P.loadLyrics = loadLyrics;

  function syncLyrics(cur) {
    if (!P.lyrics || !P.lyrics.lines.length) return;
    const lines = P.lyrics.lines;
    const off = P.lyrics.offset || 0;
    let idx = -1;
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].t !== null && (lines[i].t + off) <= cur + .15) idx = i;
      else if (lines[i].t !== null && (lines[i].t + off) > cur + .15) break;
    }
    if (idx === P.lrcIndex) return;
    P.lrcIndex = idx;

    const all = $$('.lrc-line', $('#lyrics-scroll'));
    all.forEach((n, i) => {
      n.classList.toggle('active', i === idx);
      n.classList.toggle('near', Math.abs(i - idx) === 1);
    });
    if (idx >= 0 && all[idx]) {
      const parent = $('#lyrics-scroll');
      const target = all[idx];
      parent.scrollTo({
        top: target.offsetTop - parent.clientHeight / 2 + target.clientHeight / 2,
        behavior: 'smooth'
      });
    }
  }

  function addSubtitle(vttText) {
    try {
      const b = new Blob([vttText], { type: 'text/vtt' });
      const u = URL.createObjectURL(b);
      const track = el('track', {
        kind: 'subtitles',
        srclang: 'en',
        label: 'Subtitles',
        src: u,
        default: 'default'
      });
      P.a.appendChild(track);
      track.track.mode = 'showing';
      $('#v-cc').classList.add('on');
    } catch (e) { console.warn('[sub]', e); }
  }
  P.addSubtitle = addSubtitle;

  /* =========================================================
     queue, marks, A-B loop, speed
     ========================================================= */
  function renderQueue() {
    const list = $('#q-list'); if (!list) return;
    list.innerHTML = '';
    const n = P.queue.length;
    $('#q-count').textContent = n;
    if (!n) {
      list.appendChild(el('div', { class: 'q-empty', text: 'Queue is empty' }));
      return;
    }
    P.queue.forEach((id, i) => {
      const t = L().get(id);
      if (!t) return;
      const isNow = i === P.index;
      const cu = L().coverUrl(t);
      const art = el('div', { class: 'q-art' });
      if (cu) art.appendChild(el('img', { src: cu, alt: '', style: 'width:100%;height:100%;object-fit:cover;border-radius:10px' }));
      else art.appendChild(icon(t.kind === 'video' ? 'video' : 'music'));

      const meta = el('div', { class: 'q-meta' }, [
        el('b', { text: t.title || t.name }),
        el('small', { text: (t.artist || '—') + (t.duration ? ' · ' + HP.fmtTime(t.duration) : '') })
      ]);
      const rm = el('button', { class: 'icon-btn tiny' }, [icon('x')]);
      rm.addEventListener('click', e => { e.stopPropagation(); P.removeFromQueue(i); });

      const row = el('div', { class: 'q-item' + (isNow ? ' now' : ''), 'data-i': i, draggable: 'true' }, [
        icon('drag', 'q-handle'), art, meta, rm
      ]);
      row.addEventListener('click', () => { P.index = i; load(t, true); renderQueue(); });
      bindQueueDrag(row, i);
      list.appendChild(row);
    });
  }
  P.renderQueue = renderQueue;

  function bindQueueDrag(row, i) {
    row.addEventListener('dragstart', e => { e.dataTransfer.setData('text/plain', i); row.classList.add('dragging'); });
    row.addEventListener('dragend', () => row.classList.remove('dragging'));
    row.addEventListener('dragover', e => { e.preventDefault(); row.classList.add('drag-over'); });
    row.addEventListener('dragleave', () => row.classList.remove('drag-over'));
    row.addEventListener('drop', e => {
      e.preventDefault(); row.classList.remove('drag-over');
      const from = +e.dataTransfer.getData('text/plain');
      if (isNaN(from) || from === i) return;
      const item = P.queue.splice(from, 1)[0];
      P.queue.splice(i, 0, item);
      if (P.index === from) P.index = i;
      else if (from < P.index && i >= P.index) P.index--;
      else if (from > P.index && i <= P.index) P.index++;
      buildOrder(); renderQueue();
    });
  }

  P.addNext = function (id) {
    if (P.queue.indexOf(id) > -1) P.queue.splice(P.queue.indexOf(id), 1);
    P.queue.splice(P.index + 1, 0, id);
    buildOrder(); renderQueue(); HP.toast('Playing next');
  };
  P.addLast = function (id) {
    if (P.queue.indexOf(id) < 0) P.queue.push(id);
    buildOrder(); renderQueue(); HP.toast('Added to queue');
  };
  P.removeFromQueue = function (i) {
    P.queue.splice(i, 1);
    if (i < P.index) P.index--;
    else if (i === P.index) {
      if (P.queue.length) { P.index = Math.min(P.index, P.queue.length - 1); load(L().get(P.queue[P.index]), true); }
      else P.stop();
    }
    buildOrder(); renderQueue();
  };
  P.clearQueue = function () {
    P.queue = []; P.index = -1; P.stop(); renderQueue(); HP.toast('Queue cleared');
  };

  /* A-B loop */
  P.markAB = function () {
    const cur = P.active.currentTime || 0;
    if (P.ab.a == null) {
      P.ab.a = cur;
      HP.toast('A point: ' + HP.fmtTime(cur));
    } else if (P.ab.b == null) {
      if (cur <= P.ab.a) { P.ab.a = cur; HP.toast('A reset: ' + HP.fmtTime(cur)); }
      else {
        P.ab.b = cur;
        HP.toast('Looping A-B (' + HP.fmtTime(P.ab.a) + ' → ' + HP.fmtTime(cur) + ')');
      }
    } else {
      P.ab = { a: null, b: null };
      HP.toast('A-B loop cleared');
    }
    updateAB();
  };
  function updateAB() {
    const abBox = $('#seek-ab');
    const dur = P.active.duration || (P.current && P.current.duration) || 0;
    if (!abBox) return;
    if (P.ab.a != null && dur > 0) {
      const aPct = (P.ab.a / dur) * 100;
      const bPct = P.ab.b != null ? (P.ab.b / dur) * 100 : aPct;
      abBox.hidden = false;
      abBox.style.left = aPct + '%';
      abBox.style.width = Math.max(2, bPct - aPct) + '%';
      $('#t-ab').classList.add('on');
      $('#ab-label').textContent = P.ab.b != null ? 'A↔B' : 'A…';
    } else {
      abBox.hidden = true;
      $('#t-ab').classList.remove('on');
      $('#ab-label').textContent = 'A-B';
    }
  }

  /* bookmarks */
  P.addBookmark = function () {
    const t = P.current; if (!t) return;
    const cur = Math.round(P.active.currentTime || 0);
    t.bookmarks = t.bookmarks || [];
    if (t.bookmarks.indexOf(cur) < 0) {
      t.bookmarks.push(cur);
      t.bookmarks.sort((a, b) => a - b);
      L().saveTrack(t);
      renderMarks();
      HP.toast('Bookmark added at ' + HP.fmtTime(cur), 'ok');
    }
  };
  function renderMarks() {
    const box = $('#seek-marks'); if (!box) return;
    box.innerHTML = '';
    const t = P.current; if (!t || !t.bookmarks || !t.duration) return;
    t.bookmarks.forEach(sec => {
      const pct = (sec / t.duration) * 100;
      const mark = el('i', { style: 'left:' + pct + '%' });
      mark.title = HP.fmtTime(sec);
      mark.addEventListener('click', e => { e.stopPropagation(); P.seek(sec); });
      box.appendChild(mark);
    });
  }

  /* speed */
  P.setSpeed = function (v) {
    v = clamp(+v, .25, 4);
    S.speed = v; HP.save();
    P.a.playbackRate = v; P.b.playbackRate = v;
    updateSpeedLabel();
    $$('#speed-chips .chip').forEach(c => c.classList.toggle('active', +c.dataset.sp === v));
    $('#speed-range').value = v * 100;
  };
  function updateSpeedLabel() {
    const sp = S.speed || 1;
    $('#speed-label').textContent = sp.toFixed(sp % 1 ? (sp * 10 % 1 ? 2 : 1) : 0) + '×';
  }

  /* PiP */
  P.togglePip = async function () {
    if (document.pictureInPictureElement) {
      await document.exitPictureInPicture();
    } else if (P.a.requestPictureInPicture) {
      try { await P.a.requestPictureInPicture(); }
      catch (e) { HP.toast('PiP unavailable for this format'); }
    } else {
      HP.toast('PiP is not supported on this browser');
    }
  };

  /* =========================================================
     bindings
     ========================================================= */
  function bindUI() {
    $('#btn-play').addEventListener('click', () => P.toggle());
    $('#mini-play').addEventListener('click', () => P.toggle());
    $('#v-play-center').addEventListener('click', () => P.toggle());

    $('#btn-next').addEventListener('click', () => P.next());
    $('#mini-next').addEventListener('click', e => { e.stopPropagation(); P.next(); });
    $('#btn-prev').addEventListener('click', () => P.prev());
    $('#btn-ff').addEventListener('click', () => P.seekBy(10));
    $('#btn-rw').addEventListener('click', () => P.seekBy(-10));

    $('#btn-shuf').addEventListener('click', () => {
      S.shuffle = !S.shuffle; HP.save();
      buildOrder(); syncToggles();
      HP.toast(S.shuffle ? 'Shuffle on' : 'Shuffle off');
    });
    $('#btn-rep').addEventListener('click', () => {
      const modes = ['off', 'all', 'one'];
      S.repeat = modes[(modes.indexOf(S.repeat) + 1) % modes.length];
      HP.save(); syncToggles();
      HP.toast('Repeat: ' + S.repeat);
    });

    $('#np-fav').addEventListener('click', () => { if (P.current) L().toggleFav(P.current.id); });
    $('#mini-fav').addEventListener('click', e => { e.stopPropagation(); if (P.current) L().toggleFav(P.current.id); });

    // Download buttons
    const dlBtn = $('#np-download');
    if (dlBtn) dlBtn.addEventListener('click', () => {
      if (P.current && HP.UI && HP.UI.downloadMedia) HP.UI.downloadMedia(P.current);
    });
    const vDlBtn = $('#v-download');
    if (vDlBtn) vDlBtn.addEventListener('click', () => {
      if (P.current && HP.UI && HP.UI.downloadMedia) HP.UI.downloadMedia(P.current);
    });

    /* seekbar scrubbing */
    const seek = $('#seek');
    let seeking = false;
    const seekAt = e => {
      const r = seek.getBoundingClientRect();
      const pct = clamp((e.clientX - r.left) / r.width, 0, 1);
      const dur = P.active.duration || (P.current && P.current.duration) || 0;
      P.seek(dur * pct);
    };
    seek.addEventListener('pointerdown', e => {
      seeking = true; seek.classList.add('drag');
      try { seek.setPointerCapture(e.pointerId); } catch (_) { }
      seekAt(e);
    });
    seek.addEventListener('pointermove', e => {
      const r = seek.getBoundingClientRect();
      const pct = clamp((e.clientX - r.left) / r.width, 0, 1);
      const dur = P.active.duration || (P.current && P.current.duration) || 0;
      const tip = $('#seek-tip');
      tip.hidden = false;
      tip.style.left = (pct * 100) + '%';
      tip.textContent = HP.fmtTime(dur * pct);
      if (seeking) seekAt(e);
    });
    const endSeek = () => { seeking = false; seek.classList.remove('drag'); $('#seek-tip').hidden = true; };
    seek.addEventListener('pointerup', endSeek);
    seek.addEventListener('pointercancel', endSeek);
    seek.addEventListener('pointerleave', () => { if (!seeking) $('#seek-tip').hidden = true; });

    /* volume slider on minibar */
    const vol = $('#mini-vol');
    if (vol) {
      vol.value = S.volume * 100;
      vol.addEventListener('input', () => E().setVolume(vol.value / 100));
      $('#mini-mute').addEventListener('click', () => {
        S.muted = !S.muted; HP.save(); E().applyVolume();
      });
    }

    /* Video HUD overlay buttons */
    const pipBtn = $('#v-pip');
    if (pipBtn) pipBtn.addEventListener('click', () => P.togglePip());

    const fullBtn = $('#v-full');
    if (fullBtn) fullBtn.addEventListener('click', () => P.toggleFullscreen());

    const ccBtn = $('#v-cc');
    if (ccBtn) ccBtn.addEventListener('click', () => P.toggleCC());

    const shotBtn = $('#v-shot');
    if (shotBtn) shotBtn.addEventListener('click', () => P.screenshot());

    const mirrorBtn = $('#v-mirror');
    if (mirrorBtn) mirrorBtn.addEventListener('click', () => {
      document.body.classList.toggle('mirror');
      mirrorBtn.classList.toggle('on', document.body.classList.contains('mirror'));
    });

    const FITS = ['contain', 'cover', 'fill'];
    let fitI = 0;
    const aspectBtn = $('#v-aspect');
    if (aspectBtn) aspectBtn.addEventListener('click', () => {
      fitI = (fitI + 1) % FITS.length;
      document.body.classList.remove('fit-cover', 'fit-fill');
      if (FITS[fitI] !== 'contain') document.body.classList.add('fit-' + FITS[fitI]);
      HP.toast('Aspect: ' + FITS[fitI]);
    });

    let rot = 0;
    const rotBtn = $('#v-rotate');
    if (rotBtn) rotBtn.addEventListener('click', () => {
      rot = (rot + 90) % 360;
      document.body.classList.remove('rot-90', 'rot-180', 'rot-270');
      if (rot) document.body.classList.add('rot-' + rot);
      HP.toast('Rotated ' + rot + '°');
    });

    // Video Screen Lock toggle (prevents accidental touch in landscape)
    const lockBtn = $('#v-lock');
    if (lockBtn) lockBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      P.locked = !P.locked;
      document.body.classList.toggle('video-locked', P.locked);
      HP.toast(P.locked ? 'Screen Locked 🔒 (Tap unlock icon to unlock)' : 'Screen Unlocked 🔓');
      if (P.locked) P.hideHud();
    });

    const unlockBtn = $('#v-unlock-btn');
    if (unlockBtn) unlockBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      P.locked = false;
      document.body.classList.remove('video-locked');
      HP.toast('Screen Unlocked 🔓');
      P.showHud();
    });

    // Video back button in landscape overlay
    const vBack = $('#v-back');
    if (vBack) vBack.addEventListener('click', () => {
      if (document.fullscreenElement) P.toggleFullscreen();
      if (HP.UI) HP.UI.openNP(false);
    });

    $('#t-ab').addEventListener('click', () => P.markAB());
    $('#t-mark').addEventListener('click', () => P.addBookmark());
    $('#t-queue').addEventListener('click', () => HP.UI.toggleQueue());
    $('#mini-queue').addEventListener('click', e => { e.stopPropagation(); HP.UI.toggleQueue(); });
    $('#t-lyrics').addEventListener('click', () => P.toggleLyrics());
    $('#lyrics').addEventListener('click', () => P.toggleLyrics(false));

    syncToggles(); updateSpeedLabel();
  }

  P.toggleCC = function () {
    const tracks = P.a.textTracks;
    if (!tracks || !tracks.length) {
      if (P.current) HP.UI.loadSidecar(P.current, 'sub');
      else HP.toast('No subtitles available');
      return;
    }
    const t = tracks[0];
    t.mode = t.mode === 'showing' ? 'hidden' : 'showing';
    $('#v-cc').classList.toggle('on', t.mode === 'showing');
    HP.toast(t.mode === 'showing' ? 'Subtitles On' : 'Subtitles Off');
  };

  P.toggleLyrics = function (force) {
    const box = $('#lyrics');
    const show = force === undefined ? box.hidden : force;
    box.hidden = !show;
    S.lyricsOn = show; HP.save();
    if (show) { P.lrcIndex = -1; syncLyrics(P.active.currentTime || 0); }
  };

  P.toggleFullscreen = function () {
    const node = $('#np');
    if (!document.fullscreenElement) {
      (node.requestFullscreen ? node.requestFullscreen() : node.webkitRequestFullscreen && node.webkitRequestFullscreen());
      document.body.classList.add('cinema');
      if (screen.orientation && screen.orientation.lock && P.current && P.current.kind === 'video')
        screen.orientation.lock('landscape').catch(() => { });
    } else {
      document.exitFullscreen && document.exitFullscreen();
      document.body.classList.remove('cinema');
      if (screen.orientation && screen.orientation.unlock) try { screen.orientation.unlock(); } catch (e) { }
    }
  };
  document.addEventListener('fullscreenchange', () => {
    const fs = !!document.fullscreenElement;
    document.body.classList.toggle('cinema', fs);
    const fullUse = $('#v-full use');
    if (fullUse) fullUse.setAttribute('href', fs ? '#i-collapse' : '#i-expand');
  });

  P.screenshot = function () {
    const v = P.a;
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
        HP.toast('Screenshot saved', 'ok');
      }, 'image/png');
    } catch (e) { HP.toast('Video format blocks frame capture', 'err'); }
  };

  /* =========================================================
     gestures on the stage (Landscape & Video player)
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
      if (e.target.closest('.vtools') || e.target.closest('.lyrics-scroll') || e.target.closest('.v-overlay-ctrls')) return;
      if (P.locked && !e.target.closest('#v-unlock-btn')) return;

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
      try { stage.setPointerCapture(e.pointerId); } catch (_) { }
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
      if (P.locked) return;
      if (pts.has(e.pointerId)) pts.set(e.pointerId, e);
      if (pts.size === 2 && pinch0) {
        const [p1, p2] = Array.from(pts.values());
        const d = Math.hypot(p1.clientX - p2.clientX, p1.clientY - p2.clientY);
        P.zoom = clamp(d / pinch0, .6, 3);
        P.a.style.transform = `scale(${P.zoom})`;
        return;
      }
      if (!st || !S.gestures) return;
      const dx = e.clientX - st.x, dy = e.clientY - st.y;
      if (!st.axis && (Math.abs(dx) > 10 || Math.abs(dy) > 10)) {
        st.axis = Math.abs(dx) > Math.abs(dy) ? 'x' : 'y';
        st.moved = true;
        clearTimeout(holdTimer);
      }
      if (!st.axis) return;

      if (st.axis === 'x') {
        const dur = P.active.duration || (P.current && P.current.duration) || 0;
        const delta = (dx / st.w) * Math.min(120, dur || 120);
        const tgt = clamp(st.time0 + delta, 0, dur);
        P.seek(tgt);
        flashGfx(delta >= 0 ? 'ff' : 'rw', (delta >= 0 ? '+' : '') + Math.round(delta) + 's (' + HP.fmtTime(tgt) + ')');
      } else {
        const delta = -dy / st.h;
        if (st.side > .5) {
          const v = clamp(st.vol0 + delta, 0, 1);
          E().setVolume(v);
          showBar(v > .5 ? 'vol' : v > 0 ? 'vol' : 'mute', Math.round(v * 100), v * 100);
        } else {
          P.brightness = clamp(st.br0 + delta, .1, 1.5);
          P.a.style.filter = `brightness(${P.brightness})`;
          showBar('sun', Math.round(P.brightness * 100) + '%', (P.brightness / 1.5) * 100);
        }
      }
    });

    const endPointer = e => {
      pts.delete(e.pointerId);
      clearTimeout(holdTimer);
      if (P.speedHold) {
        P.speedHold = false;
        P.active.playbackRate = S.speed;
        $('#speed-badge').hidden = true;
      }
      if (!st) return;
      if (!st.moved) {
        const now = Date.now();
        if (now - lastTap < 280) {
          clearTimeout(tapTimer);
          const step = +S.seekStep || 10;
          if (st.side < .35) {
            P.seekBy(-step);
            $('#ripple-l').classList.add('flash');
            setTimeout(() => $('#ripple-l').classList.remove('flash'), 450);
            flashGfx('rw', '-' + step + 's');
          } else if (st.side > .65) {
            P.seekBy(step);
            $('#ripple-r').classList.add('flash');
            setTimeout(() => $('#ripple-r').classList.remove('flash'), 450);
            flashGfx('ff', '+' + step + 's');
          } else {
            P.toggleFullscreen();
          }
          lastTap = 0;
        } else {
          lastTap = now;
          tapTimer = setTimeout(() => {
            P.toggleHud();
          }, 290);
        }
      }
      st = null;
    };
    stage.addEventListener('pointerup', endPointer);
    stage.addEventListener('pointercancel', endPointer);
  }

  function syncToggles() {
    $('#btn-shuf').classList.toggle('on', !!S.shuffle);
    $('#btn-rep').classList.toggle('on', S.repeat !== 'off');
    const u = $('#btn-rep use');
    if (u) u.setAttribute('href', S.repeat === 'one' ? '#i-repeat1' : '#i-repeat');
  }

  /* media session metadata */
  function mediaSession() {
    if (!('mediaSession' in navigator)) return;
    const ms = navigator.mediaSession;
    ms.setActionHandler('play', () => P.play());
    ms.setActionHandler('pause', () => P.pause());
    ms.setActionHandler('nexttrack', () => P.next());
    ms.setActionHandler('previoustrack', () => P.prev());
    ms.setActionHandler('seekto', d => { if (d.seekTime != null) P.seek(d.seekTime); });
    ms.setActionHandler('seekforward', d => P.seekBy(d.seekOffset || 10));
    ms.setActionHandler('seekbackward', d => P.seekBy(-(d.seekOffset || 10)));
  }

  /* wake lock */
  async function keepAwake(on) {
    if (!S.keepAwake || !('wakeLock' in navigator)) return;
    if (on && !P.wake) {
      try { P.wake = await navigator.wakeLock.request('screen'); } catch (_) { }
    } else if (!on && P.wake) {
      try { await P.wake.release(); } catch (_) { }
      P.wake = null;
    }
  }

  function savePos() {
    if (!P.current || !P.active) return;
    const cur = P.active.currentTime || 0;
    P.current.pos = Math.round(cur);
    S.lastId = P.current.id; S.lastPos = P.current.pos;
    HP.save();
    L().saveTrack(P.current);
  }

  /* loop tick */
  function tick() {
    requestAnimationFrame(tick);
    if (!P.active || P.active.paused) return;
    if (S.crossfade && P.queue.length > 1 && !P.crossing && P.active.duration) {
      const rem = P.active.duration - P.active.currentTime;
      if (rem > 0 && rem <= S.crossfade) crossToNext();
    }
  }

  async function crossToNext() {
    P.crossing = true;
    const nextI = (P.index + 1) % P.queue.length;
    const realId = S.shuffle ? P.queue[P.order[nextI]] : P.queue[nextI];
    const nextTrack = L().get(realId);
    if (!nextTrack || nextTrack.kind === 'video') { P.crossing = false; return; }

    const nextTarget = P.active === P.a ? P.b : P.a;
    const src = await L().resolveSrc(nextTrack);
    if (!src) { P.crossing = false; return; }

    nextTarget.src = src;
    nextTarget.currentTime = 0;
    E().elementGain(nextTarget, 0);
    try {
      await nextTarget.play();
      E().crossfade(P.active, nextTarget, S.crossfade);
      setTimeout(() => {
        P.index = nextI;
        P.current = nextTrack;
        P.active = nextTarget;
        P.crossing = false;
        paintNowPlaying(nextTrack);
        highlightCards(); renderQueue();
      }, S.crossfade * 1000);
    } catch (_) { P.crossing = false; }
  }

  function highlightCards() {
    $$('.card.playing').forEach(c => c.classList.remove('playing'));
    if (P.current) {
      const c = $('.card[data-id="' + P.current.id + '"]');
      if (c) c.classList.add('playing');
    }
  }
  P.highlightCards = highlightCards;

  /* sleep timer */
  P.setSleep = function (min) {
    clearTimeout(P.sleepTimer);
    const badge = $('#sleep-state');
    if (!min) {
      P.sleep = null;
      badge.hidden = true;
      HP.toast('Sleep timer turned off');
      return;
    }
    if (min === 'endtrack') {
      P.sleep = 'endtrack';
      badge.hidden = false;
      badge.textContent = 'Will stop at the end of this track';
      HP.toast('Sleep timer set: end of track');
      return;
    }
    P.sleep = min;
    const end = Date.now() + min * 60000;
    badge.hidden = false;
    badge.textContent = 'Stopping in ' + min + ' minutes';
    HP.toast('Sleep timer set: ' + min + ' min', 'ok');

    P.sleepTimer = setTimeout(() => {
      E().fadeVolume(0, 8000).then(() => {
        P.pause();
        E().applyVolume();
        P.sleep = null;
        badge.hidden = true;
      });
    }, Math.max(100, min * 60000 - 8000));
  };

  P.rangeFill = function (r) {
    const min = +r.min || 0, max = +r.max || 100, val = +r.value || 0;
    const pct = ((val - min) / (max - min)) * 100;
    r.style.background = `linear-gradient(90deg,var(--a1) ${pct}%,rgba(140,150,180,.2) ${pct}%)`;
  };

  HP.Player = P;
})(window);
