#!/usr/bin/env python3
"""
audit_prproj.py — read a Premiere project (.prproj) and describe it the way
Isma Organizer sees it, so the REAL plugin code can be replayed on a REAL
project (tools/replay.mjs) without opening Premiere.

    python3 tools/audit_prproj.py <project.prproj> [out.json]

Never writes to the project: it streams the gzip XML read-only. The output is
a "host description": bins, project items (media with their file path,
sequences), and every sequence's tracks with the item behind each clip — the
same shape the fake host in the tests builds, at real scale.

Why this exists: for weeks the synthetic tests passed while the user's real
projects failed (nested leftovers, unnumbered bins pasted from old projects,
10–20 s freezes on 28 000-clip projects). Every one of those was visible in the
.prproj; none was visible in a synthetic fixture.

Object graph walked (Premiere 2024–2026, project Version 45):
  Sequence ─ TrackGroups/TrackGroup/Second → Video|AudioTrackGroup
    → TrackGroup/Tracks/Track (ObjectURef) → Video|AudioClipTrack
    → ClipTrack/ClipItems/TrackItems/TrackItem → Video|AudioClipTrackItem
    → ClipTrackItem/SubClip → SubClip → MasterClip (ObjectURef)
  MasterClip ─ Clips/Clip → VideoClip|AudioClip ─ Clip/Source →
    Video|AudioSequenceSource ─ SequenceSource/Sequence   (a sequence)
    Video|AudioMediaSource    ─ MediaSource/Media → Media/ActualMediaFilePath
  ClipProjectItem ─ ProjectItem/Name, MasterClip
  BinProjectItem | RootProjectItem ─ ProjectItemContainer/Items/Item
"""
import gzip
import json
import os
import sys
import xml.etree.ElementTree as ET


def _is_file_path(p):
    return bool(p) and (p.startswith('/') or (len(p) > 2 and p[1] == ':'))


