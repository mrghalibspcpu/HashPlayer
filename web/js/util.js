/* ============================================================
   HashPlayer · util.js — helpers, i18n, toasts, colour magic
   ============================================================ */
(function (w) {
  'use strict';
  const HP = (w.HP = w.HP || {});

  /* ---------- DOM ---------- */
  const $ = (s, r) => (r || document).querySelector(s);
  const $$ = (s, r) => Array.prototype.slice.call((r || document).querySelectorAll(s));
  function el(tag, props, kids) {
    const n = document.createElement(tag);
    if (props) for (const k in props) {
      if (k === 'class') n.className = props[k];
      else if (k === 'html') n.innerHTML = props[k];
      else if (k === 'text') n.textContent = props[k];
      else if (k.slice(0, 2) === 'on') n.addEventListener(k.slice(2), props[k]);
      else if (props[k] !== null && props[k] !== undefined && props[k] !== false) n.setAttribute(k, props[k]);
    }
    (kids || []).forEach(c => c && n.appendChild(typeof c === 'string' ? document.createTextNode(c) : c));
    return n;
  }
  const icon = (name, cls) => {
    const s = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    s.setAttribute('class', 'ic' + (cls ? ' ' + cls : ''));
    const u = document.createElementNS('http://www.w3.org/2000/svg', 'use');
    u.setAttribute('href', '#i-' + name);
    s.appendChild(u);
    return s;
  };

  /* ---------- format ---------- */
  function fmtTime(s) {
    if (!isFinite(s) || s < 0) s = 0;
    s = Math.floor(s);
    const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), x = s % 60;
    return (h ? h + ':' + String(m).padStart(2, '0') : m) + ':' + String(x).padStart(2, '0');
  }
  function fmtBytes(b) {
    if (!b && b !== 0) return '—';
    const u = ['B', 'KB', 'MB', 'GB', 'TB'];
    let i = 0; while (b >= 1024 && i < u.length - 1) { b /= 1024; i++; }
    return (i ? b.toFixed(b < 10 ? 1 : 0) : b) + ' ' + u[i];
  }
  const fmtDate = t => t ? new Date(t).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' }) : '—';
  const clamp = (v, a, b) => v < a ? a : v > b ? b : v;
  const uid = () => 'h' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  function debounce(fn, ms) { let t; return function () { clearTimeout(t); const a = arguments, s = this; t = setTimeout(() => fn.apply(s, a), ms); }; }
  function throttle(fn, ms) { let last = 0, t; return function () { const n = Date.now(), a = arguments, s = this; if (n - last >= ms) { last = n; fn.apply(s, a); } else { clearTimeout(t); t = setTimeout(() => { last = Date.now(); fn.apply(s, a); }, ms - (n - last)); } }; }

  /* ---------- tiny event bus ---------- */
  const bus = {};
  HP.on = (k, fn) => ((bus[k] = bus[k] || []).push(fn), fn);
  HP.emit = (k, d) => (bus[k] || []).forEach(f => { try { f(d); } catch (e) { console.warn('[bus]', k, e); } });

  /* ---------- local settings ---------- */
  const LS = 'hashplayer.settings.v2';
  const DEFAULTS = {
    lang: 'en', theme: 'neon', surface: 'dark', autoTheme: true, motion: true, simple: false,
    vis: 'bars', gestures: true, resume: true, autoplayNext: true, keepAwake: true, seekStep: 10,
    volume: 1, muted: false, repeat: 'off', shuffle: false, speed: 1, viewMode: 'grid', sort: 'added',
    filter: 'all', eqOn: false, eqGains: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0], eqPreset: 'flat',
    preamp: 0, bass: 0, treble: 0, reverb: 0, width: 100, balance: 0, boost: 100, crossfade: 0,
    mono: false, normalize: false, fade: true, pitch: true, pitchShift: 0, lastId: null, lastPos: 0, lyricsOn: false,
    perf: null, autoPip: true, autoScan: true, autoLandscape: true, ytSearch: true, skipSilence: false,
    /* ancMode: 0 off · 1 ANC (fixed clarity curve) · 2 ANC+ (adaptive — the room
       is measured and the curve plus a level lift follow it). `anc` is kept as a
       plain on/off mirror so older code paths keep working. */
    anc: false, ancMode: 0, enhance: false
  };
  /* ---------- how much eye-candy can this device actually afford? ---------- */
  const ua = navigator.userAgent || '';
  const DEV = {
    android: /Android/i.test(ua),
    inApp: /HashPlayer\//.test(ua),
    ios: /iPad|iPhone|iPod/.test(ua),
    touch: matchMedia ? matchMedia('(hover:none)').matches : false,
    cores: navigator.hardwareConcurrency || 4,
    mem: navigator.deviceMemory || 4
  };
  /* A WebView on a phone pays for every blurred layer twice; default those devices
     to the lighter renderer so playback never competes with the compositor. */
  DEV.weak = DEV.inApp || DEV.android || DEV.ios || DEV.cores <= 4 || DEV.mem <= 4;
  HP.DEV = DEV;

  let S;
  try { S = Object.assign({}, DEFAULTS, JSON.parse(localStorage.getItem(LS) || '{}')); }
  catch (e) { S = Object.assign({}, DEFAULTS); }
  if (!Array.isArray(S.eqGains) || S.eqGains.length !== 10) S.eqGains = DEFAULTS.eqGains.slice();
  /* Anyone who already had ANC switched on keeps it, at the static level. */
  if (!S.ancMode && S.anc) S.ancMode = 1;
  S.anc = S.ancMode > 0;
  if (S.perf === null || S.perf === undefined) S.perf = DEV.weak;    // first run: pick for them
  HP.S = S;
  HP.DEFAULTS = DEFAULTS;
  const saveNow = () => { try { localStorage.setItem(LS, JSON.stringify(S)); } catch (e) { } };
  HP.save = debounce(saveNow, 350);
  HP.saveNow = saveNow;
  HP.set = (k, v) => { S[k] = v; HP.save(); HP.emit('setting', { k, v }); };

  /* ---------- toast ---------- */
  let toastBox;
  function toast(msg, kind) {
    toastBox = toastBox || $('#toasts');
    if (!toastBox) return;
    const t = el('div', { class: 'toast' + (kind ? ' ' + kind : '') }, [
      icon(kind === 'err' ? 'info' : kind === 'ok' ? 'check' : 'sparkle'),
      el('span', { text: msg })
    ]);
    toastBox.appendChild(t);
    setTimeout(() => { t.classList.add('out'); setTimeout(() => t.remove(), 320); }, kind === 'err' ? 4200 : 2600);
  }

  /* ---------- i18n ---------- */
  const STR = {
    /* English is harvested from the markup on first paint; only strings that
       never appear as markup need to be seeded here. */
    en: {
      ytOpen: 'Open YouTube',
      pitch2: 'Pitch', pitchTitle: 'Pitch', original: 'Original',
      pitchSub: 'Shifts the key up or down in semitones. The speed stays exactly where you left it.',
      ytSearching: 'Searching YouTube for',
      ytOffline: 'YouTube search is not reachable right now',
      ttDownload: 'Save for offline',
      anc: 'ANC', enhance: 'Enhance',
      ancTitle: 'Noise cancelling', ancOff: 'Off', ancStd: 'ANC', ancPlus: 'ANC+',
      ancNote: 'ANC trims rumble, mud and hiss and lifts voices. ANC+ also listens to the room and keeps the sound the same distance above the noise, so a voice stays as clear next to a fan as it is in a quiet room.'
    },
    ur: {
      search: 'تلاش کریں…', library: 'لائبریری', playlists: 'پلے لسٹ', favorites: 'پسندیدہ', sound: 'آواز',
      settings: 'ترتیبات', tracks: 'ٹریکس', addFiles: 'فائلیں شامل کریں', addFolder: 'فولڈر', addUrl: 'لنک',
      scan: 'ڈیوائس اسکین', all: 'سب', audio: 'آڈیو', video: 'ویڈیو', recent: 'حالیہ', mostPlayed: 'زیادہ سنے گئے',
      playAll: 'سب چلائیں', shuffle: 'شفل', relink: 'فائلیں دوبارہ کھولیں',
      relinkMsg: 'ٹریکس دوبارہ کھولنے ہوں گے (براؤزر مستقل رسائی محفوظ نہیں رکھ سکتا)۔',
      emptyTitle: 'اپنی میڈیا فائلیں یہاں ڈالیں', emptyText: 'اپنے ڈیوائس سے گانے یا ویڈیو شامل کریں۔ سب کچھ آپ کے ڈیوائس پر ہی رہتا ہے۔',
      playlistsSub: 'آپ کی بنائی ہوئی فہرستیں، اسی ڈیوائس پر محفوظ۔', newPlaylist: 'نئی پلے لسٹ', saveQueue: 'قطار محفوظ کریں',
      play: 'چلائیں', soundLab: 'ساؤنڈ لیب', soundLabSub: 'دس بینڈ ایکولائزر، ایفیکٹس اور انجن۔', eqOn: 'ای کیو آن',
      reset: 'ری سیٹ', presets: 'پری سیٹس', bands: 'بینڈز', preamp: 'پری ایمپ', bassBoost: 'بیس بوسٹ',
      trebleBoost: 'ٹریبل', reverb: 'ریورب / اسپیس', widener: 'اسٹیریو چوڑائی', balance: 'بیلنس',
      volBoost: 'والیوم بوسٹ', crossfade: 'کراس فیڈ', mono: 'مونو', normalize: 'نائٹ موڈ',
      fadePause: 'پلے/پاز پر فیڈ', pitch: 'رفتار بدلنے پر پچ محفوظ رکھیں', appearance: 'ظاہری شکل',
      theme: 'تھیم', themeSub: 'ایپ کا رنگ۔', surface: 'پس منظر', surfaceSub: 'AMOLED سیاہ بیٹری بچاتا ہے۔',
      autoTheme: 'البم آرٹ کے رنگ استعمال کریں', animations: 'اینیمیشنز', simpleMode: 'سادہ موڈ',
      visualizer: 'ویژولائزر', playback: 'پلے بیک', gestures: 'ویڈیو جیسچرز', resume: 'جہاں چھوڑا وہیں سے',
      autoplayNext: 'اگلا ٹریک خودکار', keepAwake: 'اسکرین جاگتی رکھیں', seekStep: 'ڈبل ٹیپ سیک',
      seekStepSub: 'ایک ڈبل ٹیپ میں کتنے سیکنڈ۔', data: 'لائبریری اور ڈیٹا', storageUsed: 'ڈیوائس اسٹوریج',
      export: 'ایکسپورٹ', import: 'امپورٹ', clear: 'صاف کریں', persistStorage: 'لائبریری کو محفوظ رکھیں',
      about: 'تعارف', aboutText: 'ایک نجی، آف لائن آڈیو اور ویڈیو پلیئر۔ آپ کی فائلیں کہیں اپ لوڈ نہیں ہوتیں۔',
      shortcuts: 'شارٹ کٹس', install: 'ایپ انسٹال کریں', nowPlaying: 'اب چل رہا ہے', speed: 'رفتار',
      loop: 'لوپ', equalizer: 'ایکولائزر', lyrics: 'بول', skipSilence: 'خاموشی چھوڑیں', captions: 'کیپشن', sleep: 'سلیپ', bookmark: 'بک مارک', queue: 'قطار',
      close: 'بند کریں', sleepTimer: 'سلیپ ٹائمر', sleepSub: 'آواز دھیرے دھیرے بند ہو جائے گی۔',
      endOfTrack: 'ٹریک کے اختتام پر', off: 'بند', addUrlTitle: 'میڈیا لنک کھولیں',
      addUrlSub: 'یوٹیوب لنک، یا آڈیو/ویڈیو فائل کا براہِ راست لنک۔', cancel: 'منسوخ', add: 'شامل کریں', save: 'محفوظ',
      trackInfo: 'ٹریک معلومات', lyricsTools: 'بول', lyricsSub: '.lrc فائل لوڈ کریں یا بول پیسٹ کریں۔',
      loadFile: 'فائل لوڈ کریں', offset: 'آفسیٹ', remove: 'ہٹائیں', dropHere: 'لائبریری میں شامل کرنے کے لیے چھوڑیں',
      perfMode: 'اسموتھ موڈ — بھاری بلر اور گلو بند کریں (فون کے لیے بہترین)',
      autoLandscape: 'لینڈ اسکیپ میں ویڈیو پوری اسکرین پر',
      autoPip: 'ایپ سے نکلنے پر چھوٹی ونڈو میں چلتا رہے',
      autoScan: 'ڈیوائس کی آڈیو/ویڈیو خودکار تلاش کریں',
      findLyrics: 'آن لائن بول تلاش کریں', scan: 'ڈیوائس اسکین کریں',
      addUrlSub2: 'یوٹیوب لنک یا آڈیو/ویڈیو فائل کا براہِ راست لنک۔',
      ytOpen: 'یوٹیوب کھولیں', pitch2: 'پچ', pitchTitle: 'پچ', original: 'اصل',
      pitchSub: 'آواز کی پچ سیمی ٹون میں اوپر نیچے کریں۔ رفتار جہاں ہے وہیں رہے گی۔', ytResults: 'یوٹیوب سے',
      ytSearch: 'تلاش میں یوٹیوب کے نتائج بھی دکھائیں (انٹرنیٹ درکار)',
      ytSearching: 'یوٹیوب پر تلاش جاری ہے', ytOffline: 'یوٹیوب تلاش فی الحال دستیاب نہیں',
      tapToUnlock: 'ان لاک کرنے کے لیے ٹیپ کریں',
      ttAspect: 'تناسب / زوم', ttRotate: 'گھمائیں', ttMirror: 'آئینہ', ttShot: 'اسکرین شاٹ',
      ttSubs: 'سب ٹائٹل', ttSpeed: 'چلنے کی رفتار', ttLock: 'اسکرین لاک', ttPip: 'چھوٹی ونڈو',
      ttYt: 'یوٹیوب میں کھولیں', ttFull: 'پوری اسکرین',
      ttDownload: 'آف لائن کے لیے محفوظ کریں',
      anc: 'اے این سی', enhance: 'اینہانس',
      ancTitle: 'شور کم کرنا', ancOff: 'بند', ancStd: 'اے این سی', ancPlus: 'اے این سی +',
      ancNote: 'اے این سی گرج، بھاری پن اور سیٹی کاٹ کر آواز صاف کرتا ہے۔ اے این سی + کمرے کا شور بھی سنتا ہے اور آواز کو اُسی فاصلے پر رکھتا ہے، تاکہ پنکھے کے پاس بھی آواز اتنی ہی صاف رہے جتنی خاموش کمرے میں۔'
    }
  };
  HP.t = k => (STR[S.lang] && STR[S.lang][k]) || STR.en[k] || k;
  function applyI18n() {
    const ur = S.lang === 'ur';
    document.documentElement.lang = S.lang;
    document.documentElement.dir = ur ? 'rtl' : 'ltr';
    document.body.dir = ur ? 'rtl' : 'ltr';
    $$('[data-i18n]').forEach(n => { const v = STR[S.lang] && STR[S.lang][n.dataset.i18n]; if (!STR.en[n.dataset.i18n]) STR.en[n.dataset.i18n] = n.textContent; n.textContent = v || STR.en[n.dataset.i18n]; });
    $$('[data-i18n-ph]').forEach(n => { const v = STR[S.lang] && STR[S.lang][n.dataset.i18nPh]; if (!STR.en[n.dataset.i18nPh]) STR.en[n.dataset.i18nPh] = n.placeholder; n.placeholder = v || STR.en[n.dataset.i18nPh]; });
    $$('[data-i18n-t]').forEach(n => { const v = STR[S.lang] && STR[S.lang][n.dataset.i18nT]; if (v) n.title = v; });
  }

  /* ---------- colour extraction from artwork ---------- */
  const cvs = document.createElement('canvas');
  function paletteFrom(img) {
    try {
      const n = 28; cvs.width = n; cvs.height = n;
      const ctx = cvs.getContext('2d', { willReadFrequently: true });
      ctx.drawImage(img, 0, 0, n, n);
      const d = ctx.getImageData(0, 0, n, n).data, buckets = {};
      for (let i = 0; i < d.length; i += 4) {
        const r = d[i], g = d[i + 1], b = d[i + 2], a = d[i + 3];
        if (a < 125) continue;
        const mx = Math.max(r, g, b), mn = Math.min(r, g, b), l = (mx + mn) / 2, sat = mx - mn;
        if (l < 28 || l > 238) continue;                         // skip near black / white
        const key = (r >> 4) + ',' + (g >> 4) + ',' + (b >> 4);
        const o = buckets[key] || (buckets[key] = { r: 0, g: 0, b: 0, n: 0, s: 0 });
        o.r += r; o.g += g; o.b += b; o.n++; o.s += sat;
      }
      const list = Object.values(buckets).map(o => ({
        r: o.r / o.n | 0, g: o.g / o.n | 0, b: o.b / o.n | 0, score: o.n * (1 + (o.s / o.n) / 90)
      })).sort((a, b) => b.score - a.score);
      if (!list.length) return null;
      const pick = c => vivid(c.r, c.g, c.b);
      const first = list[0];
      let second = list.find(c => Math.abs(c.r - first.r) + Math.abs(c.g - first.g) + Math.abs(c.b - first.b) > 110) || list[1] || first;
      return [pick(first), pick(second)];
    } catch (e) { return null; }
  }
  /* push colour toward a bright neon-ish version so UI stays readable */
  function vivid(r, g, b) {
    let [h, s, l] = rgb2hsl(r, g, b);
    s = clamp(s * 1.45 + .12, .42, 1);
    l = clamp(l < .45 ? l + .22 : l > .72 ? .66 : l, .45, .72);
    const [R, G, B] = hsl2rgb(h, s, l);
    return '#' + [R, G, B].map(v => clamp(Math.round(v), 0, 255).toString(16).padStart(2, '0')).join('');
  }
  function rgb2hsl(r, g, b) {
    r /= 255; g /= 255; b /= 255;
    const mx = Math.max(r, g, b), mn = Math.min(r, g, b), d = mx - mn, l = (mx + mn) / 2;
    let h = 0, s = 0;
    if (d) {
      s = l > .5 ? d / (2 - mx - mn) : d / (mx + mn);
      h = mx === r ? ((g - b) / d + (g < b ? 6 : 0)) : mx === g ? (b - r) / d + 2 : (r - g) / d + 4;
      h /= 6;
    }
    return [h, s, l];
  }
  function hsl2rgb(h, s, l) {
    if (!s) { const v = l * 255; return [v, v, v]; }
    const q = l < .5 ? l * (1 + s) : l + s - l * s, p = 2 * l - q;
    const f = t => { t = (t + 1) % 1; return (t < 1 / 6 ? p + (q - p) * 6 * t : t < .5 ? q : t < 2 / 3 ? p + (q - p) * (2 / 3 - t) * 6 : p) * 255; };
    return [f(h + 1 / 3), f(h), f(h - 1 / 3)];
  }

  /* ---------- misc ---------- */
  const AUDIO_EXT = /\.(mp3|m4a|m4b|aac|flac|wav|wave|ogg|oga|opus|weba|aiff?|caf|wma|amr|mid)$/i;
  const VIDEO_EXT = /\.(mp4|m4v|webm|mkv|mov|avi|3gp|ogv|mpg|mpeg|ts|flv|wmv)$/i;
  const LRC_EXT = /\.(lrc|txt)$/i;
  const SUB_EXT = /\.(srt|vtt|ass|ssa)$/i;
  HP.kindOf = function (name, mime) {
    mime = mime || '';
    if (mime.indexOf('audio') === 0) return 'audio';
    if (mime.indexOf('video') === 0) return 'video';
    if (AUDIO_EXT.test(name)) return 'audio';
    if (VIDEO_EXT.test(name)) return 'video';
    if (LRC_EXT.test(name)) return 'lrc';
    if (SUB_EXT.test(name)) return 'sub';
    return null;
  };
  HP.baseName = n => String(n).replace(/\.[^.]+$/, '');
  HP.prettyName = function (name) {
    let s = HP.baseName(name).replace(/[_]+/g, ' ').replace(/\s{2,}/g, ' ').trim();
    s = s.replace(/^\d{1,3}\s*[-.)]\s*/, '');                 // leading track number
    s = s.replace(/\b(192|128|320)\s?kbps\b/gi, '').replace(/\[[^\]]*\]|\((official|lyrics?|audio|video|hd|4k)[^)]*\)/gi, '');
    return s.trim() || name;
  };
  HP.splitArtistTitle = function (name) {
    const s = HP.prettyName(name), m = s.split(/\s+[-–—]\s+/);
    if (m.length >= 2 && m[0].length > 1 && m[0].length < 42) return { artist: m[0].trim(), title: m.slice(1).join(' - ').trim() };
    return { artist: '', title: s };
  };

  HP.$ = $; HP.$$ = $$; HP.el = el; HP.icon = icon;
  HP.fmtTime = fmtTime; HP.fmtBytes = fmtBytes; HP.fmtDate = fmtDate;
  HP.clamp = clamp; HP.uid = uid; HP.esc = esc; HP.debounce = debounce; HP.throttle = throttle;
  HP.toast = toast; HP.applyI18n = applyI18n; HP.paletteFrom = paletteFrom; HP.STR = STR;
  HP.isAndroidApp = !!(w.HashNative);
  HP.supportsFS = typeof w.showOpenFilePicker === 'function';
})(window);
