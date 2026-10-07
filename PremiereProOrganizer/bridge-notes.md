# Pinterest bridge — what it is, and how to put it back

This panel gained an auto-import bridge. It was **already lost once**, when the
plugin was replaced wholesale by a newer build, so here is exactly what it
consists of — restoring it is a graft, not a rewrite.

The one and only source is **this repository** (on the author's Mac,
`~/Desktop/Isma Organizer`): the installers next to `PremiereProOrganizer/`
copy exactly that folder into Premiere. Every older copy was moved to
`~/Desktop/Isma Organizer — archives 2026-09-18` on 2026-09-18; do not
resurrect one of those by accident.

Since 2.3.0 the whole `.jsx` lives inside a single global, `IsmaOrganizer`, and
the panel reaches it through `hostCall('name', …)`. Never add a top-level
function to that file: another panel's script would be free to overwrite it.

## What it does

Watches a folder (default `~/Downloads/Pinterest`) and imports anything that
lands there into the open project — videos into the b-roll bin, images into the
images bin, with the matching colour labels. No server, no browser permission:
the CEP manifest already enables Node, so `fs` is enough.

It only runs while the panel is open.

## The three additions

**1. `OrganizeFilesInProject.jsx` — `importWatched(payloadJSON)`**

Sits in the API section, with its helper `existingMediaPaths(root)`, and must be
listed in the `return { … }` block at the bottom — `check-panel.mjs` fails if it
is defined but not exposed.

Takes `{ paths, names: {broll, images, other}, ignored, colorLabels }` and
returns `{ imported, skipped, failed, noProject, byCat }`.

It imports to the root and *then* moves, rather than passing a target bin to
`importFiles()`: depending on the Premiere version that third argument is
ignored in silence and the file lands at the root without anyone knowing. A
before/after diff over the whole project is true in every version.

**2. `OrganizeFilesInProject.jsx` — one rule inside `looksLikeSocialName()`**

```js
if (/_\d{18,19}$/.test(base)) return true;
```

That is the `{title}_{id}` filename the Pinterest extension writes by default.
Without it a rush placed by the bridge goes back to "video" on the next organize
run and has to be dragged down by hand. The 18-19 bound is deliberate and
matches the reasoning already applied to the TikTok rule: 17 digits would catch
a `AAAAMMJJHHMMSSmmm` camera timestamp.

**3. `index.html` — the panel side**

- `#bridge-status` div, right after `#report`, plus its CSS next to
  `#auto-status` (same visual family).
- A "Pinterest bridge" section at the end of `#params`: `f-bridge-enabled`,
  `f-watch-dir`, `f-watch-images`.
- Those three ids added to `TEXT_KEYS` / `CHECK_KEYS`, which is all the
  persistence they need.
- The watcher block at the very end of the script.

## The three things the watcher gets right

- **`.crdownload`.** A browser writes a temp file that grows, then renames.
  Import one tick early and Premiere gets a truncated file — an offline clip,
  permanently. It waits for a size that stops changing.
- **Switching on.** It does not dump the folder's history into whatever project
  happens to be open. What is already there is marked seen; only later arrivals
  import.
- **No project open.** Nothing imported *and* nothing marked, so the file is
  picked up on the next pass rather than lost.

It also stands down while a manual organize run is in progress, and calls
`refreshBaseline()` after importing so auto-organize does not treat the bridge's
own import as a reason to re-sort the project.

## Checking it still works

```bash
node tests/check-panel.mjs    # parses, ids match, jsx functions exist, b-roll rule
node tests/check-bridge.mjs   # real temp folder, simulated browser download
node tests/check-nested.mjs   # sequence / nested split against a stubbed host
node tests/check-plan.mjs     # the organizer end to end on a fake project: modes, undo, preview, rules
node tests/check-real-project.mjs    # replayed on a REAL project's structure (244 sequences) — the nested-sequence rule
node tests/check-auto-sequences.mjs  # a Nest made mid-session is filed (Auto-organize OFF), and every run is journaled
node tests/check-performance.mjs     # real-scale (28 000 clips): the automatic pass must not freeze Premiere
node tests/check-import-leftovers.mjs  # REAL project (Client B 6): old bins an import put inside "01 sequence"
node tests/check-broll-panel.mjs       # the B-roll tab (former Pinterest B-roll panel), Windows and fresh-Mac paths
node tests/check-pinterest.mjs         # the Pinterest client, fake Pinterest + fake ffmpeg, Windows lookup
```

