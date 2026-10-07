/**
 *   node tools/replay.mjs <host.json> [--jsx path] [--scenario name] [--active "seq name"]
 *
 * Replays the REAL OrganizeFilesInProject.jsx on a real project described by
 * tools/audit_prproj.py, and COUNTS the calls into Premiere.
 *
 * Why count calls: ExtendScript is synchronous — while the script runs,
 * Premiere is frozen. On the user's 28 000-clip project the "new sequence"
 * pass froze Premiere for 7–20 s (measured in the run journal). Node timing
 * says nothing about that; the number of host property reads does, and it can
 * be calibrated against the journal's real milliseconds.
 *
 * Scenarios:
 *   organize   — the Organize button (incremental)
 *   sequences  — the automatic pass after a Nest (sequences only)
 *   nest       — the user nests inside --active: a new "Nested Sequence 999"
 *                lands at the root and in that timeline, then the automatic pass
 *   full       — "Re-sort the whole project"
 *   preview    — Preview
 *
 * Output: JSON on stdout — calls, moved per category, where every sequence
 * ends up against the user's rule (nested ⇔ used in a timeline OR named
 * "Nested Sequence…"), media left at the root.
 */
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const IS_MAIN = !!process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);

export function buildHost(desc, jsxSource) {
  let calls = 0;
  let id = 1;
  const count = () => { calls++; if (globalThis.__trace) globalThis.__trace(); };
  // Every read of a host object's public property is one call into Premiere.
  const host = (target) => new Proxy(target, {
    get(t, k) { if (typeof k === 'string' && !k.startsWith('_')) count(); return t[k]; }
  });
  const collection = (arr) => {
    const c = host({ numItems: arr.length, length: arr.length });
    return new Proxy(c, { get(t, k) { if (k === 'numItems' || k === 'numTracks' || /^\d+$/.test(String(k))) count(); return /^\d+$/.test(String(k)) ? arr[+k] : (k === 'numTracks' ? arr.length : t[k]); } });
  };

  const mkItem = (name, type, extra = {}) => {
    const o = Object.assign({ name, type, nodeId: 'n' + id++, _kids: [], _parent: null, _color: null }, extra);
    o.setColorLabel = (c) => { o._color = c; };
    o.moveBin = (d) => { move(o, d._raw || d); return 0; };
    const p = host(o);
    o._proxy = p;
    return o;
  };
  const move = (o, d) => {
    if (o._parent) { const k = o._parent._kids; k.splice(k.indexOf(o), 1); }
    d._kids.push(o); o._parent = d;
  };
  const makeBin = (name, type = 2) => {
    const b = mkItem(name, type);
    b._raw = b;
    Object.defineProperty(b, 'children', { get() { return collection(b._kids.map((k) => k._proxy)); }, enumerable: true });
    b.createBin = (n) => { const c = makeBin(n); move(c, b); return c._proxy; };
    b.deleteBin = () => { if (b._kids.length) throw new Error('non-empty ' + b.name); const k = b._parent._kids; k.splice(k.indexOf(b), 1); b._parent = null; };
    return b;
  };

  const root = makeBin('root', 3);
  const binObj = {};
  const ensureBin = (uid) => {
    if (binObj[uid]) return binObj[uid];
    const b = desc.bins[uid];
    const o = makeBin(b.name);
    binObj[uid] = o;
    move(o, b.parent ? ensureBin(b.parent) : root);
    return o;
  };
  Object.keys(desc.bins).forEach(ensureBin);

  const itemObj = {};
  for (const it of desc.items) {
    const isSeq = it.kind === 'sequence';
    const o = mkItem(it.name, 1, {
      isSequence: () => isSeq,
      isMergedClip: () => false,
      isOffline: () => it.kind === 'media' && !it.exists,
      getMediaPath: () => (it.path || '')
    });
    o._desc = it;
    itemObj[it.uid] = o;
    move(o, it.parent ? ensureBin(it.parent) : root);
  }

  const mkTracks = (rows) => {
    const tracks = rows.map((row) => host({ clips: null, _row: row, isLocked: () => false }));
    tracks.forEach((t, i) => {
      const clipObjs = rows[i].map((u) => host({ projectItem: u && itemObj[u] ? itemObj[u]._proxy : null }));
      Object.defineProperty(t, 'clips', { get() { count(); return collection(clipObjs); } });
      t._clipObjs = clipObjs;
    });
    return collection(tracks);
  };
  const sequences = desc.sequences.map((s) => {
    const seq = { name: s.name, sequenceID: s.uid, _desc: s };
    seq._video = s.video; seq._audio = s.audio;
    Object.defineProperty(seq, 'videoTracks', { get() { count(); return mkTracks(seq._video); } });
    Object.defineProperty(seq, 'audioTracks', { get() { count(); return mkTracks(seq._audio); } });
    return host(seq);
  });
  const seqList = new Proxy(sequences, { get(t, k) { if (k === 'numSequences') { count(); return t.length; } if (/^\d+$/.test(String(k))) count(); return t[k]; } });

  const project = { rootItem: root._proxy, path: '/replay/' + desc.source, sequences: seqList, activeSequence: null, openSequence() { return false; } };
  const box = { app: { project: host(project) } };
  vm.createContext(box);
  new vm.Script(jsxSource).runInContext(box);

  const pathOf = (o) => { const p = []; for (let x = o._parent; x && x !== root; x = x._parent) p.unshift(x.name); return p.join('/'); };
  return {
    O: box.IsmaOrganizer, root, itemObj, sequences, project, pathOf,
    calls: () => calls, resetCalls: () => { calls = 0; },
    setActive: (name) => { project.activeSequence = sequences.find((s) => s.name === name) || null; },
    // A batch of sequences imported into their own user bin (with its own
    // "08 nested sequence" sub-bin, as a project organised by the plugin has).
    addImport(binName, names) {
      const b = makeBin(binName);
      move(b, root);
      const sub = makeBin('08 nested sequence');
      move(sub, b);
      return names.map((name, i) => {
        const o = mkItem(name, 1, { isSequence: () => true, isMergedClip: () => false, isOffline: () => false, getMediaPath: () => '' });
        o._desc = { uid: 'imp-' + binName + '-' + i, kind: 'sequence', name };
        itemObj[o._desc.uid] = o;
        move(o, i % 2 ? sub : b);
        const s = host({ name, sequenceID: o._desc.uid, _video: [[]], _audio: [] });
        Object.defineProperty(s, 'videoTracks', { get() { count(); return mkTracks([[]]); } });
        Object.defineProperty(s, 'audioTracks', { get() { count(); return mkTracks([]); } });
        sequences.push(s);
        return o;
      });
    },
    addNest(name, insideName) {
      const o = mkItem(name, 1, { isSequence: () => true, isMergedClip: () => false, isOffline: () => false, getMediaPath: () => '' });
      o._desc = { uid: 'new-' + name, kind: 'sequence', name };
      itemObj[o._desc.uid] = o;
      move(o, root);
      const parent = sequences.find((s) => s.name === insideName);
      if (parent) parent._video = parent._video.concat([[o._desc.uid]]);
      const s = host({ name, sequenceID: o._desc.uid, _video: [[]], _audio: [] });
      Object.defineProperty(s, 'videoTracks', { get() { count(); return mkTracks([[]]); } });
      Object.defineProperty(s, 'audioTracks', { get() { count(); return mkTracks([]); } });
      sequences.push(s);
      desc.sequences.push({ uid: o._desc.uid, name, video: [[]], audio: [] });
      if (parent) desc.sequences.find((x) => x.name === insideName).video.push([o._desc.uid]);
      desc.items.push(o._desc);
      return o;
    }
  };
}

