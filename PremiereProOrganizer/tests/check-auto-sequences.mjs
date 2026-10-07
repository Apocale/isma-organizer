/**
 *   node tests/check-auto-sequences.mjs
 *
 * A Nest made in the middle of a session must be filed without reopening the
 * project — with the settings the user REALLY has (read from the panel's own
 * storage on 2026-09-24): Auto-organize OFF, on-open and on-import ticked.
 *
 * Runs the real panel script with a controllable clock, a fake Premiere that
 * answers the signature poll, and a real temporary home folder, so the journal
 * line (~/Documents/Journal premire/data/plugin-isma-organizer.jsonl) is
 * checked on disk.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..') + '/';
const html = fs.readFileSync(ROOT + 'index.html', 'utf8');
const script = /<script type="text\/javascript">([\s\S]*?)<\/script>/.exec(html)[1];

let failed = 0;
const check = (name, ok, detail = '') => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '   -> ' + detail : ''}`);
  if (!ok) failed++;
};

// ------------------------------------------------------------------ the rig
function rig({ store = {}, seqWatch = true, journalDir = true, sig = {} } = {}) {
  const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'org-auto-'));
  const JOURNAL = path.join(HOME, 'Documents/Journal premire/data');
  if (journalDir) fs.mkdirSync(JOURNAL, { recursive: true });

  let now = 1790000000000;
  class FakeDate extends Date {
    constructor(...a) { super(...(a.length ? a : [now])); }
    static now() { return now; }
  }

  const els = {};
  function el(id) {
    if (!els[id]) {
      els[id] = {
        id, value: '', checked: false, textContent: '', innerHTML: '', className: '',
        disabled: false, hidden: false, style: {},
        classList: { _s: {}, add(c) { this._s[c] = 1; }, remove(c) { delete this._s[c]; }, toggle() {}, contains(c) { return !!this._s[c]; } },
        addEventListener(t, fn) { (this._h = this._h || {})[t] = fn; },
        fire(t) { if (this._h && this._h[t]) this._h[t].call(this, { preventDefault() {} }); },
        click() { this.fire('click'); },
        querySelector: () => null, appendChild() {}, removeChild() {}, focus() {}
      };
    }
    return els[id];
  }
  // The markup's defaults, which the stub DOM does not parse.
  el('f-auto-sequences').checked = seqWatch;
  el('f-auto-interval').value = '30';

  // An existing user (settings saved by an earlier version). Switched off =
  // stored off, as savePrefs() leaves it when the user flips the switch.
  const localStore = Object.assign({ prefsVersion: '2' }, seqWatch === false ? { 'f-auto-sequences': '0' } : {}, store);
  // `sig` is what Premiere answers from the very first poll — the panel polls
  // once as soon as it loads, so the starting state must be set before that.
  const host = { sig: Object.assign({ ok: true, path: '/P/Client B 5.prproj', name: 'Client B 5', rootCount: 10, seqCount: 244, rootSeqs: 0 }, sig),
                 calls: [], reply: null };

  const sandbox = {
    console, JSON, Object, Math, RegExp, String, Number, Boolean, Array, Error, parseInt, parseFloat, isNaN,
    Date: FakeDate,
    setTimeout: () => 0, clearTimeout: () => {}, setInterval: () => 0, clearInterval: () => {},
    require: (m) => (m === 'fs' ? fs : m === 'os' ? { homedir: () => HOME } : null),
    localStorage: {
      getItem: (k) => (k in localStore ? localStore[k] : null),
      setItem: (k, v) => { localStore[k] = String(v); },
      removeItem: (k) => { delete localStore[k]; }
    },
    document: { getElementById: el, addEventListener() {}, createElement: () => el('__tmp__'), body: el('__body__') },
    window: {},
    CSInterface: function () {
      this.getSystemPath = () => '/nonexistent/PremiereProOrganizer';
      this.evalScript = (code, cb) => {
        if (code.indexOf('$.evalFile') === 0) return cb('');
        if (code === 'IsmaOrganizer.getProjectSignature()') return cb(JSON.stringify(host.sig));
        if (code.indexOf('IsmaOrganizer.diagnoseNested(') === 0) return cb(host.diagReply || '');
        if (code.indexOf('IsmaOrganizer.previewOrganize(') === 0) { host.previews = (host.previews || 0) + 1; return cb(host.previewReply || ''); }
        if (code.indexOf('IsmaOrganizer.resetAndOrganize(') === 0) {
          const payload = JSON.parse(JSON.parse(/resetAndOrganize\((.*)\)$/s.exec(code)[1]));
          host.calls.push(payload);
          const r = typeof host.reply === 'function' ? host.reply(payload) : host.reply;
          return cb(r);
        }
        cb('');
      };
    },
    SystemPath: { EXTENSION: 'extension' }
  };
  vm.createContext(sandbox);
  new vm.Script(script).runInContext(sandbox);

  return {
    sandbox, el, host, HOME,
    journalFile: path.join(JOURNAL, 'plugin-isma-organizer.jsonl'),
    advance(ms) { now += ms; },
    tick() { sandbox.autoTick(); },
    journal() {
      try { return fs.readFileSync(path.join(JOURNAL, 'plugin-isma-organizer.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)); }
      catch (e) { return []; }
    },
    cleanup() { fs.rmSync(HOME, { recursive: true, force: true }); }
  };
}

// A report shaped like the host's, for a sequences-only pass that filed `n` nests.
const report = (n, extra = {}) => JSON.stringify(Object.assign({
  ok: true, mode: 'incremental', project: '/P/Client B 5.prproj',
  counts: n ? { nested: n } : {}, total: n, unchanged: 0, failed: 0, failedNames: [], skipped: [], duplicates: [],
  undo: { items: Array.from({ length: n }, (_, i) => ({ id: 'n' + i, from: '', fromParts: [] })), bins: [], names: { seq: '01 sequence', nested: '08 nested sequence' }, project: '/P/Client B 5.prproj' },
  onlySequences: true, seqTotal: 245, nestedFound: n, unusedNested: [], debug: { version: '2.5.0' },
  scan: 'none', clipsRead: 0
}, extra));

const USER_SETTINGS = { 'f-auto-enabled': '0', 'f-auto-on-open': '1', 'f-auto-on-import': '1', 'f-auto-interval': '30' };

// ================================================================ 1
console.log('\n1) The user\'s real settings: Auto-organize OFF — a Nest made mid-session is filed');
{
  const r = rig({ store: USER_SETTINGS });
  check('a NEW user starts with "File new sequences" off (opt-in since 2.6.0)', !/id="f-auto-sequences" checked/.test(html));
  check('…someone who used an earlier version keeps it on', r.el('f-auto-sequences').checked === true);
  r.tick();
  check('first poll only takes a baseline', r.host.calls.length === 0);

  // the user nests: Premiere drops "Nested Sequence 132" at the root
  r.host.sig = Object.assign({}, r.host.sig, { seqCount: 245, rootCount: 11, rootSeqs: 1 });
  r.advance(6000); r.tick();
  check('a new sequence arms a run, but waits for the gesture to settle', r.host.calls.length === 0);

  r.host.reply = () => { r.host.sig = Object.assign({}, r.host.sig, { rootCount: 10, rootSeqs: 0 }); return report(1); };
  r.advance(6000); r.tick();
  check('it runs on the next poll — without reopening the project', r.host.calls.length === 1, String(r.host.calls.length));
  const p = r.host.calls[0] || {};
  check('…sequences only: media are never touched by this trigger', p.only === 'sequences', String(p.only));
  check('…in incremental mode', p.mode === 'incremental', p.mode);
  check('…even though Auto-organize is off', r.el('f-auto-enabled').checked === false);

  const lines = r.journal();
  check('one journal line was appended', lines.length === 1, String(lines.length));
  const L = lines[0] || { detail: {} };
  check('shape: ts / plugin / action / object / ms', typeof L.ts === 'number' && L.plugin === 'Isma Organizer' && L.action === 'plugin.call' && L.object === 'organize' && typeof L.ms === 'number',
        JSON.stringify({ ts: L.ts, plugin: L.plugin, action: L.action, object: L.object, ms: L.ms }));
  check('raison = sequences', L.detail.raison === 'sequences', L.detail.raison);
  check('sequences / nested_trouves / nested_deplaces', L.detail.sequences === 245 && L.detail.nested_trouves === 1 && L.detail.nested_deplaces === 1,
        JSON.stringify(L.detail));
  check('deplaces_par_categorie is keyed by BIN name', L.detail.deplaces_par_categorie && L.detail.deplaces_par_categorie['08 nested sequence'] === 1,
        JSON.stringify(L.detail.deplaces_par_categorie));
  check('the project is named', L.project === 'Client B 5.prproj', L.project);

  r.advance(6000); r.tick(); r.advance(6000); r.tick();
  check('nothing new → no second run', r.host.calls.length === 1, String(r.host.calls.length));

  // a second Nest 20 s later: honoured, after the one-minute floor between automatic runs
  r.host.sig = Object.assign({}, r.host.sig, { seqCount: 246, rootCount: 11, rootSeqs: 1 });
  r.host.reply = () => { r.host.sig = Object.assign({}, r.host.sig, { rootCount: 10, rootSeqs: 0 }); return report(1); };
  r.advance(6000); r.tick(); r.advance(6000); r.tick();
  check('a second Nest inside the cooldown waits', r.host.calls.length === 1, String(r.host.calls.length));
  r.advance(60000); r.tick();
  check('…and is filed once the cooldown is over', r.host.calls.length === 2, String(r.host.calls.length));
  r.cleanup();
}

// ================================================================ 2
console.log('\n2) A sequence left at the root on purpose (Ignore list) does not loop');
{
  const r = rig({ store: USER_SETTINGS });
  r.tick();
  r.host.sig = Object.assign({}, r.host.sig, { seqCount: 245, rootSeqs: 1 });
  r.host.reply = report(0);          // host filed nothing: the sequence is ignored, stays at root
  r.advance(6000); r.tick(); r.advance(6000); r.tick();
  check('one run happened', r.host.calls.length === 1, String(r.host.calls.length));
  for (let i = 0; i < 20; i++) { r.advance(6000); r.tick(); }
  check('no re-run every minute on the same leftover', r.host.calls.length === 1, String(r.host.calls.length));
  r.host.sig = Object.assign({}, r.host.sig, { seqCount: 246, rootSeqs: 2 });
  r.advance(6000); r.tick(); r.advance(6000); r.tick();
  check('…but a genuinely new sequence still triggers', r.host.calls.length === 2, String(r.host.calls.length));
  r.cleanup();
}

// ================================================================ 3
console.log('\n3) Switch off → nothing automatic at all');
{
  const r = rig({ store: USER_SETTINGS, seqWatch: false });
  r.tick();
  r.host.sig = Object.assign({}, r.host.sig, { seqCount: 245, rootCount: 11, rootSeqs: 1 });
  for (let i = 0; i < 10; i++) { r.advance(6000); r.tick(); }
  check('no run when both Auto-organize and the sequence watch are off', r.host.calls.length === 0, String(r.host.calls.length));
  r.cleanup();
}

// ================================================================ 4
console.log('\n4) With Auto-organize ON, an import still runs the full pass (not sequences-only)');
{
  const r = rig({ store: Object.assign({}, USER_SETTINGS, { 'f-auto-enabled': '1' }) });
  r.tick();
  r.host.sig = Object.assign({}, r.host.sig, { rootCount: 30 });            // 20 clips imported, no sequence
  r.host.reply = report(0, { onlySequences: false, counts: { video: 20 }, total: 20 });
  r.advance(6000); r.tick(); r.advance(7000); r.tick();
  check('the import trigger ran', r.host.calls.length === 1, String(r.host.calls.length));
  check('…without the sequences-only restriction', r.host.calls[0] && r.host.calls[0].only === undefined, String(r.host.calls[0] && r.host.calls[0].only));
  check('…journal says raison = import', (r.journal()[0] || { detail: {} }).detail.raison === 'import');
  check('…and the host is told it is an automatic import (cheap classification)', r.host.calls[0] && r.host.calls[0].auto === 'import', String(r.host.calls[0] && r.host.calls[0].auto));
  r.cleanup();
}

// ================================================================ 5
console.log('\n5) Manual run, host error, missing journal folder');
{
  const r = rig({ store: USER_SETTINGS });
  r.tick();
  r.host.reply = report(3, { onlySequences: false, counts: { nested: 2, seq: 1 }, total: 3, nestedFound: 2 });
  r.el('organize-btn').fire('click');
  const L = r.journal()[0] || { detail: {} };
  check('manual click → raison = manuel', L.detail.raison === 'manuel', L.detail.raison);
  check('manual click is a full incremental pass', r.host.calls[0] && r.host.calls[0].only === undefined);
  check('…both bins counted by name', L.detail.deplaces_par_categorie && L.detail.deplaces_par_categorie['01 sequence'] === 1 && L.detail.deplaces_par_categorie['08 nested sequence'] === 2,
        JSON.stringify(L.detail.deplaces_par_categorie));

  r.host.reply = 'EvalScript error.';
  r.advance(61000);
  r.el('organize-btn').fire('click');
  const E = r.journal()[1] || { detail: {} };
  check('a host error is journaled too, with the error', /EvalScript/.test(E.detail.erreur || ''), E.detail.erreur);
  r.cleanup();

  const q = rig({ store: USER_SETTINGS, journalDir: false });
  q.tick();
  q.host.reply = report(1);
  let threw = false;
  try { q.el('organize-btn').fire('click'); } catch (e) { threw = true; }
  check('no journal folder → no file, no exception, run still reported', !threw && !fs.existsSync(q.journalFile) && q.host.calls.length === 1);
  q.cleanup();
}

// ================================================================ 6
console.log('\n6) Opening a project that already has sequences at the root does nothing (the Client B 3 case)');
{
  const r = rig({ store: USER_SETTINGS, sig: { path: '/P/Client B 3.prproj', seqCount: 110, rootSeqs: 110, rootCount: 130 } });
  r.tick();
  for (let i = 0; i < 12; i++) { r.advance(6000); r.tick(); }
  check('no run over a minute of polls', r.host.calls.length === 0, String(r.host.calls.length));
  // switching to another project with its own backlog: same rule
  r.host.sig = Object.assign({}, r.host.sig, { path: '/P/Other.prproj', seqCount: 40, rootSeqs: 12 });
  for (let i = 0; i < 6; i++) { r.advance(6000); r.tick(); }
  check('opening another project with a backlog: still nothing', r.host.calls.length === 0, String(r.host.calls.length));
  // but a Nest made now is filed (and the backlog with it)
  r.host.sig = Object.assign({}, r.host.sig, { seqCount: 41, rootSeqs: 13 });
  r.host.reply = () => { r.host.sig = Object.assign({}, r.host.sig, { rootSeqs: 0 }); return report(13); };
  r.advance(6000); r.tick(); r.advance(6000); r.tick();
  check('a Nest made in this session is filed', r.host.calls.length === 1 && r.host.calls[0].only === 'sequences', String(r.host.calls.length));
  r.cleanup();
}

// ================================================================ 7
console.log('\n7) A sequence deleted from the root does not trigger anything');
{
  const r = rig({ store: USER_SETTINGS, sig: { rootSeqs: 3 } });
  r.tick();
  r.host.sig = Object.assign({}, r.host.sig, { rootSeqs: 2, seqCount: 243 });
  for (let i = 0; i < 5; i++) { r.advance(6000); r.tick(); }
  check('fewer sequences → no run', r.host.calls.length === 0, String(r.host.calls.length));
  r.host.sig = Object.assign({}, r.host.sig, { rootSeqs: 3, seqCount: 244 });
  r.host.reply = report(1);
  r.advance(6000); r.tick(); r.advance(6000); r.tick();
  check('…and one more after that does', r.host.calls.length === 1, String(r.host.calls.length));
  r.cleanup();
}

// ================================================================ 8
console.log('\n8) Media waiting at the root: the status line says so, one click files them');
{
  const r = rig({ store: USER_SETTINGS });
  r.host.sig = Object.assign({}, r.host.sig, { rootMedia: 33 });
  r.tick();
  const status = () => r.el('auto-status').innerHTML;
  check('the status line counts them', /33 items at the root/.test(status()), status().replace(/<[^>]+>/g, ''));
  check('nothing moves by itself (Auto-organize is off)', r.host.calls.length === 0);
  r.host.reply = () => { r.host.sig = Object.assign({}, r.host.sig, { rootMedia: 0 }); return report(33, { onlySequences: false, counts: { video: 20, audio: 13 }, total: 33 }); };
  r.el('auto-status')._h.click({ target: { id: 'nudge-organize' }, preventDefault() {} });
  check('clicking it runs a normal Organize', r.host.calls.length === 1 && r.host.calls[0].only === undefined, String(r.host.calls.length));
  check('…and the line clears once they are filed', !/at the root/.test(status()), status().replace(/<[^>]+>/g, ''));
  const L = r.journal()[0] || { detail: {} };
  check('the journal says manuel, and which scan ran', L.detail.raison === 'manuel' && 'scan' in L.detail && 'clips_lus' in L.detail, JSON.stringify({ raison: L.detail.raison, scan: L.detail.scan, clips: L.detail.clips_lus }));
  r.cleanup();

  const q = rig({ store: Object.assign({}, USER_SETTINGS, { 'f-auto-enabled': '1' }) });
  q.el('f-auto-on-import').checked = true;
  q.host.sig = Object.assign({}, q.host.sig, { rootMedia: 33 });
  q.tick();
  check('no nudge when Auto-organize files imports itself', !/at the root/.test(q.el('auto-status').innerHTML));
  q.cleanup();
}

// ================================================================ 9  (code audit of 2.5.0)
console.log('\n9) A run armed in one project never fires in the next one (C1)');
{
  const r = rig({ store: USER_SETTINGS });
  r.tick();
  r.host.sig = Object.assign({}, r.host.sig, { seqCount: 245, rootSeqs: 1 });
  r.host.reply = () => { r.host.sig = Object.assign({}, r.host.sig, { rootSeqs: 0 }); return report(1); };
  r.advance(6000); r.tick(); r.advance(6000); r.tick();
  check('the first Nest is filed in Client B 5', r.host.calls.length === 1, String(r.host.calls.length));
  r.host.sig = Object.assign({}, r.host.sig, { seqCount: 246, rootSeqs: 1 });   // second Nest, inside the cooldown
  r.advance(6000); r.tick(); r.advance(6000); r.tick();
  check('…the second one waits for the cooldown', r.host.calls.length === 1, String(r.host.calls.length));
  r.host.sig = { ok: true, path: '/P/Client B 3.prproj', name: 'Client B 3', rootCount: 130, seqCount: 110, rootSeqs: 110, rootMedia: 0 };
  for (let i = 0; i < 15; i++) { r.advance(6000); r.tick(); }
  check('the user opens Client B 3: nothing runs there', r.host.calls.length === 1, String(r.host.calls.length));
  r.cleanup();
}

console.log('\n10) The nudge only counts what Organize can still file (S5) — and is gone with no project (N1)');
{
  const r = rig({ store: USER_SETTINGS, sig: { rootMedia: 3 } });
  r.tick();
  const status = () => r.el('auto-status').innerHTML.replace(/<[^>]+>/g, '');
  check('3 items at the root → nudge', /3 items at the root/.test(status()), status());
  r.host.reply = () => { r.host.sig = Object.assign({}, r.host.sig, { rootMedia: 2 }); return report(1, { onlySequences: false, counts: { video: 1 }, total: 1 }); };
  r.el('auto-status')._h.click({ target: { id: 'nudge-organize' }, preventDefault() {} });
  check('after Organize, the 2 it left (Ignore list) are not nagged about', !/at the root/.test(status()), status());
  r.host.sig = Object.assign({}, r.host.sig, { rootMedia: 4 });
  r.advance(6000); r.tick();
  check('2 new imports → "2 items"', /2 items at the root/.test(status()), status());
  r.host.sig = { ok: false };
  r.advance(6000); r.tick();
  check('no project open → no nudge', !/at the root/.test(status()), status());
  r.cleanup();
}

console.log('\n11) The status line is not rewritten when nothing changed (N6)');
{
  const r = rig({ store: USER_SETTINGS, sig: { rootMedia: 5 } });
  r.tick();
  const node = r.el('auto-status');
  let html = node.innerHTML, writes = 0;
  Object.defineProperty(node, 'innerHTML', { get: () => html, set: (v) => { writes++; html = v; } });
  for (let i = 0; i < 10; i++) { r.advance(6000); r.tick(); }
  check('10 unchanged polls → 0 rewrites (the link under the cursor stays clickable)', writes === 0, String(writes));
  r.cleanup();
}

console.log('\n12) A Preview does not make a waiting Nest disappear (N7)');
{
  const r = rig({ store: USER_SETTINGS });
  r.tick();
  r.host.sig = Object.assign({}, r.host.sig, { seqCount: 245, rootSeqs: 1 });
  r.advance(6000); r.tick();                                  // armed, not yet due
  r.host.previewReply = JSON.stringify({ ok: true, preview: true, counts: {}, total: 0, unchanged: 0, skipped: [], duplicates: [] });
  r.el('preview-btn').click();
  check('the Preview ran', r.host.previews === 1);
  r.host.reply = () => { r.host.sig = Object.assign({}, r.host.sig, { rootSeqs: 0 }); return report(1); };
  for (let i = 0; i < 14; i++) { r.advance(6000); r.tick(); }
  check('the Nest is still filed afterwards', r.host.calls.length === 1 && r.host.calls[0].only === 'sequences', String(r.host.calls.length));
  r.cleanup();
}

console.log('\n13) The diagnostic\'s journal line keeps "scan" a mode (N2)');
{
  const r = rig({ store: USER_SETTINGS });
  r.tick();
  r.host.diagReply = JSON.stringify({ ok: true, scan: { seqCount: 3, tracksSeen: 2, clipsSeen: 5, nestedFound: 1, opened: 0, errors: [] }, items: [] });
  r.el('diag-btn').click();
  const L = r.journal()[0] || { detail: {} };
  check('detail.scan is a string', typeof L.detail.scan === 'string' || L.detail.scan === undefined, JSON.stringify(L.detail.scan));
  r.cleanup();
}

console.log(`\n${failed ? failed + ' failure(s)' : 'new sequences are filed mid-session, and every run is measured'}\n`);
process.exit(failed ? 1 : 0);
