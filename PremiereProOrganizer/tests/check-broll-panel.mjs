/**
 *   node tests/check-panel.mjs
 *
 * Runs the REAL panel script in a stubbed CEP environment against a REAL
 * folder, and checks what it finds, what it filters, and what it would send to
 * Premiere. The panel only ever runs inside Premiere, where a mistake shows up
 * as a blank grid with no message at all.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..') + '/';
const html = fs.readFileSync(ROOT + 'index.html', 'utf8');
const script = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1])[0];
const jsx = fs.readFileSync(ROOT + 'ImportBroll.jsx', 'utf8');

let failed = 0;
const check = (name, ok, detail = '') => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '   -> ' + detail : ''}`);
  if (!ok) failed++;
};

// ---- a folder that looks like the real thing -------------------------------

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'broll-'));
fs.mkdirSync(DIR + '/Downloads/Pinterest/Video', { recursive: true });
fs.mkdirSync(DIR + '/Downloads/Pinterest/Images', { recursive: true });
const put = (rel, bytes) => fs.writeFileSync(DIR + '/Downloads/Pinterest/' + rel, Buffer.alloc(bytes, 1));
put('Video/sunset-beach_771874823639535801.mp4', 4_000_000);
put('Video/city-night_771874823639535802.mp4', 9_000_000);
put('Video/still-writing.mp4.crdownload', 1_000);
put('Images/moodboard_771874823639535803.jpg', 300_000);
put('legacy-clip.mp4', 2_000_000);
put('notes.txt', 100);
fs.writeFileSync(DIR + '/Downloads/Pinterest/.DS_Store', 'x');
// Since 2.7.2 the panel saves into its own folder; Downloads/Pinterest is the
// folder of someone who used it before (the settings migration remembers it in
// 'broll-old-dir'), still listed, never written to.
const APP = DIR + '/Library/Application Support/IsmaOrganizer/B-roll';
const store = { 'broll-old-dir': DIR + '/Downloads/Pinterest' };
const opened = [];

// ---- stubs -----------------------------------------------------------------

const els = {};
function makeEl(id) {
  const node = {
    id, value: '', checked: false, innerHTML: '', className: '',
    disabled: false, title: '', style: {}, children: [], isConnected: true,
    hidden: false,
    classList: {
      _s: {},
      add(c) { this._s[c] = true; }, remove(c) { delete this._s[c]; },
      toggle(c, on) { if (on === undefined) on = !this._s[c]; if (on) this._s[c] = true; else delete this._s[c]; return !!on; },
      contains(c) { return !!this._s[c]; }
    },
    querySelector() { return null; },
    scrollIntoView() {},
    appendChild(c) { this.children.push(c); },
    addEventListener(t, fn) { (this._h = this._h || {})[t] = fn; },
    fire(t) { if (this._h && this._h[t]) this._h[t].call(this); },
    removeAttribute() {}, load() {}
  };
  // `render()` clears the grid with `textContent = ''`. A plain property kept
  // the stub's children array intact, so every re-render stacked cards on top
  // of the old ones and every count below was wrong.
  let text = '';
  Object.defineProperty(node, 'textContent', {
    get: () => text,
    set(v) { text = String(v); if (text === '') node.children = []; }
  });
  return node;
}
function el(id) {
  if (!els[id]) els[id] = makeEl(id);
  return els[id];
}
let anon = 0;
const makeNode = () => makeEl('__n' + ++anon);

const hostCalls = [];
let hostReply = null;

// Timers are collected, not run. flush(ms) fires only those due within that
// window, so a 140 ms debounce can be exercised without also tripping the 6 s
// thumbnail guards or the 15 s host timeout.
let timers = [];
let timerId = 0;
function flush(withinMs) {
  const due = timers.filter((t) => t.ms <= withinMs);
  timers = timers.filter((t) => t.ms > withinMs);
  due.forEach((t) => { try { t.fn(); } catch (e) {} });
  return due.length;
}

const sandbox = {
  console, JSON, Object, Math, Date, RegExp, String, Number, Boolean, Array, Error,
  parseInt, parseFloat, isNaN, encodeURIComponent, Buffer,
  setTimeout: (fn, ms) => { timers.push({ id: ++timerId, fn, ms }); return timerId; },
  clearTimeout: (id) => { timers = timers.filter((t) => t.id !== id); },
  setInterval: () => 0,
  require: (m) => (m === 'fs' ? Object.assign({}, fs, { watch: () => ({ close() {}, on() {} }) })
    : m === 'os' ? { homedir: () => DIR, platform: () => 'darwin' }
    : m === 'path' ? path
    : m === 'child_process' ? { execFile: (cmd, args) => { opened.push([cmd].concat(args || [])); } }
    : null),
  localStorage: { getItem: (k) => (k in store ? store[k] : null), setItem(k, v) { store[k] = String(v); }, removeItem(k) { delete store[k]; } },
  Image: function () { this.src = ''; },
  window: {},
  document: {
    getElementById: el,
    createElement: makeNode,
    createTextNode: (t) => ({ nodeValue: String(t) }),
    addEventListener() {}
  },
  CSInterface: function () {
    this.getSystemPath = () => ROOT.replace(/\/$/, '');
    this.evalScript = (code, cb) => {
      if (code.indexOf('$.evalFile') === 0) return cb('');
      hostCalls.push(code.replace(/^PQDBroll\./, ''));
      cb(hostReply);
    };
  },
  SystemPath: { EXTENSION: 'extension' }
};
sandbox.window = sandbox;
vm.createContext(sandbox);

console.log('\n1) The panel script loads and reads the folder');
hostReply = JSON.stringify({ ok: true, name: 'Test.prproj', paths: [] });
try {
  new vm.Script(script).runInContext(sandbox);
  check('the script runs without throwing', true);
} catch (e) {
  check('the script runs without throwing', false, e.message);
  console.log(`\n1 failure(s)\n`);
  process.exit(1);
}

// The IIFE keeps its state private, so read what it produced through the DOM.
const grid = el('grid');
const cardCount = () => grid.children.filter((c) => c.className && c.className.indexOf('card') === 0).length;

check('it found the media files', cardCount() === 4, cardCount() + ' cards');
check(
  'the partial download is ignored',
  !grid.children.some((c) => (c.title || '').indexOf('crdownload') !== -1)
);
check(
  'the .txt and the dotfile are ignored',
  !grid.children.some((c) => /\.txt$|DS_Store/.test(c.title || ''))
);
check('sub-folders are walked', grid.children.some((c) => /sunset-beach/.test(c.title || '')));
check('files at the folder root are found too', grid.children.some((c) => /legacy-clip/.test(c.title || '')));

check("cards are draggable", grid.children.filter((c) => c.title).every((c) => c.draggable === true),
  grid.children.filter((c) => c.title && c.draggable !== true).length + " not draggable");

console.log('\n2) Newest first');
const titles = grid.children.filter((c) => c.title).map((c) => c.title);
check('something is listed', titles.length === 4, titles.join(' | '));

console.log('\n3) Filtering');
el('bf-video').fire('click');
check('the video filter keeps only videos', cardCount() === 3, cardCount() + ' cards');
el('bf-image').fire('click');
check('the image filter keeps only images', cardCount() === 1, cardCount() + ' cards');
el('bf-all').fire('click');
check('back to all', cardCount() === 4, cardCount() + ' cards');

el('q').value = 'sunset';
el('q').fire('input');
check('typing alone does not rebuild the grid', cardCount() === 4, cardCount() + ' cards before the debounce');
check('the debounce is armed', flush(300) > 0);
check('search narrows the grid', cardCount() === 1, cardCount() + ' cards');
el('q').value = 'zzzz';
el('q').fire('input');
flush(300);
check('a search with no hit shows the empty state', cardCount() === 0);
el('q').value = '';
el('q').fire('input');
flush(300);

console.log('\n4) One click = one selection, opened large');
const cardFor = (re) => grid.children.filter((c) => re.test(c.title || ''))[0];
const lightbox = el('lightbox');
cardFor(/sunset-beach/).fire('click');
check('the lightbox opens', lightbox.hidden === false && lightbox.classList.contains('open'));
check('it names the clip by its readable title', el('lb-name').textContent === 'sunset beach', el('lb-name').textContent);
check('the info line keeps the real file name', /sunset-beach_771874823639535801\.mp4/.test(el('lb-info').textContent), el('lb-info').textContent);
check('a <video> was mounted on the stage', el('lb-stage').children.some((n) => n.controls === true && /sunset-beach/.test(n.src)),
  el('lb-stage').children.map((n) => n.src).join(' | '));
check('the card is selected', cardFor(/sunset-beach/).classList.contains('sel'));

cardFor(/city-night/).fire('click');
check('clicking another card moves the selection (no multi-select)',
  cardFor(/city-night/).classList.contains('sel') && !cardFor(/sunset-beach/).classList.contains('sel'));
check('the lightbox now shows the second clip', el('lb-name').textContent === 'city night', el('lb-name').textContent);

el('lb-close').fire('click');
check('✕ closes the lightbox and unmounts the video', lightbox.hidden === true && el('lb-stage').children.length === 0);

const search = (q) => { el('q').value = q; el('q').fire('input'); flush(300); };

console.log('\n5) Dragging hands Premiere exactly one file');
const dt = { data: {}, effectAllowed: '', setData(k, v) { this.data[k] = v; }, setDragImage() {} };
cardFor(/legacy-clip/)._h.dragstart.call(cardFor(/legacy-clip/), { dataTransfer: dt });
const keys = Object.keys(dt.data);
check('one com.adobe.cep.dnd.file.0 entry', keys.length === 1 && keys[0] === 'com.adobe.cep.dnd.file.0', keys.join(', '));
check('holding the absolute path of the dragged card', dt.data['com.adobe.cep.dnd.file.0'] === DIR + '/Downloads/Pinterest/legacy-clip.mp4', dt.data['com.adobe.cep.dnd.file.0']);
check('dragging selects the card', cardFor(/legacy-clip/).classList.contains('sel'));
check('the previously selected card is released', !cardFor(/city-night/).classList.contains('sel'));
check('the status says what is being dragged', /Dragging/.test(el('status').textContent), el('status').textContent);
check('the grid is frozen while the drag is in flight', (() => { search('sunset'); const frozen = cardCount() === 4; return frozen; })());
cardFor(/legacy-clip/)._h.dragend.call(cardFor(/legacy-clip/), { dataTransfer: { dropEffect: 'copy' } });
check('…and catches up once the drop lands', cardCount() === 1, cardCount() + ' cards');
search('');

// From the lightbox frame too
cardFor(/moodboard/).fire('click');
const dt2 = { data: {}, effectAllowed: '', setData(k, v) { this.data[k] = v; }, setDragImage() {} };
el('lb-frame')._h.dragstart.call(el('lb-frame'), { dataTransfer: dt2, target: { tagName: 'IMG' } });
check('the lightbox frame drags the clip it shows', dt2.data['com.adobe.cep.dnd.file.0'] === DIR + '/Downloads/Pinterest/Images/moodboard_771874823639535803.jpg', dt2.data['com.adobe.cep.dnd.file.0']);
el('lb-frame')._h.dragend.call(el('lb-frame'), { dataTransfer: { dropEffect: 'none' } });
check('a cancelled drag is reported as such', /cancelled/i.test(el('status').textContent), el('status').textContent);
const dt3 = { data: {}, setData(k, v) { this.data[k] = v; }, setDragImage() {} };
let prevented = false;
el('lb-frame')._h.dragstart.call(el('lb-frame'), { dataTransfer: dt3, target: { tagName: 'VIDEO', clientHeight: 400 }, offsetY: 390, preventDefault() { prevented = true; } });
check('a drag started on the video controls strip is left to the scrub bar', prevented && !dt3.data['com.adobe.cep.dnd.file.0']);
el('lb-close').fire('click');

console.log('\n6) Search: every word must match, in any order');
search('beach sunset');
check('"beach sunset" finds sunset-beach', cardCount() === 1 && !!cardFor(/sunset-beach/), cardCount() + ' cards');
search('sunset city');
check('"sunset city" matches nothing (both words required)', cardCount() === 0, cardCount() + ' cards');
search('7718748236395358');
check('the Pin id still works as a search', cardCount() === 3, cardCount() + ' cards');
search('');
check('cards show the readable title, not the raw file name',
  grid.children.some((c) => c.children.some((m) => m.className === 'meta' && m.children.some((n) => n.textContent === 'sunset beach'))));

console.log('\n6b) "In project" is a badge, never a dimmed tile');
hostReply = JSON.stringify({ ok: true, name: 'Test.prproj', paths: [(DIR + '/Downloads/Pinterest/legacy-clip.mp4').toLowerCase()] });
el('refresh').fire('click');
const legacy = cardFor(/legacy-clip/);
check('the imported clip carries the badge', legacy.children.some((n) => n.className === 'badge have' && /in project/.test(n.textContent)));
check('…and is not dimmed', legacy.className.indexOf('inproject') === -1, legacy.className);
check('…and is still draggable', legacy.draggable === true);
check('the count line reports it', /1<\/b> in project/.test(el('status').innerHTML), el('status').innerHTML);

console.log('\n6b2) A host that does not answer keeps the last badges');
hostReply = 'EvalScript error.';
el('refresh').fire('click');
check('the badge survived the failed refresh', cardFor(/legacy-clip/).children.some((n) => n.className === 'badge have'));
check('the warning is visible after the render', /host script failed|did not answer/i.test(el('status').textContent), el('status').textContent);
hostReply = JSON.stringify({ ok: true, name: 'Test.prproj', paths: [(DIR + '/Downloads/Pinterest/legacy-clip.mp4').toLowerCase()] });

console.log('\n6c) Thumbnails are cached on disk between sessions');
const cacheDir = DIR + '/Library/Caches/PinterestBroll';
check('the cache folder was created under the home folder', fs.existsSync(cacheDir), cacheDir);

console.log('\n8) Pinterest mode: search, save on click, then drag');
const fakeCalls = { search: [], download: [] };
sandbox.__PQDPinterest = {
  search(q, bookmark, cb) {
    fakeCalls.search.push({ q, bookmark });
    const pins = [
      { id: '771874823639535899', title: 'Cozy kitchen morning', thumb: 'https://i.pinimg.com/474x/aa.jpg', width: 720, height: 1280, durationMs: 21633, pinner: 'someone', color: '#80644d', mp4: '', hls: 'https://v1.pinimg.com/x.m3u8', fileName: 'Cozy kitchen morning_771874823639535899.mp4' },
      { id: '771874823639535801', title: 'Sunset beach (already here)', thumb: 'https://i.pinimg.com/474x/bb.jpg', width: 720, height: 1280, durationMs: 5000, pinner: 'other', color: '', mp4: '', hls: 'https://v1.pinimg.com/y.m3u8', fileName: 'sunset-beach_771874823639535801.mp4' }
    ];
    cb(null, { pins, bookmark: bookmark ? null : 'BOOKMARK-2' });
  },
  download(pin, dir, onProgress, cb) {
    fakeCalls.download.push({ id: pin.id, dir });
    onProgress(0.42, 'downloading video');
    const out = dir + '/' + pin.fileName;
    fs.writeFileSync(out, Buffer.alloc(1234, 1));
    cb(null, { path: out });
  }
};
// the panel already loaded: the client is picked up lazily on first use
el('m-pin').fire('click');
check('switching modes shows the Pinterest row and hides the local one', el('row-pin').hidden === false && el('row-local').hidden === true && el('pgrid').hidden === false && grid.hidden === true);
el('pq').value = 'cuisine moderne';
el('pq')._h.keydown.call(el('pq'), { key: 'Enter', preventDefault() {} });
check('Enter runs the search', fakeCalls.search.length === 1 && fakeCalls.search[0].q === 'cuisine moderne', JSON.stringify(fakeCalls.search));
const pcards = () => el('pgrid').children.filter((c) => /card pin/.test(c.className || ''));
check('results rendered as tiles', pcards().length === 2, pcards().length + ' tiles');
const cozy = pcards()[0], beach = pcards()[1];
check('the tile shows the title', cozy.children.some((m) => m.className === 'meta' && m.children.some((n) => n.textContent === 'Cozy kitchen morning')));
check('a result already in the downloads folder is marked saved and draggable',
  beach.classList.contains('saved') && beach.draggable === true, beach.className);
check('a new result says "save" and is not draggable', !cozy.classList.contains('saved') && cozy.draggable === false);
check('the status counts results', /2<\/b> video/.test(el('status').innerHTML) && /1<\/b> saved/.test(el('status').innerHTML), el('status').innerHTML);

cozy.fire('click');
check('clicking saves into the panel\'s own folder, not Downloads', fakeCalls.download.length === 1 && fakeCalls.download[0].dir === APP, JSON.stringify(fakeCalls.download));
check('the tile is now saved and draggable', cozy.classList.contains('saved') && cozy.draggable === true, cozy.className);
check('the status says to drag it', /drag/i.test(el('status').textContent), el('status').textContent);
check('the file shows up in the local list too', grid.children.some((c) => /Cozy kitchen morning/.test(c.title || '')));
const dtp = { data: {}, setData(k, v) { this.data[k] = v; }, setDragImage() {} };
cozy._h.dragstart.call(cozy, { dataTransfer: dtp, preventDefault() {} });
check('dragging the saved tile hands Premiere the local path', dtp.data['com.adobe.cep.dnd.file.0'] === APP + '/Cozy kitchen morning_771874823639535899.mp4', dtp.data['com.adobe.cep.dnd.file.0']);
cozy._h.dragend.call(cozy, { dataTransfer: { dropEffect: 'copy' } });
cozy.fire('click');
check('clicking a saved tile opens it large instead of downloading again', fakeCalls.download.length === 1 && el('lightbox').hidden === false && el('lb-name').textContent === 'Cozy kitchen morning', el('lb-name').textContent);
el('lb-close').fire('click');

// paging: scrolling near the bottom asks for the next page with the bookmark
const pg = el('pgrid'); pg.scrollTop = 900; pg.clientHeight = 500; pg.scrollHeight = 1500;
pg.fire('scroll');
check('scrolling to the bottom loads the next page with the bookmark', fakeCalls.search.length === 2 && fakeCalls.search[1].bookmark === 'BOOKMARK-2', JSON.stringify(fakeCalls.search[1]));
check('duplicates across pages are not shown twice', pcards().length === 2, pcards().length + ' tiles');
pg.fire('scroll');
check('no bookmark left → no further request', fakeCalls.search.length === 2);

el('m-local').fire('click');
check('back to the local list', grid.hidden === false && el('pgrid').hidden === true);

console.log('\n9) The panel\'s own folder, and the Folder button (2.7.2)');
check('the panel made its own folder', fs.existsSync(APP), APP);
check('a video saved before in Downloads/Pinterest is still listed', grid.children.some((c) => /sunset-beach/.test(c.title || '')));
check('nothing new was written to Downloads/Pinterest', !fs.existsSync(DIR + '/Downloads/Pinterest/Cozy kitchen morning_771874823639535899.mp4'));
el('open-dir').fire('click');
check('the Folder button shows that folder in the Finder', opened.length === 1 && opened[0][0] === 'open' && opened[0][1] === APP, JSON.stringify(opened));

console.log('\n7) The host script actually holds together');

// Regex-matching three function names was not a test. Truncating the file to
// drop every helper still passed it, while projectMedia() then returned
// ok:true with an empty list — so the panel believed the project was empty and
// happily re-imported everything. Evaluate the file instead.
check('ImportBroll.jsx parses', (() => { try { new vm.Script(jsx); return true; } catch (e) { return false; } })());
check('ImportBroll.jsx is not truncated', jsx.length > 6000, jsx.length + ' bytes');

const hostBox = { app: {}, $: {} };
vm.createContext(hostBox);
try { new vm.Script(jsx).runInContext(hostBox); } catch (e) { /* reported below */ }

