/* ============================================================
   HashPlayer · app.js — shell wiring, settings, EQ UI,
   shortcuts, drag & drop, PWA install, Android bridge,
   YouTube search & stream player, and One-Tap Online Lyrics.
   ============================================================ */
(function (w) {
  'use strict';
  const HP = w.HP, S = HP.S, $ = HP.$, $$ = HP.$$, el = HP.el, icon = HP.icon, clamp = HP.clamp;
  const L = HP.Lib, P = HP.Player, E = HP.Engine, UI = {};
  const APP_VERSION = '2.1.0';

  /* =========================================================
     views & navigation
     ========================================================= */
  UI.nav = function (view) {
    const map = {
      library: 'library',
      youtube: 'youtube',
      playlists: 'playlists',
      favorites: 'library',
      eq: 'eq',
      settings: 'settings'
    };
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
    if (target === 'youtube') {
      UI.loadYouTubeDefault();
    }
    if (target === 'playlists') { closePlaylistDetail(); L.renderPlaylists(); }
    if (target === 'eq') drawCurve();
    if (target === 'settings') refreshStorage();
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
  UI.openNP = function (on) {
    const np = $('#np');
    const show = on === undefined ? !np.classList.contains('on') : on;
    np.classList.toggle('on', show);
    np.setAttribute('aria-hidden', show ? 'false' : 'true');
    document.body.classList.toggle('np-open', show);
    if (show && S.lyricsOn) $('#lyrics').hidden = false;
    if (show) P.showHud();
  };

  /* =========================================================
     download / save media to device
     ========================================================= */
  UI.downloadMedia = async function (t) {
    t = t || P.current;
    if (!t) { HP.toast('Select a track or video first'); return; }

    if (t.source === 'native' || t.file) {
      HP.toast('Already saved on your device storage 📁', 'ok');
      return;
    }

    const title = HP.prettyName(t.title || t.name || 'Media');
    let ext = t.kind === 'video' ? '.mp4' : '.mp3';
    let mime = t.mime || (t.kind === 'video' ? 'video/mp4' : 'audio/mpeg');
    let streamUrl = t.url;

    HP.toast('Preparing download…');

    // If YouTube item without direct progressive stream url yet
    if (t.youtubeId || (t.origUrl && HP.Meta.isYouTube(t.origUrl))) {
      try {
        const id = t.youtubeId || HP.Meta.extractYouTubeId(t.origUrl);
        const yt = await HP.Meta.resolveYouTube(id);
        if (yt && yt.streamUrl && !yt.isEmbed) {
          streamUrl = yt.streamUrl;
        } else if (yt && yt.audioUrl) {
          streamUrl = yt.audioUrl;
          ext = '.m4a';
          mime = 'audio/mp4';
        }
      } catch (_) {}
    }

    if (!streamUrl) {
      HP.toast('Could not get download stream link', 'err');
      return;
    }

    const filename = (title.replace(/[/\\?%*:|"<>]/g, '_')) + ext;

    // Android native bridge
    if (w.HashNative && w.HashNative.downloadMedia) {
      try {
        w.HashNative.downloadMedia(streamUrl, filename, mime);
        HP.toast('Download started in background ⬇', 'ok');
        return;
      } catch (e) {
        console.warn('[native dl error]', e);
      }
    }

    // Web browser fallback
    try {
      const a = el('a', { href: streamUrl, download: filename, target: '_blank', rel: 'noopener noreferrer' });
      document.body.appendChild(a);
      a.click();
      setTimeout(() => a.remove(), 2000);
      HP.toast('Download requested ⬇', 'ok');
    } catch (_) {
      w.open(streamUrl, '_blank');
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
    item('dl', 'Download / Save to device', () => UI.downloadMedia(t));
    item('lyrics', 'Search lyrics online…', () => UI.searchLyricsOnline(t));
    item('lyrics', 'Edit lyrics…', () => UI.lyricsTool(t));
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

  /* =========================================================
     YouTube In-App Browser & Search
     ========================================================= */
  let ytLoadedQuery = null;

  UI.searchYouTube = async function (query) {
    query = String(query || '').trim();
    if (!query) return;
    ytLoadedQuery = query;

    const loader = $('#yt-loading');
    const resultsBox = $('#yt-results');
    if (loader) loader.hidden = false;
    if (resultsBox) resultsBox.innerHTML = '';

    const items = await HP.Meta.searchYouTube(query);
    if (loader) loader.hidden = true;

    if (!items || !items.length) {
      if (resultsBox) {
        resultsBox.innerHTML = `
          <div class="no-results">
            <b>No YouTube videos found</b>
            <span>Check your network connection or try different search keywords.</span>
          </div>`;
      }
      return;
    }

    if (resultsBox) {
      items.forEach(it => {
        const card = el('div', { class: 'yt-card' });

        const thumb = el('div', { class: 'yt-thumb' }, [
          el('img', { src: it.cover, alt: '', loading: 'lazy' }),
          it.duration ? el('span', { class: 'yt-dur', text: HP.fmtTime(it.duration) }) : null,
          el('div', { class: 'yt-play-overlay' }, [
            el('div', { class: 'yt-play-btn-circle' }, [icon('play')])
          ])
        ]);

        const info = el('div', { class: 'yt-card-info' }, [
          el('div', { class: 'yt-card-title', text: it.title }),
          el('div', { class: 'yt-card-artist', text: it.artist + (it.views ? ' · ' + it.views : '') })
        ]);

        const actRow = el('div', { class: 'yt-card-actions' });
        const addBtn = el('button', { class: 'btn tiny' }, [icon('plus'), el('span', { text: 'Library' })]);
        addBtn.addEventListener('click', async e => {
          e.stopPropagation();
          await L.addUrl(it.url);
        });

        const dlBtn = el('button', { class: 'btn tiny ghost' }, [icon('dl'), el('span', { text: 'Save' })]);
        dlBtn.addEventListener('click', async e => {
          e.stopPropagation();
          const t = await L.addUrl(it.url);
          if (t) UI.downloadMedia(t);
        });

        actRow.appendChild(addBtn);
        actRow.appendChild(dlBtn);
        info.appendChild(actRow);

        card.appendChild(thumb);
        card.appendChild(info);

        card.addEventListener('click', async () => {
          await L.addAndPlayUrl(it.url);
        });

        resultsBox.appendChild(card);
      });
    }
  };

  UI.loadYouTubeDefault = function () {
    if (!ytLoadedQuery) {
      const activeChip = $('#yt-trending-chips .chip.active');
      const q = activeChip ? activeChip.dataset.q : 'Trending Music 2024';
      UI.searchYouTube(q);
    }
  };

  function bindYouTubeUI() {
    const inp = $('#yt-search-input');
    const clearBtn = $('#yt-search-clear');
    const goBtn = $('#yt-search-go');

    if (inp) {
      inp.addEventListener('input', () => {
        if (clearBtn) clearBtn.hidden = !inp.value;
      });
      inp.addEventListener('keydown', e => {
        if (e.key === 'Enter') {
          $$('#yt-trending-chips .chip').forEach(c => c.classList.remove('active'));
          UI.searchYouTube(inp.value.trim());
        }
      });
    }

    if (clearBtn) {
      clearBtn.addEventListener('click', () => {
        if (inp) { inp.value = ''; inp.focus(); }
        clearBtn.hidden = true;
      });
    }

    if (goBtn) {
      goBtn.addEventListener('click', () => {
        if (inp && inp.value.trim()) {
          $$('#yt-trending-chips .chip').forEach(c => c.classList.remove('active'));
          UI.searchYouTube(inp.value.trim());
        }
      });
    }

    $$('#yt-trending-chips .chip').forEach(chip => {
      chip.addEventListener('click', () => {
        $$('#yt-trending-chips .chip').forEach(c => c.classList.remove('active'));
        chip.classList.add('active');
        if (inp) inp.value = '';
        if (clearBtn) clearBtn.hidden = true;
        UI.searchYouTube(chip.dataset.q);
      });
    });

    const pasteBtn = $('#yt-open-link');
    if (pasteBtn) {
      pasteBtn.addEventListener('click', () => {
        $('#url-input').value = '';
        UI.sheet('sheet-url');
        setTimeout(() => $('#url-input').focus(), 320);
      });
    }
  }

  /* =========================================================
     One-Tap Online Lyrics Search (LRCLIB)
     ========================================================= */
  UI.searchLyricsOnline = async function (t) {
    t = t || P.current;
    if (!t) { HP.toast('Play or pick a track first'); return; }

    const input = $('#lrc-search-q');
    const resultsBox = $('#lrc-search-results');
    const defaultQuery = (t.artist ? t.artist + ' ' : '') + (t.title || t.name);
    input.value = defaultQuery;
    resultsBox.innerHTML = '<div class="lrc-searching"><div class="boot-ring mini"></div><span>Searching online lyrics…</span></div>';
    UI.sheet('sheet-lyrics-search');

    async function doSearch(query) {
      resultsBox.innerHTML = '<div class="lrc-searching"><div class="boot-ring mini"></div><span>Searching online lyrics…</span></div>';
      const items = await HP.Meta.searchLyricsQuery(query);
      resultsBox.innerHTML = '';

      if (!items || !items.length) {
        resultsBox.appendChild(el('div', { class: 'lrc-no-results', text: 'No lyrics found online. Try editing the search query above.' }));
        return;
      }

      items.forEach(item => {
        const hasSync = !!item.syncedLyrics;
        const durStr = item.duration ? HP.fmtTime(item.duration) : '';
        const badge = el('span', { class: 'badge ' + (hasSync ? 'v' : ''), text: hasSync ? 'SYNCED LRC' : 'PLAIN' });
        const titleEl = el('b', { text: item.trackName || 'Unknown Title' });
        const subEl = el('small', { text: (item.artistName || '—') + (item.albumName ? ' · ' + item.albumName : '') + (durStr ? ' · ' + durStr : '') });

        const row = el('div', { class: 'lrc-res-item' }, [
          el('div', { class: 'lrc-res-info' }, [titleEl, subEl]),
          badge
        ]);

        row.addEventListener('click', () => {
          const lrcText = item.syncedLyrics || item.plainLyrics;
          if (!lrcText) return;
          t.lrc = lrcText;
          L.saveTrack(t);
          if (P.current && P.current.id === t.id) {
            P.loadLyrics(t);
            P.toggleLyrics(true);
          }
          UI.closeAll();
          HP.toast('Synced lyrics added 🎉', 'ok');
        });
        resultsBox.appendChild(row);
      });
    }

    $('#lrc-search-btn').onclick = () => doSearch(input.value.trim());
    input.onkeydown = e => { if (e.key === 'Enter') doSearch(input.value.trim()); };

    // Initial search
    doSearch(defaultQuery);
  };

  /* ---- lyrics / subtitle tools ---- */
  UI.lyricsTool = function (t) {
    t = t || P.current;
    if (!t) { HP.toast('Play a track first'); return; }
    $('#lrc-text').value = t.lrc || '';
    $('#lrc-offset').textContent = ((P.lyrics && P.lyrics.offset) || 0).toFixed(1) + 's';
    UI.sheet('sheet-lyrics');

    $('#lrc-search-online').onclick = () => UI.searchLyricsOnline(t);

    $('#lrc-save').onclick = () => {
      t.lrc = $('#lrc-text').value.trim() || null;
      L.saveTrack(t);
      if (P.current && P.current.id === t.id) { P.loadLyrics(t); P.toggleLyrics(!!t.lrc); }
      UI.closeAll(); HP.toast(t.lrc ? 'Lyrics saved' : 'Lyrics removed', 'ok');
    };
    $('#lrc-clear').onclick = () => { $('#lrc-text').value = ''; };
    $('#lrc-load').onclick = () => UI.loadSidecar(t, 'lrc');
    const bump = d => {
      if (!P.lyrics) return;
      P.lyrics.offset = +((P.lyrics.offset || 0) + d).toFixed(1);
      $('#lrc-offset').textContent = P.lyrics.offset.toFixed(1) + 's';
      P.lrcIndex = -1;
    };
    $('#lrc-minus').onclick = () => bump(-.5);
    $('#lrc-plus').onclick = () => bump(.5);
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
    /* curve through 10 band gains */
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
      });
    });
    $('#eq-enable').checked = !!S.eqOn;
    $('#eq-enable').addEventListener('change', () => {
      S.eqOn = $('#eq-enable').checked; HP.save(); E.applyEQ(); drawCurve(); readout();
    });
    $('#eq-reset').addEventListener('click', () => {
      E.setPreset('flat');
      $$('#eq-presets .chip').forEach(x => x.classList.toggle('active', x.dataset.preset === 'flat'));
      syncEQSliders(); drawCurve(); readout();
    });
  }

  /* =========================================================
     settings UI
     ========================================================= */
  function applyTheme() {
    document.body.className = document.body.className
      .replace(/\btheme-\S+/g, '')
      .replace(/\bsurface-\S+/g, '')
      .replace(/\bmode-\S+/g, '')
      .replace(/\bno-motion\b/g, '')
      .trim();
    document.body.classList.add('theme-' + S.theme, 'surface-' + S.surface, S.simple ? 'mode-simple' : 'mode-pro');
    if (!S.motion) document.body.classList.add('no-motion');
    const th = { dark: '#07080c', amoled: '#000000', light: '#f4f6fa' }[S.surface] || '#07080c';
    $('meta[name="theme-color"]').setAttribute('content', th);
  }
  UI.applyTheme = applyTheme;

  function bindSettings() {
    $$('#theme-chips .chip').forEach(c => {
      c.classList.toggle('active', c.dataset.theme === S.theme);
      c.addEventListener('click', () => {
        S.theme = c.dataset.theme; HP.save();
        $$('#theme-chips .chip').forEach(x => x.classList.toggle('active', x === c));
        applyTheme();
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
    ['#set-gestures', 'gestures'], ['#set-resume', 'resume'], ['#set-autoplay', 'autoplayNext'],
    ['#set-keepawake', 'keepAwake']];
    sw.forEach(([sel, key]) => {
      const c = $(sel); if (!c) return;
      c.checked = !!S[key];
      c.addEventListener('change', () => {
        S[key] = c.checked; HP.save();
        if (key === 'motion' || key === 'simple') applyTheme();
        if (key === 'autoTheme') { if (P.current) HP.emit('track-changed', P.current); }
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
        HP.toast(ok ? 'Your library is protected from eviction' : 'Keep using the app and try again', ok ? 'ok' : 'err');
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
      ? HP.fmtBytes(e.usage) + ' used · ' + st.total + ' tracks indexed'
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
      applyTheme(); HP.applyI18n(); L.render(); L.renderPlaylists();
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
        case 'p': P.togglePip(); break;
        case 's': P.toggleShuffle ? P.toggleShuffle() : $('#btn-shuf').click(); break;
        case 'r': P.cycleRepeat ? P.cycleRepeat() : $('#btn-rep').click(); break;
        case 'e': UI.nav('eq'); break;
        case 'q': UI.toggleQueue(); break;
        case 'y': UI.openNP(true); P.toggleLyrics(); break;
        case 'c': P.toggleCC(); break;
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
    ['#btn-add-folder', '#btn-empty-folder'].forEach(s => $(s) && $(s).addEventListener('click', addFolder));
    $('#btn-add-url').addEventListener('click', () => { $('#url-input').value = ''; UI.sheet('sheet-url'); setTimeout(() => $('#url-input').focus(), 320); });
    $('#url-add').addEventListener('click', async () => {
      const u = $('#url-input').value.trim();
      if (!u) return;
      UI.closeAll();
      await L.addAndPlayUrl(u);
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
    notify(playing, title, artist, isVideo) {
      try {
        if (w.HashNative && w.HashNative.setPlaybackState) {
          w.HashNative.setPlaybackState(
            !!playing,
            title || (P.current ? (P.current.title || P.current.name) : ''),
            artist || (P.current ? P.current.artist : ''),
            !!isVideo
          );
        }
      } catch (e) { }
    },
    exit() { try { w.HashNative && w.HashNative.exitApp && w.HashNative.exitApp(); } catch (e) { } }
  };
  HP.Native = Native;

  /* called from Kotlin */
  w.HashBridge = {
    onScan(json) {
      try {
        L.addNative(JSON.parse(json)).then(() => L.render());
      } catch (e) {
        HP.toast('Scan result could not be read', 'err');
      }
    },
    onBack() {
      if (!$('#ctx').hidden) { $('#ctx').hidden = true; $('#scrim').classList.remove('on'); return true; }
      if (openSheetId) { UI.closeAll(); return true; }
      if ($('#queue-panel').classList.contains('on')) { UI.toggleQueue(false); return true; }
      if ($('#np').classList.contains('on')) { UI.openNP(false); return true; }
      if (document.body.dataset.view !== 'library') { UI.nav('library'); return true; }
      return false;
    },
    onOpenUri(json) {
      try {
        const it = JSON.parse(json);
        L.addNative([it]).then(added => {
          L.render();
          let t = (added && added[0]) || null;
          if (!t) L.tracks.forEach(x => { if (!t && x.nativeUri === it.uri) t = x; });
          if (t) { P.context = 'Opened file'; P.playTrack(t.id, [t.id]); UI.openNP(true); }
        });
      } catch (e) { HP.toast('Could not open that file', 'err'); }
    },
    onOpenUrl(url) {
      if (url) {
        L.addAndPlayUrl(url);
      }
    },
    onPipMode(inPip) {
      document.body.classList.toggle('in-pip', !!inPip);
      if (inPip && !$('#np').classList.contains('on')) {
        UI.openNP(true);
      }
    },
    onTransport(action) {
      ({ play: () => P.play(), pause: () => P.pause(), next: () => P.next(), prev: () => P.prev(), toggle: () => P.toggle() }[action] || (() => { }))();
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
    buildEQ(); bindFX(); bindSettings(); bindFiles(); bindKeys(); buildKeys(); bindYouTubeUI();
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
    search.addEventListener('input', HP.debounce(() => {
      L.search = search.value;
      $('#search-clear').hidden = !search.value;
      L.render();
    }, 160));
    $('#search-clear').addEventListener('click', () => { search.value = ''; L.search = ''; $('#search-clear').hidden = true; L.render(); search.focus(); });
    $('#btn-play-all').addEventListener('click', () => { P.context = 'Library'; P.playList(L.contextIds()); UI.openNP(true); });
    $('#btn-shuffle-all').addEventListener('click', () => { P.context = 'Shuffle'; P.playList(L.contextIds(), true); UI.openNP(true); });
    $('#btn-scan').addEventListener('click', () => Native.scan());
    if (HP.isAndroidApp) $('#btn-scan').hidden = false;

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
      HP.applyI18n(); L.render();
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
    const qp = new URLSearchParams(location.search).get('view');
    UI.nav(['library', 'youtube', 'playlists', 'favorites', 'eq', 'settings'].indexOf(qp) > -1 ? qp : 'library');
    L.queueMeta(Array.from(L.tracks.values()).filter(t => !t.tagged));

    /* auto-scan media on device startup in Android app */
    if (w.HashNative && w.HashNative.autoScan) {
      try { w.HashNative.autoScan(); } catch (_) {}
    }

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
      $('#minibar').hidden = false;
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

    registerSW();
    setTimeout(() => $('#boot').classList.add('gone'), 420);
    setTimeout(() => { const b = $('#boot'); b && b.remove(); }, 1200);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();

  HP.UI = UI;
})(window);
