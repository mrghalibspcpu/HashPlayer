/* ============================================================
   HashPlayer · visual.js — audio visualiser + energy timeline
   ============================================================ */
(function (w) {
  'use strict';
  const HP = w.HP, S = HP.S;
  const V = { mode: S.vis || 'bars', running: false, visible: () => true };
  let cvs, ctx, dpr = 1, W = 0, H = 0, raf = 0, freq = null, time = null, parts = [], t0 = performance.now();
  let a1 = '#00e5ff', a2 = '#b61bff', gold = '#ffcf6b';

  function readColors() {
    const cs = getComputedStyle(document.body);
    a1 = (cs.getPropertyValue('--a1') || '#00e5ff').trim();
    a2 = (cs.getPropertyValue('--a2') || '#b61bff').trim();
    gold = (cs.getPropertyValue('--gold') || '#ffcf6b').trim();
  }
  HP.on('theme', readColors);

  function size() {
    if (!cvs) return;
    const r = cvs.getBoundingClientRect();
    dpr = Math.min(w.devicePixelRatio || 1, 2);
    W = Math.max(1, Math.round(r.width * dpr));
    H = Math.max(1, Math.round(r.height * dpr));
    if (cvs.width !== W || cvs.height !== H) { cvs.width = W; cvs.height = H; }
  }

  V.init = function (canvas) {
    cvs = canvas; ctx = cvs.getContext('2d');
    readColors(); size();
    if (w.ResizeObserver) new ResizeObserver(size).observe(cvs);
    else w.addEventListener('resize', size);
  };
  V.setMode = function (m) {
    V.mode = m; S.vis = m; HP.save();
    document.body.classList.toggle('vis-off', m === 'off');
    if (ctx) ctx.clearRect(0, 0, W, H);
    HP.emit('vis', m);
  };
  V.start = function () { if (V.running) return; V.running = true; loop(); };
  V.stop = function () { V.running = false; cancelAnimationFrame(raf); };

  function loop() {
    if (!V.running) return;
    raf = requestAnimationFrame(loop);
    if (!ctx || V.mode === 'off' || document.hidden || !V.visible()) return;
    const an = HP.Engine.analyser;
    size();
    ctx.clearRect(0, 0, W, H);
    if (!an) { idle(); return; }
    const n = an.frequencyBinCount;
    if (!freq || freq.length !== n) { freq = new Uint8Array(n); time = new Uint8Array(n); }
    an.getByteFrequencyData(freq);
    an.getByteTimeDomainData(time);
    switch (V.mode) {
      case 'mirror': mirror(); break;
      case 'wave': wave(); break;
      case 'radial': radial(); break;
      case 'nebula': nebula(); break;
      default: bars();
    }
  }

  /* average of a frequency slice (0..1) */
  function band(from, to) {
    let s = 0, c = 0;
    for (let i = from; i < to && i < freq.length; i++) { s += freq[i]; c++; }
    return c ? s / c / 255 : 0;
  }
  V.level = () => freq ? band(0, Math.min(90, freq.length)) : 0;
  V.bass = () => freq ? band(1, 10) : 0;

  function grad(x0, y0, x1, y1) {
    const g = ctx.createLinearGradient(x0, y0, x1, y1);
    g.addColorStop(0, a1); g.addColorStop(.55, a2); g.addColorStop(1, gold);
    return g;
  }

  /* ---------- modes ---------- */
  function bars() {
    const count = Math.max(26, Math.min(72, Math.floor(W / dpr / 11)));
    const gap = W * .004, bw = (W - gap * (count - 1)) / count;
    ctx.fillStyle = grad(0, H, W, 0);
    const max = Math.floor(freq.length * .62);
    for (let i = 0; i < count; i++) {
      const lo = Math.floor(Math.pow(i / count, 1.7) * max), hi = Math.max(lo + 1, Math.floor(Math.pow((i + 1) / count, 1.7) * max));
      const v = Math.pow(band(lo, hi), .82);
      const h = Math.max(2 * dpr, v * H * .78);
      const x = i * (bw + gap);
      round(x, H - h, bw, h, Math.min(bw / 2, 5 * dpr));
    }
  }
  function mirror() {
    const count = Math.max(22, Math.min(64, Math.floor(W / dpr / 13)));
    const gap = W * .005, bw = (W - gap * (count - 1)) / count, mid = H / 2;
    ctx.fillStyle = grad(0, 0, W, H);
    const max = Math.floor(freq.length * .6);
    for (let i = 0; i < count; i++) {
      const lo = Math.floor(Math.pow(i / count, 1.7) * max), hi = Math.max(lo + 1, Math.floor(Math.pow((i + 1) / count, 1.7) * max));
      const v = Math.pow(band(lo, hi), .85), h = Math.max(2 * dpr, v * H * .42);
      const x = i * (bw + gap);
      round(x, mid - h, bw, h * 2, Math.min(bw / 2, 6 * dpr));
    }
  }
  function wave() {
    ctx.lineWidth = 2.4 * dpr; ctx.lineJoin = 'round';
    for (let pass = 0; pass < 2; pass++) {
      ctx.beginPath();
      const amp = pass ? .22 : .34, off = pass ? 1 : 0;
      for (let i = 0; i < time.length; i += 2) {
        const x = (i / time.length) * W;
        const y = H / 2 + ((time[i] - 128) / 128) * H * amp * (off ? -1 : 1);
        i ? ctx.lineTo(x, y) : ctx.moveTo(x, y);
      }
      ctx.strokeStyle = pass ? a2 : a1;
      ctx.globalAlpha = pass ? .55 : .95;
      ctx.shadowBlur = 16 * dpr; ctx.shadowColor = pass ? a2 : a1;
      ctx.stroke();
    }
    ctx.globalAlpha = 1; ctx.shadowBlur = 0;
  }
  function radial() {
    const cx = W / 2, cy = H / 2, r0 = Math.min(W, H) * .21, count = 96;
    const lvl = V.bass();
    ctx.save(); ctx.translate(cx, cy); ctx.rotate((performance.now() - t0) / 9000);
    ctx.strokeStyle = grad(-W / 2, -H / 2, W / 2, H / 2);
    ctx.lineCap = 'round';
    const max = Math.floor(freq.length * .55);
    for (let i = 0; i < count; i++) {
      const lo = Math.floor(Math.pow(i / count, 1.6) * max), hi = Math.max(lo + 1, Math.floor(Math.pow((i + 1) / count, 1.6) * max));
      const v = Math.pow(band(lo, hi), .9), a = (i / count) * Math.PI * 2;
      const len = v * Math.min(W, H) * .25, rr = r0 * (1 + lvl * .14);
      ctx.lineWidth = Math.max(1.6 * dpr, (Math.PI * 2 * rr / count) * .55);
      ctx.beginPath();
      ctx.moveTo(Math.cos(a) * rr, Math.sin(a) * rr);
      ctx.lineTo(Math.cos(a) * (rr + len), Math.sin(a) * (rr + len));
      ctx.stroke();
    }
    ctx.globalAlpha = .35; ctx.lineWidth = 1.4 * dpr;
    ctx.beginPath(); ctx.arc(0, 0, r0 * (1 + lvl * .14), 0, Math.PI * 2); ctx.stroke();
    ctx.restore(); ctx.globalAlpha = 1;
  }
  function nebula() {
    if (parts.length !== 120) {
      parts = Array.from({ length: 120 }, () => ({
        a: Math.random() * Math.PI * 2, r: Math.random(), s: .2 + Math.random() * .9,
        sz: .5 + Math.random() * 2.4, b: Math.floor(Math.random() * 40)
      }));
    }
    const cx = W / 2, cy = H / 2, R = Math.min(W, H) * .46, lvl = V.level(), bass = V.bass();
    ctx.globalCompositeOperation = 'lighter';
    parts.forEach(p => {
      const e = Math.pow(freq[p.b + 2] / 255 || 0, 1.3);
      p.a += .0016 * p.s * (1 + bass * 2.2);
      const rr = R * (p.r * .55 + .22 + e * .45 + bass * .1);
      const x = cx + Math.cos(p.a) * rr, y = cy + Math.sin(p.a) * rr * .78;
      const sz = (p.sz + e * 5) * dpr;
      const g = ctx.createRadialGradient(x, y, 0, x, y, sz * 3);
      g.addColorStop(0, p.b % 3 ? a1 : a2);
      g.addColorStop(1, 'transparent');
      ctx.fillStyle = g; ctx.globalAlpha = .35 + e * .6;
      ctx.beginPath(); ctx.arc(x, y, sz * 3, 0, Math.PI * 2); ctx.fill();
    });
    ctx.globalAlpha = .18 + lvl * .35;
    ctx.fillStyle = a2;
    ctx.beginPath(); ctx.arc(cx, cy, R * (.12 + bass * .1), 0, Math.PI * 2); ctx.fill();
    ctx.globalCompositeOperation = 'source-over'; ctx.globalAlpha = 1;
  }
  function idle() {
    const t = (performance.now() - t0) / 1000;
    ctx.lineWidth = 2 * dpr; ctx.strokeStyle = a1; ctx.globalAlpha = .22;
    ctx.beginPath();
    for (let x = 0; x <= W; x += 6 * dpr) {
      const y = H / 2 + Math.sin(x / (70 * dpr) + t * 1.4) * H * .05 * Math.sin(t * .6 + x / (260 * dpr));
      x ? ctx.lineTo(x, y) : ctx.moveTo(x, y);
    }
    ctx.stroke(); ctx.globalAlpha = 1;
  }
  function round(x, y, w2, h, r) {
    if (ctx.roundRect) { ctx.beginPath(); ctx.roundRect(x, y, w2, h, r); ctx.fill(); }
    else ctx.fillRect(x, y, w2, h);
  }

  /* ============ energy timeline (painted while you listen) ============ */
  const BUCKETS = 220;
  const Energy = { map: null, id: null, dirty: false };
  Energy.load = function (id, arr) {
    Energy.id = id;
    Energy.map = arr && arr.length === BUCKETS ? Float32Array.from(arr) : new Float32Array(BUCKETS);
    Energy.dirty = false; Energy.draw();
  };
  Energy.push = function (pos, dur) {
    if (!Energy.map || !dur || !isFinite(dur) || !freq) return;
    const i = HP.clamp(Math.floor((pos / dur) * BUCKETS), 0, BUCKETS - 1);
    const v = V.level();
    Energy.map[i] = Energy.map[i] ? Energy.map[i] * .6 + v * .4 : v;
    Energy.dirty = true;
  };
  Energy.data = () => Energy.map ? Array.prototype.slice.call(Energy.map).map(v => +v.toFixed(3)) : null;
  let ecvs, ectx;
  Energy.attach = function (canvas) { ecvs = canvas; ectx = canvas.getContext('2d'); };
  Energy.draw = function (progress) {
    if (!ecvs || !ectx) return;
    const r = ecvs.getBoundingClientRect(), d = Math.min(w.devicePixelRatio || 1, 2);
    const cw = Math.max(1, r.width * d), ch = Math.max(1, r.height * d);
    if (ecvs.width !== cw || ecvs.height !== ch) { ecvs.width = cw; ecvs.height = ch; }
    ectx.clearRect(0, 0, cw, ch);
    if (!Energy.map) return;
    const bw = cw / BUCKETS, mid = ch / 2, p = (progress || 0) * BUCKETS;
    for (let i = 0; i < BUCKETS; i++) {
      const v = Energy.map[i];
      if (!v) continue;
      const h = Math.max(1 * d, Math.pow(v, .8) * ch * .92);
      ectx.fillStyle = i <= p ? a1 : 'rgba(150,160,185,.42)';
      ectx.globalAlpha = i <= p ? .9 : .5;
      ectx.fillRect(i * bw, mid - h / 2, Math.max(1, bw - .9 * d), h);
    }
    ectx.globalAlpha = 1;
  };

  V.Energy = Energy;
  HP.Vis = V;
})(window);