check('it exposes exactly one global',
  Object.keys(hostBox).filter((k) => k !== 'app' && k !== '$').join(',') === 'PQDBroll',
  Object.keys(hostBox).filter((k) => k !== 'app' && k !== '$').join(', '));

// The shared ExtendScript engine is why this matters: a bare top-level name
// here can silently replace the sibling panel's function of the same name.
const sibling = ROOT + 'OrganizeFilesInProject.jsx';   // same folder since 2.6.0
if (fs.existsSync(sibling)) {
  const theirs = new Set([...fs.readFileSync(sibling, 'utf8')
    .matchAll(/^function\s+(\w+)/gm)].map((m) => m[1]));
  const ours = [...jsx.matchAll(/^function\s+(\w+)/gm)].map((m) => m[1]);
  const clash = ours.filter((f) => theirs.has(f));
  check('no top-level name collides with Isma Organizer', clash.length === 0, clash.join(', ') || ours.length + ' top-level function(s)');
}

['projectMedia'].forEach((fn) => {
  check(`PQDBroll.${fn}() is callable`, !!(hostBox.PQDBroll && typeof hostBox.PQDBroll[fn] === 'function'));
});

console.log('\n8) Any computer, not just this Mac (2.6.0)');
{
  // The functions that touch the system, lifted out of the panel script and
  // run against a fake Windows and a fake fresh Mac.
  const fnSrc = (name) => {
    const i = script.indexOf('function ' + name + '(');
    if (i < 0) return '';
    let d = 0;
    for (let k = script.indexOf('{', i); k < script.length; k++) {
      if (script[k] === '{') d++;
      else if (script[k] === '}' && --d === 0) return script.slice(i, k + 1);
    }
    return '';
  };
  const lift = (globals) => {
    const box = Object.assign({}, globals);
    vm.createContext(box);
    new vm.Script('var TAG_PY;\n' + ['pjoin', 'platform', 'env', 'appDir', 'oldDir', 'pkey', 'rootDirs', 'rootDir', 'fileUrl', 'thumbCacheBase', 'tagPython'].map(fnSrc).join('\n')).runInContext(box);
    return box;
  };
  const win = lift({ path: path.win32, os: { homedir: () => 'C:\\Users\\ana', platform: () => 'win32' },
                     localStorage: { getItem: (k) => (k === 'broll-old-dir' ? 'C:\\Users\\ana\\Downloads\\Pinterest' : null) },
                     process: { platform: 'win32', env: { LOCALAPPDATA: 'C:\\Users\\ana\\AppData\\Local' } },
                     fs: { existsSync: () => true } });
  check('Windows: the panel\'s own folder, in AppData\\Local', win.rootDir() === 'C:\\Users\\ana\\AppData\\Local\\IsmaOrganizer\\B-roll', win.rootDir());
  check('Windows: a file path becomes a file:/// URL the player can open',
        win.fileUrl('C:\\Users\\ana\\Downloads\\Pinterest\\a b.mp4') === 'file:///C:/Users/ana/Downloads/Pinterest/a%20b.mp4',
        win.fileUrl('C:\\Users\\ana\\Downloads\\Pinterest\\a b.mp4'));
  check('Windows: thumbnails cached in AppData\\Local', win.thumbCacheBase() === 'C:\\Users\\ana\\AppData\\Local\\IsmaOrganizer\\BrollThumbs', win.thumbCacheBase());
  check('Windows: no Finder tag attempted', win.tagPython() === '');
  check('Windows, someone who used Downloads/Pinterest: both folders listed', win.rootDirs().length === 2 && win.rootDirs()[1] === 'C:\\Users\\ana\\Downloads\\Pinterest', JSON.stringify(win.rootDirs()));

  const freshMac = lift({ path: path.posix, os: { homedir: () => '/Users/lea', platform: () => 'darwin' },
                          process: { platform: 'darwin', env: {} }, fs: { existsSync: () => false } });
  check('a Mac without developer tools: no python call, so no "install developer tools" window', freshMac.tagPython() === '');
  check('Mac: thumbnails in the same cache folder as before', freshMac.thumbCacheBase() === '/Users/lea/Library/Caches/PinterestBroll', freshMac.thumbCacheBase());
  check('Mac: file URL', freshMac.fileUrl('/Users/lea/Downloads/Pinterest/a b.mp4') === 'file:///Users/lea/Downloads/Pinterest/a%20b.mp4');
  check('Mac: the panel\'s own folder, out of sight in Library', freshMac.rootDir() === '/Users/lea/Library/Application Support/IsmaOrganizer/B-roll', freshMac.rootDir());
  check('a new user: only that folder, Downloads is never read', freshMac.rootDirs().length === 1, JSON.stringify(freshMac.rootDirs()));
  const brewMac = lift({ path: path.posix, os: { homedir: () => '/Users/lea', platform: () => 'darwin' },
                         process: { platform: 'darwin', env: {} }, fs: { existsSync: (p) => p === '/opt/homebrew/bin/python3' } });
  check('a Mac with Homebrew python tags with it', brewMac.tagPython() === '/opt/homebrew/bin/python3', brewMac.tagPython());
}

fs.rmSync(DIR, { recursive: true, force: true });
console.log(`\n${failed ? failed + ' failure(s)' : 'the b-roll panel behaves'}\n`);
process.exit(failed ? 1 : 0);