def parse(path):
    seqs, groups, tracks, titems, subclips, masters = {}, {}, {}, {}, {}, {}
    clips, seqsrc, mediasrc, media, cpi, bins = {}, {}, {}, {}, {}, {}
    depth = 0
    with gzip.open(path, 'rb') as fh:
        for ev, el in ET.iterparse(fh, events=('start', 'end')):
            if ev == 'start':
                depth += 1
                continue
            depth -= 1
            if depth != 1:              # direct children of <PremiereData> only
                continue
            t, oid, uid = el.tag, el.get('ObjectID'), el.get('ObjectUID')
            if t == 'Sequence' and uid:
                seqs[uid] = {'name': el.findtext('Name') or '',
                             'groups': [s.get('ObjectRef') for s in el.findall('./TrackGroups/TrackGroup/Second')]}
            elif t in ('VideoTrackGroup', 'AudioTrackGroup') and oid:
                groups[oid] = (t[0], [x.get('ObjectURef') for x in el.findall('./TrackGroup/Tracks/Track')])
            elif t in ('VideoClipTrack', 'AudioClipTrack') and uid:
                tracks[uid] = [x.get('ObjectRef') for x in el.findall('./ClipTrack/ClipItems/TrackItems/TrackItem')]
            elif t in ('VideoClipTrackItem', 'AudioClipTrackItem') and oid:
                s = el.find('./ClipTrackItem/SubClip')
                titems[oid] = s.get('ObjectRef') if s is not None else None
            elif t == 'SubClip' and oid:
                m = el.find('MasterClip')
                subclips[oid] = m.get('ObjectURef') if m is not None else None
            elif t == 'MasterClip' and uid:
                masters[uid] = [c.get('ObjectRef') for c in el.findall('./Clips/Clip')]
            elif t in ('VideoClip', 'AudioClip') and oid:
                s = el.find('./Clip/Source')
                clips[oid] = {'src': s.get('ObjectRef') if s is not None else None,
                              'inUse': (el.findtext('./Clip/InUse') or '').strip() == 'true'}
            elif t in ('VideoSequenceSource', 'AudioSequenceSource') and oid:
                s = el.find('./SequenceSource/Sequence')
                seqsrc[oid] = s.get('ObjectURef') if s is not None else None
            elif t in ('VideoMediaSource', 'AudioMediaSource') and oid:
                m = el.find('./MediaSource/Media')
                mediasrc[oid] = m.get('ObjectURef') if m is not None else None
            elif t == 'Media' and uid:
                media[uid] = (el.findtext('ActualMediaFilePath') or el.findtext('FilePath') or '').strip()
            elif t == 'ClipProjectItem' and uid:
                m = el.find('MasterClip')
                cpi[uid] = {'name': el.findtext('./ProjectItem/Name') or '',
                            'master': m.get('ObjectURef') if m is not None else None}
            elif t in ('BinProjectItem', 'RootProjectItem') and uid:
                bins[uid] = {'name': el.findtext('./ProjectItem/Name') or '', 'root': t == 'RootProjectItem',
                             'items': [x.get('ObjectURef') for x in el.findall('./ProjectItemContainer/Items/Item')]}
            el.clear()

    # What each master clip is: a sequence, a media file, or neither.
    master_kind = {}
    for mu, cl in masters.items():
        kind, in_use = None, False
        for c in cl:
            info = clips.get(c) or {}
            in_use = in_use or info.get('inUse', False)
            src = info.get('src')
            if src in seqsrc and seqsrc[src]:
                kind = ('sequence', seqsrc[src])
            elif src in mediasrc and not kind:
                kind = ('media', media.get(mediasrc[src], ''))
        master_kind[mu] = (kind, in_use)

    parent_of = {}
    for bu, b in bins.items():
        for it in b['items']:
            parent_of[it] = bu
    root = next(b for b, v in bins.items() if v['root'])

    # Project items keyed by master clip, so a track clip resolves to the item.
    item_of_master = {}
    items = []
    for u, it in cpi.items():
        kind, in_use = master_kind.get(it['master'], (None, False))
        entry = {'uid': u, 'name': it['name'], 'parent': parent_of.get(u) if parent_of.get(u) != root else None,
                 'inUse': in_use}
        if kind and kind[0] == 'sequence':
            entry['kind'] = 'sequence'
            entry['seq'] = kind[1]
        elif kind and kind[0] == 'media' and not _is_file_path(kind[1]):
            # Adjustment Layer, Color Matte, Black Video…: their "path" is a
            # number. They are never offline — Premiere files them like any
            # item without a file (09 other).
            entry['kind'] = 'media'
            entry['path'] = ''
            entry['exists'] = True
            entry['synthetic'] = True
        elif kind and kind[0] == 'media':
            entry['kind'] = 'media'
            entry['path'] = kind[1]
            entry['exists'] = bool(kind[1]) and os.path.exists(kind[1])
        else:
            entry['kind'] = 'other'
        items.append(entry)
        item_of_master.setdefault(it['master'], u)

    # A sequence's name, as ExtendScript reports it, is the Sequence's own
    # <Name>: the ClipProjectItem's name goes stale when a script duplicates or
    # renames a sequence (AutoPod/AutoCut backups, "X Copy") — 46 such items in
    # the user's projects, and with the stale names no backup was recognised.
    for i in items:
        if i['kind'] == 'sequence' and i['seq'] in seqs and seqs[i['seq']]['name']:
            i['name'] = seqs[i['seq']]['name']
    seq_item = {i['seq']: i['uid'] for i in items if i['kind'] == 'sequence'}
    sequences = []
    for su, s in seqs.items():
        vt, at = [], []
        for g in s['groups']:
            kind, tlist = groups.get(g, ('V', []))
            for tu in tlist:
                row = [item_of_master.get(subclips.get(titems.get(ti))) for ti in tracks.get(tu, [])]
                (vt if kind == 'V' else at).append(row)
        sequences.append({'uid': seq_item.get(su, 'orphan-' + su), 'name': s['name'], 'video': vt, 'audio': at})

    return {
        'source': os.path.basename(path),
        'bins': {u: {'name': b['name'], 'parent': parent_of.get(u) if parent_of.get(u) != root else None}
                 for u, b in bins.items() if not b['root']},
        'items': items,
        'sequences': sequences,
        'stats': {'sequences': len(seqs), 'tracks': len(tracks), 'clips': len(titems), 'mediaItems': sum(i['kind'] == 'media' for i in items),
                  'bins': len(bins) - 1}
    }


if __name__ == '__main__':
    if len(sys.argv) < 2:
        sys.exit(__doc__)
    desc = parse(sys.argv[1])
    out = sys.argv[2] if len(sys.argv) > 2 else None
    if out:
        with open(out, 'w', encoding='utf-8') as fh:
            json.dump(desc, fh, ensure_ascii=False, separators=(',', ':'))
    print(json.dumps(desc['stats']))
