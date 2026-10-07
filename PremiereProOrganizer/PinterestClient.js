/**
 * PinterestClient.js — search Pinterest videos and save one as an MP4,
 * from inside the Premiere panel (Node side, loaded with require()).
 *
 * How it works, and why
 * ---------------------
 * Pinterest has no public "search everything" API, and refuses to be shown
 * inside a panel. What it does answer is the JSON endpoint its own website
 * calls, provided the request looks like the website's: a cookie jar started
 * by one visit to the home page, and the same handful of headers. That is what
 * this module does — one search per Enter, one download per click, nothing
 * automated behind the user's back.
 *
 * Videos come as modern HLS (CMAF): one video file and one audio file, each a
 * complete fragmented MP4 described by a playlist. We download both whole and
 * let ffmpeg join them without re-encoding. Older Pins publish a progressive
 * MP4 directly; those are saved as-is, no ffmpeg needed.
 *
 * Everything that touches the network or spawns a process is injectable
 * (`deps`), so tests run against a fake Pinterest and a fake ffmpeg.
 *
 * This is an unofficial endpoint: it can change without notice. Every failure
 * is reported as a sentence the panel can show, never swallowed.
 */
(function () {
  'use strict';

  var UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
           '(KHTML, like Gecko) Chrome/124.0 Safari/537.36';
  var HOME = 'https://www.pinterest.com/';
  var COOKIE_TTL_MS = 30 * 60 * 1000;
  // Where ffmpeg usually lives. Premiere hands its panels a short PATH (on a
  // Mac, not even Homebrew's folder), hence the explicit places first.
  var FFMPEG_MAC_LINUX = ['/opt/homebrew/bin/ffmpeg', '/usr/local/bin/ffmpeg', '/opt/local/bin/ffmpeg', '/usr/bin/ffmpeg', 'ffmpeg'];

  /** Progressive (non-HLS) keys Pinterest publishes, best first. */
  var PROGRESSIVE_RANK = ['V_1080P', 'V_HEVC_MP4_T5', 'V_EXP7', 'V_EXP6', 'V_EXP5',
                          'V_720P', 'V_EXP4', 'V_EXP3', 'V_480P', 'V_360P', 'V_240P'];

  function create(deps) {
    deps = deps || {};
    var https = deps.https || require('https');
    var fs = deps.fs || require('fs');
    var path = deps.path || require('path');
    var spawn = deps.spawn || require('child_process').spawn;
    var now = deps.now || function () { return Date.now(); };
    var platform = deps.platform || (typeof process !== 'undefined' ? process.platform : '');
    var env = deps.env || (typeof process !== 'undefined' ? process.env : {}) || {};

    var jar = { cookies: {}, csrftoken: '', at: 0 };

    // ------------------------------------------------------------ HTTP

    function cookieHeader() {
      var parts = [];
      for (var k in jar.cookies) if (jar.cookies.hasOwnProperty(k)) parts.push(k + '=' + jar.cookies[k]);
      return parts.join('; ');
    }

    function absorbCookies(res) {
      var set = res.headers && res.headers['set-cookie'];
      if (!set) return;
      if (!Array.isArray(set)) set = [set];
      for (var i = 0; i < set.length; i++) {
        var kv = String(set[i]).split(';')[0];
        var eq = kv.indexOf('=');
        if (eq === -1) continue;
        var name = kv.substring(0, eq).trim(), value = kv.substring(eq + 1).trim();
        if (!name) continue;
        jar.cookies[name] = value;
        if (name === 'csrftoken') jar.csrftoken = value;
      }
    }

    /** GET as the website would. cb(err, { status, body(Buffer), headers }). */
    function get(url, headers, cb, onData) {
      var u;
      try { u = new URL(url); } catch (e) { return cb(new Error('bad URL ' + url)); }
      var opts = {
        method: 'GET', hostname: u.hostname, path: u.pathname + u.search,
        headers: Object.assign({
          'User-Agent': UA,
          'Accept-Encoding': 'identity',
          'Accept-Language': 'en-US,en;q=0.9,fr;q=0.8'
        }, headers || {})
      };
      var cookie = cookieHeader();
      if (cookie && /pinterest\.com$/i.test(u.hostname)) opts.headers.Cookie = cookie;

      var req;
      try {
        req = https.request(opts, function (res) {
          absorbCookies(res);
          var chunks = [], size = 0;
          var total = parseInt(res.headers['content-length'] || '0', 10) || 0;
          res.on('data', function (c) {
            chunks.push(c); size += c.length;
            if (onData) onData(size, total);
          });
          res.on('end', function () {
            cb(null, { status: res.statusCode, body: Buffer.concat(chunks), headers: res.headers });
          });
          res.on('error', function (e) { cb(e); });
        });
      } catch (e) { return cb(e); }
      req.on('error', function (e) { cb(e); });
      req.setTimeout(30000, function () { req.destroy(new Error('timed out')); });
      req.end();
    }

    /** One home-page visit gives the csrftoken cookie the JSON endpoint wants. */
    function ensureSession(cb) {
      if (jar.csrftoken && now() - jar.at < COOKIE_TTL_MS) return cb(null);
      get(HOME, { Accept: 'text/html' }, function (err, res) {
        if (err) return cb(new Error('Pinterest is unreachable: ' + err.message));
        if (!jar.csrftoken) return cb(new Error('Pinterest did not hand out a session (HTTP ' + res.status + ')'));
        jar.at = now();
        cb(null);
      });
    }

    function pinterestHeaders(sourceUrl, handler) {
      return {
        Accept: 'application/json, text/javascript, */*, q=0.01',
        'X-Requested-With': 'XMLHttpRequest',
        'X-CSRFToken': jar.csrftoken,
        'X-Pinterest-AppState': 'active',
        'X-Pinterest-Source-Url': sourceUrl,
        'X-Pinterest-PWS-Handler': handler,
        Referer: HOME.replace(/\/$/, '') + sourceUrl
      };
    }

    // ------------------------------------------------------------ search

    /**
     * search(query, bookmark, cb) → cb(err, { pins, bookmark })
     * `bookmark` from a previous answer fetches the next page.
     */
    function search(query, bookmark, cb) {
      var q = String(query || '').trim();
      if (!q) return cb(null, { pins: [], bookmark: null });
      ensureSession(function (err) {
        if (err) return cb(err);
        var sourceUrl = '/search/videos/?q=' + encodeURIComponent(q);
        var options = { query: q, scope: 'videos', bookmarks: bookmark ? [bookmark] : [] };
        var data = JSON.stringify({ options: options, context: {} });
        var url = HOME + 'resource/BaseSearchResource/get/?source_url=' + encodeURIComponent(sourceUrl) +
                  '&data=' + encodeURIComponent(data);
        get(url, pinterestHeaders(sourceUrl, 'www/search/[scope].js'), function (err2, res) {
          if (err2) return cb(new Error('Pinterest is unreachable: ' + err2.message));
          if (res.status === 403 || res.status === 429) {
            jar.csrftoken = '';   // next search starts a fresh session
            return cb(new Error('Pinterest refused the search (HTTP ' + res.status + ') — wait a minute and try again'));
          }
          if (res.status !== 200) return cb(new Error('Pinterest answered HTTP ' + res.status));
          var parsed;
          try { parsed = JSON.parse(res.body.toString('utf8')); } catch (e) {
            return cb(new Error('Pinterest sent something that is not JSON — the endpoint may have changed'));
          }
          cb(null, parseSearch(parsed));
        });
      });
    }

    function parseSearch(json) {
      var rr = (json && json.resource_response) || {};
      var results = (rr.data && rr.data.results) || [];
      var pins = [];
      for (var i = 0; i < results.length; i++) {
        var pin = normalizePin(results[i]);
        if (pin) pins.push(pin);
      }
      return { pins: pins, bookmark: rr.bookmark || null };
    }

    /** The few fields the panel shows and the download needs. */
    function normalizePin(raw) {
      if (!raw || typeof raw !== 'object' || !raw.id) return null;
      var vl = raw.videos && raw.videos.video_list;
      if (!vl) return null;

      var progressive = null, hls = null, best = null;
      for (var p = 0; p < PROGRESSIVE_RANK.length && !progressive; p++) {
        var cand = vl[PROGRESSIVE_RANK[p]];
        if (cand && cand.url && /\.mp4(?:[?#]|$)/i.test(cand.url)) progressive = cand;
      }
      for (var k in vl) {
        if (!vl.hasOwnProperty(k) || !vl[k] || !vl[k].url) continue;
        if (!best) best = vl[k];
        if (/\.m3u8(?:[?#]|$)/i.test(vl[k].url) && (!hls || k === 'V_HLSV4')) hls = vl[k];
      }
      if (!progressive && !hls) return null;
      var media = progressive || hls || best;

      var images = raw.images || {};
      var thumb = (images['474x'] || images['236x'] || images.orig || {}).url || '';
      var title = firstText([raw.grid_title, raw.title, raw.description]);

      return {
        id: String(raw.id),
        title: title,
        thumb: thumb,
        width: media.width || 0,
        height: media.height || 0,
        durationMs: media.duration || 0,
        pinner: (raw.pinner && raw.pinner.username) || '',
        domain: raw.domain || '',
        color: raw.dominant_color || '',
        mp4: progressive ? progressive.url : '',
        hls: hls ? hls.url : '',
        fileName: fileNameFor(title, raw.id)
      };
    }

    function firstText(list) {
      for (var i = 0; i < list.length; i++) {
        var s = String(list[i] || '').replace(/\s+/g, ' ').trim();
        if (s) return s;
      }
      return '';
    }

    // ------------------------------------------------------------ naming
    // "{title}_{id}.mp4", exactly what the Chrome extension writes, so the
    // Organizer's b-roll rule (a Pin id at the end of the name) keeps matching.

    function fileNameFor(title, id) {
      var base = String(title || '')
        // Letters, digits, spaces and light punctuation only: a Pin title is
        // full of emoji, hashtags and "@handles" that make a file name a mess.
        .replace(/[^\p{L}\p{N}\s.,'’()&-]/gu, ' ')
        .replace(/\s+/g, ' ')
        .trim().replace(/^[.\s]+/, '').replace(/[.\s]+$/, '')
        .slice(0, 60)
        .replace(/[\s_.-]+$/, '');
      if (!base) base = 'pinterest';
      return base + '_' + String(id) + '.mp4';
    }

    // ------------------------------------------------------------ download

    function ffmpegCandidates() {
      // A copy dropped next to the panel (bin/ffmpeg or bin/ffmpeg.exe) wins:
      // that is the way for someone who cannot install anything system-wide.
      var own = deps.extensionDir ? [path.join(deps.extensionDir, 'bin', platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg')] : [];
      if (platform !== 'win32') return own.concat(FFMPEG_MAC_LINUX);
      // winget, a manual unzip in C:\ffmpeg, Program Files, Chocolatey, Scoop.
      var c = own.slice();
      if (env.LOCALAPPDATA) c.push(path.join(env.LOCALAPPDATA, 'Microsoft', 'WinGet', 'Links', 'ffmpeg.exe'));
      c.push('C:\\ffmpeg\\bin\\ffmpeg.exe');
      if (env.ProgramFiles) c.push(path.join(env.ProgramFiles, 'ffmpeg', 'bin', 'ffmpeg.exe'));
      if (env.ChocolateyInstall) c.push(path.join(env.ChocolateyInstall, 'bin', 'ffmpeg.exe'));
      if (env.USERPROFILE) c.push(path.join(env.USERPROFILE, 'scoop', 'shims', 'ffmpeg.exe'));
      c.push('ffmpeg.exe');
      return c;
    }

    function findFfmpeg() {
      var list = ffmpegCandidates();
      for (var i = 0; i < list.length; i++) {
        var c = list[i];
        if (c.indexOf('/') !== -1 || c.indexOf('\\') !== -1) {
          try { if (fs.existsSync(c)) return c; } catch (e) {}
          continue;
        }
        // A bare name is only usable if some PATH entry really holds it —
        // CEP's PATH is short, and "ffmpeg: not found" is a worse message.
        var dirs = String(env.PATH || env.Path || '').split(platform === 'win32' ? ';' : ':');
        for (var d = 0; d < dirs.length; d++) {
          if (!dirs[d]) continue;
          var full = path.join(dirs[d], c);
          try { if (fs.existsSync(full)) return full; } catch (e) {}
        }
      }
      return null;
    }

    // How to get ffmpeg, in the words of the system the user is on.
    function ffmpegHint() {
      if (platform === 'win32') return 'winget install -e --id Gyan.FFmpeg';
      if (platform === 'darwin') return 'brew install ffmpeg';
      return 'install ffmpeg';
    }

    function ffmpegMissing() {
      return 'Saving this video needs ffmpeg (' + ffmpegHint() + ', or see the README), then restart Premiere.';
    }

    /**
     * download(pin, destDir, onProgress, cb) → cb(err, { path })
     * onProgress(fraction 0..1, label)
     */
    function download(pin, destDir, onProgress, cb) {
      var progress = onProgress || function () {};
      var finalPath = path.join(destDir, pin.fileName);
      try { if (!fs.existsSync(destDir)) fs.mkdirSync(destDir, { recursive: true }); }
      catch (e) { return cb(new Error('cannot create ' + destDir)); }
      if (fs.existsSync(finalPath)) return cb(null, { path: finalPath, existed: true });

      var tmpDir = path.join(destDir, '.pqd-tmp');
      try { if (!fs.existsSync(tmpDir)) fs.mkdirSync(tmpDir, { recursive: true }); } catch (e) {}
      var partial = path.join(tmpDir, pin.id + '.part.mp4');

      function finish(err) {
        if (err) { cleanup([partial]); return cb(err); }
        try { fs.renameSync(partial, finalPath); } catch (e) { cleanup([partial]); return cb(new Error('cannot write ' + finalPath)); }
        cb(null, { path: finalPath });
      }

      if (pin.mp4) {
        progress(0, 'downloading');
        return fetchToFile(pin.mp4, partial, function (frac) { progress(frac, 'downloading'); }, finish);
      }
      if (!pin.hls) return cb(new Error('this Pin has no video stream'));

      var ffmpeg = findFfmpeg();
      if (!ffmpeg) {
        return cb(new Error(ffmpegMissing()));
      }

      progress(0, 'reading playlist');
      resolveHls(pin.hls, function (err, plan) {
        if (err) return cb(err);
        var vPart = path.join(tmpDir, pin.id + '.video');
        var aPart = path.join(tmpDir, pin.id + '.audio');

        if (plan.kind === 'cmaf') {
          // Video 0–70 %, audio 70–85 %, mux 85–100 %.
          fetchToFile(plan.video, vPart, function (f) { progress(f * 0.7, 'downloading video'); }, function (e1) {
            if (e1) return cb(e1);
            var afterAudio = function (e2) {
              if (e2) { cleanup([vPart, aPart]); return cb(e2); }
              progress(0.85, 'joining audio and video');
              var args = ['-hide_banner', '-loglevel', 'error', '-y', '-i', vPart];
              if (plan.audio) args.push('-i', aPart);
              args.push('-c', 'copy', '-movflags', '+faststart', partial);
              runFfmpeg(ffmpeg, args, function (e3) {
                cleanup([vPart, aPart]);
                if (e3) return cb(e3);
                progress(1, 'done');
                finish(null);
              });
            };
            if (plan.audio) fetchToFile(plan.audio, aPart, function (f) { progress(0.7 + f * 0.15, 'downloading audio'); }, afterAudio);
            else afterAudio(null);
          });
          return;
        }

        // Classic HLS (MPEG-TS segments): ffmpeg reads the playlist itself.
        progress(0.1, 'downloading stream');
        runFfmpeg(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y', '-user_agent', UA,
                           '-i', plan.playlist, '-c', 'copy', '-bsf:a', 'aac_adtstoasc', partial],
          function (e) {
            if (e) return cb(e);
            progress(1, 'done');
            finish(null);
          });
      });
    }

    /**
     * Reads the master playlist, picks the best video rendition and its audio
     * group, then the media playlists to find the whole-file URIs (EXT-X-MAP).
     * cb(err, { kind: 'cmaf', video, audio } | { kind: 'ts', playlist })
     */
    function resolveHls(masterUrl, cb) {
      get(masterUrl, { Accept: '*/*' }, function (err, res) {
        if (err || res.status !== 200) return cb(new Error('could not read the video playlist'));
        var master = parsePlaylist(res.body.toString('utf8'), masterUrl);
        if (!master.variants.length) {
          // Already a media playlist.
          if (master.map) return cb(null, { kind: 'cmaf', video: master.map, audio: null });
          return cb(null, { kind: 'ts', playlist: masterUrl });
        }
        var best = master.variants[0];
        var audioUri = best.audioGroup && master.audio[best.audioGroup];
        get(best.url, { Accept: '*/*' }, function (e2, r2) {
          if (e2 || r2.status !== 200) return cb(new Error('could not read the video rendition'));
          var media = parsePlaylist(r2.body.toString('utf8'), best.url);
          if (!media.map) return cb(null, { kind: 'ts', playlist: masterUrl });
          if (!audioUri) return cb(null, { kind: 'cmaf', video: media.map, audio: null });
          get(audioUri, { Accept: '*/*' }, function (e3, r3) {
            if (e3 || r3.status !== 200) return cb(new Error('could not read the audio rendition'));
            var audio = parsePlaylist(r3.body.toString('utf8'), audioUri);
            cb(null, { kind: 'cmaf', video: media.map, audio: audio.map || null });
          });
        });
      });
    }

    /** Minimal M3U8 reader: variants (sorted best first), audio groups, EXT-X-MAP. */
    function parsePlaylist(text, baseUrl) {
      var out = { variants: [], audio: {}, map: null };
      var lines = String(text).split(/\r?\n/);
      var pending = null;
      for (var i = 0; i < lines.length; i++) {
        var line = lines[i].trim();
        if (!line) continue;
        if (line.indexOf('#EXT-X-MEDIA:') === 0 && /TYPE=AUDIO/.test(line)) {
          var gid = attr(line, 'GROUP-ID'), uri = attr(line, 'URI');
          if (gid && uri && !out.audio[gid]) out.audio[gid] = resolve(uri, baseUrl);
        } else if (line.indexOf('#EXT-X-STREAM-INF:') === 0) {
          var res = attr(line, 'RESOLUTION'), bw = parseInt(attr(line, 'BANDWIDTH') || '0', 10);
          var h = res ? parseInt(res.split('x')[1], 10) : 0;
          pending = { height: h || 0, bandwidth: bw || 0, audioGroup: attr(line, 'AUDIO') };
        } else if (line.indexOf('#EXT-X-MAP:') === 0) {
          var m = attr(line, 'URI');
          if (m && !out.map) out.map = resolve(m, baseUrl);
        } else if (line.charAt(0) !== '#') {
          if (pending) { pending.url = resolve(line, baseUrl); out.variants.push(pending); pending = null; }
        }
      }
      out.variants.sort(function (a, b) { return (b.height - a.height) || (b.bandwidth - a.bandwidth); });
      return out;
    }

    function attr(line, name) {
      var m = new RegExp(name + '=("([^"]*)"|([^,]*))').exec(line);
      return m ? (m[2] !== undefined ? m[2] : m[3]) : '';
    }

    function resolve(uri, base) {
      try { return new URL(uri, base).href; } catch (e) { return uri; }
    }

    function fetchToFile(url, dest, onProgress, cb) {
      get(url, { Accept: '*/*' }, function (err, res) {
        if (err) return cb(new Error('download failed: ' + err.message));
        if (res.status !== 200) return cb(new Error('download refused (HTTP ' + res.status + ')'));
        try { fs.writeFileSync(dest, res.body); } catch (e) { return cb(new Error('cannot write ' + dest)); }
        onProgress(1);
        cb(null);
      }, function (size, total) { if (total) onProgress(size / total); });
    }

    function runFfmpeg(bin, args, cb) {
      var child;
      // windowsHide: no console window flashing on Windows during the join.
      try { child = spawn(bin, args, { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true }); }
      catch (e) { return cb(new Error('cannot start ffmpeg: ' + e.message)); }
      var stderr = '';
      if (child.stderr) child.stderr.on('data', function (d) { stderr += String(d); });
      child.on('error', function (e) { cb(new Error('ffmpeg failed to start: ' + e.message)); });
      child.on('close', function (code) {
        if (code === 0) return cb(null);
        cb(new Error('ffmpeg could not join the video (' + (stderr.trim().split('\n').pop() || 'code ' + code) + ')'));
      });
    }

    function cleanup(paths) {
      for (var i = 0; i < paths.length; i++) {
        try { if (paths[i] && fs.existsSync(paths[i])) fs.unlinkSync(paths[i]); } catch (e) {}
      }
    }

    return {
      search: search,
      download: download,
      fileNameFor: fileNameFor,
      findFfmpeg: findFfmpeg,
      ffmpegMissing: ffmpegMissing,
      _test: { parseSearch: parseSearch, parsePlaylist: parsePlaylist, normalizePin: normalizePin, jar: jar }
    };
  }

  if (typeof module !== 'undefined' && module.exports) module.exports = { create: create };
  else if (typeof window !== 'undefined') window.PinterestClient = { create: create };
})();
