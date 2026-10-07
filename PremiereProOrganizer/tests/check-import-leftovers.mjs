/**
 *   node tests/check-import-leftovers.mjs
 *
 * An import that recreated old bins INSIDE the plugin's bins — replayed on the
 * real project where it happened.
 *
 * Client B 6, 2026-09-30 17:28: importing the sequences of "Sources 10-3"
 * from an older project recreated that project's bins inside "01 sequence":
 * "nested sequence" (2 nests), "video" (5 rushes), "music & sound effect"
 * (3 sounds). The user clicked Organize at 17:31 (2.5.0): nothing moved —
 * incremental runs never opened a sub-bin — and the nests stayed among the
 * edits. The user's words: "les séquences ne sont pas dans leur dossier".
 *
 * The fixture is that project as saved at 19:07 (fixtures/real-import-
 * leftovers.json): every bin and sequence, who nests what, and the media the
 * plugin looks at. The rule pinned here (2.5.1):
 *   · a sub-bin of a plugin bin that carries a plugin bin name (a category or
 *     an old name) is an import leftover: its content is filed like a new
 *     import, and it goes once empty;
 *   · a sub-bin the user made inside "01 sequence" keeps its edits;
 *   · the user's own bins ("02 rushes & nests (jours)", "Sources …") are never
 *     entered;
 *   · the automatic pass after a Nest still opens no sub-bin.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildHost, payload, expectedBins } from '../tools/replay.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..') + '/';
const jsx = fs.readFileSync(ROOT + 'OrganizeFilesInProject.jsx', 'utf8');
const fx = JSON.parse(fs.readFileSync(ROOT + 'tests/fixtures/real-import-leftovers.json', 'utf8'));

let failed = 0;
const check = (name, ok, detail = '') => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '   -> ' + detail : ''}`);
  if (!ok) failed++;
};

const LEFTOVERS = ['01 sequence/nested sequence', '01 sequence/video', '01 sequence/music & sound effect'];
const USER_TOPS = ['02 rushes & nests (jours)', 'Sources 9-30 CB2new_ClientB2_1'];
const fresh = () => {
  const desc = JSON.parse(JSON.stringify(fx));
  const h = buildHost(desc, jsx);
  const where = () => { const w = {}; for (const it of desc.items) w[it.uid] = h.pathOf(h.itemObj[it.uid]); return w; };
  const bins = () => { const out = new Set(); const walk = (r, p = []) => { for (const k of r._kids) if (k.type === 2) { const q = p.concat(k.name); out.add(q.join('/')); walk(k, q); } }; walk(h.root); return out; };
  return { desc, h, where, bins };
};
const top = (p) => p.split('/')[0];

// ---------------------------------------------------------------- 0
console.log('\n0) The recorded project really has the shape that broke');
{
  const { desc, where, bins } = fresh();
  const w = where();
  const inLeftover = (p) => desc.items.filter((it) => w[it.uid] === p);
  check('2 nests inside "01 sequence/nested sequence"', inLeftover(LEFTOVERS[0]).length === 2 &&
        inLeftover(LEFTOVERS[0]).every((it) => it.kind === 'sequence'), inLeftover(LEFTOVERS[0]).map((it) => it.name).join(', '));
  check('5 rushes inside "01 sequence/video"', inLeftover(LEFTOVERS[1]).length === 5);
  check('3 sounds inside "01 sequence/music & sound effect"', inLeftover(LEFTOVERS[2]).length === 3);
  check('and the user\'s own bins are there', USER_TOPS.every((b) => bins().has(b)));
}

// ---------------------------------------------------------------- 1
console.log('\n1) One click on Organize');
{
  const { desc, h, where, bins } = fresh();
  const before = where(), binsBefore = bins();
  const pv = JSON.parse(h.O.previewOrganize(payload('incremental')));
  check('Preview moves nothing', JSON.stringify(where()) === JSON.stringify(before));
  const rep = JSON.parse(h.O.resetAndOrganize(payload('incremental')));
  const after = where();
  check('Preview predicted the run', pv.total === rep.total && JSON.stringify(pv.counts) === JSON.stringify(rep.counts),
        `${pv.total} / ${rep.total} ${JSON.stringify(rep.counts)}`);
  check('10 items filed: 2 nests, 5 rushes, 3 sounds', rep.total === 10 && rep.counts.nested === 2 &&
        rep.counts.video === 5 && rep.counts.audio === 3 && rep.failed === 0, JSON.stringify(rep.counts));

  const { isNest } = expectedBins(desc);
  const outside = desc.items.filter((it) => it.kind === 'sequence' && !USER_TOPS.includes(top(after[it.uid])));
  const nestsWrong = outside.filter((it) => isNest(it) && after[it.uid] !== '08 nested sequence');
  const editsWrong = outside.filter((it) => !isNest(it) && top(after[it.uid]) !== '01 sequence');
  check('every nest outside the user\'s bins is in 08 nested sequence', nestsWrong.length === 0,
        nestsWrong.map((it) => `${it.name} @ ${after[it.uid]}`).join(', ') || `${outside.filter(isNest).length} nests`);
  check('every edit outside the user\'s bins is in 01 sequence', editsWrong.length === 0,
        editsWrong.map((it) => `${it.name} @ ${after[it.uid]}`).join(', ') || 'none');
  check('01 sequence holds sequences only', desc.items.every((it) => top(after[it.uid]) !== '01 sequence' || it.kind === 'sequence'));
  check('the three leftover bins are gone', LEFTOVERS.every((b) => !bins().has(b)), [...bins()].filter((b) => b.startsWith('01 sequence/')).join(', '));
  check('…and named in the report', JSON.stringify((rep.leftoverBins || []).slice().sort()) === JSON.stringify(LEFTOVERS.slice().sort()), JSON.stringify(rep.leftoverBins));
  check('the edit in the user\'s sub-bin "01 sequence/9-29 V1 (…)" stays there',
        desc.items.some((it) => after[it.uid].startsWith('01 sequence/9-29 V1') && it.kind === 'sequence'));
  const userMoved = desc.items.filter((it) => USER_TOPS.includes(top(before[it.uid])) && after[it.uid] !== before[it.uid]);
  check('not one item left the user\'s bins (lots "Sources …", "02 rushes & nests (jours)")', userMoved.length === 0, String(userMoved.length));
  const userBinsGone = [...binsBefore].filter((b) => USER_TOPS.includes(top(b)) && !bins().has(b));
  check('not one of the user\'s bins was deleted', userBinsGone.length === 0, userBinsGone.join(', ') || `${[...binsBefore].filter((b) => USER_TOPS.includes(top(b))).length} kept`);

  const again = JSON.parse(h.O.resetAndOrganize(payload('incremental')));
  check('a second click moves nothing', again.total === 0 && (again.leftoverBins || []).length === 0, `${again.total} moved`);

  const undo = JSON.parse(h.O.undoOrganize(JSON.stringify(rep.undo)));
  const back = where();
  check('Undo puts the 10 back, leftover bins recreated', undo.restored === 10 &&
        desc.items.every((it) => back[it.uid] === before[it.uid]), JSON.stringify(undo));
}

// ---------------------------------------------------------------- 2
console.log('\n2) The automatic pass after a Nest opens no sub-bin');
{
  const { h, where } = fresh();
  const before = where();
  h.setActive('10/3');
  const nest = h.addNest('Nested Sequence 185', '10/3');
  h.resetCalls();
  const rep = JSON.parse(h.O.resetAndOrganize(payload('incremental', 'sequences')));
  check('the new Nest is filed into 08', h.pathOf(nest) === '08 nested sequence', h.pathOf(nest));
  const w = where();
  check('the leftovers wait for the Organize button', Object.keys(before).every((u) => w[u] === before[u]) && (rep.leftoverBins || []).length === 0);
  check('cheap: under 3 000 calls to Premiere', h.calls() < 3000, `${h.calls()} calls`);
}

console.log(`\n${failed ? failed + ' failure(s)' : 'what an import slips into the plugin\'s bins is filed'}\n`);
process.exit(failed ? 1 : 0);
