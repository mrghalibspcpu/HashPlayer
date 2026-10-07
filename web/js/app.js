/* ============================================================
   HashPlayer · app.js — shell wiring, settings, EQ UI,
   shortcuts, drag & drop, PWA install, Android bridge
   ============================================================ */
(function (w) {
  'use strict';
  const HP = w.HP, S = HP.S, $ = HP.$, $$ = HP.$$, el = HP.el, icon = HP.icon, clamp = HP.clamp;
  const L = HP.Lib, P = HP.Player, E = HP.Engine, UI = {};
  const APP_VERSION = '2.8.0';

  /* =========================================================
     views & navigation
     ========================================================= */
  UI.nav = function (view) {
    const map = { library: 'library', playlists: 'playlists', favorites: 'library', eq: 'eq', settings: 'settings' };
    const target = map[view] || 'library';
    L.view = view;
    document.body.dataset.view = view;
    $$('.view').forEach(v => v.classList.toggle('active', v.id === 'view-' + target));
    $$('.nav-item').forEach(n => n.classList.toggle('active', n.dataset.nav === view));
    $('#views').scrollTop = 0;
    if (target === 'library') {
      $('#lib-title').textContent = view === 'favorites' ? (HP.t('favorites') || 'Favorites') : (HP.t('library') || 'Library');
      $('#type-chips').style.display = view === 'favorites' ? 'none' : '';
      L.render();
    }
    if (target === 'playlists') { closePlaylistDetail(); L.renderPlaylists(); }
    if (target === 'eq') drawCurve();
    if (target === 'settings') refreshStorage();
    UI.updateSearchActive();
  };

  /* =========================================================
     focused search mode — while the search bar is focused or holds a
     query, the library header/toolbar extras and the bottom nav get out
     of the way so the results list has the full screen above the keyboard
     ========================================================= */
  let searchFocused = false;
  UI.isSearchActive = false;
  UI.updateSearchActive = function () {
    const input = $('#search');
    const query = input ? input.value || '' : '';
    const libraryish = document.body.dataset.view === 'library' || document.body.dataset.view === 'favorites';
    const active = !!(libraryish && (searchFocused || query.trim() !== ''));
    UI.isSearchActive = active;
    document.body.classList.toggle('search-active', active);
    const back = $('#search-back');
    if (back) back.hidden = !active;
  };
  /** Exit is intentionally stronger than the × clear affordance: it clears the
     query, dismisses the keyboard and returns directly to the main Library. */
  UI.exitSearch = function () {
    const input = $('#search');
    if (input) input.value = '';
    L.search = '';
    searchFocused = false;
    if (input) input.blur();
    $('#search-clear').hidden = true;
    L.ytSearch('');
    UI.nav('library');
    L.render();
    UI.updateSearchActive();
  };

  /* =========================================================
     sheets, scrim, queue
     ========================================================= */
  let openSheetId = null;
  UI.sheet = function (id) {
    UI.closeAll(true);
    const s = $('#' + id); if (!s) return;
    s.hidden = false;
    requestAnimationFrame(() => { s.classList.add('on'); $('#scrim').classList.add('on'); });
    openSheetId = id;
  };
  UI.closeAll = function (keepScrim) {
    $$('.sheet.on').forEach(s => { s.classList.remove('on'); setTimeout(() => { if (!s.classList.contains('on')) s.hidden = true; }, 320); });
    $('#ctx').hidden = true;
    openSheetId = null;
    if (!keepScrim) $('#scrim').classList.remove('on');
  };
  UI.toggleQueue = function (force) {
    const q = $('#queue-panel');
    const on = force === undefined ? !q.classList.contains('on') : force;
    q.classList.toggle('on', on);
    q.setAttribute('aria-hidden', on ? 'false' : 'true');
    $('#scrim').classList.toggle('on', on);
    if (on) P.renderQueue();
  };
  /* The player is an overlay route. Keep the underlying route and scroll
     position so Android/browser Back can pop it without losing the view. */
  const routeStack = [];
  UI.openNP = function (on) {
    const np = $('#np');
    const wasOpen = np.classList.contains('on');
    const show = on === undefined ? !wasOpen : !!on;
    if (show === wasOpen) {
      P.syncMiniPlayer && P.syncMiniPlayer();
      return;
    }

    if (show) {
      routeStack.push({
        name: 'player',
        view: document.body.dataset.view || 'library',
        scrollTop: $('#views').scrollTop
      });
    }

    np.classList.toggle('on', show);
    np.setAttribute('aria-hidden', show ? 'false' : 'true');
    document.body.classList.toggle('np-open', show);
    if (show && S.lyricsOn) $('#lyrics').hidden = false;
    if (P.setPlayerViewActive) P.setPlayerViewActive(show);

    if (!show) {
      const route = routeStack.length ? routeStack.pop() : null;
      const view = route && route.name === 'player' ? route.view : (document.body.dataset.view || 'library');
      const active = $('.view.active');
      const expected = view === 'playlists' ? 'view-playlists'
        : view === 'eq' ? 'view-eq'
          : view === 'settings' ? 'view-settings' : 'view-library';
      /* Normally the old view never unmounts. This guard repairs it if a
         fullscreen/native lifecycle transition caused its active state to be lost. */
      if (!active || active.id !== expected) UI.nav(view);
      else if (view === 'library' || view === 'favorites') L.render();
      requestAnimationFrame(() => { $('#views').scrollTop = route ? route.scrollTop : 0; });
    }
  };

  /* =========================================================
     track context menu
     ========================================================= */
  UI.trackMenu = function (t, x, y) {
    const m = $('#ctx');
    m.innerHTML = '';
    const item = (ic, label, fn, cls) => {
      const b = el('button', { class: cls || '' }, [icon(ic), el('span', { text: label })]);
      b.addEventListener('click', () => { m.hidden = true; $('#scrim').classList.remove('on'); fn(); });
      m.appendChild(b);
    };
    item('play', 'Play now', () => P.playTrack(t.id, L.contextIds()));
    item('next', 'Play next', () => P.addNext(t.id));
    item('queue', 'Add to queue', () => P.addLast(t.id));
    m.appendChild(el('div', { class: 'sep' }));
    item('heart', t.fav ? 'Remove from favourites' : 'Add to favourites', () => L.toggleFav(t.id));
    item('plus', 'Add to playlist…', () => UI.playlistPicker([t.id]));
    item('lyrics', 'Lyrics…', () => UI.lyricsTool(t));
    if (t.kind === 'video') item('cc', 'Load subtitles…', () => UI.loadSidecar(t, 'sub'));
    item('info', 'Track info', () => UI.trackInfo(t));
    m.appendChild(el('div', { class: 'sep' }));
    item('trash', 'Remove from library', async () => {
      await L.remove(t.id); L.render(); HP.toast('Removed');
    }, 'danger');

    m.hidden = false;
    const r = m.getBoundingClientRect();
    m.style.left = clamp(x, 8, innerWidth - r.width - 8) + 'px';
    m.style.top = clamp(y, 8, innerHeight - r.height - 8) + 'px';
    $('#scrim').classList.add('on');
  };

  UI.trackInfo = function (t) {
    const b = $('#info-body');
    b.innerHTML = '';
    const row = (k, v) => { if (v == null || v === '') return; b.appendChild(el('b', { text: k })); b.appendChild(el('span', { text: String(v) })); };
    row('Title', t.title); row('Artist', t.artist); row('Album', t.album);
    row('Genre', t.genre); row('Year', t.year); row('Track #', t.trackNo);
    row('Type', t.kind + (t.mime ? ' · ' + t.mime : ''));
    row('Duration', t.duration ? HP.fmtTime(t.duration) : '—');
    row('Size', t.size ? HP.fmtBytes(t.size) : '—');
    row('Plays', t.plays || 0);
    row('Last played', t.lastPlayed ? HP.fmtDate(t.lastPlayed) : 'never');
    row('Added', HP.fmtDate(t.added));
    row('Source', t.source + (t.folder ? ' · ' + t.folder : ''));
    row('File', t.name);
    row('Lyrics', t.lrc ? 'yes' : 'no'); row('Subtitles', t.sub ? 'yes' : 'no');
    UI.sheet('sheet-info');
  };

  UI.playlistPicker = function (ids) {
    const box = $('#pl-pick');
    box.innerHTML = '';
    $('#pl-dlg-title').textContent = 'Add to playlist';
    $('#pl-input').value = '';
    $('#pl-input').placeholder = 'Or type a new playlist name…';
    L.playlists.forEach(p => {
      const lb = el('label', {}, [
        el('input', { type: 'checkbox', value: p.id }),
        el('span', { text: p.name + ' · ' + p.items.length })
      ]);
      box.appendChild(lb);
    });
    if (!L.playlists.length) box.appendChild(el('p', { class: 'muted', text: 'No playlists yet — name one below.' }));
    UI.sheet('sheet-playlist');
    $('#pl-save').onclick = async () => {
      const checked = $$('#pl-pick input:checked').map(i => i.value);
      const name = $('#pl-input').value.trim();
      for (const pid of checked) await L.addToPlaylist(pid, ids);
      if (name) { const p = await L.createPlaylist(name, ids.slice()); HP.toast('Created “' + p.name + '”', 'ok'); }
      if (!checked.length && !name) { HP.toast('Pick a playlist or type a name', 'err'); return; }
      UI.closeAll(); L.renderPlaylists();
    };
  };

  UI.openPlaylist = function (pid) {
    const p = L.playlists.find(x => x.id === pid); if (!p) return;
    const ids = p.items.filter(id => L.tracks.has(id));
    $('#playlist-grid').hidden = true;
    $('.view-head', $('#view-playlists')).hidden = true;
    $('#playlist-detail').hidden = false;
    $('#pl-name').textContent = p.name;
    $('#pl-meta').textContent = ids.length + ' tracks';
    const box = $('#pl-tracks');
    box.innerHTML = '';
    ids.forEach(id => {
      const t = L.get(id);
      const cu = L.coverUrl(t);
      const row = el('div', { class: 'card', 'data-id': id }, [
        cu ? el('img', { class: 'card-art', src: cu, alt: '' }) : el('div', { class: 'card-art' }, [icon(t.kind === 'video' ? 'video' : 'music', 'ph')]),
        el('div', { class: 'card-info' }, [
          el('div', { class: 'card-title', text: t.title || t.name }),
          el('div', { class: 'card-sub', text: (t.artist || '—') + ' · ' + (t.duration ? HP.fmtTime(t.duration) : '—') })
        ])
      ]);
      const rm = el('button', { class: 'icon-btn tiny' }, [icon('x')]);
      rm.addEventListener('click', async e => {
        e.stopPropagation();
        p.items = p.items.filter(x => x !== id);
        await HP.DB.put('playlists', p); UI.openPlaylist(pid); L.renderPlaylists();
      });
      row.appendChild(el('div', { class: 'list-right' }, [rm]));
      row.addEventListener('click', () => { P.context = p.name; P.playTrack(id, ids); });
      /* long-tap / right-click → the full track menu (incl. Add to playlist) */
      row.addEventListener('contextmenu', e => { e.preventDefault(); UI.trackMenu(t, e.clientX, e.clientY); });
      let lpT;
      row.addEventListener('touchstart', e => {
        lpT = setTimeout(() => {
          if (navigator.vibrate) navigator.vibrate(12);
          const x = e.touches[0].clientX, y = e.touches[0].clientY;
          UI.trackMenu(t, x, y);
        }, 520);
      }, { passive: true });
      ['touchend', 'touchmove', 'touchcancel'].forEach(ev => row.addEventListener(ev, () => clearTimeout(lpT), { passive: true }));
      box.appendChild(row);
    });
    box.classList.add('list');
    $('#pl-play').onclick = () => { P.context = p.name; P.playList(ids); UI.openNP(true); };
    $('#pl-shuffle').onclick = () => { P.context = p.name; P.playList(ids, true); UI.openNP(true); };
    $('#pl-delete').onclick = async () => {
      if (!confirm('Delete playlist “' + p.name + '”?')) return;
      await L.deletePlaylist(pid); closePlaylistDetail(); L.renderPlaylists();
    };
  };
  function closePlaylistDetail() {
    $('#playlist-detail').hidden = true;
    $('#playlist-grid').hidden = false;
    $('.view-head', $('#view-playlists')).hidden = false;
  }

  /* ---- landscape: a phone turned sideways means "I want the video big" ---- */
  let landscapeAuto = false;
  UI.autoLandscape = function (isLandscape) {
    if (!S.autoLandscape) return;
    const video = document.body.classList.contains('has-video');
    const small = Math.min(w.innerWidth, w.innerHeight) < 560;
    if (isLandscape && video && small && $('#np').classList.contains('on')) {
      if (!document.body.classList.contains('cinema')) {
        landscapeAuto = true;
        document.body.classList.add('cinema');
        HP.Native.call('setFullscreen', true);
        HP.emit('fullscreen-ui', true);
      }
    } else if (!isLandscape && landscapeAuto) {
      landscapeAuto = false;
      document.body.classList.remove('cinema');
      HP.Native.call('setFullscreen', false);
      HP.emit('fullscreen-ui', false);
    }
  };
  /* browsers (and PWAs) get the same behaviour without the native callback */
  if (w.matchMedia) {
    const mq = w.matchMedia('(orientation:landscape)');
    const onMq = e => UI.autoLandscape(e.matches);
    if (mq.addEventListener) mq.addEventListener('change', onMq);
    else if (mq.addListener) mq.addListener(onMq);
  }

  /* ---- lyrics / subtitle tools ---- */
  UI.lyricsTool = function (t) {
    t = t || P.current;
    if (!t) { HP.toast('Play a track first'); return; }
    $('#lrc-text').value = t.lrc || '';
    $('#lrc-offset').textContent = ((P.lyrics && P.lyrics.offset) || 0).toFixed(1) + 's';
    UI.sheet('sheet-lyrics');
    $('#lrc-save').onclick = () => {
      t.lrc = $('#lrc-text').value.trim() || null;
      L.saveTrack(t);
      if (P.current && P.current.id === t.id) { P.loadLyrics(t); P.toggleLyrics(!!t.lrc); }
      UI.closeAll(); HP.toast(t.lrc ? 'Lyrics saved' : 'Lyrics removed', 'ok');
    };
    $('#lrc-clear').onclick = () => { $('#lrc-text').value = ''; };
    $('#lrc-load').onclick = () => UI.loadSidecar(t, 'lrc');
    $('#lrc-results').hidden = true;
    $('#lrc-online').onclick = () => UI.findLyricsOnline(t);
    const bump = d => {
      if (!P.lyrics) return;
      P.lyrics.offset = +((P.lyrics.offset || 0) + d).toFixed(1);
      $('#lrc-offset').textContent = P.lyrics.offset.toFixed(1) + 's';
      P.lrcIndex = -1;
    };
    $('#lrc-minus').onclick = () => bump(-.5);
    $('#lrc-plus').onclick = () => bump(.5);
  };
  /** One tap: look the current song up on LRCLIB and offer the matches. */
  UI.findLyricsOnline = async function (t) {
    t = t || P.current;
    if (!t) { HP.toast('Play a track first'); return; }
    const box = $('#lrc-results'), btn = $('#lrc-online');
    box.hidden = false;
    box.innerHTML = '';
    box.appendChild(el('div', { class: 'lrc-note', text: 'Searching for “' + (HP.Meta.cleanName(t.title || t.name) || t.name) + '”…' }));
    btn.disabled = true;
    try {
      const hits = await HP.Meta.findLyrics(t);
      box.innerHTML = '';
      hits.forEach(h => {
        const row = el('button', { class: 'lrc-hit', type: 'button' }, [
          el('span', { class: 'lrc-hit-main' }, [
            el('b', { text: h.title || '(untitled)' }),
            el('small', { text: (h.artist || 'Unknown') + (h.album ? ' · ' + h.album : '') })
          ]),
          el('span', { class: 'lrc-hit-tag' + (h.synced ? ' synced' : ''), text: h.synced ? 'Synced' : 'Plain' })
        ]);
        row.addEventListener('click', () => {
          $('#lrc-text').value = h.text;
          t.lrc = h.text;
          L.saveTrack(t);
          if (P.current && P.current.id === t.id) { P.loadLyrics(t); P.toggleLyrics(true); }
          box.hidden = true;
          HP.toast(h.synced ? 'Synced lyrics added' : 'Lyrics added', 'ok');
        });
        box.appendChild(row);
      });
    } catch (e) {
      const why = e && e.message;
      box.innerHTML = '';
      box.appendChild(el('div', { class: 'lrc-note', text:
        why === 'offline' ? 'You are offline — connect and try again.'
          : why === 'none' ? 'No lyrics found. Try fixing the title/artist, or paste them below.'
            : 'Lyrics service unreachable right now.' }));
      const g = el('button', { class: 'btn small ghost', type: 'button', text: 'Search the web instead' });
      g.addEventListener('click', () => {
        const q = encodeURIComponent(((t.artist || '') + ' ' + (t.title || t.name) + ' lyrics').trim());
        const u = 'https://duckduckgo.com/?q=' + q;
        if (w.HashNative && w.HashNative.openExternal) w.HashNative.openExternal(u);
        else w.open(u, '_blank', 'noopener');
      });
      box.appendChild(g);
    } finally { btn.disabled = false; }
  };

  UI.loadSidecar = function (t, kind) {
    const inp = $('#side-input');
    inp.value = '';
    inp.onchange = async () => {
      const f = inp.files[0]; if (!f) return;
      const txt = await f.text();
      if (kind === 'lrc') {
        t.lrc = txt; $('#lrc-text').value = txt;
        if (P.current && P.current.id === t.id) { P.loadLyrics(t); P.toggleLyrics(true); }
        HP.toast('Lyrics loaded', 'ok');
      } else {
        t.sub = HP.Meta.toVTT(txt, f.name);
        if (P.current && P.current.id === t.id) { $$('track', P.a).forEach(n => n.remove()); P.addSubtitle(t.sub); }
        HP.toast('Subtitles loaded', 'ok');
      }
      L.saveTrack(t);
    };
    inp.click();
  };

  /* =========================================================
     equaliser UI
     ========================================================= */
  function buildEQ() {
    const rack = $('#eq-rack');
    rack.innerHTML = '';
    E.FREQS.forEach((f, i) => {
      const val = el('span', { class: 'eq-val', text: fmtDb(S.eqGains[i]) });
      const r = el('input', { type: 'range', min: -12, max: 12, step: .5, value: S.eqGains[i], orient: 'vertical', 'aria-label': f + ' hertz' });
      r.addEventListener('input', () => {
        const v = +r.value;
        val.textContent = fmtDb(v);
        S.eqPreset = 'custom';
        E.setBand(i, v);
        $$('#eq-presets .chip').forEach(c => c.classList.remove('active'));
        drawCurve(); readout();
      });
      rack.appendChild(el('div', { class: 'eq-band' }, [
        val, r, el('span', { class: 'eq-hz', text: f >= 1000 ? (f / 1000) + 'k' : f })
      ]));
    });
    const pr = $('#eq-presets');
    pr.innerHTML = '';
    Object.keys(E.PRESETS).forEach(k => {
      const c = el('button', { class: 'chip' + (S.eqPreset === k ? ' active' : ''), 'data-preset': k, text: E.PRESET_NAMES[k] });
      c.addEventListener('click', () => {
        E.setPreset(k);
        $$('#eq-presets .chip').forEach(x => x.classList.toggle('active', x === c));
        if (!S.eqOn) { S.eqOn = true; $('#eq-enable').checked = true; E.applyEQ(); HP.save(); }
        syncEQSliders(); drawCurve(); readout();
      });
      pr.appendChild(c);
    });
  }
  const fmtDb = v => (v > 0 ? '+' : '') + (+v).toFixed(v % 1 ? 1 : 0);
  function syncEQSliders() {
    $$('#eq-rack .eq-band').forEach((b, i) => {
      b.querySelector('input').value = S.eqGains[i];
      b.querySelector('.eq-val').textContent = fmtDb(S.eqGains[i]);
    });
  }
  function readout() {
    const on = S.eqOn, max = Math.max.apply(null, S.eqGains.map(Math.abs));
    $('#eq-readout').textContent = !on ? 'Bypassed' : max < .5 ? 'Flat' : (E.PRESET_NAMES[S.eqPreset] || 'Custom') + ' · ±' + max.toFixed(1) + ' dB';
  }
  function drawCurve() {
    const c = $('#eq-curve'); if (!c) return;
    const d = Math.min(w.devicePixelRatio || 1, 2), r = c.getBoundingClientRect();
    c.width = Math.max(1, r.width * d); c.height = Math.max(1, r.height * d);
    const ctx = c.getContext('2d'), W = c.width, H = c.height;
    ctx.clearRect(0, 0, W, H);
    const cs = getComputedStyle(document.body);
    const a1 = cs.getPropertyValue('--a1').trim() || '#00e5ff', a2 = cs.getPropertyValue('--a2').trim() || '#b61bff';
    /* grid */
    ctx.strokeStyle = 'rgba(150,160,190,.16)'; ctx.lineWidth = 1 * d;
    [.25, .5, .75].forEach(p => { ctx.beginPath(); ctx.moveTo(0, H * p); ctx.lineTo(W, H * p); ctx.stroke(); });
    /* curve through the 10 band gains */
    const n = E.FREQS.length, pts = [];
    for (let i = 0; i < n; i++) {
      const x = (i + .5) / n * W;
      const g = S.eqOn ? (S.eqGains[i] || 0) + (i < 3 ? (S.bass || 0) * .4 : 0) + (i > 6 ? (S.treble || 0) * .4 : 0) : 0;
      pts.push({ x, y: H / 2 - (clamp(g, -16, 16) / 16) * (H / 2 - 6 * d) });
    }
    const grad = ctx.createLinearGradient(0, 0, W, 0);
    grad.addColorStop(0, a1); grad.addColorStop(1, a2);
    ctx.beginPath();
    ctx.moveTo(0, pts[0].y);
    for (let i = 0; i < pts.length - 1; i++) {
      const p0 = pts[i], p1 = pts[i + 1];
      ctx.quadraticCurveTo(p0.x, p0.y, (p0.x + p1.x) / 2, (p0.y + p1.y) / 2);
    }
    ctx.lineTo(W, pts[n - 1].y);
    ctx.strokeStyle = grad; ctx.lineWidth = 2.6 * d; ctx.shadowBlur = 14 * d; ctx.shadowColor = a1;
    ctx.stroke(); ctx.shadowBlur = 0;
    ctx.lineTo(W, H); ctx.lineTo(0, H); ctx.closePath();
    const fill = ctx.createLinearGradient(0, 0, 0, H);
    fill.addColorStop(0, a1 + '44'); fill.addColorStop(1, 'transparent');
    ctx.fillStyle = fill; ctx.fill();
    pts.forEach(p => { ctx.beginPath(); ctx.arc(p.x, p.y, 2.6 * d, 0, Math.PI * 2); ctx.fillStyle = '#fff'; ctx.fill(); });
  }
  UI.drawCurve = drawCurve;

  function bindFX() {
    const map = [
      ['#fx-preamp', 'preamp', v => v + ' dB'], ['#fx-bass', 'bass', v => '+' + v + ' dB'],
      ['#fx-treble', 'treble', v => (v > 0 ? '+' : '') + v + ' dB'], ['#fx-reverb', 'reverb', v => v + '%'],
      ['#fx-width', 'width', v => v + '%'], ['#fx-balance', 'balance', v => v == 0 ? 'C' : (v < 0 ? 'L' + -v : 'R' + v)],
      ['#fx-boost', 'boost', v => v + '%'], ['#fx-crossfade', 'crossfade', v => v == 0 ? 'Off' : v + 's']
    ];
    map.forEach(([sel, key, fmt]) => {
      const r = $(sel); if (!r) return;
      r.value = S[key];
      const out = r.parentElement.querySelector('output');
      const paint = () => { out.textContent = fmt(r.value); P.rangeFill(r); };
      paint();
      r.addEventListener('input', () => {
        S[key] = +r.value; HP.save(); paint(); E.applyAll();
        if (key === 'bass' || key === 'treble') drawCurve();
      });
    });
    const toggles = [['#fx-mono', 'mono'], ['#fx-normalize', 'normalize'], ['#fx-fade', 'fade'], ['#fx-pitch', 'pitch']];
    toggles.forEach(([sel, key]) => {
      const c = $(sel); if (!c) return;
      c.checked = !!S[key];
      c.addEventListener('change', () => {
        S[key] = c.checked; HP.save(); E.applyAll();
        if (key === 'pitch' && P.a) [P.a, P.b].forEach(m => { if ('preservesPitch' in m) m.preservesPitch = S.pitch; });
      });
    });
    const en = $('#eq-enable');
    en.checked = !!S.eqOn;
    en.addEventListener('change', () => { S.eqOn = en.checked; HP.save(); E.applyEQ(); drawCurve(); readout(); });
    $('#eq-reset').addEventListener('click', () => {
      E.setPreset('flat');
      ['preamp', 'bass', 'treble', 'reverb', 'balance'].forEach(k => S[k] = 0);
      S.width = 100; S.boost = 100;
      HP.save(); E.applyAll();
      bindFX(); syncEQSliders(); drawCurve(); readout();
      $$('#eq-presets .chip').forEach(x => x.classList.toggle('active', x.dataset.preset === 'flat'));
      HP.toast('Sound reset to flat');
    });
    readout();
  }

  /* =========================================================
     settings
     ========================================================= */
  function applyTheme() {
    document.body.className = document.body.className
      .replace(/theme-\w+/g, '').replace(/surface-\w+/g, '').trim();
    document.body.classList.add('theme-' + S.theme, 'surface-' + S.surface);
    document.body.classList.toggle('no-motion', !S.motion);
    document.body.classList.toggle('perf', !!S.perf);
    document.body.classList.toggle('mode-simple', !!S.simple);
    document.body.classList.toggle('mode-pro', !S.simple);
    const meta = $('meta[name=theme-color]');
    if (meta) meta.content = S.surface === 'light' ? '#eef1f8' : S.surface === 'amoled' ? '#000000' : '#07080c';
    HP.emit('theme');
    setTimeout(drawCurve, 60);
  }
  UI.applyTheme = applyTheme;

  function bindSettings() {
    $$('#theme-chips .chip').forEach(c => {
      c.classList.toggle('active', c.dataset.theme === S.theme);
      c.addEventListener('click', () => {
        S.theme = c.dataset.theme; HP.save();
        $$('#theme-chips .chip').forEach(x => x.classList.toggle('active', x === c));
        P.clearTint(); applyTheme();
      });
    });
    $$('#surface-chips .chip').forEach(c => {
      c.classList.toggle('active', c.dataset.surface === S.surface);
      c.addEventListener('click', () => {
        S.surface = c.dataset.surface; HP.save();
        $$('#surface-chips .chip').forEach(x => x.classList.toggle('active', x === c));
        applyTheme();
      });
    });
    $$('#vis-chips .chip').forEach(c => {
      c.classList.toggle('active', c.dataset.vis === S.vis);
      c.addEventListener('click', () => {
        HP.Vis.setMode(c.dataset.vis);
        $$('#vis-chips .chip').forEach(x => x.classList.toggle('active', x === c));
      });
    });
    const sw = [['#set-autotheme', 'autoTheme'], ['#set-motion', 'motion'], ['#set-simple', 'simple'],
    ['#set-perf', 'perf'], ['#set-gestures', 'gestures'], ['#set-resume', 'resume'],
    ['#set-autoplay', 'autoplayNext'], ['#set-keepawake', 'keepAwake'],
    ['#set-autoland', 'autoLandscape'], ['#set-autopip', 'autoPip'], ['#set-autoscan', 'autoScan'],
    ['#set-ytsearch', 'ytSearch']];
    sw.forEach(([sel, key]) => {
      const c = $(sel); if (!c) return;
      c.checked = !!S[key];
      c.addEventListener('change', () => {
        S[key] = c.checked; HP.save();
        HP.emit('setting', { k: key, v: c.checked });
        if (key === 'motion' || key === 'simple' || key === 'perf') applyTheme();
        if (key === 'perf') { HP.Vis.retune && HP.Vis.retune(); HP.toast(c.checked ? 'Smooth mode on — fewer effects, steadier playback' : 'Full effects on', 'ok'); }
        if (key === 'ytSearch') L.ytSearch(c.checked ? L.search : '');
        if (key === 'autoTheme') { if (!c.checked) P.clearTint(); else if (P.current) HP.emit('track-changed', P.current); }
      });
    });
    const ss = $('#set-seekstep');
    ss.value = String(S.seekStep);
    ss.addEventListener('change', () => { S.seekStep = +ss.value; HP.save(); });

    const sortSel = $('#sort-by');
    sortSel.value = S.sort;
    sortSel.addEventListener('change', () => { S.sort = sortSel.value; HP.save(); L.render(); });

    $('#btn-view-mode').addEventListener('click', () => {
      S.viewMode = S.viewMode === 'grid' ? 'list' : 'grid'; HP.save();
      $('#btn-view-mode use').setAttribute('href', S.viewMode === 'grid' ? '#i-grid' : '#i-list');
      L.render();
    });
    $('#btn-view-mode use').setAttribute('href', S.viewMode === 'grid' ? '#i-grid' : '#i-list');

    const pers = $('#set-persist');
    HP.DB.persisted().then(p => pers.checked = !!p);
    pers.addEventListener('change', async () => {
      if (pers.checked) {
        const ok = await HP.DB.persist();
        pers.checked = ok;
        HP.toast(ok ? 'Your library is protected from eviction' : 'The browser declined — keep using the app and try again', ok ? 'ok' : 'err');
      }
    });

    $('#btn-export').addEventListener('click', exportData);
    $('#btn-import').addEventListener('click', () => $('#import-input').click());
    $('#import-input').addEventListener('change', importData);
    $('#btn-clear').addEventListener('click', async () => {
      if (!confirm('Remove every track, playlist and setting from this device?')) return;
      await L.clearAll();
      localStorage.removeItem('hashplayer.settings.v2');
      location.reload();
    });
  }

  async function refreshStorage() {
    const e = await HP.DB.estimate();
    const st = L.stats();
    $('#storage-info').textContent = e && e.usage != null
      ? HP.fmtBytes(e.usage) + ' used by the app · ' + st.total + ' tracks indexed'
      : st.total + ' tracks indexed';
  }

  async function exportData() {
    const data = {
      app: 'HashPlayer', version: APP_VERSION, exported: new Date().toISOString(),
      settings: S,
      playlists: L.playlists,
      tracks: Array.from(L.tracks.values()).map(t => ({
        key: t.key, name: t.name, title: t.title, artist: t.artist, album: t.album, genre: t.genre,
        year: t.year, trackNo: t.trackNo, duration: t.duration, size: t.size, kind: t.kind,
        source: t.source, url: t.url, folder: t.folder, added: t.added, plays: t.plays,
        lastPlayed: t.lastPlayed, fav: t.fav, pos: t.pos, lrc: t.lrc, bookmarks: t.bookmarks
      }))
    };
    const b = new Blob([JSON.stringify(data, null, 1)], { type: 'application/json' });
    const a = el('a', { href: URL.createObjectURL(b), download: 'hashplayer-library.json' });
    document.body.appendChild(a); a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1500);
    HP.toast('Library exported', 'ok');
  }
  async function importData(e) {
    const f = e.target.files[0]; if (!f) return;
    try {
      const d = JSON.parse(await f.text());
      if (d.settings) { Object.assign(S, d.settings); HP.saveNow(); }
      if (Array.isArray(d.playlists)) for (const p of d.playlists) { L.playlists.push(p); await HP.DB.put('playlists', p); }
      let merged = 0, created = 0;
      const byKey = new Map(); L.tracks.forEach(t => byKey.set(t.key, t));
      for (const r of (d.tracks || [])) {
        const ex = byKey.get(r.key);
        if (ex) {
          ex.fav = ex.fav || r.fav; ex.plays = Math.max(ex.plays || 0, r.plays || 0);
          ex.lrc = ex.lrc || r.lrc; ex.bookmarks = (ex.bookmarks && ex.bookmarks.length) ? ex.bookmarks : (r.bookmarks || []);
          L.saveTrack(ex); merged++;
        } else if (r.source === 'url' && r.url) {
          const t = Object.assign({ id: HP.uid(), cover: null, file: null, handle: null, nativeUri: null, tagged: true }, r);
          L.tracks.set(t.id, t); await L.saveTrack(t); created++;
        }
      }
      HP.toast('Imported · ' + merged + ' updated, ' + created + ' added', 'ok');
      applyTheme(); HP.applyI18n(); L.render(); L.renderPlaylists(); Google.paint();
    } catch (x) { HP.toast('That file could not be read', 'err'); }
    e.target.value = '';
  }

  /* =========================================================
     keyboard
     ========================================================= */
  const KEYS = [
    ['Space / K', 'Play or pause'], ['← / →', 'Seek back / forward'], ['Shift + ← / →', 'Jump 1 minute'],
    ['↑ / ↓', 'Volume'], ['J / L', 'Seek 10 s'], ['M', 'Mute'], ['N / B', 'Next / previous track'],
    ['F', 'Fullscreen'], ['P', 'Picture-in-picture'], ['S', 'Shuffle'], ['R', 'Repeat mode'],
    ['E', 'Sound Lab'], ['Q', 'Queue'], ['Y', 'Lyrics'], ['C', 'Subtitles'], ['V', 'Next visualiser'],
    ['A', 'Set A-B loop point'], ['D', 'Bookmark this moment'], ['[ / ]', 'Slower / faster'],
    ['U', 'Lock / unlock the screen'],
    ['0–9', 'Jump to 0–90 %'], ['/', 'Search'], ['Esc', 'Close panels']
  ];
  function buildKeys() {
    const box = $('#keys-list'); box.innerHTML = '';
    KEYS.forEach(([k, d]) => box.appendChild(el('div', {}, [el('kbd', { text: k }), el('span', { text: d })])));
  }
  function bindKeys() {
    document.addEventListener('keydown', e => {
      const tag = (e.target.tagName || '').toLowerCase();
      if (tag === 'input' || tag === 'textarea' || tag === 'select' || e.target.isContentEditable) {
        if (e.key === 'Escape') e.target.blur();
        return;
      }
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      const k = e.key.toLowerCase();
      const step = +S.seekStep || 10;
      const hit = () => e.preventDefault();
      /* While the screen is locked only the unlock key works. */
      if (P.locked) {
        if (k === 'escape' || k === 'u') { hit(); P.setLock(false); }
        return;
      }
      switch (k) {
        case ' ': case 'k': hit(); P.toggle(); break;
        case 'arrowright': hit(); P.seekBy(e.shiftKey ? 60 : step); break;
        case 'arrowleft': hit(); P.seekBy(e.shiftKey ? -60 : -step); break;
        case 'l': hit(); P.seekBy(10); break;
        case 'j': hit(); P.seekBy(-10); break;
        case 'arrowup': hit(); E.setVolume(clamp(S.volume + .05, 0, 1)); break;
        case 'arrowdown': hit(); E.setVolume(clamp(S.volume - .05, 0, 1)); break;
        case 'm': S.muted = !S.muted; HP.save(); E.applyVolume(); break;
        case 'n': P.next(); break;
        case 'b': P.prev(); break;
        case 'f': P.toggleFullscreen(); break;
        case 'p': $('#v-pip').click(); break;
        case 's': P.toggleShuffle(); break;
        case 'r': P.cycleRepeat(); break;
        case 'e': UI.nav('eq'); break;
        case 'q': UI.toggleQueue(); break;
        case 'y': UI.openNP(true); P.toggleLyrics(); break;
        case 'c': P.toggleCC(); break;
        case 'u': if (document.body.classList.contains('has-video')) { hit(); P.toggleLock(); } break;
        case 'v': cycleVis(); break;
        case 'a': P.markAB(); break;
        case 'd': P.addBookmark(); break;
        case '[': P.setSpeed(Math.max(.25, S.speed - .25)); break;
        case ']': P.setSpeed(Math.min(4, S.speed + .25)); break;
        case '/': hit(); $('#search').focus(); break;
        case 'escape':
          if ($('#ctx').hidden === false) { $('#ctx').hidden = true; $('#scrim').classList.remove('on'); }
          else if (openSheetId) UI.closeAll();
          else if ($('#queue-panel').classList.contains('on')) UI.toggleQueue(false);
          else if ($('#np').classList.contains('on')) UI.openNP(false);
          break;
        default:
          if (/^[0-9]$/.test(k) && P.current) {
            const d = P.active.duration || 0;
            if (d) P.seek(d * (+k / 10));
          }
      }
    });
  }
  function cycleVis() {
    const modes = ['bars', 'mirror', 'wave', 'radial', 'nebula', 'off'];
    const i = (modes.indexOf(S.vis) + 1) % modes.length;
    HP.Vis.setMode(modes[i]);
    $$('#vis-chips .chip').forEach(x => x.classList.toggle('active', x.dataset.vis === modes[i]));
    HP.toast('Visualiser: ' + modes[i]);
  }

  /* =========================================================
     drag & drop + file inputs
     ========================================================= */
  function bindFiles() {
    const fi = $('#file-input'), di = $('#folder-input');
    const addFiles = () => HP.supportsFS ? L.pickWithHandles(false).then(r => { if (r === null) fi.click(); }) : fi.click();
    const addFolder = () => HP.supportsFS ? L.pickWithHandles(true).then(r => { if (r === null) di.click(); }) : di.click();
    fi.addEventListener('change', async () => { await L.addFiles(fi.files); fi.value = ''; L.render(); });
    di.addEventListener('change', async () => { await L.addFiles(di.files); di.value = ''; L.render(); });
    ['#btn-add-files', '#btn-empty-files', '#btn-add-top'].forEach(s => $(s) && $(s).addEventListener('click', addFiles));
    ['#btn-empty-folder'].forEach(s => $(s) && $(s).addEventListener('click', addFolder));
    $('#btn-add-url').addEventListener('click', () => { $('#url-input').value = ''; UI.sheet('sheet-url'); setTimeout(() => $('#url-input').focus(), 320); });
    $('#url-add').addEventListener('click', async () => {
      const t = await L.addUrl($('#url-input').value);
      UI.closeAll();
      if (t) { L.render(); P.playTrack(t.id, [t.id]); UI.openNP(true); }
    });
    $('#url-input').addEventListener('keydown', e => { if (e.key === 'Enter') $('#url-add').click(); });
    $('#btn-relink').addEventListener('click', addFiles);
    $('#btn-relink-hide').addEventListener('click', () => { L.relinkHidden = true; $('#relink-bar').hidden = true; });

    let dragN = 0;
    const dz = $('#dropzone');
    w.addEventListener('dragenter', e => { e.preventDefault(); if (e.dataTransfer && Array.from(e.dataTransfer.types || []).indexOf('Files') > -1) { dragN++; dz.classList.add('on'); } });
    w.addEventListener('dragover', e => e.preventDefault());
    w.addEventListener('dragleave', () => { if (--dragN <= 0) { dragN = 0; dz.classList.remove('on'); } });
    w.addEventListener('drop', async e => {
      e.preventDefault(); dragN = 0; dz.classList.remove('on');
      if (!e.dataTransfer) return;
      HP.toast('Reading files…');
      await L.addDataTransfer(e.dataTransfer);
      L.render();
    });
  }

  /* =========================================================
     Android bridge (used by the APK build)
     ========================================================= */
  const Native = {
    get available() { return !!w.HashNative; },
    scan() {
      if (!w.HashNative || !w.HashNative.scanMedia) { HP.toast('Device scan only works in the Android app', 'err'); return; }
      HP.toast('Scanning your device…');
      try { w.HashNative.scanMedia(); } catch (e) { HP.toast('Scan failed', 'err'); }
    },
    notify(playing) {
      const t = P.current;
      try { w.HashNative && w.HashNative.setPlaybackState && w.HashNative.setPlaybackState(!!playing, t ? (t.title || t.name) : '', t ? (t.artist || '') : ''); } catch (e) { }
      /* The home-screen widget shows the file that played last: title, artist,
         play/pause and a thumbnail. Whatever art we cannot hand over as a data
         url (device files) the shell reads itself through MediaStore. */
      const n = w.HashNative;
      if (!n || !n.setNowPlaying) return;
      const seq = ++widgetSeq;
      widgetArt(t).then(art => {
        if (seq !== widgetSeq) return;              // a newer track already spoke
        try {
          n.setNowPlaying(JSON.stringify({
            playing: !!playing,
            title: t ? (t.title || t.name || '') : '',
            artist: t ? (t.artist || '') : '',
            uri: t ? (t.nativeUri || t.url || (t.ytId ? 'https://www.youtube.com/watch?v=' + t.ytId : '')) : '',
            trackId: t ? (t.id || '') : '',
            kind: t ? (t.kind || 'audio') : 'audio',
            art: art || ''
          }));
        } catch (e) { }
      });
    },
    exit() { try { w.HashNative && w.HashNative.exitApp && w.HashNative.exitApp(); } catch (e) { } },
    call(fn) {
      const n = w.HashNative;
      if (!n || typeof n[fn] !== 'function') return undefined;
      try { return n[fn].apply(n, Array.prototype.slice.call(arguments, 1)); } catch (e) { return undefined; }
    }
  };
  /* A thumbnail for the widget: a data url when we already have one, the
     YouTube thumbnail url when the track has one, otherwise the embedded
     cover blob re-drawn at 192 px so the bridge string stays small. */
  let widgetSeq = 0;
  function widgetArt(t) {
    return new Promise(res => {
      const done = v => res(v || '');
      try {
        if (!t) return done('');
        const cu = L.coverUrl(t);
        if (typeof cu === 'string' && cu.indexOf('data:') === 0) return done(cu);
        if (typeof t.thumb === 'string' && t.thumb) return done(t.thumb);
        if (!t.cover || !w.URL || !w.URL.createObjectURL) return done('');
        const url = URL.createObjectURL(t.cover);
        const img = new Image();
        const timer = setTimeout(() => { URL.revokeObjectURL(url); done(''); }, 1200);
        img.onload = () => {
          clearTimeout(timer);
          try {
            const c = document.createElement('canvas'), n = 192;
            const side = Math.min(img.width || n, img.height || n) || n;
            c.width = n; c.height = n;
            c.getContext('2d').drawImage(img, ((img.width || side) - side) / 2, ((img.height || side) - side) / 2, side, side, 0, 0, n, n);
            done(c.toDataURL('image/jpeg', .85));
          } catch (e) { done(''); }
          URL.revokeObjectURL(url);
        };
        img.onerror = () => { clearTimeout(timer); URL.revokeObjectURL(url); done(''); };
        img.src = url;
      } catch (e) { done(''); }
    });
  }

  HP.Native = Native;

  /* =========================================================
     "Continue with Google" — the Android shell owns the WebView
     that holds the session, so it also owns the sign-in sheet.
     The web side only paints the two entry points (the library
     card and the Settings row) and asks the shell for the state.
     ========================================================= */
  const Google = {
    signedIn: false,
    get available() { try { return !!(w.HashNative && w.HashNative.googleSignInSheet); } catch (e) { return false; } },
    signIn() {
      try {
        if (w.HashNative && w.HashNative.googleSignInSheet) { w.HashNative.googleSignInSheet(); return; }
      } catch (e) { }
      L.openYouTube('');            // no shell sheet: the browser bar still has its pill
    },
    signOut() {
      try { w.HashNative && w.HashNative.googleSignOut && w.HashNative.googleSignOut(); } catch (e) { }
      Google.set(false);
    },
    set(on) { Google.signedIn = !!on; Google.paint(); },
    paint() {
      const app = HP.isAndroidApp;
      const panel = $('#panel-google');
      if (panel) panel.hidden = !app;
      const card = $('#g-card');
      if (card) card.hidden = !(app && !Google.signedIn && !S.googleCardHidden);
      const st = $('#g-status');
      if (st) st.textContent = HP.t(Google.signedIn ? 'gStatusIn' : 'gStatusOut');
      const b2 = $('#btn-google2');
      if (b2) {
        b2.classList.toggle('signed', Google.signedIn);
        const sp = b2.querySelector('span');
        if (sp) sp.textContent = HP.t(Google.signedIn ? 'gOpenYt' : 'gContinue');
      }
      const out = $('#btn-google-out');
      if (out) out.hidden = !(app && Google.signedIn);
    }
  };
  HP.Google = Google;

  function bindGoogle() {
    const card = $('#btn-google');
    if (card) card.addEventListener('click', () => Google.signIn());
    const hide = $('#g-card-hide');
    if (hide) hide.addEventListener('click', () => { S.googleCardHidden = true; HP.save(); Google.paint(); });
    const two = $('#btn-google2');
    if (two) two.addEventListener('click', () => {
      /* signed in → straight to your own feed; signed out → the sheet */
      if (Google.signedIn) L.openYouTube(''); else Google.signIn();
    });
    const out = $('#btn-google-out');
    if (out) out.addEventListener('click', () => Google.signOut());
    if (HP.isAndroidApp) {
      let v = false;
      try { v = !!(w.HashNative && w.HashNative.googleSignedIn && w.HashNative.googleSignedIn()); } catch (e) { }
      Google.set(v);
    } else Google.paint();
  }

  /* =========================================================
     Home-screen widget taps
     ========================================================= */
  UI.widgetAction = function (a) {
    UI.closeAll(); UI.toggleQueue(false);
    if (a === 'yt') { L.openYouTube($('#search') ? $('#search').value : ''); return; }
    if (a === 'search') {
      UI.openNP(false); UI.nav('library');
      const s = $('#search');
      if (s) setTimeout(() => { try { s.focus(); s.click(); } catch (e) { } }, 320);
      return;
    }
    if (a === 'playlists') { UI.openNP(false); UI.nav('playlists'); return; }
    if (a === 'toggle' && P.current) { P.toggle(); UI.openNP(true); return; }
    /* resume: the file that played last, from where it stopped. On a cold
       start the widget tap can beat IndexedDB, so give the library a few
       seconds to arrive before giving up. */
    const attempt = tries => {
      const id = (P.current && P.current.id) || S.lastId;
      if (id && L.tracks.has(id)) {
        UI.openNP(true);
        if (P.current && P.current.id === id) { P.play(); return; }
        P.context = 'Widget';
        P.playTrack(id, L.contextIds().length ? L.contextIds() : [id], S.lastPos || 0);
        return;
      }
      if (tries > 0) { setTimeout(() => attempt(tries - 1), 700); return; }
      UI.openNP(false); UI.nav('library');
      HP.toast(HP.t('widgetNothing'));
    };
    attempt(6);
  };

  /* called from Kotlin */
  let artTimer = 0;
  w.HashBridge = {
    /** silent = the automatic scan at launch; stay quiet unless we actually found something */
    onScan(json, silent) {
      try {
        L.addNative(JSON.parse(json), { quiet: !!silent }).then(added => {
          L.render();
          if (silent && added && added.length) HP.toast(added.length + ' tracks added from this device', 'ok');
        });
      } catch (e) { if (!silent) HP.toast('Scan result could not be read', 'err'); }
    },

    /** A link shared or opened from another app (YouTube, a browser, a chat…). */
    onOpenLink(url) {
      (async () => {
        try {
          /* A YouTube link or a direct media file plays straight away. Anything
             else (TikTok, Facebook, Instagram, X, a blog…) is a *page*: open it
             in the in-app browser, which finds the real video inside it. */
          const u = String(url || '');
          const yt = HP.YT && HP.YT.parse ? HP.YT.parse(u) : null;
          const direct = /\.(mp3|m4a|aac|flac|wav|ogg|opus|mp4|m4v|webm|mkv|mov|m3u8|mpd)(\?|#|$)/i.test(u);
          if (!(yt && yt.id) && !direct) { L.openWeb(u); return; }
          const t = await L.addUrl(u);
          if (!t) return;
          L.render();
          P.context = 'Shared link';
          await P.playTrack(t.id, [t.id]);
          UI.openNP(true);
        } catch (e) { HP.toast('Could not open that link', 'err'); }
      })();
    },

    /** Google sign-in state changed in the shell's WebView. */
    onGoogleSignIn(signedIn) {
      Google.set(!!signedIn);
      if (signedIn) HP.toast(HP.t('gSignedInToast'), 'ok');
    },

    /** A tap on the home-screen widget. */
    onWidget(action) { UI.widgetAction(String(action || '')); },

    /** The Activity entered or left system picture-in-picture. */
    onPip(active) {
      document.body.classList.toggle('in-pip', !!active);
      if (active) { UI.closeAll(); UI.toggleQueue(false); }
    },

    /** Device rotated — offer full-screen video in landscape. */
    onRotate(landscape) { UI.autoLandscape(!!landscape); },
    onBack() {
      if (P.locked) { P.setLock(false); return true; }   // one back press = unlock
      if (UI.isSearchActive) { UI.exitSearch(); return true; }
      if (!$('#ctx').hidden) { $('#ctx').hidden = true; $('#scrim').classList.remove('on'); return true; }
      if (openSheetId) { UI.closeAll(); return true; }
      if ($('#queue-panel').classList.contains('on')) { UI.toggleQueue(false); return true; }
      if ($('#np').classList.contains('on')) { UI.openNP(false); return true; }
      /* Defensive lifecycle repair for an interrupted native player transition. */
      if (document.body.classList.contains('nv-mode')) { P.setPlayerViewActive(false); return true; }
      if (document.body.dataset.view !== 'library') { UI.nav('library'); return true; }
      return false;
    },
    onOpenUri(json) {
      try {
        let items = JSON.parse(json);
        if (!Array.isArray(items)) items = [items];
        if (!items.length) return;
        L.addNative(items, { quiet: true }).then(added => {
          L.render();
          const ids = [];
          items.forEach(it => {
            let t = (added || []).find(x => x.nativeUri === it.uri);
            if (!t) L.tracks.forEach(x => { if (x.nativeUri === it.uri) t = x; });
            if (t) ids.push(t.id);
          });
          if (!ids.length) { HP.toast('Could not open that file', 'err'); return; }
          P.context = ids.length > 1 ? ids.length + ' shared files' : 'Opened file';
          P.playTrack(ids[0], ids);
          UI.openNP(true);
        });
      } catch (e) { HP.toast('Could not open that file', 'err'); }
    },
    /** ExoPlayer state for the track currently playing natively. */
    onNative(json) {
      if (!P.n) return;
      let s; try { s = JSON.parse(json); } catch (e) { return; }
      P.n.onState(s);
    },

    /** Album art / video thumbnail extracted natively for a device file. */
    onArt(uri, dataUrl) {
      if (!uri || !dataUrl) return;
      let hit = null;
      L.tracks.forEach(t => { if (!hit && t.nativeUri === uri) hit = t; });
      if (!hit || hit.thumb === dataUrl) return;
      hit.thumb = dataUrl;
      L.saveTrack(hit);
      HP.emit('track-updated', hit);
      clearTimeout(artTimer);
      artTimer = setTimeout(() => L.render(), 350);   // one repaint per burst
    },

    onTransport(action) {
      if (typeof action === 'string' && action.indexOf('seek:') === 0) {
        P.seek((parseInt(action.slice(5), 10) || 0) / 1000);
        return;
      }
      ({ play: () => P.play(), pause: () => P.pause(), next: () => P.next(), prev: () => P.prev(), toggle: () => P.toggle() }[action] || (() => { }))();
    },

    /**
     * The device media volume changed (hardware keys, another app, the system
     * panel). Follow it in the UI without writing it straight back.
     */
    onVolume(value) {
      const v = Math.max(0, Math.min(1, +value || 0));
      if (Math.abs((S.volume || 0) - v) < .005 && !S.muted) return;
      S.muted = false;
      HP.Engine.setVolume(v, { fromDevice: true });
    },

    /** Rows for one YouTube search, answered on the id we asked with. */
    onYtSearch(reqId, json) {
      if (HP.YT && HP.YT.deliver) HP.YT.deliver(reqId, json);
    },

    /** The in-app browser found the video on a page — play it here. */
    onOpenStream(json) {
      (async () => {
        try {
          const info = JSON.parse(json);
          const t = await L.addStream(info);
          if (!t) return;
          L.render();
          P.context = info.site || 'Web';
          await P.playTrack(t.id, [t.id]);
          UI.openNP(true);
        } catch (e) { HP.toast('Could not play that video', 'err'); }
      })();
    },

    /** Offline download progress from the Android shell. */
    onDownload(json) {
      let d = null;
      try { d = JSON.parse(json); } catch (e) { return; }
      if (!d) return;
      P.showDownload(d);
      if (d.state === 'done') {
        L.addNative([{
          uri: d.uri, name: d.name, title: d.title || '', artist: d.artist || '',
          album: '', size: d.size || 0, mime: d.mime || '', duration: d.duration || 0,
          kind: d.kind || 'video', folder: 'HashPlayer'
        }], { quiet: true }).then(() => {
          L.render();
          HP.toast('Saved for offline — it is in your library now', 'ok');
        });
      } else if (d.state === 'error') {
        HP.toast('Download failed: ' + (d.error || 'unknown'), 'err');
      } else if (d.state === 'start') {
        HP.toast('Downloading…', 'ok');
      }
    },

    /** The in-app YouTube browser opened/closed — re-sync the native picture. */
    onYtBrowser(open) {
      const onPlayer = $('#np') && $('#np').classList.contains('on');
      P.setPlayerViewActive(!open && !!onPlayer);
    },

    /** A video was tapped in the in-app YouTube browser — play it here. */
    onYtPick(id, title, author) {
      if (!id) return;
      L.pickYt(String(id), title || '', author || '').catch(() => { });
    }
  };

  /* =========================================================
     PWA install + service worker
     ========================================================= */
  let deferred = null;
  w.addEventListener('beforeinstallprompt', e => {
    e.preventDefault(); deferred = e;
    $('#btn-install').hidden = false; $('#btn-install2').hidden = false;
  });
  w.addEventListener('appinstalled', () => {
    deferred = null;
    $('#btn-install').hidden = true; $('#btn-install2').hidden = true;
    HP.toast('HashPlayer installed 🎉', 'ok');
  });
  async function doInstall() {
    if (!deferred) {
      HP.toast('Use your browser menu → “Install app” / “Add to Home screen”');
      return;
    }
    deferred.prompt();
    const r = await deferred.userChoice;
    if (r.outcome === 'accepted') HP.toast('Installing…', 'ok');
    deferred = null;
  }

  function registerSW() {
    if (!('serviceWorker' in navigator) || location.protocol === 'file:') return;
    navigator.serviceWorker.register('sw.js').catch(e => console.warn('[sw]', e));
  }

  /* =========================================================
     boot
     ========================================================= */
  async function boot() {
    applyTheme();
    HP.applyI18n();
    P.init();
    buildEQ(); bindFX(); bindSettings(); bindFiles(); bindKeys(); buildKeys();
    $('#app-version').textContent = 'v' + APP_VERSION;
    $('#about-env').textContent = HP.isAndroidApp ? 'Android app' : (matchMedia('(display-mode: standalone)').matches ? 'installed PWA' : 'web');

    /* nav */
    $$('.nav-item').forEach(n => n.addEventListener('click', () => UI.nav(n.dataset.nav)));
    $('#brand').addEventListener('click', e => { e.preventDefault(); UI.nav('library'); });
    $('#btn-menu').addEventListener('click', () => UI.toggleQueue());
    $('#btn-menu').setAttribute('aria-label', 'Queue');

    /* chips / toolbar */
    $$('#type-chips .chip').forEach(c => {
      c.classList.toggle('active', c.dataset.filter === S.filter);
      c.addEventListener('click', () => {
        S.filter = c.dataset.filter; HP.save();
        $$('#type-chips .chip').forEach(x => x.classList.toggle('active', x === c));
        L.render();
      });
    });
    const search = $('#search');
    search.addEventListener('input', () => UI.updateSearchActive());
    search.addEventListener('focus', () => { searchFocused = true; UI.updateSearchActive(); });
    search.addEventListener('blur', () => { searchFocused = false; UI.updateSearchActive(); });
    search.addEventListener('input', HP.debounce(() => {
      L.search = search.value;
      $('#search-clear').hidden = !search.value;
      L.render();
    }, 160));
    /* The same box also looks on YouTube — on a longer delay, so it waits for
       you to stop typing instead of firing a request per keystroke. */
    search.addEventListener('input', HP.debounce(() => L.ytSearch(search.value), 420));
    search.addEventListener('keydown', e => { if (e.key === 'Enter') L.ytSearch(search.value); });
    $('#search-clear').addEventListener('click', () => {
      search.value = ''; L.search = ''; $('#search-clear').hidden = true;
      L.render(); L.ytSearch(''); search.focus(); UI.updateSearchActive();
    });
    const ytHide = $('#yt-hide');
    if (ytHide) ytHide.addEventListener('click', () => { L.yt.rows = []; L.yt.error = ''; L.renderYt(); });
    w.addEventListener('online', () => { if (L.search) L.ytSearch(L.search); });
    $('#search-back').addEventListener('click', () => UI.exitSearch());
    /* The YouTube icon in the search bar opens YouTube itself — the real home
       feed and the real search, so the results are exactly the app's. */
    const ytOpen = $('#yt-open');
    if (ytOpen) ytOpen.addEventListener('click', () => L.openYouTube(search.value));
    $('#btn-play-all').addEventListener('click', () => { P.context = 'Library'; P.playList(L.contextIds()); UI.openNP(true); });
    $('#btn-shuffle-all').addEventListener('click', () => { P.context = 'Shuffle'; P.playList(L.contextIds(), true); UI.openNP(true); });
    $('#btn-scan').addEventListener('click', () => Native.scan());
    if (HP.isAndroidApp) $('#btn-scan').hidden = false;
    bindGoogle();

    /* playlists */
    $('#btn-new-playlist').addEventListener('click', () => {
      $('#pl-dlg-title').textContent = 'New playlist';
      $('#pl-pick').innerHTML = '';
      $('#pl-input').value = '';
      UI.sheet('sheet-playlist');
      $('#pl-save').onclick = async () => {
        const n = $('#pl-input').value.trim();
        if (!n) { HP.toast('Give it a name', 'err'); return; }
        await L.createPlaylist(n, []);
        UI.closeAll(); L.renderPlaylists(); HP.toast('Playlist created', 'ok');
      };
    });
    const saveQueue = async () => {
      if (!P.queue.length) { HP.toast('Queue is empty', 'err'); return; }
      $('#pl-dlg-title').textContent = 'Save queue as playlist';
      $('#pl-pick').innerHTML = '';
      $('#pl-input').value = 'Queue · ' + new Date().toLocaleDateString();
      UI.sheet('sheet-playlist');
      $('#pl-save').onclick = async () => {
        const n = $('#pl-input').value.trim() || 'Queue';
        await L.createPlaylist(n, P.queue.slice());
        UI.closeAll(); L.renderPlaylists(); HP.toast('Saved “' + n + '”', 'ok');
      };
    };
    $('#btn-save-queue').addEventListener('click', saveQueue);
    $('#q-save').addEventListener('click', saveQueue);
    $('#pl-back').addEventListener('click', () => { closePlaylistDetail(); L.renderPlaylists(); });
    $('#q-clear').addEventListener('click', () => P.clearQueue());
    $('#q-close').addEventListener('click', () => UI.toggleQueue(false));

    /* now playing open/close */
    $('#mini-art').addEventListener('click', () => UI.openNP(true));
    $('#mini-meta').addEventListener('click', () => UI.openNP(true));
    $('#mini-expand').addEventListener('click', () => UI.openNP(true));
    $('#np-close').addEventListener('click', () => UI.openNP(false));
    $('#np-more').addEventListener('click', e => { if (P.current) UI.trackMenu(P.current, e.clientX - 180, e.clientY + 10); });

    /* tools */
    $('#t-eq').addEventListener('click', () => { UI.openNP(false); UI.nav('eq'); });
    $('#t-vis').addEventListener('click', () => cycleVis());
    $('#t-sleep').addEventListener('click', () => UI.sheet('sheet-sleep'));
    $('#t-speed').addEventListener('click', () => UI.sheet('sheet-speed'));
    $$('#sleep-chips .chip').forEach(c => c.addEventListener('click', () => {
      P.setSleep(c.dataset.min === 'endtrack' ? 'endtrack' : +c.dataset.min);
      $$('#sleep-chips .chip').forEach(x => x.classList.toggle('active', x === c && c.dataset.min !== '0'));
    }));
    const spChips = $('#speed-chips');
    [.25, .5, .75, 1, 1.25, 1.5, 1.75, 2, 2.5, 3].forEach(v => {
      const c = el('button', { class: 'chip', 'data-sp': v, text: v + '×' });
      c.addEventListener('click', () => P.setSpeed(v));
      spChips.appendChild(c);
    });
    const sr = $('#speed-range');
    sr.addEventListener('input', () => P.setSpeed(sr.value / 100));

    /* pitch — a separate control: it never touches the speed, and the speed
       control never touches it */
    $$('#pitch-chips .chip').forEach(c =>
      c.addEventListener('click', () => P.setPitch(+c.dataset.st, true)));
    const pr = $('#pitch-range');
    if (pr) pr.addEventListener('input', () => P.setPitch(+pr.value, true));

    /* lyrics tool from the np toolbar (long press opens editor) */
    let lt;
    $('#t-lyrics').addEventListener('pointerdown', () => { lt = setTimeout(() => UI.lyricsTool(P.current), 550); });
    ['pointerup', 'pointerleave', 'pointercancel'].forEach(ev => $('#t-lyrics').addEventListener(ev, () => clearTimeout(lt)));
    $('#t-lyrics').addEventListener('dblclick', () => UI.lyricsTool(P.current));

    /* sheets */
    $$('[data-close]').forEach(b => b.addEventListener('click', () => UI.closeAll()));
    $('#scrim').addEventListener('click', () => { UI.closeAll(); UI.toggleQueue(false); });
    $('#btn-help').addEventListener('click', () => UI.sheet('sheet-help'));
    $('#btn-help2').addEventListener('click', () => UI.sheet('sheet-help'));
    $('#btn-install').addEventListener('click', doInstall);
    $('#btn-install2').addEventListener('click', doInstall);
    $('#btn-lang').addEventListener('click', () => {
      S.lang = S.lang === 'en' ? 'ur' : 'en'; HP.save();
      HP.applyI18n(); L.render(); Google.paint();
      HP.toast(S.lang === 'ur' ? 'زبان: اردو' : 'Language: English', 'ok');
    });

    /* library events */
    HP.on('library', () => { if (document.body.dataset.view === 'playlists') L.renderPlaylists(); });
    HP.on('track-updated', t => {
      const c = $('.card[data-id="' + t.id + '"]');
      if (!c) return;
      const title = c.querySelector('.card-title'), sub = c.querySelector('.card-sub'), dur = c.querySelector('.badge.dur');
      if (title) title.textContent = t.title || t.name;
      if (sub) sub.textContent = (t.artist || (t.kind === 'video' ? 'Video' : 'Unknown artist')) + (t.album ? ' · ' + t.album : '');
      if (dur) dur.textContent = t.duration ? HP.fmtTime(t.duration) : '—';
      const cu = L.coverUrl(t), art = c.querySelector('.card-art');
      if (cu && art && !art.querySelector('img')) {
        art.querySelector('.ph') && art.querySelector('.ph').remove();
        art.insertBefore(el('img', { src: cu, alt: '', loading: 'lazy' }), art.firstChild);
      }
    });
    HP.on('track-changed', () => P.highlightCards());

    /* load the library */
    await L.load();
    setTimeout(() => { try { L.requestArt(); } catch (e) { } }, 1200);   // fill in device artwork
    const qp = new URLSearchParams(location.search).get('view');
    UI.nav(['library', 'playlists', 'favorites', 'eq', 'settings'].indexOf(qp) > -1 ? qp : 'library');
    L.queueMeta(Array.from(L.tracks.values()).filter(t => !t.tagged));

    /* installed-app file handler: "Open with HashPlayer" */
    if ('launchQueue' in w && w.launchQueue && 'setConsumer' in w.launchQueue) {
      w.launchQueue.setConsumer(async params => {
        if (!params || !params.files || !params.files.length) return;
        const files = [], handles = new Map();
        for (const h of params.files) { try { const f = await h.getFile(); handles.set(f, h); files.push(f); } catch (e) { } }
        const added = await L.addFiles(files, { handles });
        L.render();
        if (added && added.length) { P.playTrack(added[0].id, added.map(t => t.id)); UI.openNP(true); }
      });
    }

    /* restore last session (paused) */
    if (S.resume && S.lastId && L.tracks.has(S.lastId)) {
      const t = L.get(S.lastId);
      P.queue = [t.id]; P.index = 0; P.current = t;
      P.syncMiniPlayer && P.syncMiniPlayer();
      $('#mini-title').textContent = t.title || t.name;
      $('#mini-artist').textContent = (t.artist || '—') + ' · tap to resume';
      const cu = L.coverUrl(t);
      if (cu) { $('#mini-img').src = cu; $('#mini-art').classList.add('has-img'); }
      const resume = async e => {
        e.stopImmediatePropagation(); e.preventDefault();
        $('#mini-play').removeEventListener('click', resume, true);
        await P.playTrack(t.id, L.contextIds().length ? L.contextIds() : [t.id], S.lastPos);
      };
      $('#mini-play').addEventListener('click', resume, true);
    }

    /* tell the Android shell how the user wants it to behave */
    if (Native.available) {
      HP.Native.call('setAutoPip', !!S.autoPip);
      HP.Native.call('keepAwake', !!S.keepAwake);
      /* Start from the device's real media volume so the slider tells the truth. */
      const dev = HP.Device && HP.Device.volume;
      if (dev && dev.available()) {
        const v = dev.get();
        if (v != null) { S.volume = v; S.muted = false; HP.save(); E.applyVolume({ fromDevice: true }); }
      }
      /* Real titles for YouTube videos resolved by the native engine. */
      if (HP.NativeMedia) HP.NativeMedia.onMeta = m => {
        if (!m || !m.uri || String(m.uri).indexOf('hpyt:') !== 0) return;
        L.updateYt(String(m.uri).slice(5), m);
        if (P.setNativeCaptionAvailability) P.setNativeCaptionAvailability(m);
      };
      const scanBtn = $('#btn-scan');
      if (scanBtn) { scanBtn.hidden = false; scanBtn.querySelector('span').textContent = 'Rescan device'; }
      /* the shell scans by itself on launch; this covers a reload with the page already granted */
      if (S.autoScan && !L.tracks.size) setTimeout(() => HP.Native.call('scanMedia'), 900);
      HP.on('setting', ({ k, v }) => {
        if (k === 'autoPip') HP.Native.call('setAutoPip', !!v);
        if (k === 'keepAwake') HP.Native.call('keepAwake', !!v);
      });
    }
    /* The IFrame API is only the fallback once the shell can stream YouTube itself. */
    if (HP.YT && navigator.onLine && !(HP.NativeMedia && HP.NativeMedia.youtube()) &&
      [...L.tracks.values()].some(t => t.source === 'yt')) HP.YT.preload();

    registerSW();
    setTimeout(() => $('#boot').classList.add('gone'), 420);
    setTimeout(() => { const b = $('#boot'); b && b.remove(); }, 1200);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();

  HP.UI = UI;
})(window);
