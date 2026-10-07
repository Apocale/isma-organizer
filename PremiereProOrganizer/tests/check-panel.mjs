/**
 *   node tests/check-panel.mjs
 *
 * Static checks on the panel. It only ever runs inside Premiere, where a syntax
 * error shows up as a blank panel with no message at all — so these run here.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..') + '/';

let failed = 0;
const check = (name, ok, detail = '') => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '   -> ' + detail : ''}`);
  if (!ok) failed++;
};

const html = fs.readFileSync(ROOT + 'index.html', 'utf8');
const jsx = fs.readFileSync(ROOT + 'OrganizeFilesInProject.jsx', 'utf8');

console.log('\n1) Both files parse');
const blocks = [...html.matchAll(/<script type="text\/javascript">([\s\S]*?)<\/script>/g)].map((m) => m[1]);
check('one inline script block found', blocks.length === 1, blocks.length + ' block(s)');
try {
  new vm.Script(blocks[0]);
  check('the panel script parses', true, blocks[0].split('\n').length + ' lines');
} catch (e) {
  check('the panel script parses', false, e.message);
}
try {
  new vm.Script(jsx);
  check('the ExtendScript parses', true, jsx.split('\n').length + ' lines');
} catch (e) {
  check('the ExtendScript parses', false, e.message);
}

console.log('\n2) Markup and script agree');
const presentIds = [...html.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]);
const readIds = [
  ...new Set(
    [...blocks[0].matchAll(/getElementById\(\s*'([^']+)'\s*\)/g)]
      .map((m) => m[1])
      .concat([...blocks[0].matchAll(/\b(?:val|checked)\(\s*'([^']+)'\s*\)/g)].map((m) => m[1]))
  )
];
const missing = readIds.filter((id) => !presentIds.includes(id));
check('no id is read that the markup lacks', missing.length === 0, missing.join(', ') || readIds.length + ' ids');

const keyList = (name) =>
  JSON.parse('[' + new RegExp('var ' + name + ' = \\[([\\s\\S]*?)\\];').exec(blocks[0])[1].replace(/'/g, '"') + ']');
const persisted = keyList('TEXT_KEYS').concat(keyList('CHECK_KEYS'));
const keysMissing = persisted.filter((id) => !presentIds.includes(id));
check('every persisted field exists', keysMissing.length === 0, keysMissing.join(', ') || persisted.length + ' fields');
['f-bridge-enabled', 'f-watch-dir', 'f-watch-images', 'f-auto-sequences', 'f-seq-patterns', 'f-nested-patterns'].forEach((id) => {
  check(`${id} is persisted`, persisted.includes(id));
});

// The user's sequence rules must reach the host, in every run the panel makes.
{
  const bp = /function buildPayload\(mode\) \{[\s\S]*?\n        \}/.exec(blocks[0]);
  check('the sequence rules are sent to the host', !!bp && /seqPatterns:\s*splitList\(val\('f-seq-patterns'\)\)/.test(bp[0]) &&
        /nestedPatterns:\s*splitList\(val\('f-nested-patterns'\)\)/.test(bp[0]));
}

console.log('\n2a) One panel, two tabs (2.6.0: Pinterest B-roll merged in)');
{
  const ids = [...html.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]);
  const dup = ids.filter((id, i) => ids.indexOf(id) !== i);
  check('every id is unique across both tabs', dup.length === 0, dup.join(', ') || ids.length + ' ids');
  ['tab-btn-organize', 'tab-btn-broll', 'tab-organize', 'tab-broll', 'grid', 'lightbox', 'organize-btn'].forEach((id) => {
    check(`#${id} is in the page`, ids.includes(id));
  });
  const plain = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
  check('the B-roll script is the one plain <script>, private in its own function',
        plain.length === 1 && /^\s*\(function \(\) \{/.test(plain[0]) && /PQDBroll/.test(plain[0]));
  check('…and it comes after the organizer script', html.indexOf('<script>') > html.indexOf('<script type="text/javascript">\n'));
  const tabsJs = /<script data-part="tabs">([\s\S]*?)<\/script>/.exec(html);
  check('the tab switch script exists and parses', !!tabsJs && (() => { try { new vm.Script(tabsJs[1]); return true; } catch (e) { return false; } })());

  // run the tab switch against a tiny DOM
  const mk = (id) => ({ id, className: '', hidden: false, attrs: {}, h: {}, clicked: 0,
    setAttribute(k, v) { this.attrs[k] = v; }, addEventListener(t, fn) { this.h[t] = fn; }, click() { this.clicked++; } });
  const dom = { 'tab-btn-organize': mk('o'), 'tab-btn-broll': mk('b'), lightbox: Object.assign(mk('lightbox'), { hidden: true }), 'lb-close': mk('lb-close') };
  const cls = new Set(); const store = {};
  const box = {
    document: { documentElement: { classList: { add: (c) => cls.add(c), remove: (c) => cls.delete(c) } }, getElementById: (id) => dom[id] || null },
    localStorage: { getItem: (k) => (k in store ? store[k] : null), setItem: (k, v) => { store[k] = String(v); } }
  };
  vm.createContext(box);
  new vm.Script(tabsJs[1]).runInContext(box);
  check('it opens on Organize the first time', !cls.has('broll-mode') && dom['tab-btn-organize'].className === 'on');
  dom['tab-btn-broll'].h.click();
  check('B-roll: the page switches and remembers it', cls.has('broll-mode') && dom['tab-btn-broll'].className === 'on' && store['isma-tab'] === 'broll');
  dom.lightbox.hidden = false;
  dom['tab-btn-organize'].h.click();
  check('back to Organize closes an open b-roll preview', !cls.has('broll-mode') && dom['lb-close'].clicked === 1);
  const again = new Set(); const box2 = Object.assign({}, box, { document: { documentElement: { classList: { add: (c) => again.add(c), remove: (c) => again.delete(c) } }, getElementById: (id) => dom[id] || null } });
  store['isma-tab'] = 'broll';
  vm.createContext(box2);
  new vm.Script(tabsJs[1]).runInContext(box2);
  check('reopening the panel returns to the last tab', again.has('broll-mode'));
  const manifest = fs.readFileSync(ROOT + 'CSXS/manifest.xml', 'utf8');
  check('the manifest keeps the flags the b-roll thumbnails need', /--allow-file-access-from-files/.test(manifest) && /--disable-site-isolation-trials/.test(manifest));
  check('one menu entry, "Isma Organizer"', (manifest.match(/<Menu>/g) || []).length === 1 && /<Menu>Isma Organizer<\/Menu>/.test(manifest));
  ['ImportBroll.jsx', 'PinterestClient.js', 'tag-broll.py'].forEach((f) => check(`${f} ships with the panel`, fs.existsSync(ROOT + f)));
}

console.log('\n2c) Nothing depends on one computer, nothing names it');
// The panel builds every personal path at run time from os.homedir(). A real
// home folder written into a shipped file breaks the panel on every other
// computer; written anywhere in the repository, it publishes a name. The
// second check looks for the home folder of whoever runs the tests.
{
  const shipped = ['index.html', 'OrganizeFilesInProject.jsx', 'ImportBroll.jsx', 'PinterestClient.js', 'tag-broll.py', 'CSXS/manifest.xml'];
  // "/Users/x/…" in a comment is an example, not a home folder
  const anyHome = /(?:\/Users\/|\/home\/|\b[A-Za-z]:[\\/]{1,2}Users[\\/]{1,2})(?!(?:x|you|name|Shared|Public)\b)[\w.-]{2,}/;
  const hard = shipped.filter((f) => anyHome.test(fs.readFileSync(ROOT + f, 'utf8')));
  check('no home-folder path in the shipped files', hard.length === 0, hard.join(', ') || shipped.length + ' files');

  const home = os.homedir();
  const files = [];
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (e.name.startsWith('.') || e.name === 'node_modules' || e.name === '__pycache__') continue;
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (/\.(html|jsx?|mjs|py|json|md|xml)$/.test(e.name)) files.push(p);
    }
  };
  walk(ROOT);
  // the installers and the README sit next to the plugin folder in the repository
  for (const f of ['README.md', 'Install-Mac.command', 'Install-Windows.bat']) {
    if (fs.existsSync(ROOT + '../' + f)) files.push(ROOT + '../' + f);
  }
  const named = home.length > 3
    ? files.filter((f) => { const t = fs.readFileSync(f, 'utf8'); return t.includes(home + '/') || t.includes(home + '\\'); })
    : [];
  check('no file mentions the home folder of this computer', named.length === 0,
    named.map((f) => path.relative(ROOT, f)).join(', ') || files.length + ' files');
}

console.log('\n2b) The manifest grants what the script uses');
// The tests stub require(), so a panel whose manifest does not enable Node
// passes every suite here and then fails silently inside Premiere — which is
// exactly what happened for weeks: the journal and the Pinterest bridge never
// ran. Read the real manifest instead of trusting the stub.
{
  const manifest = fs.readFileSync(ROOT + 'CSXS/manifest.xml', 'utf8');
  const usesNode = /\brequire\(\s*'(fs|os|child_process|path)'\s*\)/.test(blocks[0]);
  const enabled = /<Parameter>\s*--enable-nodejs\s*<\/Parameter>/.test(manifest);
  const mixed = /<Parameter>\s*--mixed-context\s*<\/Parameter>/.test(manifest);
  check('the panel script uses Node (fs/os)', usesNode);
  check('…so the manifest enables Node', !usesNode || enabled, enabled ? '--enable-nodejs' : 'MISSING --enable-nodejs');
  check('…in mixed context, where require() is a page global', !usesNode || mixed, mixed ? '--mixed-context' : 'MISSING --mixed-context');
}

console.log('\n3) Every function the panel calls in the host exists AND is exposed');
// The panel reaches the host through hostCall('name', …) and one typeof probe.
// Everything in the .jsx lives inside the IsmaOrganizer closure, so a function
// that exists but is missing from the return block is just as broken as one
// that was deleted — check both.
const called = [...new Set(
  [...blocks[0].matchAll(/hostCall\('(\w+)'/g)].map((m) => m[1])
    .concat([...blocks[0].matchAll(/typeof ' \+ HOST \+ '\.(\w+)/g)].map((m) => m[1]))
)];
const returnBlock = jsx.slice(jsx.lastIndexOf('\nreturn {'));
called.forEach((fn) => {
  check(`${fn}() is defined in the .jsx`, new RegExp('function\\s+' + fn + '\\s*\\(').test(jsx));
  check(`${fn} is exposed on IsmaOrganizer`, new RegExp('\\b' + fn + ':\\s*' + fn + '\\b').test(returnBlock));
});
check('importWatched is among them', called.includes('importWatched'), called.join(', '));
check('no evalScript call bypasses the namespace',
      ![...blocks[0].matchAll(/evalScript\('(\w+)\(/g)].length,
      'all host calls go through hostCall()');

console.log('\n3b) Nothing leaks out of the closure');
{
  const box = { app: { project: null } };
  vm.createContext(box);
  new vm.Script(jsx).runInContext(box);
  const leaked = Object.keys(box).filter((k) => k !== 'app' && k !== 'IsmaOrganizer');
  check('only IsmaOrganizer is defined at top level', leaked.length === 0, leaked.join(', ') || 'clean');
}

console.log('\n4) The b-roll rule keeps bridged files where the bridge put them');
// The rule is reached through the test hook the closure exposes — slicing
// the source by function name broke every time a helper moved.
const ruleBox = { app: { project: null } };
vm.createContext(ruleBox);
new vm.Script(jsx).runInContext(ruleBox);
const rule = (name) => ruleBox.IsmaOrganizer._test.looksLikeSocialName(name, name);

[
  ['38a0da7d7cb89edfdf58842f1dbdcab1.mp4', true, 'Pinterest, raw hash'],
  ['fccc8a42a3f7b068c9dd7d12b85d7a57_720w.mp4', true, 'Pinterest, hash + width'],
  ['deco-salon-scandinave_771874823639535801.mp4', true, 'Pinterest, {title}_{id}'],
  ['my great pin_771874823639535801 (1).mp4', true, 'duplicate suffix'],
  ['7588196048716238101.mp4', true, 'TikTok'],
  // Bounds measured on 80 real downloads: Pin ids run 15 to 19 digits, so the
  // old 18-19 bound was dropping one file in five.
  ['10977592837695411.mp4', true, 'bare Pin id, 17 digits'],
  ['1970393584402766.mp4', true, 'bare Pin id, 16 digits'],
  ['Happy-Family-with-Baby_20969954511893939.mp4', true, 'title + 17-digit id starting "20"'],
  ['Quiet-burn_976718237958518487_01.jpg', true, 'carousel page, {index} suffix'],
  // 17 digits is the one length that collides with a camera timestamp, so the
  // date is read rather than the digits counted.
  ['VID_20240101120000123.mp4', false, 'camera timestamp, 17 digits'],
  ['20240101120000123.mp4', false, 'bare camera timestamp'],
  ['IMG_20240101120000.mp4', false, 'camera file'],
  ['interview_final_v2.mp4', false, 'ordinary edit file'],
  ['scene_012.mov', false, 'scene number'],
  ['A_ROLL_2024.mov', false, 'ordinary A-roll']
].forEach(([name, want, why]) => {
  const got = rule(name);
  check(`${why}: ${name}`, got === want, got ? 'b-roll' : 'not b-roll');
});

console.log(`\n${failed ? failed + ' failure(s)' : 'the panel is sound'}\n`);
process.exit(failed ? 1 : 0);
