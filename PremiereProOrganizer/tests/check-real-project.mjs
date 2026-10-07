/**
 *   node tests/check-real-project.mjs
 *
 * The organizer replayed on the structure of a REAL project: 244 sequences,
 * 29 bins, nests two levels deep, and who nests what — read from the project's
 * autosave of 2026-09-24 15:34 (right after an Organizer 2.3.0 run) and kept in
 * fixtures/real-project-sequences.json (names and nesting only, no media).
 *
 * Why this exists: the synthetic tests passed for weeks while, on this very
 * project, 19 "Nested Sequence" leftovers stayed in "01 sequence" and 7 more
 * sat in an unnumbered "nested sequence" bin. Nothing synthetic had those two
 * shapes; the real project has both. The rule the user expects, and this test
 * pins:
 *
 *   a sequence is nested  ⇔  it is used inside another timeline
 *                            OR it is named like a Premiere nest
 *                               ("Nested Sequence 42", "Séquence imbriquée 3")
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..') + '/';
const jsx = fs.readFileSync(ROOT + 'OrganizeFilesInProject.jsx', 'utf8');
const fx = JSON.parse(fs.readFileSync(ROOT + 'tests/fixtures/real-project-sequences.json', 'utf8'));

let failed = 0;
const check = (name, ok, detail = '') => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '   -> ' + detail : ''}`);
  if (!ok) failed++;
};

function build() {
  let id = 1;
  const violations = [];
  const mk = (name, type) => ({ name, type, nodeId: 'n' + id++, _kids: [], _parent: null,
    setColorLabel() {}, moveBin(d) { mv(this, d); } });
  const mv = (it, d) => {
    if (it._parent) { const k = it._parent._kids; k.splice(k.indexOf(it), 1); }
    d._kids.push(it); it._parent = d;
  };
  const asBin = (b) => {
    Object.defineProperty(b, 'children', { get() { const a = b._kids.slice(); a.numItems = a.length; return a; } });
    b.createBin = (n) => { const c = asBin(mk(n, 2)); mv(c, b); return c; };
    b.deleteBin = () => {
      if (b._kids.length) { violations.push(b.name); throw new Error('non-empty ' + b.name); }
      const k = b._parent._kids; k.splice(k.indexOf(b), 1); b._parent = null;
    };
    return b;
  };
  const root = asBin(mk('root', 3));
  const binObj = { [fx.root]: root };
  const ensureBin = (uid) => {
    if (binObj[uid]) return binObj[uid];
    const b = fx.bins[uid];
    const o = asBin(mk(b.name, 2));
    binObj[uid] = o;
    mv(o, b.parent ? ensureBin(b.parent) : root);
    return o;
  };
  // every bin, empty ones included: an empty user bin must survive
  Object.keys(fx.bins).forEach(ensureBin);

  const itemObj = {};
  for (const it of fx.items) {
    const o = mk(it.name, 1);
    Object.assign(o, { isSequence: () => true, isMergedClip: () => false, isOffline: () => false, getMediaPath: () => '' });
    itemObj[it.uid] = o;
    mv(o, it.parent ? ensureBin(it.parent) : root);
  }
  const sequences = fx.sequences.map((s) => {
    const clips = s.contains.map((u) => ({ projectItem: itemObj[u] }));
    clips.numItems = clips.length;
    const v = [{ clips }]; v.numTracks = 1;
    const a = []; a.numTracks = 0;
    return { name: s.name, sequenceID: s.uid, videoTracks: v, audioTracks: a };
  });
  sequences.numSequences = sequences.length;

  const box = { app: { project: { rootItem: root, path: '/real/project.prproj', sequences, activeSequence: null, openSequence() {} } } };
  vm.createContext(box);
  new vm.Script(jsx).runInContext(box);

  const pathOf = (o) => { const p = []; for (let x = o._parent; x && x !== root; x = x._parent) p.unshift(x.name); return p.join('/'); };
  const used = new Set(fx.sequences.flatMap((s) => s.contains));
  const expected = (it) => (used.has(it.uid) || /^(nested sequence|séquence imbriquée)/i.test(it.name))
    ? '08 nested sequence' : '01 sequence';
  const binNames = () => root._kids.filter((k) => k.type === 2).map((k) => k.name);

  // Mid-session helpers: a Nest lands at the root (measured in the activity
  // journal), and becomes a clip inside the timeline it was made in.
  const seqByName = (n) => sequences.find((s) => s.name === n);
  const addNest = (name, insideName) => {
    const o = mk(name, 1);
    Object.assign(o, { isSequence: () => true, isMergedClip: () => false, isOffline: () => false, getMediaPath: () => '' });
    mv(o, root);
    const parent = seqByName(insideName);
    parent.videoTracks[0].clips.push({ projectItem: o });
    parent.videoTracks[0].clips.numItems = parent.videoTracks[0].clips.length;
    const v = []; v.numTracks = 1; v.push({ clips: Object.assign([], { numItems: 0 }) });
    const a = []; a.numTracks = 0;
    sequences.push({ name, sequenceID: 'new-' + name, videoTracks: v, audioTracks: a });
    sequences.numSequences = sequences.length;
    return o;
  };
  const addMedia = (name, p) => {
    const o = mk(name, 1);
    Object.assign(o, { isSequence: () => false, isMergedClip: () => false, isOffline: () => false, getMediaPath: () => p });
    mv(o, root);
    return o;
  };
  return { O: box.IsmaOrganizer, root, itemObj, pathOf, expected, violations, binNames, addNest, addMedia };
}

// The recorded project carries bins from older versions of the plugin
// ("nested sequence", "video"…): merging them is the owner's setting.
const payload = (mode, only) => JSON.stringify({
  mode, only, names: {}, ignored: [], brollPatterns: [], exportPatterns: [], audioSplit: true,
  sfxPatterns: [], voicePatterns: [], colorLabels: true, refreshView: false, legacyBins: true
});

function misfiled(h) {
  return fx.items.filter((it) => h.pathOf(h.itemObj[it.uid]) !== h.expected(it))
    .map((it) => `${it.name} in "${h.pathOf(h.itemObj[it.uid])}"`);
}

console.log('\n0) The recorded project really has the shapes that broke');
{
  const h = build();
  const inSeqBin = fx.items.filter((it) => h.pathOf(h.itemObj[it.uid]) === '01 sequence' && /^nested sequence/i.test(it.name));
  const unusedNamed = inSeqBin.filter((it) => !fx.sequences.some((s) => s.contains.includes(it.uid)));
  check('19 "Nested Sequence…" items sit in 01 sequence before the fix', inSeqBin.length === 19, String(inSeqBin.length));
  check('…all 19 used in no timeline at all', unusedNamed.length === 19, String(unusedNamed.length));
  check('an unnumbered "nested sequence" bin (pasted from an older project) holds 7', fx.items.filter((it) => h.pathOf(h.itemObj[it.uid]) === 'nested sequence').length === 7);
  const outside = fx.items.filter((it) => h.expected(it) === '08 nested sequence' && h.pathOf(h.itemObj[it.uid]) !== '08 nested sequence');
  check('before the fix: 26 nested outside 08', outside.length === 26, String(outside.length));
  const depthOf = (uid, seen = []) => { const s = fx.sequences.find((x) => x.uid === uid); if (!s || seen.includes(uid) || !s.contains.length) return 0; return 1 + Math.max(...s.contains.map((c) => depthOf(c, seen.concat(uid)))); };
  check('nests really go two levels deep', Math.max(...fx.items.map((it) => depthOf(it.uid))) >= 2);
}

for (const mode of ['incremental', 'full']) {
  console.log(`\n1) ${mode} run on the real project`);
  const h = build();
  const rep = JSON.parse(h.O.resetAndOrganize(payload(mode)));
  const wrong = misfiled(h);
  check('every sequence is where the user expects it', wrong.length === 0, wrong.slice(0, 4).join(' · ') || '244/244');
  check('01 sequence holds only real edits (72)', fx.items.filter((it) => h.pathOf(h.itemObj[it.uid]) === '01 sequence').length === 72);
  check('08 nested sequence holds all 172 nests', fx.items.filter((it) => h.pathOf(h.itemObj[it.uid]) === '08 nested sequence').length === 172);
  check('no "Nested Sequence…" left outside 08', !fx.items.some((it) => /^nested sequence/i.test(it.name) && h.pathOf(h.itemObj[it.uid]) !== '08 nested sequence'));
  check('the 19 leftovers are reported by name, not deleted', rep.unusedNested.length === 19 && fx.items.length === 244, String(rep.unusedNested.length));
  check('the emptied unnumbered "nested sequence" bin is gone', !h.binNames().includes('nested sequence'), h.binNames().join(', '));
  check('no non-empty bin was ever deleted', h.violations.length === 0, h.violations.join(', ') || 'none');

  const again = JSON.parse(h.O.resetAndOrganize(payload('incremental')));
  check('a second run moves nothing', again.total === 0, String(again.total));

  const undo = JSON.parse(h.O.undoOrganize(JSON.stringify(rep.undo)));
  const back = fx.items.filter((it) => h.pathOf(h.itemObj[it.uid]) === (it.parent ? (() => { const p = []; for (let b = it.parent; b && fx.bins[b]; b = fx.bins[b].parent) p.unshift(fx.bins[b].name); return p.join('/'); })() : ''));
  check('undo puts all 244 back where they were', undo.restored === rep.total && back.length === 244, `${back.length}/244 · restored ${undo.restored}/${rep.total}`);
}

console.log('\n2) Mid-session on the real project: a Nest, then a Nest inside it, while media sit at the root');
{
  const h = build();
  h.O.resetAndOrganize(payload('incremental'));
  const n1 = h.addNest('Nested Sequence 132', '9/26');            // made inside a real edit
  const n2 = h.addNest('Nested Sequence 133', 'Nested Sequence 132'); // nest inside the nest
  const clip = h.addMedia('A001_new_take.mp4', '/Volumes/Cam/A001_new_take.mp4');
  const sig = JSON.parse(h.O.getProjectSignature());
  check('the signature sees 2 sequences waiting at the root', sig.rootSeqs === 2 && sig.seqCount === 246, JSON.stringify({ rootSeqs: sig.rootSeqs, seqCount: sig.seqCount }));
  const rep = JSON.parse(h.O.resetAndOrganize(payload('incremental', 'sequences')));
  check('both nests filed into 08', h.pathOf(n1) === '08 nested sequence' && h.pathOf(n2) === '08 nested sequence', h.pathOf(n1) + ' / ' + h.pathOf(n2));
  check('the media clip at the root is NOT touched by a sequences-only pass', h.pathOf(clip) === '', h.pathOf(clip) || '(root)');
  // The automatic pass no longer re-reads every timeline (7–20 s frozen per
  // Nest on this very project): the 2 new nests are known by their name; the
  // only timeline it may read is the ACTIVE one (none is open here).
  check('exactly 2 moves; the 2 new nests seen; 246 sequences; no timeline read but the active one',
    rep.total === 2 && rep.counts.nested === 2 && rep.onlySequences === true && rep.seqTotal === 246 && rep.nestedFound === 2 &&
    (rep.scan === 'none' || rep.scan === 'active') && rep.clipsRead === 0,
        JSON.stringify({ total: rep.total, counts: rep.counts, only: rep.onlySequences, seqTotal: rep.seqTotal, found: rep.nestedFound, scan: rep.scan, clips: rep.clipsRead }));
  check('the signature is back to 0 at the root', JSON.parse(h.O.getProjectSignature()).rootSeqs === 0);
  check('a full pass afterwards files the clip, and still 0 nested outside 08',
    (() => { h.O.resetAndOrganize(payload('incremental')); return h.pathOf(clip) === '02 video' && !fx.items.some((it) => h.expected(it) === '08 nested sequence' && h.pathOf(h.itemObj[it.uid]) !== '08 nested sequence'); })(),
    h.pathOf(clip));
}

console.log(`\n${failed ? failed + ' failure(s)' : 'the real project sorts the way the user expects'}\n`);
process.exit(failed ? 1 : 0);