// The user's rule, computed from the description itself.
export function expectedBins(desc) {
  const used = new Set();
  for (const s of desc.sequences) for (const row of s.video.concat(s.audio)) for (const u of row) if (u && u !== s.uid) used.add(u);
  const named = (n) => /^\s*(nested sequence|séquence imbriquée|sequence imbriquee)/i.test(n);
  return { used, isNest: (it) => it.kind === 'sequence' && (used.has(it.uid) || named(it.name)) };
}

export const payload = (mode, only) => JSON.stringify({
  mode, only, names: {}, ignored: [], brollPatterns: ['DJI', 'GOPR', 'GX0', 'OSMO'],
  exportPatterns: ['Exports', 'Renders', 'Rendus', 'Export'], audioSplit: true,
  sfxPatterns: ['sfx', 'whoosh', 'riser', 'impact', 'swoosh', 'hit', 'foley', 'transition'],
  voicePatterns: ['vo', 'voix', 'voice', 'voice-over', 'voiceover', 'itw', 'interview', 'narration'],
  colorLabels: true, refreshView: false,
  // the owner's real projects carry bins from older versions of the plugin
  legacyBins: true
});

if (IS_MAIN) {
  const args = process.argv.slice(2);
  const opt = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
  const flags = ['--jsx', '--scenario', '--active'];
  const hostFile = args.find((a, i) => !a.startsWith('--') && !flags.includes(args[i - 1]));
  const jsxPath = opt('--jsx', path.join(HERE, '..', 'OrganizeFilesInProject.jsx'));
  const scenario = opt('--scenario', 'organize');
  const desc = JSON.parse(fs.readFileSync(hostFile, 'utf8'));
  const h = buildHost(desc, fs.readFileSync(jsxPath, 'utf8'));
  const active = opt('--active', null);
  if (active) h.setActive(active);
  let rep;
  const t0 = Date.now();
  h.resetCalls();
  if (scenario === 'organize') rep = JSON.parse(h.O.resetAndOrganize(payload('incremental')));
  else if (scenario === 'sequences') rep = JSON.parse(h.O.resetAndOrganize(payload('incremental', 'sequences')));
  else if (scenario === 'full') rep = JSON.parse(h.O.resetAndOrganize(payload('full')));
  else if (scenario === 'preview') rep = JSON.parse(h.O.previewOrganize(payload('incremental')));
  else if (scenario === 'nest') {
    h.O.resetAndOrganize(payload('incremental'));       // a filed project, as the user has it
    h.addNest('Nested Sequence 999', active || h.sequences[0].name);
    h.resetCalls();
    rep = JSON.parse(h.O.resetAndOrganize(payload('incremental', 'sequences')));
  }
  const { isNest } = expectedBins(desc);
  const misfiled = [];
  for (const it of desc.items) {
    if (it.kind !== 'sequence') continue;
    const o = h.itemObj[it.uid];
    const at = h.pathOf(o);
    const want = isNest(it) ? '08 nested sequence' : '01 sequence';
    if (at !== want) misfiled.push({ name: it.name, at: at || '(root)', want });
  }
  const mediaAtRoot = desc.items.filter((it) => it.kind === 'media' && h.pathOf(h.itemObj[it.uid]) === '').length;
  console.log(JSON.stringify({
    scenario, calls: h.calls(), nodeMs: Date.now() - t0,
    moved: rep && rep.total, counts: rep && rep.counts, nestedFound: rep && rep.nestedFound,
    sequencesMisfiled: misfiled.length, misfiledSample: misfiled.slice(0, 6), mediaAtRoot
  }));
}
