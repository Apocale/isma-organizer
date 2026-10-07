/**
 *   node tests/check-pinterest.mjs
 *
 * PinterestClient.js against a fake Pinterest and a fake ffmpeg: the session
 * handshake, the search (real response shape, recorded in fixtures/), the
 * paging, the HLS/CMAF resolution, the join, the file naming, and every
 * failure that must come back as a sentence rather than a hang.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..') + '/';
const require = createRequire(import.meta.url);
const { create } = require(ROOT + 'PinterestClient.js');
const fixture = fs.readFileSync(ROOT + 'tests/fixtures/pinterest-search.json', 'utf8');

let failed = 0;
const check = (name, ok, detail = '') => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '   -> ' + detail : ''}`);
  if (!ok) failed++;
};

// ---------------------------------------------------------------- fake network
const HASH = 'a2f1c28d481198b2ede40e96341ed32b';
const CDN = 'https://v1.pinimg.com/videos/iht/hls/a2/f1/c2/';
const master = [
  '#EXTM3U',
  `#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="audio1",NAME="1",AUTOSELECT=YES,URI="${HASH}_audio.m3u8",CHANNELS="2"`,
  '#EXT-X-STREAM-INF:BANDWIDTH=257832,CODECS="avc1.64080D,mp4a.40.29",RESOLUTION=234x416,AUDIO="audio1"',
  `${HASH}_240w.m3u8`,
  '#EXT-X-STREAM-INF:BANDWIDTH=1000000,CODECS="avc1.64081F,mp4a.40.29",RESOLUTION=720x1280,AUDIO="audio1"',
  `${HASH}_720w.m3u8`,
  '#EXT-X-STREAM-INF:BANDWIDTH=617160,CODECS="avc1.64081F,mp4a.40.29",RESOLUTION=540x960,AUDIO="audio1"',
  `${HASH}_540w.m3u8`
].join('\n');
const media = (name) => `#EXTM3U\n#EXT-X-TARGETDURATION:2\n#EXT-X-MAP:URI="${HASH}_${name}",BYTERANGE="974@0"\n#EXTINF:2\n#EXT-X-BYTERANGE:1000@974\n${HASH}_${name}\n`;

const requests = [];
let mode = { home: 200, search: 200, notJson: false, cdn: 200 };

function fakeHttps() {
  return {
    request(opts, onRes) {
      const url = 'https://' + opts.hostname + opts.path;
      requests.push({ url, headers: opts.headers });
      const req = new EventEmitter();
      req.setTimeout = () => {};
      req.destroy = () => {};
      req.end = () => {
        const res = new EventEmitter();
        res.headers = {};
        let body = Buffer.alloc(0);
        if (url === 'https://www.pinterest.com/') {
          res.statusCode = mode.home;
          res.headers['set-cookie'] = ['csrftoken=abc123; Path=/; Secure', '_pinterest_sess=xyz; Path=/'];
          body = Buffer.from('<html>');
        } else if (url.indexOf('/resource/BaseSearchResource/get/') !== -1) {
          res.statusCode = mode.search;
          body = Buffer.from(mode.notJson ? '<html>blocked</html>' : fixture);
        } else if (url.endsWith(`${HASH}.m3u8`)) {
          res.statusCode = mode.cdn; body = Buffer.from(master);
        } else if (url.endsWith('_720w.m3u8')) {
          res.statusCode = 200; body = Buffer.from(media('720w.cmfv'));
        } else if (url.endsWith('_audio.m3u8')) {
          res.statusCode = 200; body = Buffer.from(media('audio.cmfa'));
        } else if (url.endsWith('.cmfv')) {
          res.statusCode = 200; body = Buffer.alloc(5000, 7); res.headers['content-length'] = '5000';
        } else if (url.endsWith('.cmfa')) {
          res.statusCode = 200; body = Buffer.alloc(800, 9); res.headers['content-length'] = '800';
        } else if (url.endsWith('aabbcc.mp4')) {
          res.statusCode = 200; body = Buffer.from('PROGRESSIVE-MP4'); res.headers['content-length'] = String(body.length);
        } else {
          res.statusCode = 404;
        }
        setImmediate(() => {
          onRes(res);
          res.emit('data', body);
          res.emit('end');
        });
      };
      return req;
    }
  };
}

const spawned = [];
function fakeSpawn(bin, args) {
  spawned.push({ bin, args });
  const child = new EventEmitter();
  child.stderr = new EventEmitter();
  setImmediate(() => {
    const out = args[args.length - 1];
    if (bin === '/bad/ffmpeg') { child.stderr.emit('data', 'Invalid data found'); child.emit('close', 1); return; }
    fs.writeFileSync(out, Buffer.concat([Buffer.from('MUXED:'), ...args.filter((a) => /\.(video|audio)$/.test(a)).map((a) => fs.readFileSync(a))]));
    child.emit('close', 0);
  });
  return child;
}

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'pqd-client-'));
const ffmpegPath = path.join(DIR, 'ffmpeg');
fs.writeFileSync(ffmpegPath, '#!/bin/sh\n');   // exists → "found"

function client(overrides = {}) {
  const fsWithFfmpeg = Object.assign({}, fs, {
    existsSync: (p) => (p === '/opt/homebrew/bin/ffmpeg' ? overrides.ffmpeg !== false : fs.existsSync(p))
  });
  return create(Object.assign({ https: fakeHttps(), spawn: fakeSpawn, fs: fsWithFfmpeg, now: () => 1000 }, overrides));
}

const wait = (fn) => new Promise((resolve) => fn((err, res) => resolve({ err, res })));

// ================================================================ 1) search
console.log('\n1) A search starts a session and asks as the website would');
{
  const c = client();
  requests.length = 0;
  const { err, res } = await wait((cb) => c.search('cuisine moderne', null, cb));
  check('no error', !err, err && err.message);
  check('the home page was visited first, then the search', requests.length === 2 && requests[0].url === 'https://www.pinterest.com/' && /BaseSearchResource/.test(requests[1].url),
        requests.map((r) => r.url.slice(0, 60)).join(' | '));
  const h = requests[1].headers;
  check('the csrftoken cookie came back as a header', h['X-CSRFToken'] === 'abc123' && /csrftoken=abc123/.test(h.Cookie), h.Cookie);
  check('scope=videos and the query travel in the data parameter', /%22scope%22%3A%22videos%22/.test(requests[1].url) && /cuisine%20moderne/.test(requests[1].url));
  check('4 video pins parsed', res.pins.length === 4, String(res.pins.length));
  check('a bookmark for the next page', typeof res.bookmark === 'string' && res.bookmark.length > 10);

  const p = res.pins[0];
  check('title, thumbnail, duration, size', p.title.length > 0 && /pinimg\.com/.test(p.thumb) && p.durationMs === 21633 && p.width === 720,
        JSON.stringify({ t: p.title, d: p.durationMs, w: p.width }));
  check('HLS master URL kept, no mp4', /\.m3u8$/.test(p.hls) && p.mp4 === '');
  check('file name is {title}_{id}.mp4', new RegExp('_' + p.id + '\\.mp4$').test(p.fileName) && !/[\\/:*?"<>|]/.test(p.fileName), p.fileName);

  const prog = res.pins[3];
  check('a progressive pin exposes its mp4', prog.mp4 === 'https://v1.pinimg.com/videos/mc/720p/aa/bb/cc/aabbcc.mp4');

  // second page
  requests.length = 0;
  const page2 = await wait((cb) => c.search('cuisine moderne', res.bookmark, cb));
  check('paging reuses the session (no second home visit)', requests.length === 1, String(requests.length));
  check('the bookmark is sent back', decodeURIComponent(requests[0].url).indexOf(res.bookmark) !== -1);
  check('page 2 parsed', !page2.err && page2.res.pins.length === 4);
}

console.log('\n1b) Naming');
{
  const c = client();
  check('accents and spaces kept, slashes, colons, emoji and handles dropped',
        c.fileNameFor('Déco: salon / cuisine 🍽 par @moi', '123456789012345678') === 'Déco salon cuisine par moi_123456789012345678.mp4', c.fileNameFor('Déco: salon / cuisine 🍽 par @moi', '123456789012345678'));
  check('empty title falls back to "pinterest"', c.fileNameFor('', '1') === 'pinterest_1.mp4');
  check('very long titles are cut', c.fileNameFor('x'.repeat(200), '1').length < 80);
  check('the Organizer\'s b-roll rule matches the result', /_(\d{15,19})(?:_\d{1,3})?$/.test(c.fileNameFor('Kitchen', '771874823639535801').replace(/\.mp4$/, '')));
}

// ================================================================ 2) download CMAF
console.log('\n2) Saving a modern (CMAF) video: video + audio files, joined by ffmpeg');
{
  const c = client();
  const { res: s } = await wait((cb) => c.search('cuisine', null, cb));
  const p = s.pins[0];
  spawned.length = 0;
  const steps = [];
  const { err, res } = await wait((cb) => c.download(p, DIR + '/Pinterest', (f, label) => steps.push([Math.round(f * 100), label]), cb));
  check('no error', !err, err && err.message);
  check('the file is where the panel expects it', res && res.path === DIR + '/Pinterest/' + p.fileName, res && res.path);
  check('ffmpeg was called once, copy mode, with video then audio', spawned.length === 1 && spawned[0].bin === '/opt/homebrew/bin/ffmpeg' &&
        spawned[0].args.indexOf('copy') !== -1 && spawned[0].args.filter((a) => a === '-i').length === 2, spawned.length && spawned[0].args.join(' '));
  check('the best rendition (720w) was chosen, not the first listed (240w)', spawned[0].args.some((a) => /\.video$/.test(a)) && requests.some((r) => r.url.endsWith('_720w.m3u8')) && !requests.some((r) => r.url.endsWith('_240w.m3u8')));
  const out = fs.readFileSync(res.path);
  check('the output holds both streams', out.length === 6 + 5000 + 800, String(out.length));
  check('progress went from 0 to 100 with labels', steps[0][0] === 0 && steps[steps.length - 1][0] === 100 && steps.some((s) => /audio/.test(s[1])),
        steps.map((s) => s.join(':')).join(' '));
  check('temp files are gone', !fs.existsSync(DIR + '/Pinterest/.pqd-tmp/' + p.id + '.video') && !fs.existsSync(DIR + '/Pinterest/.pqd-tmp/' + p.id + '.part.mp4'));

  const again = await wait((cb) => c.download(p, DIR + '/Pinterest', null, cb));
  check('saving it again is a no-op that reports the existing file', !again.err && again.res.existed === true);
}

// ================================================================ 3) progressive
console.log('\n3) A progressive mp4 is saved as-is, no ffmpeg');
{
  const c = client();
  const { res: s } = await wait((cb) => c.search('cuisine', null, cb));
  const p = s.pins[3];
  spawned.length = 0;
  const { err, res } = await wait((cb) => c.download(p, DIR + '/Pinterest', null, cb));
  check('saved', !err && fs.readFileSync(res.path, 'utf8') === 'PROGRESSIVE-MP4', err && err.message);
  check('ffmpeg not involved', spawned.length === 0);
}

// ================================================================ 4) failures
console.log('\n4) Every failure is a sentence');
{
  const c = client();
  mode.search = 403;
  let r = await wait((cb) => c.search('x', null, cb));
  check('403 → "refused… wait a minute"', r.err && /refused/.test(r.err.message) && /wait/.test(r.err.message), r.err && r.err.message);
  mode.search = 200; mode.notJson = true;
  r = await wait((cb) => c.search('x', null, cb));
  check('HTML instead of JSON → says the endpoint may have changed', r.err && /not JSON/.test(r.err.message), r.err && r.err.message);
  mode.notJson = false;

  const noFf = client({ ffmpeg: false });
  const { res: s } = await wait((cb) => noFf.search('cuisine', null, cb));
  fs.rmSync(DIR + '/Pinterest', { recursive: true, force: true });
  r = await wait((cb) => noFf.download(s.pins[0], DIR + '/Pinterest', null, cb));
  check('no ffmpeg → says how to install it', r.err && /brew install ffmpeg/.test(r.err.message), r.err && r.err.message);

  mode.cdn = 403;
  const c2 = client();
  const s2 = await wait((cb) => c2.search('cuisine', null, cb));
  r = await wait((cb) => c2.download(s2.res.pins[0], DIR + '/Pinterest', null, cb));
  check('an unreadable playlist is reported', r.err && /playlist/.test(r.err.message), r.err && r.err.message);
  mode.cdn = 200;

  const bad = client({ spawn: (bin, args) => fakeSpawn('/bad/ffmpeg', args) });
  const s3 = await wait((cb) => bad.search('cuisine', null, cb));
  r = await wait((cb) => bad.download(s3.res.pins[0], DIR + '/Pinterest', null, cb));
  check('an ffmpeg failure quotes its last line', r.err && /Invalid data found/.test(r.err.message), r.err && r.err.message);
  check('…and leaves no partial file behind', !fs.existsSync(DIR + '/Pinterest/' + s3.res.pins[0].fileName) && !fs.existsSync(DIR + '/Pinterest/.pqd-tmp/' + s3.res.pins[0].id + '.video'));
}

// ================================================================ 5) playlist parser
console.log('\n5) Playlist reader');
{
  const t = client()._test;
  const m = t.parsePlaylist(master, CDN + HASH + '.m3u8');
  check('variants sorted best first', m.variants[0].height === 1280 && m.variants[0].url.endsWith('_720w.m3u8'));
  check('audio group resolved to an absolute URL', m.audio.audio1 === CDN + HASH + '_audio.m3u8', m.audio.audio1);
  const md = t.parsePlaylist(media('720w.cmfv'), CDN + HASH + '_720w.m3u8');
  check('EXT-X-MAP gives the whole-file URI', md.map === CDN + HASH + '_720w.cmfv', md.map);
}

// ================================================================ 6) any computer
console.log('\n6) ffmpeg on Windows (2.6.0)');
{
  const mk = (exists, env) => create({ https: fakeHttps(), spawn: fakeSpawn, now: () => 1000, path: path.win32, platform: 'win32', env,
                                       fs: { existsSync: (p) => exists.includes(p), mkdirSync() {} } });
  const winget = 'C:\\Users\\ana\\AppData\\Local\\Microsoft\\WinGet\\Links\\ffmpeg.exe';
  check('installed with winget → found', mk([winget], { LOCALAPPDATA: 'C:\\Users\\ana\\AppData\\Local', PATH: 'C:\\Windows' }).findFfmpeg() === winget);
  check('ffmpeg.exe on the PATH (";"-separated) → found', mk(['D:\\tools\\ffmpeg.exe'], { PATH: 'C:\\Windows;D:\\tools' }).findFfmpeg() === 'D:\\tools\\ffmpeg.exe');
  const none = mk([], { PATH: 'C:\\Windows' });
  check('nothing installed → not found', none.findFfmpeg() === null);
  const { res: s } = await wait((cb) => none.search('cuisine', null, cb));
  const r = await wait((cb) => none.download(s.pins[0], 'C:\\Users\\ana\\Downloads\\Pinterest', null, cb));
  check('no ffmpeg on Windows → says how to install it with winget', r.err && /winget install -e --id Gyan\.FFmpeg/.test(r.err.message), r.err && r.err.message);
}

fs.rmSync(DIR, { recursive: true, force: true });
console.log(`\n${failed ? failed + ' failure(s)' : 'the Pinterest client behaves'}\n`);
process.exit(failed ? 1 : 0);
