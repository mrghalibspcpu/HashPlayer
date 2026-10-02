/* ============================================================
   HashPlayer · meta.js — tag reader (ID3v1/v2, MP4, FLAC, OGG,
   WAV), album art, LRC lyrics, SRT→VTT subtitles,
   online lyrics search (LRCLIB), and YouTube stream / search.
   ============================================================ */
(function (w) {
  'use strict';
  const HP = w.HP, Meta = {};

  const dec = (buf, enc) => {
    try { return new TextDecoder(enc || 'utf-8').decode(buf); }
    catch (e) { return String.fromCharCode.apply(null, new Uint8Array(buf)); }
  };
  const str = (u8, a, b) => dec(u8.subarray(a, b), 'utf-8');
  const latin = (u8, a, b) => dec(u8.subarray(a, b), 'windows-1252');
  const be32 = (u8, i) => (u8[i] << 24 | u8[i + 1] << 16 | u8[i + 2] << 8 | u8[i + 3]) >>> 0;
  const be24 = (u8, i) => (u8[i] << 16 | u8[i + 1] << 8 | u8[i + 2]) >>> 0;
  const le32 = (u8, i) => (u8[i] | u8[i + 1] << 8 | u8[i + 2] << 16 | u8[i + 3] << 24) >>> 0;
  const syncsafe = (u8, i) => ((u8[i] & 127) << 21 | (u8[i + 1] & 127) << 14 | (u8[i + 2] & 127) << 7 | (u8[i + 3] & 127)) >>> 0;
  const clean = s => (s || '').replace(/\0+$/g, '').replace(/^\uFEFF/, '').trim();

  function readBuf(file, start, len) {
    return new Promise(res => {
      try {
        const fr = new FileReader();
        fr.onload = () => res(new Uint8Array(fr.result));
        fr.onerror = () => res(null);
        fr.readAsArrayBuffer(file.slice(start, Math.min(start + len, file.size)));
      } catch (e) { res(null); }
    });
  }

  /* ---------------- ID3 text decoding ---------------- */
  function id3Text(u8, enc) {
    switch (enc) {
      case 0: return clean(latin(u8, 0, u8.length));
      case 1: return clean(dec(u8, 'utf-16'));
      case 2: return clean(dec(u8, 'utf-16be'));
      default: return clean(dec(u8, 'utf-8'));
    }
  }
  function nullEnd(u8, from, enc) {
    if (enc === 1 || enc === 2) {
      for (let i = from; i + 1 < u8.length; i += 2) if (!u8[i] && !u8[i + 1]) return i;
      return u8.length;
    }
    for (let i = from; i < u8.length; i++) if (!u8[i]) return i;
    return u8.length;
  }

  /* ---------------- ID3v2 ---------------- */
  function parseID3v2(u8, out) {
    if (!(u8[0] === 0x49 && u8[1] === 0x44 && u8[2] === 0x33)) return 0;
    const ver = u8[3], flags = u8[5], size = syncsafe(u8, 6), end = Math.min(10 + size, u8.length);
    let p = 10;
    if (flags & 0x40) {
      p += ver === 4 ? syncsafe(u8, p) : be32(u8, p) + 4;
    }
    const v2 = ver === 2, idLen = v2 ? 3 : 4, hdrLen = v2 ? 6 : 10;
    while (p + hdrLen <= end) {
      const id = latin(u8, p, p + idLen);
      if (!/^[A-Z0-9]{3,4}$/.test(id)) break;
      let fsize = v2 ? be24(u8, p + 3) : (ver === 4 ? syncsafe(u8, p + 4) : be32(u8, p + 4));
      if (fsize <= 0 || p + hdrLen + fsize > end) break;
      const body = u8.subarray(p + hdrLen, p + hdrLen + fsize);
      try { frame(id, body, out); } catch (e) { }
      p += hdrLen + fsize;
    }
    return end;
  }
  const TXT = {
    TIT2: 'title', TT2: 'title', TPE1: 'artist', TP1: 'artist', TPE2: 'albumArtist', TP2: 'albumArtist',
    TALB: 'album', TAL: 'album', TCON: 'genre', TCO: 'genre', TYER: 'year', TYE: 'year', TDRC: 'year',
    TRCK: 'trackNo', TRK: 'trackNo', TBPM: 'bpm', TCOM: 'composer', TPOS: 'disc'
  };
  function frame(id, b, out) {
    if (TXT[id]) {
      const v = id3Text(b.subarray(1), b[0]);
      if (v) out[TXT[id]] = v;
      return;
    }
    if (id === 'APIC' || id === 'PIC') {
      const enc = b[0];
      let i = 1, mime;
      if (id === 'PIC') { mime = 'image/' + latin(b, 1, 4).toLowerCase().replace('jpg', 'jpeg'); i = 4; }
      else { const e = nullEnd(b, 1, 0); mime = latin(b, 1, e) || 'image/jpeg'; i = e + 1; }
      const picType = b[i]; i++;
      const de = nullEnd(b, i, enc); i = de + (enc === 1 || enc === 2 ? 2 : 1);
      if (i < b.length && (!out.cover || picType === 3)) {
        out.cover = new Blob([b.subarray(i)], { type: mime.indexOf('image/') === 0 ? mime : 'image/jpeg' });
      }
      return;
    }
    if (id === 'USLT' || id === 'ULT') {
      const enc = b[0], de = nullEnd(b, 4, enc), i = de + (enc === 1 || enc === 2 ? 2 : 1);
      const t = id3Text(b.subarray(i), enc);
      if (t && t.length > 8) out.lyrics = t;
      return;
    }
    if (id === 'SYLT') {
      try {
        const enc = b[0], fmt = b[5];
        let i = nullEnd(b, 6, enc) + (enc === 1 || enc === 2 ? 2 : 1), lines = [];
        while (i < b.length) {
          const e = nullEnd(b, i, enc);
          const text = id3Text(b.subarray(i, e), enc);
          i = e + (enc === 1 || enc === 2 ? 2 : 1);
          const ms = be32(b, i); i += 4;
          if (fmt === 2) lines.push({ t: ms / 1000, text });
        }
        if (lines.length > 3) out.synced = lines;
      } catch (e) { }
    }
  }

  /* ---------------- ID3v1 ---------------- */
  function parseID3v1(u8, out) {
    if (u8.length < 128) return;
    const i = u8.length - 128;
    if (latin(u8, i, i + 3) !== 'TAG') return;
    const g = (a, b) => clean(latin(u8, i + a, i + b));
    out.title = out.title || g(3, 33);
    out.artist = out.artist || g(33, 63);
    out.album = out.album || g(63, 93);
    out.year = out.year || g(93, 97);
    if (!out.trackNo && u8[i + 125] === 0 && u8[i + 126]) out.trackNo = String(u8[i + 126]);
  }

  /* ---------------- MP4 / M4A ---------------- */
  const M4 = { '\xa9nam': 'title', '\xa9ART': 'artist', 'aART': 'albumArtist', '\xa9alb': 'album', '\xa9gen': 'genre', 'gnre': 'genre', '\xa9day': 'year', 'trkn': 'trackNo', '\xa9wrt': 'composer', '\xa9lyr': 'lyrics', 'desc': 'comment' };
  function parseMP4(u8, out) {
    function walk(start, end, depth) {
      let p = start;
      while (p + 8 <= end) {
        let size = be32(u8, p);
        const type = latin(u8, p + 4, p + 8);
        let hdr = 8;
        if (size === 1) { hdr = 16; size = be32(u8, p + 12); }
        if (size < 8 || p + size > end + 8) break;
        const bodyStart = p + hdr, bodyEnd = Math.min(p + size, end);
        if (type === 'moov' || type === 'udta' || type === 'trak' || type === 'mdia') walk(bodyStart, bodyEnd, depth + 1);
        else if (type === 'meta') walk(bodyStart + 4, bodyEnd, depth + 1);
        else if (type === 'ilst') items(bodyStart, bodyEnd);
        else if (type === 'mvhd') {
          const v = u8[bodyStart], o = bodyStart + (v === 1 ? 20 : 12);
          const scale = be32(u8, o), dur = v === 1 ? be32(u8, o + 8) : be32(u8, o + 4);
          if (scale > 0 && dur > 0 && dur !== 0xffffffff) out.duration = dur / scale;
        }
        p += size;
      }
    }
    function items(start, end) {
      let p = start;
      while (p + 8 <= end) {
        const size = be32(u8, p), type = latin(u8, p + 4, p + 8);
        if (size < 8 || p + size > end) break;
        let q = p + 8;
        while (q + 8 <= p + size) {
          const dsz = be32(u8, q), dtype = latin(u8, q + 4, q + 8);
          if (dsz < 8 || q + dsz > p + size) break;
          if (dtype === 'data') {
            const flag = be32(u8, q + 8) & 0xffffff, payload = u8.subarray(q + 16, q + dsz);
            if (type === 'covr') { if (!out.cover) out.cover = new Blob([payload], { type: flag === 13 ? 'image/jpeg' : 'image/png' }); }
            else if (M4[type]) {
              if (type === 'trkn') out.trackNo = String(payload[3] || '');
              else if (flag === 1) { const v = clean(str(payload, 0, payload.length)); if (v) out[M4[type]] = v; }
            }
          }
          q += dsz;
        }
        p += size;
      }
    }
    walk(0, u8.length, 0);
  }

  /* ---------------- FLAC ---------------- */
  function parseFLAC(u8, out) {
    if (latin(u8, 0, 4) !== 'fLaC') return;
    let p = 4, guard = 0;
    while (p + 4 < u8.length && guard++ < 64) {
      const h = u8[p], last = h & 0x80, type = h & 0x7f, len = be24(u8, p + 1), body = p + 4;
      if (body + len > u8.length) break;
      if (type === 0) {
        const sr = (u8[body + 10] << 12) | (u8[body + 11] << 4) | (u8[body + 12] >> 4);
        const total = ((u8[body + 13] & 0x0f) * 4294967296) + be32(u8, body + 14);
        if (sr > 0 && total > 0) out.duration = total / sr;
      } else if (type === 4) vorbis(u8.subarray(body, body + len), out);
      else if (type === 6 && !out.cover) {
        let q = body + 4, mlen = be32(u8, q); q += 4;
        const mime = latin(u8, q, q + mlen); q += mlen;
        const dlen = be32(u8, q); q += 4 + dlen + 16;
        const plen = be32(u8, q); q += 4;
        if (plen > 0 && q + plen <= u8.length) out.cover = new Blob([u8.subarray(q, q + plen)], { type: mime || 'image/jpeg' });
      }
      p = body + len;
      if (last) break;
    }
  }
  const VK = { TITLE: 'title', ARTIST: 'artist', ALBUM: 'album', GENRE: 'genre', DATE: 'year', TRACKNUMBER: 'trackNo', ALBUMARTIST: 'albumArtist', LYRICS: 'lyrics', UNSYNCEDLYRICS: 'lyrics', COMPOSER: 'composer' };
  function vorbis(b, out) {
    try {
      let p = 0; const vlen = le32(b, p); p += 4 + vlen;
      const n = le32(b, p); p += 4;
      for (let i = 0; i < n && p + 4 <= b.length; i++) {
        const len = le32(b, p); p += 4;
        const s = str(b, p, p + len); p += len;
        const eq = s.indexOf('=');
        if (eq < 1) continue;
        const k = s.slice(0, eq).toUpperCase(), v = clean(s.slice(eq + 1));
        if (k === 'METADATA_BLOCK_PICTURE' && !out.cover) {
          try {
            const bin = atob(v), u = new Uint8Array(bin.length);
            for (let j = 0; j < bin.length; j++) u[j] = bin.charCodeAt(j);
            let q = 4, ml = be32(u, q); q += 4;
            const mime = latin(u, q, q + ml); q += ml;
            const dl = be32(u, q); q += 4 + dl + 16;
            const pl = be32(u, q); q += 4;
            out.cover = new Blob([u.subarray(q, q + pl)], { type: mime || 'image/jpeg' });
          } catch (e) { }
        } else if (VK[k] && v) out[VK[k]] = out[VK[k]] || v;
      }
    } catch (e) { }
  }

  /* ---------------- OGG / Opus ---------------- */
  function parseOGG(u8, out) {
    const find = sig => {
      outer: for (let i = 0; i < u8.length - sig.length; i++) {
        for (let j = 0; j < sig.length; j++) if (u8[i + j] !== sig.charCodeAt(j)) continue outer;
        return i;
      }
      return -1;
    };
    let i = find('\x03vorbis');
    if (i >= 0) return vorbis(u8.subarray(i + 7), out);
    i = find('OpusTags');
    if (i >= 0) return vorbis(u8.subarray(i + 8), out);
  }

  /* ---------------- WAV ---------------- */
  function parseWAV(u8, out) {
    if (latin(u8, 0, 4) !== 'RIFF' || latin(u8, 8, 12) !== 'WAVE') return;
    let p = 12, byteRate = 0;
    while (p + 8 < u8.length) {
      const id = latin(u8, p, p + 4), sz = le32(u8, p + 4);
      if (id === 'fmt ') byteRate = le32(u8, p + 12);
      else if (id === 'data' && byteRate) { out.duration = sz / byteRate; break; }
      else if (id === 'LIST' && latin(u8, p + 8, p + 12) === 'INFO') {
        let q = p + 12;
        const map = { INAM: 'title', IART: 'artist', IPRD: 'album', ICRD: 'year', IGNR: 'genre' };
        while (q + 8 < p + 8 + sz) {
          const k = latin(u8, q, q + 4), l = le32(u8, q + 4);
          if (map[k]) out[map[k]] = clean(latin(u8, q + 8, q + 8 + l));
          q += 8 + l + (l % 2);
        }
      }
      p += 8 + sz + (sz % 2);
    }
  }

  /* ---------------- public: read tags from a File ---------------- */
  Meta.read = async function (file) {
    const out = {};
    if (!file || !file.slice) return out;
    try {
      const head = await readBuf(file, 0, 1024 * 1024);
      if (!head) return out;
      const sig4 = latin(head, 0, 4);
      if (sig4.slice(0, 3) === 'ID3') {
        parseID3v2(head, out);
        if (file.size > 128) { const tail = await readBuf(file, file.size - 128, 128); if (tail) parseID3v1(tail, out); }
      } else if (sig4 === 'fLaC') parseFLAC(head, out);
      else if (sig4 === 'OggS') parseOGG(head, out);
      else if (sig4 === 'RIFF') parseWAV(head, out);
      else if (latin(head, 4, 8) === 'ftyp') parseMP4(head, out);
      else {
        if (file.size > 128) { const tail = await readBuf(file, file.size - 128, 128); if (tail) parseID3v1(tail, out); }
        if (!out.title) parseMP4(head, out);
      }
      if (out.genre) out.genre = out.genre.replace(/^\((\d+)\)\s*/, '');
      if (out.year) out.year = String(out.year).slice(0, 4);
      if (out.trackNo) out.trackNo = String(out.trackNo).split('/')[0];
    } catch (e) { console.warn('[meta]', file.name, e); }
    return out;
  };

  /* ---------------- duration probe via media element ---------------- */
  Meta.probe = function (src, isVideo) {
    return new Promise(res => {
      const m = document.createElement(isVideo ? 'video' : 'audio');
      let done = false;
      const fin = v => { if (done) return; done = true; clearTimeout(to); m.removeAttribute('src'); try { m.load(); } catch (e) { } res(v); };
      const to = setTimeout(() => fin(0), 9000);
      m.preload = 'metadata';
      m.onloadedmetadata = () => fin(isFinite(m.duration) ? m.duration : 0);
      m.onerror = () => fin(0);
      m.src = src;
    });
  };

  /* ---------------- LRC lyrics ---------------- */
  Meta.parseLRC = function (text) {
    const lines = [], raw = String(text || '').split(/\r?\n/);
    let offset = 0;
    const tagRe = /\[(\d{1,3}):(\d{1,2})(?:[.:](\d{1,3}))?\]/g;
    raw.forEach(line => {
      const off = /^\s*\[offset:\s*([+-]?\d+)\s*\]/i.exec(line);
      if (off) { offset = parseInt(off[1], 10) / 1000; return; }
      if (/^\s*\[(ti|ar|al|by|re|ve|length):/i.test(line)) return;
      tagRe.lastIndex = 0;
      const stamps = [];
      let m;
      while ((m = tagRe.exec(line))) stamps.push(+m[1] * 60 + +m[2] + (m[3] ? +('0.' + m[3]) : 0));
      const txt = line.replace(tagRe, '').trim();
      if (stamps.length) stamps.forEach(t => lines.push({ t, text: txt }));
      else if (txt) lines.push({ t: null, text: txt });
    });
    const timed = lines.filter(l => l.t !== null).sort((a, b) => a.t - b.t);
    return {
      synced: timed.length > 2,
      lines: timed.length > 2 ? timed : lines.map(l => ({ t: null, text: l.text })),
      offset
    };
  };

  /* ---------------- subtitles ---------------- */
  const tc = t => t.replace(',', '.');
  Meta.toVTT = function (text, name) {
    const s = String(text || '').replace(/\r/g, '');
    if (/^WEBVTT/.test(s.trim())) return s;
    if (/^\s*\[Script Info\]/i.test(s)) return assToVTT(s);
    const out = ['WEBVTT', ''];
    s.split(/\n\s*\n/).forEach(block => {
      const ls = block.split('\n').filter(Boolean);
      if (!ls.length) return;
      let i = 0;
      if (/^\d+$/.test(ls[0].trim())) i = 1;
      const m = /(\d{1,2}:\d{2}:\d{2}[,.]\d{1,3})\s*-->\s*(\d{1,2}:\d{2}:\d{2}[,.]\d{1,3})/.exec(ls[i] || '');
      if (!m) return;
      out.push(tc(m[1]) + ' --> ' + tc(m[2]));
      out.push(ls.slice(i + 1).join('\n'), '');
    });
    return out.join('\n');
  };
  function assToVTT(s) {
    const out = ['WEBVTT', ''];
    const pad = t => { const p = t.split(':'); return (p[0].length < 2 ? '0' + p[0] : p[0]) + ':' + p[1] + ':' + (p[2].length < 6 ? p[2] + '0' : p[2]); };
    s.split(/\n/).forEach(l => {
      const m = /^Dialogue:\s*[^,]*,([^,]+),([^,]+),(?:[^,]*,){6}(.*)$/.exec(l);
      if (!m) return;
      out.push(pad(m[1].trim()) + ' --> ' + pad(m[2].trim()));
      out.push(m[3].replace(/\{[^}]*\}/g, '').replace(/\\N/gi, '\n'), '');
    });
    return out.join('\n');
  }

  /* ---------------- Online Lyrics Search (LRCLIB API) ---------------- */
  Meta.cleanTrackQuery = function (str) {
    if (!str) return '';
    return str
      .replace(/\.(mp3|m4a|flac|wav|ogg|opus|aac|mp4|mkv|webm)$/i, '')
      .replace(/\[[^\]]*\]/g, ' ')
      .replace(/\((official|video|audio|lyrics?|hd|4k|feat\.?|ft\.?)[^)]*\)/gi, ' ')
      .replace(/\b(128|192|320)\s?kbps\b/gi, ' ')
      .replace(/[_\-]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  };

  Meta.fetchOnlineLyrics = async function (track) {
    if (!track) return null;
    const title = Meta.cleanTrackQuery(track.title || track.name || '');
    const artist = Meta.cleanTrackQuery(track.artist || '');
    const dur = Math.round(track.duration || 0);

    const endpoints = [];
    if (title && artist) {
      endpoints.push(`https://lrclib.net/api/get?track_name=${encodeURIComponent(title)}&artist_name=${encodeURIComponent(artist)}${dur > 0 ? '&duration=' + dur : ''}`);
      endpoints.push(`https://lrclib.net/api/search?track_name=${encodeURIComponent(title)}&artist_name=${encodeURIComponent(artist)}`);
      endpoints.push(`https://lrclib.net/api/search?q=${encodeURIComponent(artist + ' ' + title)}`);
    } else if (title) {
      endpoints.push(`https://lrclib.net/api/search?q=${encodeURIComponent(title)}`);
    }

    for (const url of endpoints) {
      try {
        const ctrl = new AbortController();
        const timeout = setTimeout(() => ctrl.abort(), 6000);
        const res = await fetch(url, { signal: ctrl.signal, headers: { 'User-Agent': 'HashPlayer/2.1' } });
        clearTimeout(timeout);
        if (!res.ok) continue;
        const data = await res.json();
        if (Array.isArray(data) && data.length) {
          const best = data.find(item => item.syncedLyrics) || data[0];
          if (best && (best.syncedLyrics || best.plainLyrics)) {
            return {
              lrc: best.syncedLyrics || best.plainLyrics,
              synced: !!best.syncedLyrics,
              trackName: best.trackName,
              artistName: best.artistName,
              albumName: best.albumName,
              results: data
            };
          }
        } else if (data && (data.syncedLyrics || data.plainLyrics)) {
          return {
            lrc: data.syncedLyrics || data.plainLyrics,
            synced: !!data.syncedLyrics,
            trackName: data.trackName,
            artistName: data.artistName,
            albumName: data.albumName,
            results: [data]
          };
        }
      } catch (e) { }
    }
    return null;
  };

  Meta.searchLyricsQuery = async function (query) {
    const q = Meta.cleanTrackQuery(query);
    if (!q) return [];
    try {
      const url = `https://lrclib.net/api/search?q=${encodeURIComponent(q)}`;
      const ctrl = new AbortController();
      const timeout = setTimeout(() => ctrl.abort(), 7000);
      const res = await fetch(url, { signal: ctrl.signal, headers: { 'User-Agent': 'HashPlayer/2.1' } });
      clearTimeout(timeout);
      if (!res.ok) return [];
      const data = await res.json();
      return Array.isArray(data) ? data : [];
    } catch (e) {
      return [];
    }
  };

  /* ---------------- YouTube Stream & Search Resolver ---------------- */
  Meta.isYouTube = function (url) {
    if (!url) return false;
    return /(?:youtube\.com\/(?:watch\?.*v=|embed\/|v\/|shorts\/)|youtu\.be\/)([a-zA-Z0-9_-]{11})/i.test(url);
  };

  Meta.extractYouTubeId = function (url) {
    if (!url) return null;
    const m = /(?:youtube\.com\/(?:watch\?.*v=|embed\/|v\/|shorts\/)|youtu\.be\/)([a-zA-Z0-9_-]{11})/i.exec(url);
    return m ? m[1] : null;
  };

  Meta.resolveYouTube = async function (urlOrId) {
    const id = Meta.extractYouTubeId(urlOrId) || urlOrId;
    if (!id || !/^[a-zA-Z0-9_-]{11}$/.test(id)) return null;

    let meta = {
      title: 'YouTube Video',
      artist: 'YouTube',
      duration: 0,
      cover: `https://i.ytimg.com/vi/${id}/hqdefault.jpg`,
      streamUrl: null,
      audioUrl: null,
      id
    };

    // 1. Fetch metadata via oEmbed
    try {
      const oEmbedUrl = `https://noembed.com/embed?url=https://www.youtube.com/watch?v=${id}`;
      const r = await fetch(oEmbedUrl);
      if (r.ok) {
        const j = await r.json();
        if (j.title) meta.title = j.title;
        if (j.author_name) meta.artist = j.author_name;
        if (j.thumbnail_url) meta.cover = j.thumbnail_url;
      }
    } catch (_) {}

    // 2. Query multi-instance streaming APIs
    const streamApis = [
      `https://pipedapi.kavin.rocks/streams/${id}`,
      `https://api.piped.private.coffee/streams/${id}`,
      `https://pipedapi.tokhmi.xyz/streams/${id}`,
      `https://invidious.nerdvpn.de/api/v1/videos/${id}`,
      `https://inv.tux.pizza/api/v1/videos/${id}`,
      `https://yt.artemislena.eu/api/v1/videos/${id}`
    ];

    for (const api of streamApis) {
      try {
        const ctrl = new AbortController();
        const to = setTimeout(() => ctrl.abort(), 4500);
        const res = await fetch(api, { signal: ctrl.signal });
        clearTimeout(to);
        if (!res.ok) continue;
        const data = await res.json();

        if (data.title) meta.title = data.title;
        if (data.uploader || data.author) meta.artist = data.uploader || data.author;
        if (data.duration) meta.duration = Number(data.duration) || 0;
        if (data.thumbnailUrl) meta.cover = data.thumbnailUrl;

        // Progressive MP4 stream with audio + video
        if (Array.isArray(data.videoStreams) && data.videoStreams.length) {
          const prog = data.videoStreams.find(s => s.videoOnly === false && s.mimeType && s.mimeType.includes('mp4'))
            || data.videoStreams.find(s => s.videoOnly === false)
            || data.videoStreams[0];
          if (prog && prog.url) meta.streamUrl = prog.url;
        }

        if (Array.isArray(data.audioStreams) && data.audioStreams.length) {
          const bestAudio = data.audioStreams.find(s => s.mimeType && s.mimeType.includes('mp4')) || data.audioStreams[0];
          if (bestAudio && bestAudio.url) meta.audioUrl = bestAudio.url;
        }

        if (Array.isArray(data.formatStreams) && data.formatStreams.length) {
          const prog = data.formatStreams.find(s => s.type && s.type.includes('mp4')) || data.formatStreams[0];
          if (prog && prog.url) meta.streamUrl = prog.url;
        }

        if (meta.streamUrl) break;
      } catch (_) { }
    }

    if (!meta.streamUrl) {
      meta.streamUrl = `https://www.youtube.com/embed/${id}?autoplay=1&playsinline=1&enablejsapi=1`;
      meta.isEmbed = true;
    }

    return meta;
  };

  /* ---------------- YouTube In-App Search & Browser ---------------- */
  Meta.searchYouTube = async function (query) {
    const q = String(query || '').trim();
    if (!q) return [];
    const searchApis = [
      `https://pipedapi.kavin.rocks/search?q=${encodeURIComponent(q)}&filter=videos`,
      `https://api.piped.private.coffee/search?q=${encodeURIComponent(q)}&filter=videos`,
      `https://invidious.nerdvpn.de/api/v1/search?q=${encodeURIComponent(q)}&type=video`,
      `https://inv.tux.pizza/api/v1/search?q=${encodeURIComponent(q)}&type=video`
    ];

    for (const api of searchApis) {
      try {
        const ctrl = new AbortController();
        const to = setTimeout(() => ctrl.abort(), 5000);
        const res = await fetch(api, { signal: ctrl.signal });
        clearTimeout(to);
        if (!res.ok) continue;
        const data = await res.json();
        const items = Array.isArray(data) ? data : (data.items || []);
        if (!items.length) continue;

        return items.map(it => {
          let id = it.videoId || it.id;
          if (!id && it.url) id = Meta.extractYouTubeId(it.url) || it.url.replace('/watch?v=', '');
          const thumb = it.thumbnail || it.thumbnailUrl || (it.videoThumbnails && it.videoThumbnails[0] && it.videoThumbnails[0].url) || (id ? `https://i.ytimg.com/vi/${id}/hqdefault.jpg` : '');
          return {
            id,
            url: `https://www.youtube.com/watch?v=${id}`,
            title: it.title || 'YouTube Video',
            artist: it.uploaderName || it.author || it.channelTitle || 'YouTube',
            duration: it.duration || 0,
            cover: thumb,
            views: it.views || it.viewCountText || ''
          };
        }).filter(it => it.id && it.id.length === 11);
      } catch (_) { }
    }
    return [];
  };

  HP.Meta = Meta;
})(window);
