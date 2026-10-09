/**
 *   node tests/check-plan.mjs
 *
 * The organizer end to end, against a fake Premiere project that behaves like
 * the real one where it matters: bins with live `children`, moveBin(),
 * createBin(), and a deleteBin() that REFUSES a non-empty bin — because the
 * real one would delete the contents, and that is the one thing this plugin
 * must never do.
 *
 * Covers the rules the panel promises:
 *   · incremental runs touch the root and the top of the plugin's own bins,
 *     never a bin the user made;
 *   · a full run goes everywhere (and says so);
 *   · empty bins the user prepared are left alone;
 *   · undo puts every item back where it came from, sub-bins included;
 *   · preview moves nothing;
 *   · categorisation: sequences vs nested, b-roll by name and by folder,
 *     exports by folder, audio split with whole-word short patterns.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..') + '/';
const jsx = fs.readFileSync(ROOT + 'OrganizeFilesInProject.jsx', 'utf8');

let failed = 0;
const check = (name, ok, detail = '') => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '   -> ' + detail : ''}`);
  if (!ok) failed++;
};

// ---------------------------------------------------------------- fake host
function makeHost(globals = {}) {
  let nextId = 100;
  const violations = [];
  const deleted = [];

  const base = (name, type) => ({
    name, type, nodeId: String(nextId++), _parent: null, _color: null,
    setColorLabel(c) { this._color = c; },
    moveBin(dest) { move(this, dest); }
  });
  const detach = (it) => {
    if (it._parent) { const k = it._parent._kids; k.splice(k.indexOf(it), 1); }
    it._parent = null;
  };
  const move = (it, dest) => { detach(it); dest._kids.push(it); it._parent = dest; };

  const bin = (name) => {
    const b = base(name, 2);
    b._kids = [];
    Object.defineProperty(b, 'children', {
      get() { const arr = b._kids.slice(); arr.numItems = arr.length; return arr; }
    });
    b.createBin = (n) => { const c = bin(n); move(c, b); return c; };
    b.deleteBin = () => {
      if (b._kids.length) { violations.push(b.name); throw new Error('deleteBin on non-empty ' + b.name); }
      deleted.push(b.name);
      detach(b);
    };
    return b;
  };

  const clip = (name, mediaPath, opts = {}) => Object.assign(base(name, 1), {
    _path: mediaPath || '',
    getMediaPath() { return this._path; },
    isSequence() { return !!opts.seq; },
    isMergedClip() { return !!opts.merged; },
    isOffline() { return !!opts.offline; }
  });

  const root = bin('root');
  root.type = 3;

  const seqTracks = (...items) => {
    const t = [{ clips: Object.assign(items.map((projectItem) => ({ projectItem })), { numItems: items.length }) }];
    t.numTracks = 1;
    return t;
  };
  const sequences = [];
  sequences.numSequences = 0;

  const app = {
    project: {
      rootItem: root, path: '/Volumes/Work/test.prproj', name: 'test',
      sequences, activeSequence: null,
      openSequence() { return false; }
    }
  };

  const pathOf = (it) => {
    const parts = [];
    for (let p = it._parent; p && p !== root; p = p._parent) parts.unshift(p.name);
    return parts.join('/');
  };
  const find = (name) => {
    const walk = (b) => {
      for (const k of b._kids) {
        if (k.name === name && k.type !== 2) return k;
        if (k.type === 2) { const r = walk(k); if (r) return r; }
      }
      return null;
    };
    return walk(root);
  };
  const binAt = (p) => {
    let cur = root;
    for (const seg of p.split('/')) {
      cur = cur._kids.find((k) => k.type === 2 && k.name.toLowerCase() === seg.toLowerCase());
      if (!cur) return null;
    }
    return cur;
  };
  const addSeq = (name, items, projectItem) => {
    const s = { name, sequenceID: 'S' + name };
    const t = seqTracks(...items);
    Object.defineProperty(s, 'videoTracks', { get: () => t });
    Object.defineProperty(s, 'audioTracks', { get: () => Object.assign([], { numTracks: 0 }) });
    sequences.push(s); sequences.numSequences = sequences.length;
    move(projectItem, root);
    return projectItem;
  };

  const box = Object.assign({ app }, globals);
  vm.createContext(box);
  new vm.Script(jsx).runInContext(box);
  const O = box.IsmaOrganizer;

  return { root, bin, clip, move, app, O, pathOf, find, binAt, addSeq, violations, deleted };
}

const payload = (mode, extra = {}) => JSON.stringify(Object.assign({
  mode,
  names: {
    video: '02 video', broll: '03 b-roll', audio: '04 music & sound effect',
    images: '05 images', anim: '06 animations & templates', styles: '07 styles',
    seq: '01 sequence', nested: '08 nested sequence', other: '09 other',
    exports: '10 exports', offline: '00 offline'
  },
  ignored: [], brollPatterns: ['DJI', 'GOPR', '/B-roll/'],
  exportPatterns: ['Exports', 'Renders'],
  audioSplit: true,
  sfxPatterns: ['sfx', 'whoosh', 'riser'],
  voicePatterns: ['vo', 'voix', 'interview'],
  colorLabels: true, refreshView: false
}, extra));

// A fresh project: everything at the root, plus what the user built by hand.
function freshProject(globals) {
  const h = makeHost(globals);
  const { root, bin, clip, move } = h;

  const at = (item, parent = root) => { move(item, parent); return item; };

  at(clip('A001_interview.mp4', '/Volumes/Cam/A001_interview.mp4'));
  at(clip('DJI_0042.mp4', '/Volumes/Cam/DJI_0042.mp4'));
  at(clip('kitchen_slow.mp4', '/Volumes/Stock/B-roll/kitchen_slow.mp4'));
  at(clip('7588196048716238101.mp4', '/Users/editor/Downloads/7588196048716238101.mp4'));
  at(clip('final_v3.mp4', '/Volumes/Work/Exports/final_v3.mp4'));
  at(clip('ambient_theme.mp3', '/Volumes/Audio/ambient_theme.mp3'));
  at(clip('whoosh_01.wav', '/Volumes/Audio/whoosh_01.wav'));
  at(clip('vo_intro.wav', '/Volumes/Audio/vo_intro.wav'));
  at(clip('love.mp3', '/Volumes/Audio/love.mp3'));            // NOT a voice-over
  at(clip('logo.png', '/Volumes/Gfx/logo.png'));
  at(clip('lower-third.mogrt', '/Volumes/Gfx/lower-third.mogrt'));
  at(clip('missing.mp4', '/Volumes/Gone/missing.mp4', { offline: true }));

  // sequences: FINAL uses Intro
  const introItem = clip('Intro', '', { seq: true });
  const finalItem = clip('FINAL', '', { seq: true });
  h.addSeq('FINAL', [introItem], finalItem);
  h.addSeq('Intro', [], introItem);

  // the user's own structure
  const marie = at(bin('Interview Marie'));
  at(clip('marie_cam_a.mp4', '/Volumes/Cam/marie_cam_a.mp4'), marie);
  at(bin('Exports prep'));                                    // empty, prepared on purpose

  return h;
}

// ================================================================ 1) fresh run
console.log('\n1) Incremental run on a fresh project');
{
  const h = freshProject();
  const rep = JSON.parse(h.O.resetAndOrganize(payload('incremental')));
  const p = (n) => h.pathOf(h.find(n));

  check('it reports a project path', rep.project === '/Volumes/Work/test.prproj', rep.project);
  check('A-roll → video', p('A001_interview.mp4') === '02 video', p('A001_interview.mp4'));
  check('DJI by name → b-roll', p('DJI_0042.mp4') === '03 b-roll');
  check('stock clip by FOLDER (/B-roll/) → b-roll', p('kitchen_slow.mp4') === '03 b-roll', p('kitchen_slow.mp4'));
  check('TikTok id → b-roll', p('7588196048716238101.mp4') === '03 b-roll');
  check('render in /Exports/ → exports, not video', p('final_v3.mp4') === '10 exports', p('final_v3.mp4'));
  check('music → audio/Music', p('ambient_theme.mp3') === '04 music & sound effect/Music', p('ambient_theme.mp3'));
  check('whoosh → audio/SFX', p('whoosh_01.wav') === '04 music & sound effect/SFX');
  check('vo_intro → audio/Voice', p('vo_intro.wav') === '04 music & sound effect/Voice');
  check('"love.mp3" is music, not a voice-over', p('love.mp3') === '04 music & sound effect/Music', p('love.mp3'));
  check('png → images', p('logo.png') === '05 images');
  check('mogrt → animations', p('lower-third.mogrt') === '06 animations & templates');
  check('offline clip → 00 offline', p('missing.mp4') === '00 offline');
  check('FINAL → sequences', p('FINAL') === '01 sequence', p('FINAL'));
  check('Intro (used inside FINAL) → nested', p('Intro') === '08 nested sequence', p('Intro'));

  check('the user\'s "Interview Marie" bin was not entered',
        p('marie_cam_a.mp4') === 'Interview Marie', p('marie_cam_a.mp4'));
  check('the empty "Exports prep" bin the user made still exists', !!h.binAt('Exports prep'));
  check('no non-empty bin was ever deleted', h.violations.length === 0, h.violations.join(', ') || 'none');

  check('report total = 14 moved (12 media + 2 sequences)', rep.total === 14, String(rep.total));
  check('undo snapshot has one entry per moved item', rep.undo.items.length === 14, String(rep.undo.items.length));
  check('every undo entry comes from the root', rep.undo.items.every((u) => u.from === ''));
  check('labels were applied', h.find('DJI_0042.mp4')._color === 10 && h.binAt('03 b-roll')._color === 10);

  // ---- run it again: nothing should move
  const again = JSON.parse(h.O.resetAndOrganize(payload('incremental')));
  check('second run moves nothing', again.total === 0, String(again.total));
  check('…and says how many it checked', again.unchanged === 14, String(again.unchanged));
  check('…and has nothing to undo', again.undo.items.length === 0);
  check('the sub-bins Music/SFX/Voice survived the second run',
        !!h.binAt('04 music & sound effect/SFX') && !!h.binAt('04 music & sound effect/Voice'));

  // ---- preview after the fact: nothing to do, nothing moved
  const pv = JSON.parse(h.O.previewOrganize(payload('incremental')));
  check('preview reports nothing to do', pv.preview === true && pv.total === 0 && pv.unchanged === 14);
}

// ================================================================ 2) preview first
console.log('\n2) Preview moves nothing and predicts the run');
{
  const h = freshProject();
  const before = JSON.stringify(h.root._kids.map((k) => k.name));
  const pv = JSON.parse(h.O.previewOrganize(payload('incremental')));
  const after = JSON.stringify(h.root._kids.map((k) => k.name));
  check('the project is untouched', before === after);
  check('no bin was created', !h.binAt('02 video'));
  check('it predicts 14 moves', pv.total === 14, String(pv.total));
  check('with samples per category', pv.samples.broll.length === 3, JSON.stringify(pv.samples.broll));
  const rep = JSON.parse(h.O.resetAndOrganize(payload('incremental')));
  check('the run matches the preview', rep.total === pv.total &&
        JSON.stringify(rep.counts) === JSON.stringify(pv.counts), JSON.stringify(rep.counts));
}

// ================================================================ 3) the user's sub-bins
console.log('\n3) Sub-bins inside the plugin\'s bins: incremental leaves them, full flattens them');
{
  const h = freshProject();
  h.O.resetAndOrganize(payload('incremental'));

  // the user files two b-rolls into 03 b-roll/Cuisine, and a misfiled mp3 lands
  // at the top of 02 video
  const broll = h.binAt('03 b-roll');
  const cuisine = broll.createBin('Cuisine');
  h.find('DJI_0042.mp4').moveBin(cuisine);
  h.find('kitchen_slow.mp4').moveBin(cuisine);
  h.find('love.mp3').moveBin(h.binAt('02 video'));

  const inc = JSON.parse(h.O.resetAndOrganize(payload('incremental')));
  check('incremental: the clips stay in Cuisine', h.pathOf(h.find('DJI_0042.mp4')) === '03 b-roll/Cuisine',
        h.pathOf(h.find('DJI_0042.mp4')));
  check('incremental: Cuisine still exists', !!h.binAt('03 b-roll/Cuisine'));
  check('incremental: the misfiled mp3 at the top of a plugin bin IS re-filed',
        h.pathOf(h.find('love.mp3')) === '04 music & sound effect/Music', h.pathOf(h.find('love.mp3')));
  check('incremental: exactly one item moved', inc.total === 1, String(inc.total));

  const full = JSON.parse(h.O.resetAndOrganize(payload('full')));
  check('full: the clips come up to 03 b-roll', h.pathOf(h.find('DJI_0042.mp4')) === '03 b-roll');
  check('full: Cuisine (emptied by us) is gone', !h.binAt('03 b-roll/Cuisine'));
  check('full: "Interview Marie" is emptied and gone', !h.binAt('Interview Marie') &&
        h.pathOf(h.find('marie_cam_a.mp4')) === '02 video');
  check('full: the empty "Exports prep" bin the user made STILL exists', !!h.binAt('Exports prep'));
  check('full: report says so', full.mode === 'full');
  check('full: undo remembers Cuisine', full.undo.items.some((u) => u.from === '03 b-roll/Cuisine'));

  // ---- undo the full run
  const undo = JSON.parse(h.O.undoOrganize(JSON.stringify(full.undo)));
  check('undo restored everything the full run moved', undo.restored === full.total && undo.failed === 0,
        `${undo.restored}/${full.total}`);
  check('undo recreated Cuisine and put the clips back',
        h.pathOf(h.find('DJI_0042.mp4')) === '03 b-roll/Cuisine' && h.pathOf(h.find('kitchen_slow.mp4')) === '03 b-roll/Cuisine');
  check('undo recreated "Interview Marie"', h.pathOf(h.find('marie_cam_a.mp4')) === 'Interview Marie');
  check('no non-empty bin was ever deleted', h.violations.length === 0, h.violations.join(', ') || 'none');
}

// ================================================================ 4) undo a fresh run
console.log('\n4) Undo after a fresh run empties and removes the bins it created');
{
  const h = freshProject();
  const rep = JSON.parse(h.O.resetAndOrganize(payload('incremental')));
  const undo = JSON.parse(h.O.undoOrganize(JSON.stringify(rep.undo)));
  check('all items restored', undo.restored === rep.total, `${undo.restored}/${rep.total}`);
  check('they are back at the root', h.pathOf(h.find('DJI_0042.mp4')) === '' && h.pathOf(h.find('Intro')) === '');
  check('the category bins are gone', !h.binAt('02 video') && !h.binAt('04 music & sound effect'));
  check('the user\'s bins are still there', !!h.binAt('Interview Marie') && !!h.binAt('Exports prep'));
  check('no non-empty bin was ever deleted', h.violations.length === 0);
}

// ================================================================ 5) ignore list
console.log('\n5) The Ignore list holds in both modes');
{
  const h = freshProject();
  const keep = h.bin('Keep');
  h.move(keep, h.root);
  const kept = h.clip('keep_me.mp4', '/Volumes/Cam/keep_me.mp4');
  h.move(kept, keep);
  h.O.resetAndOrganize(payload('full', { ignored: ['Keep'] }));
  check('a clip inside an ignored bin never moves', h.pathOf(kept) === 'Keep', h.pathOf(kept));
  const h2 = freshProject();
  const rep = JSON.parse(h2.O.resetAndOrganize(payload('incremental', { ignored: ['02 video'] })));
  check('an ignored category is skipped and reported', rep.skipped.includes('02 video'), JSON.stringify(rep.skipped));
  check('…and its clips stay where they were', h2.pathOf(h2.find('A001_interview.mp4')) === '' && !h2.binAt('02 video'));
}

// ================================================================ 6) audio split off
console.log('\n6) Audio split can be turned off');
{
  const h = freshProject();
  h.O.resetAndOrganize(payload('incremental', { audioSplit: false }));
  check('audio stays flat', h.pathOf(h.find('whoosh_01.wav')) === '04 music & sound effect');
  check('no SFX sub-bin', !h.binAt('04 music & sound effect/SFX'));
}

// ================================================================ 7) rules in isolation
console.log('\n7) Pattern rules');
{
  const h = makeHost();
  const t = h.O._test;
  check('"dji" without a slash does not match a disk called DJI_SSD',
        t.matchesBrollName('clip.mp4', 'clip.mp4', '/volumes/dji_ssd/clip.mp4', ['dji']) === false);
  check('"/b-roll/" matches the folder', t.matchesBrollName('x.mp4', 'x.mp4', '/v/b-roll/x.mp4', ['/b-roll/']) === true);
  check('"render" as an export word needs a whole folder — "surrender_final.mp4" is not one',
        t.matchesPathPattern('/v/cuts/surrender_final.mp4', ['render']) === false);
  check('…but /Renders/ is', t.matchesPathPattern('/v/renders/final.mp4', ['render' + 's']) === true);
  const ctx = { sfxPatterns: ['sfx', 'whoosh'], voicePatterns: ['vo', 'interview'] };
  check('vo_intro.wav → voice', t.audioSubFor('vo_intro.wav', '', '', ctx) === 'voice');
  check('love.mp3 → music', t.audioSubFor('love.mp3', '', '', ctx) === 'music');
  check('interview_marie_raw.wav → voice (long word, substring)', t.audioSubFor('interview_marie_raw.wav', '', '', ctx) === 'voice');
  check('big_whoosh.wav → sfx', t.audioSubFor('big_whoosh.wav', '', '', ctx) === 'sfx');
}

// ================================================================ 8) audit regressions
console.log('\n8) A user bin named like an audio sub-bin, at the root, is not ours');
{
  const h = freshProject();
  const voice = h.bin('Voice'); h.move(voice, h.root);
  const vclip = h.clip('take_03.mp4', '/Volumes/Cam/take_03.mp4'); h.move(vclip, voice);
  const music = h.bin('Music'); h.move(music, h.root);                 // empty, the user's
  h.O.resetAndOrganize(payload('incremental'));
  check('the clip inside the user\'s "Voice" bin stays', h.pathOf(vclip) === 'Voice', h.pathOf(vclip));
  check('the user\'s empty "Music" bin survives', !!h.binAt('Music'));
  h.O.backToNormal('[]');
  check('…even after Back to normal', !!h.binAt('Music'));
}

console.log('\n9) A bin name containing "/" survives a full run and its undo');
{
  const h = freshProject();
  const ab = h.bin('A/B'); h.move(ab, h.root);
  const c = h.clip('odd.mp4', '/Volumes/Cam/odd.mp4'); h.move(c, ab);
  const rep = JSON.parse(h.O.resetAndOrganize(payload('full')));
  const entry = rep.undo.items.find((u) => u.id === c.nodeId);
  check('the snapshot stores segments, not a joined string', Array.isArray(entry.fromParts) && entry.fromParts.length === 1, JSON.stringify(entry.fromParts));
  h.O.undoOrganize(JSON.stringify(rep.undo));
  check('undo puts it back into the bin literally named "A/B"', c._parent && c._parent.name === 'A/B' && c._parent._parent === h.root,
        c._parent && c._parent.name);
  check('no "A" > "B" chain was invented', !h.root._kids.some((k) => k.type === 2 && k.name === 'A'));
}

console.log('\n10) Undo only removes bins the run created');
{
  const h = freshProject();
  const mine = h.bin('02 video'); h.move(mine, h.root);                 // pre-existing, empty, the user's
  const rep = JSON.parse(h.O.resetAndOrganize(payload('incremental')));
  check('the run reused the existing "02 video"', h.binAt('02 video') === mine);
  check('…and did not list it for deletion', !rep.undo.bins.includes(mine.nodeId));
  h.O.undoOrganize(JSON.stringify(rep.undo));
  check('after undo the pre-existing bin is still there', h.binAt('02 video') === mine);
  check('while the created ones are gone', !h.binAt('03 b-roll') && !h.binAt('04 music & sound effect'));
}

console.log('\n11) Back to normal is undoable');
{
  const h = freshProject();
  h.O.resetAndOrganize(payload('incremental'));
  const flat = JSON.parse(h.O.backToNormal('[]'));
  check('it reports what it flattened', flat.total === 15 && flat.undo.items.length === 15, `${flat.total} / ${flat.undo.items.length}`);
  check('everything is at the root', h.pathOf(h.find('whoosh_01.wav')) === '');
  const undo = JSON.parse(h.O.undoOrganize(JSON.stringify(flat.undo)));
  check('undo rebuilds the bins and refiles everything', undo.restored === 15 &&
        h.pathOf(h.find('whoosh_01.wav')) === '04 music & sound effect/SFX' &&
        h.pathOf(h.find('marie_cam_a.mp4')) === 'Interview Marie', h.pathOf(h.find('whoosh_01.wav')));
}

console.log('\n12) Undo refuses another project\'s snapshot');
{
  const h = freshProject();
  const rep = JSON.parse(h.O.resetAndOrganize(payload('incremental')));
  check('the snapshot names its project', rep.undo.project === '/Volumes/Work/test.prproj');
  h.app.project.path = '/Volumes/Work/OTHER.prproj';
  const res = JSON.parse(h.O.undoOrganize(JSON.stringify(rep.undo)));
  check('it is refused, nothing moves', res.error === 'wrong-project' && h.pathOf(h.find('DJI_0042.mp4')) === '03 b-roll', JSON.stringify(res));
}

console.log('\n13) Full run merges a duplicate category bin and undo restores its sub-bin');
{
  const h = freshProject();
  const old = h.bin('Old stuff'); h.move(old, h.root);
  const dup = h.bin('02 video'); h.move(dup, old);                    // Old stuff/02 video
  const sub = h.bin('Cam B'); h.move(sub, dup);                        // Old stuff/02 video/Cam B
  const c = h.clip('camb_01.mp4', '/Volumes/Cam/camb_01.mp4'); h.move(c, sub);
  const rep = JSON.parse(h.O.resetAndOrganize(payload('full')));
  check('the nested duplicate was merged into the root category', !!h.binAt('02 video') && !h.binAt('Old stuff/02 video'));
  check('the clip ends up in 02 video (flattened)', h.pathOf(c) === '02 video', h.pathOf(c));
  const undo = JSON.parse(h.O.undoOrganize(JSON.stringify(rep.undo)));
  check('undo restores Old stuff/02 video/Cam B/camb_01.mp4', h.pathOf(c) === 'Old stuff/02 video/Cam B', h.pathOf(c) + ' · ' + JSON.stringify(undo));
  check('no non-empty bin was ever deleted', h.violations.length === 0, h.violations.join(', ') || 'none');
}

console.log('\n14) A refused move is reported by name and left out of the undo snapshot');
{
  const h = freshProject();
  const stuck = h.find('logo.png');
  stuck.moveBin = () => { throw new Error('locked'); };
  const rep = JSON.parse(h.O.resetAndOrganize(payload('incremental')));
  check('failed = 1 with its name', rep.failed === 1 && rep.failedNames[0] === 'logo.png', JSON.stringify(rep.failedNames));
  check('it is not in the snapshot', !rep.undo.items.some((u) => u.id === stuck.nodeId));
  check('the other 13 moved', rep.total === 13, String(rep.total));
}

// ================================================================ 15) 2.5.0
console.log('\n15) Backups made by AutoPod / AutoCut go to 01 sequence/Backups, not among the edits');
{
  const h = freshProject();
  const pod = h.clip('P__A0755 AutoPod Backup 09-23-2026 22:16:13', '', { seq: true });
  const cut = h.clip('AutoCut-Backup<||>4 VIDEO AOUT <||>Saturday, September 12 2026 22:54:03', '', { seq: true });
  h.addSeq('P__A0755 AutoPod Backup 09-23-2026 22:16:13', [], pod);
  h.addSeq('AutoCut-Backup<||>4 VIDEO AOUT <||>Saturday, September 12 2026 22:54:03', [], cut);
  const rep = JSON.parse(h.O.resetAndOrganize(payload('incremental')));
  check('the AutoPod backup is in 01 sequence/Backups', h.pathOf(pod) === '01 sequence/Backups', h.pathOf(pod));
  check('the AutoCut backup too', h.pathOf(cut) === '01 sequence/Backups', h.pathOf(cut));
  check('the real edit FINAL stays at the top of 01 sequence', h.pathOf(h.find('FINAL')) === '01 sequence');
  const again = JSON.parse(h.O.resetAndOrganize(payload('incremental')));
  check('a second run leaves them there', again.total === 0 && h.pathOf(pod) === '01 sequence/Backups', String(again.total));
  const auto = JSON.parse(h.O.resetAndOrganize(payload('incremental', { only: 'sequences' })));
  check('…and so does the automatic pass', auto.total === 0 && h.pathOf(cut) === '01 sequence/Backups', String(auto.total));
  h.O.undoOrganize(JSON.stringify(rep.undo));
  check('undo puts them back at the root and removes the Backups bin it created',
        h.pathOf(pod) === '' && !h.binAt('01 sequence/Backups'), h.pathOf(pod) + ' · ' + !!h.binAt('01 sequence/Backups'));
}

console.log('\n16) The automatic pass does not re-judge what is already filed; the Organize button does');
{
  const h = freshProject();
  h.O.resetAndOrganize(payload('incremental'));
  // An edit the user renamed and stopped using, sitting in 08 by an older run
  const stale = h.clip('Ancien intro', '', { seq: true });
  h.addSeq('Ancien intro', [], stale);
  stale.moveBin(h.binAt('08 nested sequence'));
  const auto = JSON.parse(h.O.resetAndOrganize(payload('incremental', { only: 'sequences' })));
  check('automatic pass: it stays in 08 (filed = decided), no timeline read', h.pathOf(stale) === '08 nested sequence' && auto.clipsRead === 0,
        h.pathOf(stale) + ' · ' + auto.scan + ' · ' + auto.clipsRead);
  const manual = JSON.parse(h.O.resetAndOrganize(payload('incremental')));
  check('Organize button: complete check, it goes to 01 sequence (used nowhere, not named like a nest)',
        h.pathOf(stale) === '01 sequence' && manual.scan === 'full', h.pathOf(stale) + ' · ' + manual.scan);
}

console.log('\n17) The old unnumbered "nested sequence" bin, in the automatic pass');
{
  const h = freshProject();
  h.O.resetAndOrganize(payload('incremental'));
  const old = h.bin('nested sequence'); h.move(old, h.root);
  const renamed = h.clip('Brand intro', '', { seq: true });   // a nest renamed by hand, used in FINAL
  h.addSeq('Brand intro', [], renamed);
  renamed.moveBin(old);
  const auto = JSON.parse(h.O.resetAndOrganize(payload('incremental', { only: 'sequences', legacyBins: true })));
  check('its content is merged into 08 nested sequence, without reading timelines',
        h.pathOf(renamed) === '08 nested sequence' && auto.clipsRead === 0, h.pathOf(renamed) + ' · ' + auto.scan + ' · ' + auto.clipsRead);
  check('the emptied old bin is removed', !h.binAt('nested sequence'));
  check('no non-empty bin was ever deleted', h.violations.length === 0, h.violations.join(', ') || 'none');
}

// ================================================================ 18) audits of 2.5.0
const autoPass = (h) => JSON.parse(h.O.resetAndOrganize(payload('incremental', { only: 'sequences' })));
const activate = (h, name) => { h.app.project.activeSequence = h.app.project.sequences.find((s) => s.name === name) || null; };

console.log('\n18) A "Backups" bin the USER made inside 01 sequence is his (code audit C2)');
{
  const h = freshProject();
  h.O.resetAndOrganize(payload('incremental'));
  const mine = h.bin('Backups'); h.move(mine, h.binAt('01 sequence'));
  const v1 = h.clip('Edit v1', '', { seq: true }); h.addSeq('Edit v1', [], v1); v1.moveBin(mine);
  autoPass(h);
  h.O.resetAndOrganize(payload('incremental'));
  check('his edits stay in it, through both passes', h.pathOf(v1) === '01 sequence/Backups', h.pathOf(v1));
  check('…and the bin is kept', h.binAt('01 sequence/Backups') === mine);
  const pod = h.clip('P__A0755 AutoPod Backup 09-23-2026 22:16:13', '', { seq: true }); h.addSeq(pod.name, [], pod);
  h.O.resetAndOrganize(payload('incremental'));
  check('an AutoPod backup is still dropped into it (fill only)', h.pathOf(pod) === '01 sequence/Backups', h.pathOf(pod));
}

console.log('\n19) Ignored sub-bins are neither entered nor filled (code audit S2)');
{
  const h = freshProject();
  h.O.resetAndOrganize(payload('incremental'));
  const theme = h.clip('my_theme.mp3', '/Volumes/Audio/my_theme.mp3');
  theme.moveBin(h.binAt('04 music & sound effect/SFX'));        // the user put it there on purpose
  const w2 = h.clip('whoosh_02.wav', '/Volumes/Audio/whoosh_02.wav'); h.move(w2, h.root);
  h.O.resetAndOrganize(payload('incremental', { ignored: ['SFX'] }));
  check('what the user put in an ignored SFX stays there', h.pathOf(theme) === '04 music & sound effect/SFX', h.pathOf(theme));
  check('a new SFX goes to the top of the audio bin, not into the ignored one', h.pathOf(w2) === '04 music & sound effect', h.pathOf(w2));
  const again = JSON.parse(h.O.resetAndOrganize(payload('incremental', { ignored: ['SFX'] })));
  check('…and stays there on the next run (no endless move)', again.total === 0 && h.pathOf(w2) === '04 music & sound effect', String(again.total));
}

console.log('\n20) Only AutoCut / AutoPod backups count as backups (code audit S3)');
{
  const h = freshProject();
  const plan = h.clip('Backup plan - FINAL', '', { seq: true }); h.addSeq(plan.name, [], plan);
  const cam = h.clip('Interview backup cam', '', { seq: true }); h.addSeq(cam.name, [], cam);
  h.O.resetAndOrganize(payload('incremental'));
  check('"Backup plan - FINAL" is an edit → 01 sequence', h.pathOf(plan) === '01 sequence', h.pathOf(plan));
  check('"Interview backup cam" too', h.pathOf(cam) === '01 sequence', h.pathOf(cam));
}

console.log('\n21) Cleanup never removes a category bin that was empty before the run (code audit N3)');
{
  // A project whose only sequence is an AutoPod backup that cannot be moved:
  // the run creates "01 sequence/Backups", the move is refused, Backups stays
  // empty and is removed — and must NOT take the user's pre-existing, empty
  // "01 sequence" with it.
  const h = makeHost();
  const seqBin = h.bin('01 sequence'); h.move(seqBin, h.root);
  const pod = h.clip('P__A0755 AutoPod Backup 09-23-2026 22:16:13', '', { seq: true });
  h.addSeq(pod.name, [], pod);
  pod.moveBin = () => { throw new Error('locked'); };
  const rep = JSON.parse(h.O.resetAndOrganize(payload('incremental')));
  check('the refused move is reported', rep.failed === 1, String(rep.failed));
  check('the pre-existing (empty) 01 sequence survives', !!h.binAt('01 sequence') && h.binAt('01 sequence') === seqBin);
  check('the empty Backups created by this run is removed', !h.binAt('01 sequence/Backups'));
  check('no non-empty bin was deleted', h.violations.length === 0, h.violations.join(', ') || 'none');
}

console.log('\n22) A leftover refresh bin inside a category bin is cleaned by the next Organize (code audit N4)');
{
  const h = freshProject();
  h.O.resetAndOrganize(payload('incremental'));
  const left = h.bin('__isma_refresh__'); h.move(left, h.binAt('02 video'));
  h.O.resetAndOrganize(payload('incremental'));
  check('the leftover is gone', !h.binAt('02 video/__isma_refresh__'));
}

console.log('\n23) Old plugin bins: a CLOSED list — a user bin called "Exports" is his (pre-existing bug)');
{
  const h = freshProject();
  const exp = h.bin('Exports'); h.move(exp, h.root);
  const client = h.clip('Client_v3.mp4', '/Volumes/Work/Client_v3.mp4'); h.move(client, exp);
  const oldVideo = h.bin('video'); h.move(oldVideo, h.root);              // a bin made by an old version
  const rush = h.clip('C0042.MP4', '/Volumes/Cam/C0042.MP4'); h.move(rush, oldVideo);
  h.O.resetAndOrganize(payload('incremental', { legacyBins: true }));
  check('"Exports/Client_v3.mp4" is left alone', h.pathOf(client) === 'Exports', h.pathOf(client));
  check('…and the bin is kept', !!h.binAt('Exports'));
  check('the old unnumbered "video" bin is merged into 02 video', h.pathOf(rush) === '02 video' && !h.binAt('video'), h.pathOf(rush));
}

console.log('\n24) The automatic pass and sequences (both audits)');
{
  // a) created as an edit, then dragged into another timeline: caught while that timeline is active
  const h = freshProject();
  h.O.resetAndOrganize(payload('incremental'));
  const hook = h.clip('Hook 1', '', { seq: true }); h.addSeq('Hook 1', [], hook);
  h.O.resetAndOrganize(payload('incremental'));
  check('"Hook 1" starts in 01 sequence', h.pathOf(hook) === '01 sequence', h.pathOf(hook));
  const ads = h.clip('4 ADS CLIENT A', '', { seq: true }); h.addSeq('4 ADS CLIENT A', [hook], ads);
  activate(h, '4 ADS CLIENT A');
  autoPass(h);
  check('used in the active assembly → 08 at the next automatic pass', h.pathOf(hook) === '08 nested sequence', h.pathOf(hook));

  // b) a backlog of unnamed sequences not in the active timeline: left for Organize
  const g = freshProject();
  g.O.resetAndOrganize(payload('incremental'));
  const e = g.clip('e', '', { seq: true });                  // a renamed nest, used in FINAL
  g.addSeq('e', [], e);
  g.app.project.sequences.find((s) => s.name === 'FINAL').videoTracks[0].clips.push({ projectItem: e });
  g.app.project.sequences.find((s) => s.name === 'FINAL').videoTracks[0].clips.numItems++;
  const edit = g.clip('9/30', '', { seq: true }); g.addSeq('9/30', [], edit);
  activate(g, 'Intro');                                        // another timeline is active
  const rep = autoPass(g);
  check('two unnamed newcomers, neither in the active timeline → both stay at the root', g.pathOf(e) === '' && g.pathOf(edit) === '', g.pathOf(e) + ' / ' + g.pathOf(edit));
  check('…reported as waiting for Organize', rep.keptSeqs.length === 2, JSON.stringify(rep.keptSeqs));
  g.O.resetAndOrganize(payload('incremental'));
  check('Organize then sorts them right: e → 08, 9/30 → 01', g.pathOf(e) === '08 nested sequence' && g.pathOf(edit) === '01 sequence', g.pathOf(e) + ' / ' + g.pathOf(edit));

  // c) a single new unnamed sequence is a new edit
  const f = freshProject();
  f.O.resetAndOrganize(payload('incremental'));
  const solo = f.clip('10/1', '', { seq: true }); f.addSeq('10/1', [], solo);
  autoPass(f);
  check('one new unnamed sequence → 01 sequence', f.pathOf(solo) === '01 sequence', f.pathOf(solo));

  // d) the Organize button does not read every timeline when every sequence it sees is named
  const k = makeHost();
  const n1 = k.clip('Nested Sequence 1', '', { seq: true }); k.addSeq('Nested Sequence 1', [], n1);
  const r2 = JSON.parse(k.O.resetAndOrganize(payload('incremental')));
  check('only named nests → no timeline read', r2.scan === 'none' && k.pathOf(n1) === '08 nested sequence', r2.scan);
}

console.log('\n25) Media rules from the real-data audit (names from the user\'s projects)');
{
  const t = makeHost().O._test;
  const broll = (name, p) => t.looksLikeSocialName(name, name) || t.nearestFolderKind(p || '/x/' + name) === 'broll';
  [
    ['young-adult-in-bed-using-phone-2026-09-17-17-02-47-utc.mp4', 'Envato Elements'],
    ['PinDown.io_@hope_pin_1774103245.mp4', 'PinDown'],
    ['From Klickpin.com- 5 Stunning Daily Reset Ideas-pin-id-67131850691878709.mp4', 'KlickPin'],
    ['snaptik_6888703287718202630_v3.mp4', 'snaptik'],
    ['7580272-uhd_2160_4096_25fps.mp4', 'Pexels'],
    ['Anatomy_Pituitary_Gland_fhd_4227461.mp4', 'Pexels-like id'],
    ['tuftandpaw - 7272539256923475205.mp4', 'TikTok with account'],
    ['7398521278027615521sd.mp4', 'TikTok id + quality']
  ].forEach(([n, why]) => check(`b-roll: ${why}`, broll(n), n));
  check('b-roll: a clip in a "B ROLLS" folder', t.nearestFolderKind('/Users/x/New reels/B ROLLS/B-ROLL CONSULTATIONS/IMG_1221.MOV') === 'broll');
  check('b-roll: "Assets/B roll/…"', t.nearestFolderKind('/Volumes/Ssd 2/Client A/Assets/B roll/My Numbers/700k.mp4') === 'broll');
  check('not b-roll: a client rush in Downloads', !broll('03-13-2026(5).mp4', '/Volumes/Ssd 2/01 Rushes/Rushes du Mac/Downloads/Editor/03-13-2026(5).mp4'));
  check('not b-roll: a camera timestamp', !t.looksLikeSocialName('VID_20240101120000123.mp4', ''));

  const ctx = { sfxPatterns: ['sfx', 'whoosh', 'riser', 'impact', 'swoosh', 'hit', 'foley', 'transition'],
                voicePatterns: ['vo', 'voix', 'voice', 'voice-over', 'voiceover', 'itw', 'interview', 'narration'] };
  const sub = (n, p) => t.audioSubFor(n, n, p || '/Volumes/Audio/' + n, ctx);
  check('voice: ElevenLabs', sub('ElevenLabs_2026-09-26T19_49_36_Adam - American, Dark and Tough_pvc_sp100_s50_sb75_v3.mp3') === 'voice');
  check('voice: Adobe Enhance Speech (even with "music" in the name)', sub('8-16-esv2-50p-bg-1p-music-m.wav') === 'voice');
  check('voice: mic track "…_M_MIC_1.wav"', sub('2026_05_11_SPEAKER_01_QL_M_MIC_1.wav') === 'voice');
  check('voice: "MIC3.WAV"', sub('MIC3.WAV') === 'voice');
  check('voice: "Track1-Mic 1.wav"', sub('Track1-Mic 1.wav') === 'voice');
  check('not voice: "Mic Drop SFX.wav" is an SFX', sub('Mic Drop SFX.wav') === 'sfx');
  check('music words win: "…Background Music … Cinematic Impact.m4a"', sub('Motivational Speaker Background Music   No Vocals, Pure Cinematic Impact.m4a') === 'music');
  check('SFX by folder: "SFX Library/Clicks & UI/Tap 4.wav"', sub('Tap 4.wav', '/Volumes/Audio/SFX Library/Clicks & UI/Tap 4.wav') === 'sfx');
  check('SFX by folder: Premiere Composer audio', sub('Data Beep 05.wav', '/Users/x/Premiere Composer Files/Audio/Data Beep 05.wav') === 'sfx');
  check('the nearest folder wins: "Music & SFX/Music/x.mp3" is music', sub('x.mp3', '/Volumes/A/Music & SFX/Music/x.mp3') === 'music');
  check('short words still whole words: "hit" in a song title is no SFX when "music" is there', sub('Hit the road music.mp3') === 'music');
}

console.log('\n26) Real-data routing, end to end');
{
  const h = freshProject({ Folder: (p) => ({ exists: p !== '/Volumes/Ssd' }) });
  const song = h.clip('THANK YOU - INSTRUMENTAL - Tyler, The Creator.mp4', '/Volumes/Ssd 2/Musique/Tyler/THANK YOU - INSTRUMENTAL - Tyler, The Creator.mp4'); h.move(song, h.root);
  const blade = h.clip('BLADE WHOOSH SFX.mp4', '/Volumes/Ssd 2/FX/BLADE WHOOSH SFX.mp4'); h.move(blade, h.root);
  const exp = h.clip('1.mp4', '/Volumes/Ssd 2/Client B/03 Exports/2026-08-01/1.mp4'); h.move(exp, h.root);
  const env = h.clip('young-adult-in-bed-using-phone-2026-09-17-17-02-47-utc.mp4', '/Volumes/Ssd 2/Envato/young-adult-in-bed-using-phone-2026-09-17-17-02-47-utc.mp4'); h.move(env, h.root);
  const unplugged = h.clip('DJI_0071.MP4', '/Volumes/Ssd/ClientC/B rolls/DJI_0071.MP4', { offline: true }); h.move(unplugged, h.root);
  const deleted = h.clip('gone.mp4', '/Users/editor/Downloads/gone.mp4', { offline: true }); h.move(deleted, h.root);
  const rep = JSON.parse(h.O.resetAndOrganize(payload('incremental')));
  check('a music video from "Musique/" → audio/Music', h.pathOf(song) === '04 music & sound effect/Music', h.pathOf(song));
  check('"BLADE WHOOSH SFX.mp4" → audio/SFX', h.pathOf(blade) === '04 music & sound effect/SFX', h.pathOf(blade));
  check('a render in "03 Exports" → 10 exports', h.pathOf(exp) === '10 exports', h.pathOf(exp));
  check('an Envato clip → 03 b-roll', h.pathOf(env) === '03 b-roll', h.pathOf(env));
  check('offline on an UNPLUGGED drive → left where it is', h.pathOf(unplugged) === '', h.pathOf(unplugged));
  check('…and reported by drive', rep.driveMissing && rep.driveMissing.Ssd === 1, JSON.stringify(rep.driveMissing));
  check('really missing (drive mounted) → 00 offline', h.pathOf(deleted) === '00 offline', h.pathOf(deleted));
}

console.log('\n27) What an import slips INSIDE the plugin\'s bins (2.5.1)');
{
  // Client B 6, 30/09: importing sequences from an old project recreated its
  // bins inside "01 sequence"; Client C ads: 13 edits asleep in "other/Sequence".
  const h = freshProject();
  h.O.resetAndOrganize(payload('incremental', { ignored: ['Keep me'], legacyBins: true }));
  const seqBin = h.binAt('01 sequence'), nestBin = h.binAt('08 nested sequence'), brollBin = h.binAt('03 b-roll');
  const seq = (name, uses = []) => { const it = h.clip(name, '', { seq: true }); h.addSeq(name, uses, it); return it; };

  // leftovers of the import, one of them two levels deep
  const oldNested = seqBin.createBin('nested sequence'), oldVideo = seqBin.createBin('video'), oldAudio = seqBin.createBin('music & sound effect');
  const ns81 = seq('Nested Sequence 81'); h.move(ns81, oldNested);
  const ns82 = seq('Nested Sequence 82', [ns81]); h.move(ns82, oldNested);
  const rush = h.clip('C2187.mp4', '/Volumes/Ssd 2/Rushes/C2187.mp4'); h.move(rush, oldVideo);
  const deeper = oldVideo.createBin('Old');
  const rush2 = h.clip('0212.mp4', '/Volumes/Ssd 2/Rushes/0212.mp4'); h.move(rush2, deeper);
  const song = h.clip('Some Band - Night Drive (Instrumental).mp3', '/Users/editor/Downloads/Some Band - Night Drive (Instrumental).mp3'); h.move(song, oldAudio);

  // the user's own sub-bins inside 01 and 08
  const v1 = seqBin.createBin('9-29 V1');
  const hook = seq('Hook 2');
  const edit = seq('9/29 V1', [hook]);
  h.move(hook, v1); h.move(edit, v1);
  const png = h.clip('frame.png', '/Volumes/Gfx/frame.png'); h.move(png, v1);
  const oldNests = nestBin.createBin('Old nests');
  const ns5 = seq('Nested Sequence 5'); h.move(ns5, oldNests);
  const stray = seq('10/2'); h.move(stray, oldNests);
  // a sub-bin on the Ignore list, a media bin's sub-bin, the user's own bin
  const keep = seqBin.createBin('Keep me');
  const ns6 = seq('Nested Sequence 6'); h.move(ns6, keep);
  const ns7 = seq('Nested Sequence 7'); h.move(ns7, h.binAt('03 b-roll/Cuisine') || brollBin.createBin('Cuisine'));
  const lot = h.root.createBin('Sources 10-3'), lotNested = lot.createBin('nested sequence');
  const ns8 = seq('Nested Sequence 8'); h.move(ns8, lotNested);
  // Client C ads: an old "other" bin with a "Sequence" sub-bin, and a user sub-bin
  const other = h.root.createBin('other'), otherSeq = other.createBin('Sequence'), vid1 = other.createBin('Vid1');
  const newAds = seq('New ads'); h.move(newAds, otherSeq);
  const ns9 = seq('Nested Sequence 9'); h.move(ns9, vid1);

  const P = (it) => h.pathOf(it);
  const opts = { ignored: ['Keep me'], legacyBins: true };
  const pv = JSON.parse(h.O.previewOrganize(payload('incremental', opts)));
  check('Preview names the leftover bins, moves nothing', pv.leftoverBins.length === 5 && P(ns81) === '01 sequence/nested sequence',
        JSON.stringify(pv.leftoverBins));
  const rep = JSON.parse(h.O.resetAndOrganize(payload('incremental', opts)));
  check('Preview predicted the run', pv.total === rep.total, `${pv.total} / ${rep.total}`);
  check('nests out of "01 sequence/nested sequence" → 08', P(ns81) === '08 nested sequence' && P(ns82) === '08 nested sequence', P(ns81) + ' / ' + P(ns82));
  check('rushes out of "01 sequence/video", even two levels deep → 02 video', P(rush) === '02 video' && P(rush2) === '02 video', P(rush) + ' / ' + P(rush2));
  check('the song out of "01 sequence/music & sound effect" → audio/Music', P(song) === '04 music & sound effect/Music', P(song));
  check('the leftover bins are gone', !h.binAt('01 sequence/nested sequence') && !h.binAt('01 sequence/video') &&
        !h.binAt('01 sequence/music & sound effect') && !h.binAt('other/Sequence'));
  check('the user\'s "01 sequence/9-29 V1" keeps its edit', P(edit) === '01 sequence/9-29 V1', P(edit));
  check('…but the hook used in it is a nest → 08', P(hook) === '08 nested sequence', P(hook));
  check('…and the png has no business among sequences → 05 images', P(png) === '05 images', P(png));
  check('"08 nested sequence/Old nests" keeps its nest', P(ns5) === '08 nested sequence/Old nests', P(ns5));
  check('…and its stray edit goes to 01 sequence', P(stray) === '01 sequence', P(stray));
  check('a sub-bin on the Ignore list is not opened', P(ns6) === '01 sequence/Keep me', P(ns6));
  check('a media bin\'s sub-bin is the user\'s (03 b-roll/Cuisine)', P(ns7) === '03 b-roll/Cuisine', P(ns7));
  // Until 2.6.0 the user's own bins were never entered, so this nest stayed in
  // "Sources 10-3/nested sequence". 2.6.1 (see 33): a bin with a plugin name
  // is an import leftover wherever it sits, and the bin it leaves empty goes.
  check('a "nested sequence" inside the user\'s "Sources 10-3" is a leftover too → 08', P(ns8) === '08 nested sequence', P(ns8));
  check('…and "Sources 10-3", left empty, goes', !h.binAt('Sources 10-3'));
  check('Client C ads: the edit in "other/Sequence" → 01 sequence', P(newAds) === '01 sequence', P(newAds));
  check('…the user sub-bin "other/Vid1" is left alone', P(ns9) === 'other/Vid1', P(ns9));
  check('no non-empty bin was ever deleted', h.violations.length === 0, h.violations.join(', ') || 'none');
  const again = JSON.parse(h.O.resetAndOrganize(payload('incremental', opts)));
  check('a second click moves nothing', again.total === 0, String(again.total));
  const undo = JSON.parse(h.O.undoOrganize(JSON.stringify(rep.undo)));
  check('Undo recreates the leftover bins and puts everything back', undo.failed === 0 && P(ns81) === '01 sequence/nested sequence' &&
        P(rush2) === '01 sequence/video/Old' && P(newAds) === 'other/Sequence' && P(hook) === '01 sequence/9-29 V1' &&
        P(ns8) === 'Sources 10-3/nested sequence', JSON.stringify(undo));

  // the automatic pass after a Nest stays at the top
  const g = freshProject();
  g.O.resetAndOrganize(payload('incremental'));
  const left = g.binAt('01 sequence').createBin('nested sequence');
  const n90 = g.clip('Nested Sequence 90', '', { seq: true }); g.addSeq('Nested Sequence 90', [], n90); g.move(n90, left);
  const n91 = g.clip('Nested Sequence 91', '', { seq: true }); g.addSeq('Nested Sequence 91', [], n91);
  const ar = JSON.parse(g.O.resetAndOrganize(payload('incremental', { only: 'sequences', legacyBins: true })));
  check('automatic pass: the new Nest at the root is filed, the leftover waits', g.pathOf(n91) === '08 nested sequence' &&
        g.pathOf(n90) === '01 sequence/nested sequence' && ar.leftoverBins.length === 0, g.pathOf(n91) + ' / ' + g.pathOf(n90));

  // an "01 sequence" that held nothing but the leftover goes with it
  const k = makeHost();
  const s01 = k.root.createBin('01 sequence'), inner = s01.createBin('nested sequence');
  const n1 = k.clip('Nested Sequence 1', '', { seq: true }); k.addSeq('Nested Sequence 1', [], n1); k.move(n1, inner);
  k.O.resetAndOrganize(payload('incremental', { legacyBins: true }));
  check('an 01 sequence emptied by the cleanup goes too, nothing else', !k.binAt('01 sequence') && k.pathOf(n1) === '08 nested sequence' &&
        k.violations.length === 0, k.pathOf(n1));
}

console.log('\n28) The user\'s own rules for sequences, by name (2.5.1)');
{
  const t = makeHost().O._test;
  check('"Hook" matches "Hook 1", "hook 7" and "Hook1"', t.hasNameWords('Hook 1', ['Hook']) && t.hasNameWords('hook 7', ['Hook']) && t.hasNameWords('Hook1', ['Hook']));
  check('…whole words only: not "Hookah", and "Body" not "Nobody"', !t.hasNameWords('Hookah', ['Hook']) && !t.hasNameWords('Nobody', ['Body']));
  check('two words in order: "4 ADS" matches "4 ADS CLIENT A", not "ADS 4"', t.hasNameWords('4 ADS CLIENT A', ['4 ADS']) && !t.hasNameWords('ADS 4', ['4 ADS']));
  check('accents and case: "témoignage" matches "Témoignage 2"', t.hasNameWords('Témoignage 2', ['témoignage']));
  check('an empty rule matches nothing', !t.hasNameWords('Hook 1', ['', '  ']));

  // Project D, 30/09: "Hook 1" … "Body 5" live in 08 because "4 ADS CLIENT A" uses them
  const h = makeHost();
  const seq = (k, name, uses = []) => { const it = k.clip(name, '', { seq: true }); k.addSeq(name, uses, it); return it; };
  const hook1 = seq(h, 'Hook 1'), hook7 = seq(h, 'hook 7'), body2 = seq(h, 'Body  2');
  const cut = seq(h, 'Cut 3');                      // used nowhere, a nest for the user
  const intro = seq(h, 'Intro');                    // no rule: detection as before
  seq(h, '4 ADS CLIENT A', [hook1, hook7, body2]);
  seq(h, 'FINAL', [intro]);
  const ns12 = seq(h, 'Nested Sequence 12');
  const bk = seq(h, 'AutoCut-Backup<||>Hook 1');
  const rules = { seqPatterns: ['Hook', 'Body', 'Sequence'], nestedPatterns: ['Cut'] };
  const pv = JSON.parse(h.O.previewOrganize(payload('incremental', rules)));
  const rep = JSON.parse(h.O.resetAndOrganize(payload('incremental', rules)));
  const P = (x) => h.pathOf(x);
  check('"Hook 1", "hook 7", "Body  2" → 01 sequence, although "4 ADS CLIENT A" uses them',
        [hook1, hook7, body2].every((x) => P(x) === '01 sequence'), [hook1, hook7, body2].map(P).join(' / '));
  check('"Cut 3" → 08 nested sequence, although no timeline uses it', P(cut) === '08 nested sequence', P(cut));
  check('no rule for "Intro": used in FINAL → 08, as before', P(intro) === '08 nested sequence', P(intro));
  check('"Nested Sequence 12" stays a nest ("Sequence" in Always edits does not win)', P(ns12) === '08 nested sequence', P(ns12));
  check('an AutoCut backup of a hook still goes to Backups', P(bk) === '01 sequence/Backups', P(bk));
  check('the report counts what the rules decided (4)', rep.byRule === 4, String(rep.byRule));
  check('Preview predicted the run', pv.total === rep.total && pv.byRule === rep.byRule, `${pv.total} / ${rep.total}`);

  // filed the old way first, then the user writes the rule: Organize moves them
  const g = makeHost();
  const gh = seq(g, 'Hook 2'); seq(g, '4 ADS CLIENT A', [gh]);
  g.O.resetAndOrganize(payload('incremental'));
  check('without a rule, "Hook 2" used in "4 ADS CLIENT A" is a nest', g.pathOf(gh) === '08 nested sequence', g.pathOf(gh));
  g.O.resetAndOrganize(payload('incremental', { seqPatterns: ['Hook'] }));
  check('with the rule, the next Organize moves it to 01 sequence', g.pathOf(gh) === '01 sequence', g.pathOf(gh));
  const again = JSON.parse(g.O.resetAndOrganize(payload('incremental', { seqPatterns: ['Hook'] })));
  check('…and a second click moves nothing', again.total === 0, String(again.total));

  // the automatic pass: a duplicated hook lands at the root while "4 ADS CLIENT A" is open
  const k = makeHost();
  const kh = seq(k, 'Hook 1'); seq(k, '4 ADS CLIENT A', [kh]);
  k.O.resetAndOrganize(payload('incremental', { seqPatterns: ['Hook'] }));
  const kh15 = seq(k, 'Hook 15');
  k.app.project.sequences.find((s) => s.name === '4 ADS CLIENT A').videoTracks[0].clips.push({ projectItem: kh15 });
  k.app.project.sequences.find((s) => s.name === '4 ADS CLIENT A').videoTracks[0].clips.numItems++;
  activate(k, '4 ADS CLIENT A');
  const ar = JSON.parse(k.O.resetAndOrganize(payload('incremental', { only: 'sequences', seqPatterns: ['Hook'] })));
  const why15 = (ar.debug.seqDecisions.find((d) => d.name === 'Hook 15') || {}).why;
  check('automatic pass: "Hook 15", used in the open "4 ADS CLIENT A", → 01 sequence by the rule',
        k.pathOf(kh15) === '01 sequence' && why15 === 'rule', `${k.pathOf(kh15)} · decided by ${why15}`);
}

console.log('\n29) Windows drives (2.6.0)');
{
  const h = freshProject({ Folder: (p) => ({ exists: p !== 'E:/' }) });
  const onE = h.clip('A001.mp4', 'E:\\Rushes\\A001.mp4', { offline: true }); h.move(onE, h.root);
  const onC = h.clip('gone.mp4', 'C:\\Users\\ana\\Videos\\gone.mp4', { offline: true }); h.move(onC, h.root);
  const rep = JSON.parse(h.O.resetAndOrganize(payload('incremental')));
  check('offline on an unplugged E: drive → left where it is', h.pathOf(onE) === '', h.pathOf(onE));
  check('…and reported as E:', rep.driveMissing && rep.driveMissing['E:'] === 1, JSON.stringify(rep.driveMissing));
  check('really missing on C: (always mounted) → 00 offline', h.pathOf(onC) === '00 offline', h.pathOf(onC));
}

console.log('\n30) A new user\'s own bins called "Video", "Other", "Screenshots" are HIS (2.6.0)');
{
  // Before 2.6.0 these names were taken for bins left by old versions of the
  // plugin: emptied into the numbered bins, then deleted, on the first click.
  const h = freshProject();
  const video = h.bin('Video'); h.move(video, h.root);
  const v1 = h.clip('wedding_cam_a.mp4', '/Volumes/Cam/wedding_cam_a.mp4'); h.move(v1, video);
  const other = h.bin('Other'); h.move(other, h.root);
  const o1 = h.clip('notes.pdf', '/Volumes/Docs/notes.pdf'); h.move(o1, other);
  const shots = h.bin('Screenshots'); h.move(shots, h.root);
  const s1 = h.clip('ref.png', '/Volumes/Gfx/ref.png'); h.move(s1, shots);
  h.O.resetAndOrganize(payload('incremental'));
  const imgs = h.binAt('05 images');
  const prepared = imgs.createBin('Screenshots');            // empty, prepared on purpose
  const vids = h.binAt('02 video');
  const sub = vids.createBin('Other');
  const s2 = h.clip('broll_city.mp4', '/Volumes/Cam/broll_city.mp4'); h.move(s2, sub);
  const pv = JSON.parse(h.O.previewOrganize(payload('incremental')));
  const rep = JSON.parse(h.O.resetAndOrganize(payload('incremental')));
  check('"Video", "Other", "Screenshots" at the root keep their files', h.pathOf(v1) === 'Video' && h.pathOf(o1) === 'Other' && h.pathOf(s1) === 'Screenshots',
        [h.pathOf(v1), h.pathOf(o1), h.pathOf(s1)].join(' / '));
  check('…and still exist', !!h.binAt('Video') && !!h.binAt('Other') && !!h.binAt('Screenshots'));
  check('an empty "05 images/Screenshots" prepared by hand stays', !!h.binAt('05 images/Screenshots'));
  check('"02 video/Other" is a sub-bin of the user, not a leftover', h.pathOf(s2) === '02 video/Other' && !!h.binAt('02 video/Other'), h.pathOf(s2));
  check('nothing is announced as cleared', (pv.leftoverBins || []).length === 0 && (rep.leftoverBins || []).length === 0,
        JSON.stringify([pv.leftoverBins, rep.leftoverBins]));
  check('no non-empty bin was ever deleted', h.violations.length === 0, h.violations.join(', ') || 'none');

  // the owner's switch: bins from older versions of the plugin are merged
  const g = freshProject();
  const old = g.bin('video'); g.move(old, g.root);
  const r1 = g.clip('C0042.MP4', '/Volumes/Cam/C0042.MP4'); g.move(r1, old);
  g.O.resetAndOrganize(payload('incremental', { legacyBins: true }));
  check('with "Merge old bins" on, an old "video" bin is merged and removed', g.pathOf(r1) === '02 video' && !g.binAt('video'), g.pathOf(r1));
}

console.log('\n31) Undo keeps what was there before (2.6.0)');
{
  // an empty "04 music & sound effect" from a project template
  const h = makeHost();
  const tpl = h.root.createBin('04 music & sound effect');
  const song = h.clip('theme.mp3', '/Volumes/Audio/theme.mp3'); h.move(song, h.root);
  song.getColorLabel = function () { return 5; };
  const rep = JSON.parse(h.O.resetAndOrganize(payload('incremental')));
  check('the song went to Music, coloured', h.pathOf(song) === '04 music & sound effect/Music' && song._color === 13, h.pathOf(song) + ' · ' + song._color);
  const undo = JSON.parse(h.O.undoOrganize(JSON.stringify(rep.undo)));
  check('undo puts it back at the root', undo.restored === 1 && h.pathOf(song) === '', h.pathOf(song));
  check('…with its colour label from before', song._color === 5, String(song._color));
  check('…and the template bin that was empty before stays', !!h.binAt('04 music & sound effect'));

  // two sibling bins whose names differ only by case and a space; the second
  // keeps a clip, so it is still there when Undo runs
  const g = makeHost();
  const a = g.root.createBin('02 video'), b = g.root.createBin('02 Video ');
  const stays = g.clip('A001.mp4', '/Volumes/Cam/A001.mp4'); g.move(stays, b);
  const clipB = g.clip('mix.mp3', '/Volumes/Audio/mix.mp3'); g.move(clipB, b);
  const rep2 = JSON.parse(g.O.resetAndOrganize(payload('incremental')));
  check('the mp3 left "02 Video " for the audio bin', g.pathOf(clipB) === '04 music & sound effect/Music', g.pathOf(clipB));
  JSON.parse(g.O.undoOrganize(JSON.stringify(rep2.undo)));
  check('undo returns it to its own bin, not to the look-alike "02 video"', clipB._parent === b && a._kids.indexOf(clipB) === -1, g.pathOf(clipB));
}

console.log('\n32) A new project with empty sequences: no sequence is opened (2.6.0)');
{
  const h = makeHost();
  let opened = 0;
  h.app.project.openSequence = () => { opened++; return true; };
  const s1 = h.clip('Sequence 01', '', { seq: true }); h.addSeq('Sequence 01', [], s1);
  const s2 = h.clip('Sequence 02', '', { seq: true }); h.addSeq('Sequence 02', [], s2);
  h.O.resetAndOrganize(payload('incremental'));
  check('Organize did not open the sequences one by one in Premiere', opened === 0, opened + ' opened');
  check('both are filed as edits', h.pathOf(s1) === '01 sequence' && h.pathOf(s2) === '01 sequence');
}

console.log('\n33) Bins an import left INSIDE the user\'s own bins are filed (2.6.1)');
// Client B 6, 07/10: every day the sequences of a "Sources …" project are
// imported, and Premiere rebuilds that project's bins under the user's own
// "02 rushes & nests (jours)/Sources 10-4": "video", "nested sequence",
// "music & sound effect", "screenshots"… Organize never looked inside the
// user's bins: 47 duplicate bins, 136 items left scattered, "all in place".
{
  const build = () => {
    const h = makeHost();
    const { root, bin, clip, move } = h;
    const days = bin('02 rushes & nests (jours)'); move(days, root);
    const rushes = bin('Rushes 10-1'); move(rushes, days);
    const r1 = clip('C0012.MP4', '/Volumes/Cam/C0012.MP4'); move(r1, rushes);
    const prepared = bin('Sources 10-8'); move(prepared, days);          // empty, prepared on purpose
    const src = bin('Sources 10-4'); move(src, days);
    const vid = bin('video'); move(vid, src);
    const v1 = clip('A010.mp4', '/Volumes/Cam/A010.mp4'); move(v1, vid);
    const nestBin = bin('nested sequence'); move(nestBin, src);
    const music = bin('music & sound effect'); move(music, src);
    const musicSub = bin('Music'); move(musicSub, music);
    const song = clip('theme.mp3', '/Volumes/Audio/theme.mp3'); move(song, musicSub);
    const shots = bin('screenshots'); move(shots, src);
    const png = clip('Screenshot 1.png', '/Users/editor/Desktop/Screenshot 1.png'); move(png, shots);
    // the day's edit sits directly in the user's bin and uses a nest
    const nest = clip('Hook nest', '', { seq: true });
    const edit = clip('10-4 final', '', { seq: true });
    h.addSeq('10-4 final', [nest], edit); move(edit, src);
    h.addSeq('Hook nest', [], nest); move(nest, nestBin);
    // an older import one level deeper, holding nothing but a plugin bin
    const old = bin('9-29 V1 edit'); move(old, days);
    const oldSrc = bin('Sources 9-29'); move(oldSrc, old);
    const old08 = bin('08 nested sequence'); move(old08, oldSrc);
    const n7 = clip('Nested Sequence 07', '', { seq: true }); h.addSeq('Nested Sequence 07', [], n7); move(n7, old08);
    // the same at the root of the project
    const rootSrc = bin('Sources 9-30'); move(rootSrc, root);
    const rootMusic = bin('music & sound effect'); move(rootMusic, rootSrc);
    const riser = clip('riser.wav', '/Volumes/Audio/riser.wav'); move(riser, rootMusic);
    // on the Ignore list: never opened, even with a plugin bin inside
    const keep = bin('Keep me'); move(keep, root);
    const keepVid = bin('video'); move(keepVid, keep);
    const k1 = clip('B001.mp4', '/Volumes/Cam/B001.mp4'); move(k1, keepVid);
    return { h, r1, v1, song, png, nest, edit, n7, riser, k1 };
  };
  const user = { legacyBins: true, ignored: ['Keep me'] };
  const all = (t) => ['r1', 'v1', 'song', 'png', 'nest', 'edit', 'n7', 'riser', 'k1'].map((k) => t.h.pathOf(t[k]));

  const t = build();
  const start = all(t);
  const pv = JSON.parse(t.h.O.previewOrganize(payload('incremental', user)));
  check('Preview names the 6 bins it will empty', pv.leftoverBins.length === 6, pv.leftoverBins.join(' | '));
  check('…and moves nothing', JSON.stringify(all(t)) === JSON.stringify(start));

  const rep = JSON.parse(t.h.O.resetAndOrganize(payload('incremental', user)));
  const P = (k) => t.h.pathOf(t[k]);
  check('a video from the import → 02 video', P('v1') === '02 video', P('v1'));
  check('its music, even one level deeper (music & sound effect/Music) → audio/Music', P('song') === '04 music & sound effect/Music', P('song'));
  check('its screenshot → 05 images', P('png') === '05 images', P('png'));
  check('its nest, used by the day\'s edit → 08', P('nest') === '08 nested sequence', P('nest'));
  check('a nest two bins deeper (9-29 V1 edit/Sources 9-29/08 nested sequence) → 08', P('n7') === '08 nested sequence', P('n7'));
  check('an import at the root of the project is filed too', P('riser') === '04 music & sound effect/SFX', P('riser'));
  check('the day\'s edit stays in the user\'s "Sources 10-4"', P('edit') === '02 rushes & nests (jours)/Sources 10-4', P('edit'));
  check('the user\'s "Rushes 10-1" is not touched', P('r1') === '02 rushes & nests (jours)/Rushes 10-1', P('r1'));
  check('the Ignore list wins, plugin bin inside or not', P('k1') === 'Keep me/video', P('k1'));
  check('the emptied duplicates are gone', !t.h.binAt('02 rushes & nests (jours)/Sources 10-4/video') && !t.h.binAt('02 rushes & nests (jours)/Sources 10-4/music & sound effect'));
  check('"Sources 10-4" stays: it still holds the edit', !!t.h.binAt('02 rushes & nests (jours)/Sources 10-4'));
  check('a bin left empty by this run goes ("9-29 V1 edit", "Sources 9-30")', !t.h.binAt('02 rushes & nests (jours)/9-29 V1 edit') && !t.h.binAt('Sources 9-30'));
  check('a bin that was empty before stays ("Sources 10-8")', !!t.h.binAt('02 rushes & nests (jours)/Sources 10-8'));
  check('the report names the bins it left empty', (rep.emptiedBins || []).length === 3 && rep.emptiedBins.indexOf('Sources 9-30') !== -1, JSON.stringify(rep.emptiedBins));
  check('no deleteBin() on a bin that still held something', t.h.violations.length === 0, t.h.violations.join(', '));

  const back = JSON.parse(t.h.O.undoOrganize(JSON.stringify(rep.undo)));
  check('Undo puts all 6 moved items back', back.restored === 6 && back.failed === 0, JSON.stringify(back));
  check('…each in the bin it came from, rebuilt where needed', JSON.stringify(all(t)) === JSON.stringify(start), JSON.stringify(all(t)));

  const t2 = build();
  t2.h.O.resetAndOrganize(payload('incremental', user));
  const again = JSON.parse(t2.h.O.resetAndOrganize(payload('incremental', user)));
  check('a second click has nothing left to do', again.total === 0, String(again.total));

  // A new user ("Merge old and imported bins" off): their bins are not walked
  // at all — one may keep a "02 video" or a "video" inside a client bin on
  // purpose (review of 2026-10-09).
  const t3 = build();
  t3.h.O.resetAndOrganize(payload('incremental', { ignored: ['Keep me'] }));
  check('new user: a bin named "video" inside their bin is left alone', t3.h.pathOf(t3.v1) === '02 rushes & nests (jours)/Sources 10-4/video', t3.h.pathOf(t3.v1));
  check('new user: a numbered "08 nested sequence" inside their bin too', t3.h.pathOf(t3.n7) === '02 rushes & nests (jours)/9-29 V1 edit/Sources 9-29/08 nested sequence', t3.h.pathOf(t3.n7));

  // Only the button walks the user's bins: an automatic import or interval
  // pass would freeze Premiere for seconds on a big project.
  const t5 = build();
  t5.h.O.resetAndOrganize(payload('incremental', Object.assign({ auto: 'import' }, user)));
  check('automatic pass after an import: the user\'s bins are not walked', t5.h.pathOf(t5.v1) === '02 rushes & nests (jours)/Sources 10-4/video', t5.h.pathOf(t5.v1));

  // A category renamed to a plain word is too common a bin name: "Music" for
  // the audio bin must not take the user's own "Client A/Music".
  const m = makeHost();
  const clientA = m.bin('Client A'); m.move(clientA, m.root);
  const theirMusic = m.bin('Music'); m.move(theirMusic, clientA);
  const track = m.clip('their-track.mp3', '/Volumes/Audio/their-track.mp3'); m.move(track, theirMusic);
  const renamed = JSON.parse(payload('incremental', { legacyBins: true }));
  renamed.names.audio = 'Music';
  m.O.resetAndOrganize(JSON.stringify(renamed));
  check('a category renamed "Music" does not take the user\'s "Client A/Music"', m.pathOf(track) === 'Client A/Music' && !!m.binAt('Client A'), m.pathOf(track));

  // the automatic pass after a Nest stays instant: it never walks the user's bins
  const t4 = build();
  t4.h.O.resetAndOrganize(payload('incremental', Object.assign({ only: 'sequences' }, user)));
  check('automatic pass after a Nest: the user\'s bins are not opened', t4.h.pathOf(t4.v1) === '02 rushes & nests (jours)/Sources 10-4/video' && t4.h.pathOf(t4.n7) === '02 rushes & nests (jours)/9-29 V1 edit/Sources 9-29/08 nested sequence', t4.h.pathOf(t4.n7));
}

console.log(`\n${failed ? failed + ' failure(s)' : 'the organizer keeps its promises'}\n`);
process.exit(failed ? 1 : 0);
