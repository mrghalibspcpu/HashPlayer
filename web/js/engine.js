/* ============================================================
   HashPlayer · engine.js — Web Audio graph
   source → preamp → 10-band EQ → bass/treble → compressor →
   stereo width → balance → master → analyser → out  (+ reverb)
   ============================================================ */
(function (w) {
  'use strict';
  const HP = w.HP, S = HP.S, clamp = HP.clamp;

  const FREQS = [31, 62, 125, 250, 500, 1000, 2000, 4000, 8000, 16000];
  const PRESETS = {
    flat: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
    bass: [8, 6.5, 4.5, 1.5, 0, 0, 0, 0, 0, 0],
    deep: [6, 5, 2, 0, -1, -2, -1, 1, 3, 4],
    treble: [0, 0, 0, 0, 0, 1.5, 3, 5, 6.5, 7],
    vocal: [-3, -2, 0, 2.5, 4.5, 4.5, 3, 1.5, 0, -1],
    rock: [5, 4, 2, -1, -2, 0, 2.5, 4.5, 5, 5],
    pop: [-1.5, 0, 2, 4, 4, 2, 0, -1, -2, -2],
    jazz: [4, 3, 1.5, 2, -1, -1, 0, 1.5, 3, 4],
    classical: [5, 4, 3, 2, -1, -1, 0, 2, 3.5, 4],
    dance: [6, 5, 2, 0, -1, -2, -1, 2, 4, 5],
    hiphop: [7, 6, 2.5, 3, -1, -1, 1, 2, 3, 4],
    acoustic: [4, 4, 3, 1, 1, 1, 2, 3, 3, 2],
    speech: [-6, -4, 0, 4, 5, 4, 3, 2, 0, -2],
    night: [-2, -1, 0, 2, 3, 3, 2, 1, -1, -2]
  };
  const PRESET_NAMES = {
    flat: 'Flat', bass: 'Bass boost', deep: 'Deep', treble: 'Treble', vocal: 'Vocal', rock: 'Rock',
    pop: 'Pop', jazz: 'Jazz', classical: 'Classical', dance: 'Dance', hiphop: 'Hip-hop',
    acoustic: 'Acoustic', speech: 'Speech', night: 'Late night'
  };

  const E = {
    ctx: null, analyser: null, ready: false, connected: false, bypass: false,
    FREQS, PRESETS, PRESET_NAMES, srcMap: new WeakMap()
  };

  function db2gain(db) { return Math.pow(10, db / 20); }

  /* ---------- build the graph once ---------- */
  function build() {
    if (E.ctx) return true;
    const AC = w.AudioContext || w.webkitAudioContext;
    if (!AC) return false;
    try { E.ctx = new AC({ latencyHint: 'playback' }); } catch (e) { return false; }
    const c = E.ctx;

    E.inGain = c.createGain();            // all element sources land here
    E.preamp = c.createGain();
    E.bands = FREQS.map((f, i) => {
      const b = c.createBiquadFilter();
      b.type = i === 0 ? 'lowshelf' : i === FREQS.length - 1 ? 'highshelf' : 'peaking';
      b.frequency.value = f; b.Q.value = 1.1; b.gain.value = 0;
      return b;
    });
    E.bass = c.createBiquadFilter(); E.bass.type = 'lowshelf'; E.bass.frequency.value = 90; E.bass.gain.value = 0;
    E.treble = c.createBiquadFilter(); E.treble.type = 'highshelf'; E.treble.frequency.value = 7000; E.treble.gain.value = 0;

    /* ANC chain — four extra filters that are always in the circuit but stay
       completely neutral until the ANC button is switched on:
       hp  kills low rumble / hum below the voice floor
       mud cuts the 240 Hz muddiness that masks speech
       pres lifts the 2.8 kHz presence region so vocals & dialogue sit forward
       hiss trims the top end where tape/encoder hiss lives */
    E.ancHp = c.createBiquadFilter(); E.ancHp.type = 'highpass'; E.ancHp.frequency.value = 10; E.ancHp.Q.value = .71;
    E.ancMud = c.createBiquadFilter(); E.ancMud.type = 'peaking'; E.ancMud.frequency.value = 240; E.ancMud.Q.value = 1; E.ancMud.gain.value = 0;
    E.ancPres = c.createBiquadFilter(); E.ancPres.type = 'peaking'; E.ancPres.frequency.value = 2800; E.ancPres.Q.value = .9; E.ancPres.gain.value = 0;
    E.ancHiss = c.createBiquadFilter(); E.ancHiss.type = 'highshelf'; E.ancHiss.frequency.value = 9000; E.ancHiss.gain.value = 0;

    E.comp = c.createDynamicsCompressor();
    E.comp.threshold.value = -26; E.comp.knee.value = 28; E.comp.ratio.value = 7;
    E.comp.attack.value = .005; E.comp.release.value = .22;
    E.compWet = c.createGain(); E.compWet.gain.value = 0;
    E.compDry = c.createGain(); E.compDry.gain.value = 1;
    E.dynOut = c.createGain();

    /* mid/side stereo widener */
    E.split = c.createChannelSplitter(2);
    E.midL = c.createGain(); E.midL.gain.value = .5;
    E.midR = c.createGain(); E.midR.gain.value = .5;
    E.sideL = c.createGain(); E.sideL.gain.value = .5;
    E.sideR = c.createGain(); E.sideR.gain.value = -.5;
    E.mid = c.createGain(); E.side = c.createGain(); E.sideW = c.createGain(); E.sideNeg = c.createGain();
    E.sideNeg.gain.value = -1;
    E.merge = c.createChannelMerger(2);

    E.pan = c.createStereoPanner ? c.createStereoPanner() : null;
    E.master = c.createGain();
    E.conv = c.createConvolver(); E.conv.buffer = impulse(c, 2.1, 2.6);
    E.wet = c.createGain(); E.wet.gain.value = 0;
    E.analyser = c.createAnalyser();
    E.analyser.fftSize = 2048; E.analyser.smoothingTimeConstant = .78; E.analyser.minDecibels = -92;

    /* wire */
    E.inGain.connect(E.preamp);
    let node = E.preamp;
    E.bands.forEach(b => { node.connect(b); node = b; });
    node.connect(E.bass); E.bass.connect(E.treble);
    E.treble.connect(E.ancHp); E.ancHp.connect(E.ancMud); E.ancMud.connect(E.ancPres); E.ancPres.connect(E.ancHiss);
    E.ancHiss.connect(E.comp); E.comp.connect(E.compWet); E.compWet.connect(E.dynOut);
    E.ancHiss.connect(E.compDry); E.compDry.connect(E.dynOut);

    E.dynOut.connect(E.split);
    E.split.connect(E.midL, 0); E.split.connect(E.midR, 1);
    E.midL.connect(E.mid); E.midR.connect(E.mid);
    E.split.connect(E.sideL, 0); E.split.connect(E.sideR, 1);
    E.sideL.connect(E.side); E.sideR.connect(E.side);
    E.side.connect(E.sideW);
    E.sideW.connect(E.merge, 0, 0);
    E.sideW.connect(E.sideNeg); E.sideNeg.connect(E.merge, 0, 1);
    E.mid.connect(E.merge, 0, 0); E.mid.connect(E.merge, 0, 1);

    const tail = E.pan || E.merge;
    if (E.pan) E.merge.connect(E.pan);
    tail.connect(E.master);
    tail.connect(E.conv); E.conv.connect(E.wet); E.wet.connect(E.master);
    E.master.connect(E.analyser);
    E.analyser.connect(c.destination);

    E.ready = true;
    applyAll();
    return true;
  }

  /* synthetic impulse response — warm hall */
  function impulse(c, seconds, decay) {
    const rate = c.sampleRate, len = Math.floor(rate * seconds), buf = c.createBuffer(2, len, rate);
    for (let ch = 0; ch < 2; ch++) {
      const d = buf.getChannelData(ch);
      for (let i = 0; i < len; i++) {
        const t = i / len;
        d[i] = (Math.random() * 2 - 1) * Math.pow(1 - t, decay) * (1 - t * .25);
      }
      // early reflections
      [0.011, 0.023, 0.037, 0.051].forEach((ms, k) => {
        const idx = Math.floor(ms * rate);
        if (idx < len) d[idx] += (k % 2 ? -1 : 1) * 0.45 / (k + 1);
      });
    }
    return buf;
  }

  /* ---------- attach a media element ---------- */
  E.attach = function (media) {
    if (!build()) return false;
    if (E.srcMap.has(media)) return true;
    try {
      const src = E.ctx.createMediaElementSource(media);
      const g = E.ctx.createGain();
      src.connect(g); g.connect(E.inGain);
      E.srcMap.set(media, { src, gain: g });
      media.volume = 1;
      E.connected = true;
      return true;
    } catch (e) { console.warn('[engine] attach failed', e); return false; }
  };
  E.gainOf = media => { const o = E.srcMap.get(media); return o ? o.gain : null; };

  E.resume = function () {
    if (!E.ctx) build();
    if (E.ctx && E.ctx.state !== 'running') return E.ctx.resume().catch(() => { });
    return Promise.resolve();
  };

  /* ---------- parameter setters ---------- */
  function ramp(param, v, ms) {
    if (!param) return;
    const t = E.ctx.currentTime;
    try { param.cancelScheduledValues(t); param.setValueAtTime(param.value, t); param.linearRampToValueAtTime(v, t + (ms || 60) / 1000); }
    catch (e) { param.value = v; }
  }
  E.ramp = ramp;

  E.setBand = function (i, db) {
    pushNative();
    S.eqGains[i] = db;
    if (E.ready) ramp(E.bands[i].gain, S.eqOn ? db : 0, 80);
    HP.save();
  };
  function pushNative() {
    try { HP.NativeMedia && HP.NativeMedia.pushEq && HP.NativeMedia.pushEq(); } catch (e) { }
    try { HP.NativeMedia && HP.NativeMedia.pushFx && HP.NativeMedia.pushFx(); } catch (e) { }
  }
  E.pushNative = pushNative;

  E.applyEQ = function () {
    pushNative();
    if (!E.ready) return;
    E.bands.forEach((b, i) => ramp(b.gain, S.eqOn ? (S.eqGains[i] || 0) : 0, 90));
  };
  E.setPreset = function (name) {
    const p = PRESETS[name]; if (!p) return;
    S.eqPreset = name; S.eqGains = p.slice();
    E.applyEQ(); HP.save(); HP.emit('eq', name);
  };
  E.setVolume = function (v, opts) {
    S.volume = clamp(v, 0, 1);
    E.applyVolume(opts); HP.save();
  };
  /**
   * One volume, every engine.
   *
   * Only `<audio>/<video>` elements run through the Web Audio graph, so ramping
   * the master gain alone left the two engines that make their own sound — the
   * native ExoPlayer and the YouTube embed — at whatever level they were loaded
   * with. That is why the slider and the swipe gesture appeared to do nothing.
   *
   * Inside the Android app the device's media stream is the real master: the
   * slider moves the same volume the hardware keys do, and the engines stay at
   * unity so the two never multiply each other.
   */
  E.applyVolume = function (opts) {
    const dev = HP.Device && HP.Device.volume;
    const useDevice = !!(dev && dev.available());
    const level = S.muted ? 0 : clamp(S.volume, 0, 1);
    /* With a device master every engine stays at unity, so the two levels can
       never multiply into a muffled half-volume. Mute still happens in-app. */
    const inApp = useDevice ? (S.muted ? 0 : 1) : level;
    /* ANC+ holds the programme a fixed distance above the room: the meter says
       how many dB that takes, and the compressor already in the chain keeps the
       extra gain from turning into clipping. */
    const lift = S.ancMode === 2 ? db2gain((E.adapt && E.adapt.liftDb) || 0) : 1;
    const boosted = clamp(inApp * ((S.boost || 100) / 100) * lift, 0, 3);
    if (E.ready) ramp(E.master.gain, boosted, 60);

    const P = HP.Player;
    if (P) {
      if (!E.ready) [P.a, P.b].forEach(m => { if (m) m.volume = clamp(boosted, 0, 1); });
      [P.y, P.n].forEach(m => {
        if (!m) return;
        try { m.muted = !!S.muted; m.volume = inApp; } catch (e) { }
      });
      if (useDevice && !S.muted && !(opts && opts.fromDevice)) dev.set(level);
    }
    HP.emit('volume', S.volume);
  };

  /* ---------- ANC+ : what the room meter last said ----------
     `s` is how loud the room is (0…1), `liftDb` how far the programme is being
     held above it. Inside the Android app the native shell fills these from its
     own microphone meter; in a plain browser anc.js does the same job. */
  E.adapt = { s: 0, liftDb: 0, db: 0, listening: false };
  /** How hard the clarity curve should work right now (1 = the full ANC shape). */
  E.adaptiveK = function () {
    const s = (E.adapt && E.adapt.s) || 0;
    return S.ancMode === 2 ? 0.5 + 0.5 * s : 1;
  };
  E.setAdapt = function (a) {
    if (!a) return;
    E.adapt = { s: +a.s || 0, liftDb: +a.liftDb || 0, db: +a.db || 0, listening: !!a.listening };
    applyAll();
  };

  E.applyAll = applyAll;
  function applyAll() {
    if (!E.ready) return;
    E.applyEQ();
    ramp(E.preamp.gain, db2gain(S.preamp || 0), 80);
    ramp(E.bass.gain, S.bass || 0, 80);
    ramp(E.treble.gain, S.treble || 0, 80);
    ramp(E.wet.gain, (S.reverb || 0) / 140, 120);
    ramp(E.sideW.gain, S.mono ? 0 : (S.width || 100) / 100, 90);
    if (E.pan) ramp(E.pan.pan, clamp((S.balance || 0) / 100, -1, 1), 90);
    /* ANC: rumble filter + mud cut + presence lift + hiss trim. While it is
       on, the compressor rides along so dialogue stays level and forward;
       switching it off restores whatever Night mode the user had chosen.
       ANC+ scales the whole shape with the room the meter just measured, so a
       quiet room gets a light touch and a noisy one gets the full treatment. */
    const anc = S.ancMode > 0;
    const k = E.adaptiveK();
    ramp(E.ancHp.frequency, anc ? 90 + 60 * k : 10, 140);
    ramp(E.ancMud.gain, anc ? -4.5 * k : 0, 140);
    ramp(E.ancPres.gain, anc ? 5 * k : 0, 140);
    ramp(E.ancHiss.gain, anc ? -2.5 * k : 0, 140);
    const compOn = S.normalize || anc;
    ramp(E.compWet.gain, compOn ? 1 : 0, 150);
    ramp(E.compDry.gain, compOn ? 0 : 1, 150);
    E.applyVolume();
    pushNative();                        // mirror every knob onto ExoPlayer too
  }

  /* fade a single element's gain (crossfade / pause fade) */
  E.fadeElement = function (media, to, ms) {
    const g = E.gainOf(media);
    if (!g) { media.volume = clamp(to, 0, 1); return Promise.resolve(); }
    ramp(g.gain, to, ms);
    return new Promise(r => setTimeout(r, ms));
  };
  E.elementGain = function (media, v) {
    const g = E.gainOf(media);
    if (g) g.gain.value = v; else media.volume = clamp(v, 0, 1);
  };

  /* frequency response curve for the EQ preview */
  E.curve = function (points) {
    if (!E.ready) return null;
    const f = new Float32Array(points), mag = new Float32Array(points), ph = new Float32Array(points);
    const total = new Float32Array(points).fill(1);
    for (let i = 0; i < points; i++) f[i] = 20 * Math.pow(1000, i / (points - 1));
    E.bands.forEach(b => { b.getFrequencyResponse(f, mag, ph); for (let i = 0; i < points; i++) total[i] *= mag[i]; });
    if (S.bass) { E.bass.getFrequencyResponse(f, mag, ph); for (let i = 0; i < points; i++) total[i] *= mag[i]; }
    if (S.treble) { E.treble.getFrequencyResponse(f, mag, ph); for (let i = 0; i < points; i++) total[i] *= mag[i]; }
    return { f, mag: total };
  };

  HP.Engine = E;
})(window);