## Performance: Premiere is frozen while the script runs (2.5.0)

ExtendScript is synchronous. Every read of a Premiere object is a round trip,
about **50 µs** — calibrated on the run journal (173 708 host calls ≈ 8.7 s on
"Client B 5"). Up to 2.4.0 the automatic pass after a Nest walked every clip
of every sequence to learn which sequences are nested: 7–20 s frozen, about
once a minute while editing, on projects of 16 000–28 000 clips.

2.5.0 classifies a sequence with the cheapest signal that answers
(`classifySequence`):

1. its **name** — "Nested Sequence N" → 08; an AutoCut / AutoPod backup
   (`autocut-backup|autopod backup`) → `01 sequence/Backups`. No track read.
2. the **Organize button / Preview**: every timeline, read once (each project
   item asked once, `info.kind`).
3. **automatic passes** (after a Nest, and import / interval runs when
   Auto-organize is on): already in 08 (or the old `nested sequence`) stays;
   used in the **active** timeline → 08 (a hook just dragged into an
   assembly, even if it sat in 01); already in 01 and absent from the active
   timeline stays; not yet filed and absent from it → a single one is a new
   edit (01), several are a backlog left where they are until Organize — the
   plugin does not guess.

Owned bins carry their category and path from the moment they are found (no
tree walks). Incremental cleanup only looks at bins this run created, emptied
or owns, and deleting a bin created by the run never takes its pre-existing
parent with it. `Backups` is fill-only: the plugin drops backups into it but
never enters it — a `Backups` the user made is his. Ignored sub-bins are
neither entered nor filled. Old plugin bins are a CLOSED list
(`LEGACY_NAMES`: sequence, nested sequence, video, music & sound effect,
screenshots, 05 screenshots, styles, other) — a user bin called `Exports` is
his.

On the panel side: opening a project never files what is already at its root
(the watch reacts to this session only), a run armed in one project is
dropped when another opens, Preview and the diagnostic never swallow a
waiting Nest, and the status line offers "N items at the root — file them"
only for what Organize can still move.

Measured on 11 real projects (host calls × 50 µs = seconds frozen): the
automatic pass after a Nest in the largest timeline went from 1.1–8.7 s to
0.04–0.97 s (the cost is now the active timeline only); the Organize button
from 0.1–9.1 s to 0.06–4.8 s. `check-performance.mjs` fails if the automatic
pass reads more than the active timeline or goes over 3 000 calls.

## Media rules measured on real projects (2.5.0)

Built into the host, not settings (the user's stored settings predate them):
b-roll by folder (`B ROLL`, `B-roll`, `Broll`…), Envato
(`…-2026-09-17-17-02-47-utc`), downloaders (PinDown, KlickPin, snaptik,
SnapInsta, ssstik, savefrom, `pin-id-…`), Pexels ids, TikTok
`account - <id>` and `<id>sd`; voice by signature (ElevenLabs, Adobe Enhance
Speech `esv2`, `MIC 1`) before anything else, music words (music,
instrumental, soundtrack, bgm) before SFX words; SFX by folder (SFX libraries,
Premiere Composer / Animation Composer audio) and videos named `…SFX`; videos
in a `Musique`/`Music` folder go to Music; export folders may be numbered
(`03 Exports`); an offline item on an **unplugged** `/Volumes/<disk>` is left
where it is and reported (`driveMissing`), only really missing files go to
`00 offline`. Every rule is pinned in `check-plan.mjs` with the real file
names it was measured on.

## What an import slips inside the plugin's bins (2.5.1)

Client B 6, 2026-09-30 17:28: importing sequences from an older project
recreated that project's bins INSIDE `01 sequence` — `nested sequence` (2
nests), `video` (5 rushes), `music & sound effect` (3 sounds). Organize ran at
17:31 and moved nothing: incremental runs never opened a sub-bin. The user saw
nests among the edits ("les séquences ne sont pas dans leur dossier").

