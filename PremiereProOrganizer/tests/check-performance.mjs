/**
 *   node tests/check-performance.mjs
 *
 * How long Premiere stays FROZEN while the plugin works, at the user's real
 * scale. ExtendScript is synchronous: every read of a Premiere object is one
 * round trip, and Premiere cannot redraw until the script returns.
 *
 * Measured in the run journal (2026-09-24 → 29): the automatic pass after a
 * Nest took 7–20 s on projects of 16 000–28 000 timeline clips, about once a
 * minute while editing. Replaying the plugin on those projects gave ~50 µs per
 * host call (173 708 calls ≈ 8.7 s on "Client B 5"), so the budget here is
 * expressed in calls.
 *
 * The project: the real 244-sequence structure of that project
 * (fixtures/real-project-sequences.json), with 28 000 media clips spread over
 * its timelines like the real one — 800 rushes cut into pieces, and titles /
 * graphics that belong to no project item.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildHost, payload } from '../tools/replay.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..') + '/';
const jsx = fs.readFileSync(ROOT + 'OrganizeFilesInProject.jsx', 'utf8');
const fx = JSON.parse(fs.readFileSync(ROOT + 'tests/fixtures/real-project-sequences.json', 'utf8'));

let failed = 0;
const check = (name, ok, detail = '') => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '   -> ' + detail : ''}`);
  if (!ok) failed++;
};

const CLIPS = 28000;
const RUSHES = 800;

// Deterministic pseudo-random, so every run builds the same project.
let seed = 42;
const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);

function realScaleProject() {
  const desc = { source: 'real-scale.prproj', bins: {}, items: [], sequences: [] };
  for (const [uid, b] of Object.entries(fx.bins)) desc.bins[uid] = { name: b.name, parent: b.parent };
  const videoBin = Object.entries(fx.bins).find(([, b]) => b.name === '02 video' && !b.parent);
  for (const it of fx.items) desc.items.push({ uid: it.uid, name: it.name, parent: it.parent, kind: 'sequence' });
  for (let r = 0; r < RUSHES; r++) {
    desc.items.push({ uid: 'm' + r, name: `A${String(r).padStart(3, '0')}_C001.mp4`, parent: videoBin ? videoBin[0] : null,
                      kind: 'media', path: `/Volumes/Rushes/A${r}_C001.mp4`, exists: true });
  }
  const perSeq = Math.floor(CLIPS / fx.sequences.length);
  for (const s of fx.sequences) {
    const v1 = [], v2 = [], a1 = [];
    for (let c = 0; c < perSeq; c++) {
      const x = rnd();
      if (x < 0.55) v1.push('m' + Math.floor(rnd() * RUSHES));   // cut rushes
      else if (x < 0.85) v2.push(null);                          // titles, graphics, adjustment layers
      else a1.push('m' + Math.floor(rnd() * RUSHES));            // audio
    }
    desc.sequences.push({ uid: s.uid, name: s.name, video: [v1, v2, s.contains.slice()], audio: [a1] });
  }
  return desc;
}

const clipsIn = (d) => d.sequences.reduce((n, s) => n + s.video.concat(s.audio).reduce((m, r) => m + r.length, 0), 0);

// ---------------------------------------------------------------- 1
console.log('\n1) The pass after a Nest: no timeline is read');
{
  const desc = realScaleProject();
  const h = buildHost(desc, jsx);
  h.setActive('9/26');
  h.O.resetAndOrganize(payload('incremental'));            // the project as the user has it: filed
  h.addNest('Nested Sequence 999', '9/26');
  h.resetCalls();
  const rep = JSON.parse(h.O.resetAndOrganize(payload('incremental', 'sequences')));
  check('the project is at real scale', clipsIn(desc) >= 27000, String(clipsIn(desc)));
  check('the new nest is filed into 08', h.pathOf(h.itemObj['new-Nested Sequence 999']) === '08 nested sequence');
  // The nest is known by its name. The pass still reads the ACTIVE timeline —
  // and only it — to catch a sequence of 01 sequence the user just used there
  // (hooks dragged into an assembly), never the other 243 timelines.
  const active9 = desc.sequences.find((s) => s.name === '9/26');
  const clips9 = active9.video.concat(active9.audio).reduce((m, r) => m + r.length, 0);
  check('only the active timeline was read', rep.scan === 'active' && rep.clipsRead === clips9, `${rep.scan} · ${rep.clipsRead} / ${clips9} clips`);
  check('under 3 000 calls to Premiere (≈ 0.15 s frozen; was ~170 000 ≈ 8.7 s)', h.calls() < 3000, `${h.calls()} calls ≈ ${(h.calls() * 5e-5).toFixed(2)} s`);
}

// ---------------------------------------------------------------- 2
console.log('\n2) A new, UNNAMED sequence: only the active timeline is read');
{
  const desc = realScaleProject();
  const h = buildHost(desc, jsx);
  h.setActive('9/26');
  h.O.resetAndOrganize(payload('incremental'));
  const nest = h.addNest('Intro Brand', '9/26');           // a nest renamed at once
  const active = desc.sequences.find((s) => s.name === '9/26');
  const activeClips = active.video.concat(active.audio).reduce((m, r) => m + r.length, 0);
  h.resetCalls();
  const rep = JSON.parse(h.O.resetAndOrganize(payload('incremental', 'sequences')));
  check('it is recognised as nested, from the active timeline', h.pathOf(nest) === '08 nested sequence', h.pathOf(nest));
  check('only the active timeline was read', rep.scan === 'active' && rep.clipsRead === activeClips, `${rep.scan} · ${rep.clipsRead} / ${activeClips} clips`);
  check('cost ∝ that timeline, not the project', h.calls() < activeClips * 4 + 3000, `${h.calls()} calls for ${activeClips} clips`);

  // …and a new edit, used nowhere, goes to the sequences bin
  const edit = h.addNest('9/30', null);
  h.resetCalls();
  JSON.parse(h.O.resetAndOrganize(payload('incremental', 'sequences')));
  check('a new edit (used nowhere) goes to 01 sequence', h.pathOf(edit) === '01 sequence', h.pathOf(edit));
}

// ---------------------------------------------------------------- 3
console.log('\n3) The Organize button: a complete check, each project item asked once');
{
  const desc = realScaleProject();
  const h = buildHost(desc, jsx);
  h.resetCalls();
  const rep = JSON.parse(h.O.resetAndOrganize(payload('incremental')));
  const clips = clipsIn(desc);
  check('every timeline was read (complete check)', rep.scan === 'full' && rep.clipsRead === clips, `${rep.clipsRead} / ${clips}`);
  check('under 4 calls per clip (was ~6.4)', h.calls() / clips < 4, `${(h.calls() / clips).toFixed(2)} calls/clip · ${h.calls()} total ≈ ${(h.calls() * 5e-5).toFixed(1)} s`);
  const again = JSON.parse(h.O.resetAndOrganize(payload('incremental')));
  check('a second click moves nothing', again.total === 0, String(again.total));
}

// ---------------------------------------------------------------- 4
console.log('\n4) Importing a batch of sequences into their own bin (how "jours préparés" is built)');
{
  const desc = realScaleProject();
  const h = buildHost(desc, jsx);
  h.O.resetAndOrganize(payload('incremental'));
  // 30 sequences arrive inside an imported "Sources 9-30 CB5" bin, half of
  // them in its own "08 nested sequence": the count of sequences jumps and the
  // automatic pass runs. It must neither move them nor read any timeline.
  const imported = h.addImport('Sources 9-30 CB5', Array.from({ length: 30 }, (_, i) => (i % 2 ? 'Nested Sequence ' + (500 + i) : '9/' + (i + 1))));
  const before = imported.map((o) => h.pathOf(o));
  h.resetCalls();
  const rep = JSON.parse(h.O.resetAndOrganize(payload('incremental', 'sequences')));
  check('the imported sequences stay in their bin', imported.every((o, i) => h.pathOf(o) === before[i]), before[0] + ' / ' + before[1]);
  check('nothing moved, no timeline read (none active), < 3 000 calls', rep.total === 0 && rep.clipsRead === 0 && h.calls() < 3000, `${rep.total} moved · ${rep.scan} · ${h.calls()} calls`);
  // The button (2.6.1): the import's own "08 nested sequence" is a plugin bin
  // inside the user's bin, so its 15 nests go to 08 and it disappears; the 15
  // edits sitting directly in "Sources 9-30 CB5" stay there.
  const manual = JSON.parse(h.O.resetAndOrganize(payload('incremental')));
  const nests = imported.filter((o, i) => i % 2), edits = imported.filter((o, i) => !(i % 2));
  check('the Organize button files the nests of the import\'s "08 nested sequence"', manual.total === 15 &&
        nests.every((o) => h.pathOf(o) === '08 nested sequence'), `${manual.total} moved`);
  check('…and leaves the edits in the user\'s "Sources 9-30 CB5"', edits.every((o) => h.pathOf(o) === 'Sources 9-30 CB5'), h.pathOf(edits[0]));
}

console.log(`\n${failed ? failed + ' failure(s)' : 'Premiere is not frozen by the automatic pass'}\n`);
process.exit(failed ? 1 : 0);
