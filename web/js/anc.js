/* ============================================================
   HashPlayer · anc.js — the room meter behind ANC+

   An earbud can cancel noise because its microphone sits millimetres from your
   eardrum and its driver plays the inverted wave back. A phone (or a laptop)
   cannot do that. What it can do — the same trick "adaptive volume" earbuds and
   hearing aids use — is listen to the room, work out how loud it is, and hold
   the programme material a fixed distance above that noise while sharpening the
   band that carries speech. A voice then stays as easy to hear next to a fan as
   it is in a quiet room.

   This file is the ear for the *browser* build. Inside the Android app the
   native shell runs the identical meter in Kotlin (AncEngine.kt) against
   ExoPlayer, because that is where the audio actually is; asking for the
   microphone twice would only waste battery, so this one stands down there.

   Nothing is recorded, stored or uploaded — the samples never leave this
   function, they are reduced to a single dB number and thrown away.
   ============================================================ */
(function (w) {
  'use strict';
  const HP = w.HP;
  const A = {};

  /* The same curve the native meter uses, so ANC+ behaves identically in a
     browser and in the app. dB SPL the response is drawn between, and a rough
     full-scale calibration for a typical device microphone. */
  const QUIET_DB = 42, LOUD_DB = 82, FS_SPL = 102;
  const TICK_MS = 200, REPORT_MS = 1200, MAX_LIFT_DB = 9;

  let stream = null, ownCtx = null, analyser = null, buf = null;
  let timer = 0, running = false, askedOnce = false;
  let floor = QUIET_DB, lastReport = 0;

  A.supported = function () {
    return !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia &&
      (w.AudioContext || w.webkitAudioContext));
  };

  /** The Android shell owns the microphone there — stay out of its way. */
  A.needed = function () { return !HP.isAndroidApp && A.supported(); };

  A.isRunning = function () { return running; };

  /**
   * Start or stop the meter to match the current state. Called on every ANC
   * change and on play/pause, so the microphone is only ever open while
   * something is actually playing.
   */
  A.sync = function (playing) {
    const want = !!playing && (HP.S && HP.S.ancMode === 2) && A.needed();
    if (want && !running) A.start();
    else if (!want && running) A.stop();
  };

  A.start = function () {
    if (running || !A.supported()) return;
    running = true;                                     // guards the async gap
    navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: true,      // take our own playback out of the reading
        noiseSuppression: true,
        autoGainControl: false,      // a riding gain would hide the real level
        channelCount: 1
      }
    }).then(s => {
      if (!running) { s.getTracks().forEach(t => t.stop()); return; }
      stream = s;
      const Ctx = w.AudioContext || w.webkitAudioContext;
      ownCtx = new Ctx();
      const src = ownCtx.createMediaStreamSource(s);
      analyser = ownCtx.createAnalyser();
      analyser.fftSize = 1024;
      analyser.smoothingTimeConstant = 0;
      buf = new Uint8Array(analyser.fftSize);
      src.connect(analyser);                            // never to the output
      floor = QUIET_DB;
      lastReport = 0;
      timer = setInterval(tick, TICK_MS);
      report(true);
    }).catch(err => {
      running = false;
      report(false);
      /* Refused: fall back to the static ANC curve rather than pretending. */
      if (!askedOnce) {
        askedOnce = true;
        HP.toast(err && err.name === 'NotAllowedError'
          ? 'ANC+ needs the microphone to hear the room — nothing is recorded. Standard ANC stays on.'
          : 'This browser will not open the microphone — standard ANC stays on.', 'err');
      }
      if (HP.Player && HP.Player.setAnc) HP.Player.setAnc(1, true);
    });
  };

  A.stop = function () {
    running = false;
    if (timer) { clearInterval(timer); timer = 0; }
    if (stream) { stream.getTracks().forEach(t => t.stop()); stream = null; }
    if (ownCtx) { try { ownCtx.close(); } catch (e) { } ownCtx = null; }
    analyser = null; buf = null;
  };

  function tick() {
    if (!analyser || !buf) return;
    analyser.getByteTimeDomainData(buf);
    let sum = 0;
    for (let i = 0; i < buf.length; i++) {
      const v = (buf[i] - 128) / 128;
      sum += v * v;
    }
    const rms = Math.sqrt(sum / buf.length);
    if (rms <= 1e-7) return;
    const spl = Math.min(110, Math.max(20, 20 * Math.log10(rms) + FS_SPL));
    /* Fast attack, slow release: a door slam is heard at once but does not send
       the volume chasing after it for the next ten seconds. */
    floor += (spl - floor) * (spl > floor ? 0.35 : 0.045);

    const now = Date.now();
    if (now - lastReport < REPORT_MS) return;
    lastReport = now;
    report(true);
  }

  /** Push the measurement into the audio graph and tell the UI about it. */
  function report(listening) {
    const s = listening ? Math.min(1, Math.max(0, (floor - QUIET_DB) / (LOUD_DB - QUIET_DB))) : 0;
    const level = {
      s, liftDb: Math.min(MAX_LIFT_DB, s * MAX_LIFT_DB),
      db: listening ? Math.round(floor) : 0, listening
    };
    const E = HP.Engine;
    if (E && E.setAdapt) E.setAdapt(level);
    HP.emit('ambient', level);
  }

  /* The meter only ever runs while something is actually playing. */
  HP.on('playing', p => A.sync(p));

  HP.Anc = A;
})(window);