Since 2.5.1 the Organize button (and Preview, and Auto-organize's import runs)
looks inside the plugin's own root bins (`collectInsideOwned`):
- a sub-bin carrying a plugin bin name (a category or a `LEGACY_NAMES` entry)
  is an import leftover: everything in it, at any depth, is filed like a new
  import, and the bin goes once empty (`leftoverBins` in the report, one line
  in the panel, `restes_import` in the journal);
- other sub-bins of `01 sequence` / `08 nested sequence` are the user's: an
  edit stays in `01 sequence/9-29 V1`, a nest found there goes to 08, an edit
  under 08 goes to 01, a media file leaves;
- sub-bins of media bins (`03 b-roll/Cuisine`), `Backups`, ignored sub-bins and
  the user's own root bins are never opened. The automatic pass after a Nest
  opens no sub-bin at all.

Replayed on 12 real projects: 10 unchanged item for item; Client B 6 files
the 10 items above; Client C ads files 13 edits asleep in `other/Sequence`.

## The user's own sequence rules, by name (2.5.1)

Asked 2026-09-30: "je veux classer les séquences par nom, pas directement par
Premiere, et le faire moi-même". Two fields under More settings → Settings:
**Always edits** (`f-seq-patterns` → `seqPatterns`) and **Always nested**
(`f-nested-patterns` → `nestedPatterns`), words separated by `;`, empty by
default. A rule is a run of WHOLE words, case- and accent-insensitive
("Hook" takes "Hook 1" and "hook 7", not "Hookah"; "4 ADS" takes "4 ADS CLIENT A").
Order in `classifySequence`: Premiere's own "Nested Sequence…" name → 08;
AutoCut/AutoPod backup → `01 sequence/Backups`; Always nested → 08; Always
edits → 01; then the automatic detection as before (the user chose that over
name-only). Rules only choose between 01 and 08 (he declined per-rule folders).
They apply to the Organize button and to the automatic pass; a sequence already
in 08 is re-judged by the Organize button only. `byRule` in the report,
`par_regle` in the journal. Measured on "Project D": "Hook;Body" moves the 36
hooks and bodies that "4 ADS CLIENT A" uses from 08 to 01; a second click moves
nothing. With no rule written, 12 real projects give exactly the same result.

## One panel, two tabs (2.6.0)

Asked 2026-10-07: merge the two panels. "Pinterest B-roll" is now the
**B-roll** tab of this panel (details in `broll-notes.md`); there is one menu
entry, "Isma Organizer", and the installers remove the old separate panel. The
Organize tab is unchanged. The manifest gained the two flags the B-roll
thumbnails need (`--allow-file-access-from-files`,
`--disable-site-isolation-trials`).

## Runs on other computers (2.6.0)

Asked the same day: "plus tard, je veux rendre ce plugin public — il doit
marcher sur plein d'autres ordinateurs". So:
- every path is joined by Node (`joinPath` / `pjoin`), never with "/";
- the run log goes where each system keeps logs (`~/Library/Logs/IsmaOrganizer`,
  `%LOCALAPPDATA%\IsmaOrganizer\Logs`); the activity journal line is written
  only where that journal already exists (the folder is never created);
- the unplugged-drive rule knows Windows letters (`E:/…` with `E:` missing →
  left in place, reported as `E:`);
- Mac-only niceties check the platform (Finder tags) and never call a stub
  that pops a system window;
- both installers set PlayerDebugMode, remove the old Pinterest B-roll panel,
  and say how to get ffmpeg (details below);
- `tests/check-panel.mjs` fails if a home-folder path appears in a shipped
  file, or if any file of the repository names the home folder of the
  computer running the tests.

## Public release (2.6.0)

Asked 2026-10-07: "je veux que ça soit une application publique… si je le
donne à des amis, ça va marcher pour eux". What a fresh computer changed:

- **ExtendScript has no JSON.** On the author's Mac another panel had loaded
  json2, so `JSON` existed; on a clean install every call failed. Both `.jsx`
  define it when it is missing (json2, public domain), in plain ASCII.
- **Old bin names are opt-in.** Bins named `video`, `other`, `screenshots`,
  `styles`, `sequence`, `nested sequence`, `music & sound effect` were emptied
  into the numbered bins: right for projects sorted by old versions, wrong for
  a new user who made a "Video" bin. Setting *Merge old bins*
  (`legacyBins`), off for new users, on for existing ones.
- **New users start quiet.** *File new sequences*, *Auto-organize*,
  *Auto-import*, *Sounds* and *Red Finder tag* are off until turned on.
  Settings saved before (`prefsVersion` < 3) keep their values. A short intro
  shows until the first run.
- **Settings survive Premiere updates.** CEP's localStorage belongs to one
  Premiere version; settings are mirrored to
  `~/Library/Application Support/IsmaOrganizer/settings.json`
  (`%APPDATA%\IsmaOrganizer\settings.json`) and read back when empty.
- **Premiere 2022 to 2026.** The manifest requires CSXS 11 (Premiere 2022 to
  2024 ship CEP 11, 2025 and later CEP 12) and declares schema 7.0, as Adobe's
  samples do; it said 12.0 before. The panel code avoids JavaScript newer than
  Chromium 88 (CEP 11): no `?.`, `??`, `.at()`, `Object.hasOwn`.
- **Installers** (`Install-Mac.command`, `Install-Windows.bat`, at the root of
  the repository; English with French under each line):
  - wait while Premiere is open (or install anyway on request);
  - refuse to delete the copy they are running from (unzipped straight into
    Adobe's folder);
  - warn about another copy of the panel under another folder name;
  - set PlayerDebugMode for CSXS 9 to 16;
  - Mac: remove Apple's quarantine flag from the installed copy;
  - Windows: say "extract the ZIP first" when run from inside the ZIP. The
    file is ASCII with CRLF line endings (`.gitattributes` keeps them), and no
    text sits inside `( )` blocks: a ")" in a folder name closes them early.
  - Tested on macOS in a scratch home folder (normal, in place, installer
    alone). The Windows one is **not tested on a real Windows machine**.
- **Privacy.** Client names, people's names and personal paths were replaced
  in comments, tests and fixtures ("Client B 6", `/Users/editor`); the fixture
  of the real project is `tests/fixtures/real-import-leftovers.json`.
- **Not done:** signing (a ZXP needs a certificate; PlayerDebugMode covers
  unsigned panels), shipping ffmpeg (users install it, or drop it in
  `PremiereProOrganizer/bin/`, which git ignores), a test on Windows and on
  Premiere 2022 to 2025.

## Tools: debug on the real project, not on a guess

```bash
python3 tools/audit_prproj.py "<COPY of project>.prproj" /tmp/p.json   # read-only parse
node tools/replay.mjs /tmp/p.json --scenario nest --active "9/26"       # real plugin code, fake Premiere, host calls counted
```

Scenarios: `organize` (button), `sequences` (automatic pass), `nest` (a new
Nest in --active, then the automatic pass), `full`, `preview`. The replay
reports moves per category, sequences against the user's rule and media left
at the root. Always work on a COPY of a .prproj. The run journal
(`~/Documents/Journal premire/data/plugin-isma-organizer.jsonl`, one line per
run with `ms`, `raison`, `scan`, `clips_lus`) and the activity journal
(`~/Documents/Journal premire/journal.db`) say what happened for real.

## Node must stay enabled in the manifest

`CSXS/manifest.xml` carries `--enable-nodejs` and `--mixed-context`. It was
emptied once ("the panel uses no Node API"); the bridge and the run journal
were added afterwards and failed silently inside Premiere for weeks, because
every test stubs `require()`. `check-panel.mjs` now reads the real manifest and
fails if the script uses `require('fs'|'os'…)` without them.

## The run journal

Every run appends one JSON line to
`~/Documents/Journal premire/data/plugin-isma-organizer.jsonl` (the activity
journal reads that folder by itself; if the folder does not exist nothing is
written). `detail.raison` is `manuel | ouverture | import | minuteur |
sequences`. A verbose copy of the last answer of each kind is kept in
`~/Library/Logs/IsmaOrganizer/last-<mode>.json`.

`check-bridge.mjs` runs the real panel script in a stubbed CEP environment. If
you change the watcher, run it — the `.crdownload` timing is the part that
cannot be reasoned about safely.

## One consequence worth remembering

Import is **in place**: Premiere points at the file inside the watched folder,
nothing is copied. Empty `~/Downloads/Pinterest` and every project that used
those clips goes offline. That was a deliberate choice; switching to a copy
alongside the `.prproj` is about twenty lines in `bridgeImport`.
