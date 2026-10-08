/* ============================================================
   HashPlayer · tv.js — the ten-foot (Android TV) layer

   A TV has no finger: the remote gives a D-pad, a centre/OK key and a back
   key. This file turns those into the same point-and-click experience the
   touch app has:

     · D-pad        → spatial focus navigation across every button and card
     · centre / OK  → activates the focused control (a plain click)
     · back         → handled by the shell's existing back logic

   It also applies the TV performance profile: TV boxes are usually weaker
   than a phone from the same year, so we switch on the light renderer, drop
   the animated aurora and gestures, and start without a visualiser. Playback
   stays smooth instead of fighting the compositor for every frame.

   On the Android `tv` build the shell translates remote keys into the
   HP.TV.* calls below (dispatchKeyEvent). In a browser on a set-top box the
   same calls come from the DOM keydown listener at the bottom.
   ============================================================ */
(function (w) {
  'use strict';
  const HP = w.HP, S = HP.S;
  const ua = navigator.userAgent || '';

  const TV = {};
  TV.on = !!(
    (w.HashNative && w.HashNative.isTv && w.HashNative.isTv()) ||
    /-TV\b/.test(ua) ||
    /Android TV|GoogleTV|SMART-TV|Tizen|webOS|BRAVIA|AFTMM|AFT|CrKey|Pov_TV/i.test(ua)
  );
  HP.TV = TV;
  if (!TV.on) return;                       // a phone or desktop: touch is king

  document.documentElement.classList.add('tv');
  document.body.classList.add('tv');

  /* ---------------- the TV performance profile ----------------
     Deliberately applied on first load and persisted; the user can still
     re-enable any of it from Settings, this is only the sensible default. */
  S.perf = true;                            // light renderer, no heavy blur
  S.motion = false;                         // stop the idle animations
  S.gestures = false;                       // there is no touch to gesture with
  S.autoPip = false;                        // picture-in-picture is pointless on a TV
  S.autoLandscape = false;                  // the TV is always landscape already
  if (!S.vis || S.vis === 'bars') S.vis = 'off';
  HP.saveNow();

  /* ---------------- spatial navigation ---------------- */
  const SEL = 'button:not([disabled]), input:not([disabled]), select, a[href], [tabindex]:not([tabindex="-1"])';

  function visible(el) {
    if (!el || el.disabled) return false;
    const r = el.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) return false;
    const cs = getComputedStyle(el);
    if (cs.visibility === 'hidden' || cs.display === 'none') return false;
    return true;
  }
  function focusables() {
    return Array.from(document.querySelectorAll(SEL)).filter(visible)
      .filter(el => !el.closest('[aria-hidden="true"]'));
  }
  function center(el) {
    const r = el.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  }
  function current() {
    const a = document.activeElement;
    return a && a !== document.body && a.matches && a.matches(SEL) && visible(a) ? a : null;
  }

  /* Pick the nearest control in the given direction, using the dominant-axis
     distance so rows and columns feel like rows and columns. */
  function neighbour(from, dir) {
    const f = center(from);
    let best = null, bestScore = Infinity;
    for (const el of focusables()) {
      if (el === from) continue;
      const c = center(el);
      const dx = c.x - f.x, dy = c.y - f.y;
      let primary, cross;
      switch (dir) {
        case 'right': if (dx <= 0) continue; primary = dx; cross = Math.abs(dy); break;
        case 'left': if (dx >= 0) continue; primary = -dx; cross = Math.abs(dy); break;
        case 'down': if (dy <= 0) continue; primary = dy; cross = Math.abs(dx); break;
        default: if (dy >= 0) continue; primary = -dy; cross = Math.abs(dx); break;
      }
      /* Crossing a big gap on the other axis should cost more than moving
         along the axis you pressed. */
      const score = primary + cross * 2.2;
      if (score < bestScore) { bestScore = score; best = el; }
    }
    return best;
  }

  TV.move = function (dir) {
    const list = focusables();
    if (!list.length) return;
    let cur = current();
    if (!cur) {
      /* Start somewhere sensible: the nav, else the first control. */
      cur = list.find(el => el.classList && el.classList.contains('nav-item')) || list[0];
    } else {
      cur = neighbour(cur, dir) || cur;
    }
    try { cur.focus({ preventScroll: false }); } catch (e) { cur.focus(); }
    cur.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'smooth' });
  };

  TV.center = function () {
    const a = current();
    if (!a) { TV.move('down'); return; }
    if (a.tagName === 'INPUT' || a.tagName === 'SELECT') { a.click(); return; }
    a.click();
  };

  /* On a range slider the left/right arrows should nudge the value, not move
     focus — a remote user expects that. */
  function sliderNudge(a, dir) {
    if (!a || a.tagName !== 'INPUT' || a.type !== 'range') return false;
    const step = parseFloat(a.step || '1');
    const val = parseFloat(a.value || '0');
    const min = parseFloat(a.min || '0'), max = parseFloat(a.max || '100');
    let v = val;
    if (dir === 'right' || dir === 'down') v = Math.min(max, val + step);
    if (dir === 'left' || dir === 'up') v = Math.max(min, val - step);
    if (v !== val) {
      a.value = v;
      a.dispatchEvent(new Event('input', { bubbles: true }));
      a.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    }
    return false;
  }

  function handleMove(dir, e) {
    const a = current();
    if (a && (dir === 'left' || dir === 'right' || dir === 'up' || dir === 'down') && sliderNudge(a, dir)) {
      if (e) e.preventDefault();
      return true;
    }
    TV.move(dir);
    if (e) e.preventDefault();
    return true;
  }

  /* Browser on a set-top box: real arrow keys. Capture phase + stopPropagation
     so the desktop shortcut layer (which maps arrows to seek/volume) never sees
     them while the TV layer is in charge. */
  document.addEventListener('keydown', e => {
    const tag = ((e.target && e.target.tagName) || '').toLowerCase();
    if (tag === 'textarea' || e.target.isContentEditable) return;
    switch (e.key) {
      case 'ArrowUp': handleMove('up', e); break;
      case 'ArrowDown': handleMove('down', e); break;
      case 'ArrowLeft': handleMove('left', e); break;
      case 'ArrowRight': handleMove('right', e); break;
      case 'Enter':
        if (current()) { e.preventDefault(); TV.center(); }
        break;
    }
  }, true);

  /* Re-apply the theme so the performance profile shows immediately. */
  if (HP.UI && HP.UI.applyTheme) HP.UI.applyTheme();
  HP.emit('tv', true);
})(window);
