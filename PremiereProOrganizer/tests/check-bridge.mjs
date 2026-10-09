/**
 *   node tests/check-bridge.mjs
 *
 * Runs the REAL panel script in a stubbed CEP environment against a REAL temp
 * folder, and simulates how a browser actually writes a download: a .crdownload
 * that grows, then a rename.
 *
 * This is the part that cannot be reasoned about safely — importing one tick
 * too early hands Premiere a truncated file and a permanently offline clip.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..') + '/';
const html = fs.readFileSync(ROOT + 'index.html', 'utf8');
const script = /<script type="text\/javascript">([\s\S]*?)<\/script>/.exec(html)[1];

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'pqd-bridge-'));
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'pqd-home-'));

let failed = 0;
const check = (name, ok, detail = '') => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '   -> ' + detail : ''}`);
  if (!ok) failed++;
};

// ---- stubbed CEP / DOM ------------------------------------------------------

const store = {};
const els = {};
function el(id) {
  if (!els[id]) {
    els[id] = {
      id,
      value: '',
      checked: false,
      textContent: '',
      innerHTML: '',
      className: '',
      disabled: false,
      hidden: false,
      style: {},
      classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
      addEventListener(type, fn) {
        (this._h = this._h || {})[type] = fn;
      },
      fire(type) {
        if (this._h && this._h[type]) this._h[type]();
      },
      querySelector: () => null,
      appendChild() {},
      removeChild() {}
    };
  }
  return els[id];
}

let jsxReply = null;
const jsxCalls = [];

const sandbox = {
  console,
  JSON,
  Object,
  Math,
  Date,
  RegExp,
  String,
  Number,
  Boolean,
  Array,
  Error,
  parseInt,
  parseFloat,
  isNaN,
  setTimeout: (fn) => { if (typeof fn === 'function') fn(); return 0; },
  clearTimeout: () => {},
  setInterval: () => 0, // ticks are driven by hand below
  clearInterval: () => {},
  // A home folder of its own: with the real one, the panel restored the
  // owner's settings file and watched his real Downloads/Pinterest.
  require: (m) => (m === 'fs' ? fs : m === 'os' ? { homedir: () => HOME, platform: () => process.platform } : null),
  localStorage: {
    getItem: (k) => (k in store ? store[k] : null),
    setItem: (k, v) => { store[k] = String(v); },
    removeItem: (k) => { delete store[k]; }
  },
  document: {
    getElementById: el,
    addEventListener() {},
    createElement: () => el('__tmp__'),
    body: el('__body__')
  },
  window: {},
  CSInterface: function () {
    this.getSystemPath = () => ROOT.replace(/\/$/, '');
    this.evalScript = (code, cb) => {
      // Only a real import counts. The panel also evalFiles the script, polls
      // the project signature, and probes `typeof importWatched` at startup —
      // counting those as imports made every assertion below off by one.
      if (code.indexOf('IsmaOrganizer.importWatched(') !== 0) {
        return cb(code === 'typeof IsmaOrganizer.importWatched' ? 'function' : '');
      }
      jsxCalls.push(code);
      cb(jsxReply);
    };
  },
  SystemPath: { EXTENSION: 'extension' }
};
vm.createContext(sandbox);
new vm.Script(script).runInContext(sandbox);

el('f-watch-dir').value = DIR;
el('f-watch-images').checked = true;
el('f-color-labels').checked = true;
el('f-broll').value = '03 b-roll';
el('f-images').value = '05 screenshots';
el('f-other').value = '09 other';

const status = () => el('bridge-status').innerHTML;
const seen = () => Object.keys(sandbox.bridge.seen);
const write = (name, bytes) => fs.writeFileSync(path.join(DIR, name), Buffer.alloc(bytes, 1));
const tick = () => sandbox.bridgeTick();
const ok = (extra) =>
  JSON.stringify({ imported: 1, skipped: 0, failed: 0, noProject: false, byCat: { broll: 1 }, ...extra });
const noProject = JSON.stringify({ imported: 0, skipped: 0, failed: 0, noProject: true, byCat: {} });

console.log('\n1) Switching it on leaves the folder alone');
write('old-clip_771874823639535801.mp4', 5000);
write('old-photo_771874823639535802.jpg', 4000);
write('unrelated.txt', 100);

el('f-bridge-enabled').checked = true;
sandbox.startBridge(true);

check('the two existing media are marked seen', seen().length === 2, seen().length + ' seen');
check('the .txt was never considered', !seen().some((p) => p.endsWith('.txt')));
check('nothing was imported', jsxCalls.length === 0, jsxCalls.length + ' call(s)');
check('and it says so', /already there left alone/.test(status()), status().replace(/<[^>]+>/g, ''));

console.log('\n2) A download in progress is never imported early');
jsxReply = ok();

write('new-broll_771874823639535803.mp4.crdownload', 200000);
tick();
check('the .crdownload is ignored', jsxCalls.length === 0);

write('new-broll_771874823639535803.mp4.crdownload', 900000); // still growing
tick();
check('still ignored while growing', jsxCalls.length === 0);

fs.renameSync(
  path.join(DIR, 'new-broll_771874823639535803.mp4.crdownload'),
  path.join(DIR, 'new-broll_771874823639535803.mp4')
);

tick();
check('first tick after the rename only records the size', jsxCalls.length === 0, 'waiting for a stable size');

tick();
check('second tick with an unchanged size imports it', jsxCalls.length === 1, jsxCalls.length + ' call(s)');

const payload = JSON.parse(JSON.parse(/importWatched\((.*)\)$/s.exec(jsxCalls[0])[1]));
check('the images bin name is the organizer\'s, not a second default',
      payload.names.images === '05 screenshots', payload.names.images);
check(
  'exactly the new file was sent',
  payload.paths.length === 1 && payload.paths[0].endsWith('new-broll_771874823639535803.mp4'),
  payload.paths.join(', ')
);
check('the bin names came from the panel fields', payload.names.broll === '03 b-roll', JSON.stringify(payload.names));
check('the colour-label setting is passed through', payload.colorLabels === true);
check('it is now marked seen', seen().length === 3, seen().length + ' seen');

tick();
check('it is not imported a second time', jsxCalls.length === 1);

console.log('\n3) With no project open, the file waits instead of being dropped');
jsxReply = noProject;
write('later_771874823639535804.mp4', 7000);
tick();
tick();
check('an import was attempted', jsxCalls.length === 2, jsxCalls.length + ' call(s)');
check('the file was NOT marked seen', seen().length === 3, seen().length + ' seen');
check('the status explains the wait', /no project open/.test(status()), status().replace(/<[^>]+>/g, ''));

jsxReply = ok();
tick();
check('it is picked up as soon as a project is open', jsxCalls.length === 3);
check('and only then marked seen', seen().length === 4, seen().length + ' seen');

console.log('\n4) The images switch is honoured');
el('f-watch-images').checked = false;
write('a-photo_771874823639535805.jpg', 3000);
tick();
tick();
check('the .jpg is not imported', jsxCalls.length === 3, jsxCalls.length + ' call(s)');

el('f-watch-images').checked = true;
write('a-video_771874823639535806.mp4', 3000);
tick();
tick();
const last = JSON.parse(JSON.parse(/importWatched\((.*)\)$/s.exec(jsxCalls[jsxCalls.length - 1])[1]));
check('with images back on, both are picked up', last.paths.length === 2, last.paths.length + ' path(s)');

console.log('\n5) It stays out of the way of a manual run');
sandbox.isRunning = true;
write('during-a-run_771874823639535807.mp4', 3000);
const before = jsxCalls.length;
tick();
tick();
check('nothing is imported while the organizer is running', jsxCalls.length === before);
sandbox.isRunning = false;
tick();
tick();
check('and it resumes once the run is over', jsxCalls.length === before + 1);

console.log('\n6) The old Downloads/Pinterest is still watched (2.7.2)');
// Since 2.7.2 the panel saves into its own folder. Someone who used
// Downloads/Pinterest keeps it (settings migration → 'broll-old-dir'): what a
// browser extension still drops there is imported too.
const OLD = fs.mkdtempSync(path.join(os.tmpdir(), 'pqd-old-'));
store['broll-old-dir'] = OLD;
fs.writeFileSync(path.join(OLD, 'from-chrome_771874823639535808.mp4'), Buffer.alloc(3000, 1));
const beforeOld = jsxCalls.length;
tick();
tick();
const fromOld = jsxCalls.length > beforeOld ? JSON.parse(JSON.parse(/importWatched\((.*)\)$/s.exec(jsxCalls[jsxCalls.length - 1])[1])) : { paths: [] };
check('a file landing in the old folder is imported', fromOld.paths.length === 1 && fromOld.paths[0] === path.join(OLD, 'from-chrome_771874823639535808.mp4'), fromOld.paths.join(', '));
delete store['broll-old-dir'];
fs.rmSync(OLD, { recursive: true, force: true });

fs.rmSync(DIR, { recursive: true, force: true });
fs.rmSync(HOME, { recursive: true, force: true });
console.log(`\n${failed ? failed + ' failure(s)' : 'the bridge behaves'}\n`);
process.exit(failed ? 1 : 0);
