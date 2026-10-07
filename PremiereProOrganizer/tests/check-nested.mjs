/**
 *   node tests/check-nested.mjs
 *
 * The sequence / nested-sequence split, against a stubbed Premiere.
 *
 * This is the one classification that cannot be checked by reading the code:
 * it depends entirely on what the host lets the script read from the OTHER
 * sequences' tracks. When that read comes back empty, every sequence is
 * classified "not nested" and they all pile into one bin — which is exactly
 * the bug these tests pin down.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..') + '/';

let failed = 0;
const check = (name, ok, detail = '') => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '   -> ' + detail : ''}`);
  if (!ok) failed++;
};

// The whole .jsx loads against a stubbed `app`; the helpers under test are
// reached through the _test hook the closure exposes.
const jsx = fs.readFileSync(ROOT + 'OrganizeFilesInProject.jsx', 'utf8');

// ---------------------------------------------------------------- the stubs
const seqItem = (name, nodeId) => ({
  name, nodeId, type: 1,
  isSequence: () => true,
  isMergedClip: () => false
});
const mergedItem = (name, nodeId) => ({
  name, nodeId, type: 1,
  isSequence: () => true,      // a merged clip answers true here too
  isMergedClip: () => true
});
const tracks = (...clipLists) => {
  const t = clipLists.map((clips) => {
    const c = clips.map((projectItem) => ({ projectItem }));
    c.numItems = c.length;
    return { clips: c };
  });
  t.numTracks = t.length;
  return t;
};
const noTracks = () => { const t = []; t.numTracks = 0; return t; };

/** @param lazy  when true, tracks stay empty until openSequence() is called. */
function makeProject(specs, { lazy = false } = {}) {
  const sequences = specs.map((spec) => {
    const seq = { name: spec.name, sequenceID: spec.id, opened: !lazy };
    const live = () => (seq.opened ? spec.tracks() : noTracks());
    // configurable: a test further down replaces the getter with one that throws.
    Object.defineProperty(seq, 'videoTracks', { get: live, configurable: true });
    Object.defineProperty(seq, 'audioTracks', { get: noTracks, configurable: true });
    return seq;
  });
  sequences.numSequences = sequences.length;

  const project = {
    sequences,
    activeSequence: sequences[0] || null,
    openSequence(id) {
      const found = sequences.filter((s) => s.sequenceID === id)[0];
      if (!found) return false;
      found.opened = true;
      project.activeSequence = found;
      project.openLog.push(id);
      return true;
    },
    openLog: []
  };
  return project;
}

function run(project) {
  const box = { app: { project } };
  vm.createContext(box);
  new vm.Script(jsx).runInContext(box);
  box.result = box.IsmaOrganizer._test;
  const info = box.result.getNestedInfo();
  return { info, box, project };
}

// ------------------------------------------------- 1) the ordinary case
console.log('\n1) A sequence used inside another one is nested');
{
  const intro = seqItem('Intro', 101);
  const { info, box } = run(makeProject([
    { name: 'FINAL', id: 1, tracks: () => tracks([intro]) },
    { name: 'Intro', id: 2, tracks: () => tracks([]) }
  ]));

  check('the scan read the tracks', info.clipsSeen === 1, info.clipsSeen + ' clip(s)');
  check('one nested sequence found', info.nestedFound === 1, String(info.nestedFound));
  check('Intro is nested', box.result.isNestedSeq(seqItem('Intro', 101), info) === true);
  check('FINAL is not', box.result.isNestedSeq(seqItem('FINAL', 1), info) === false);
}

// ------------------------- 2) the bug: tracks unreadable until opened
console.log('\n2) Tracks that stay empty until the sequence is opened');
{
  const intro = seqItem('Intro', 101);
  const { info, box, project } = run(makeProject([
    { name: 'FINAL', id: 1, tracks: () => tracks([intro]) },
    { name: 'Intro', id: 2, tracks: () => tracks([]) }
  ], { lazy: true }));

  check('the fallback opened the sequences', info.opened === 2, info.opened + ' opened');
  check('and then the clip was read', info.clipsSeen === 1, info.clipsSeen + ' clip(s)');
  check('Intro is nested after all', box.result.isNestedSeq(seqItem('Intro', 101), info) === true);
  // Reopening what was active is the whole reason the user tolerates the
  // fallback: the timeline must come back the way they left it.
  check('the timeline is put back', project.activeSequence.name === 'FINAL',
        project.activeSequence.name);
}

// ------------------------------------------------ 3) merged clips
console.log('\n3) A merged clip is not a nested sequence');
{
  const { info, box } = run(makeProject([
    { name: 'FINAL', id: 1, tracks: () => tracks([mergedItem('Interview', 55)]) },
    { name: 'Interview', id: 2, tracks: () => tracks([]) }
  ]));

  check('nothing was registered as nested', info.nestedFound === 0, String(info.nestedFound));
  check('the sequence named Interview stays put',
        box.result.isNestedSeq(seqItem('Interview', 2), info) === false);
  check('and a merged clip is not treated as a sequence item',
        box.result.isSequenceItem(mergedItem('Interview', 55)) === false);
}

// ---------------------------------------------- 4) the name fallback
console.log('\n4) The name fallback only fires when the name is unique');
{
  // Same name twice in the project: the nodeId seen in the timeline belongs to
  // one of them, and nothing says which — so neither may be moved on the name.
  const { info, box } = run(makeProject([
    { name: 'Master', id: 1, tracks: () => tracks([seqItem('Sequence 01', 900)]) },
    { name: 'Sequence 01', id: 2, tracks: () => tracks([]) },
    { name: 'Sequence 01', id: 3, tracks: () => tracks([]) }
  ]));

  check('a different nodeId with a shared name is not nested',
        box.result.isNestedSeq(seqItem('Sequence 01', 77), info) === false);
  check('but the exact nodeId still is',
        box.result.isNestedSeq(seqItem('Sequence 01', 900), info) === true);
}

// -------------------------------------- 5) inherited Object members
console.log('\n5) A sequence named after an Object member is safe');
{
  const { info, box } = run(makeProject([
    { name: 'FINAL', id: 1, tracks: () => tracks([]) },
    { name: 'constructor', id: 2, tracks: () => tracks([]) }
  ]));

  check('"constructor" is not nested by accident',
        box.result.isNestedSeq(seqItem('constructor', 2), info) === false);
  check('and neither is nodeId "toString"',
        box.result.isNestedSeq(seqItem('FINAL', 'toString'), info) === false);
}

// ------------------------------------------------ 6) errors surface
console.log('\n6) A host that refuses to answer says so');
{
  const project = makeProject([{ name: 'FINAL', id: 1, tracks: () => tracks([]) }]);
  Object.defineProperty(project.sequences[0], 'videoTracks', {
    get() { throw new Error('host refused'); },
    configurable: true
  });
  const { info } = run(project);

  check('the failure is recorded, not swallowed', info.errors.length > 0,
        info.errors.join(' | ') || 'none');
}

console.log(`\n${failed ? failed + ' failure(s)' : 'the nested split holds'}\n`);
process.exit(failed ? 1 : 0);
