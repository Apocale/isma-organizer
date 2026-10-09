# B-roll tab — how it is built, and what to know before touching it

Until 2.6.0 (2026-10-07) this was a separate panel, "Pinterest B-roll"
(1.2.0, archived in `~/Desktop/Isma Organizer — archives 2026-09-18`). It is
now the **B-roll** tab of the Isma Organizer panel: one menu entry, one
folder, one installer.

How the merge is built (`index.html`):

- `#tab-organize` holds the organizer as it was; `#tab-broll` holds the
  former panel's markup. The tab bar (`.tabs`) and a tiny `<script
  data-part="tabs">` switch them by toggling `html.broll-mode`, remember the
  last tab in `localStorage` (`isma-tab`), and close the large preview when
  leaving the B-roll tab.
- The B-roll CSS is the former panel's, every selector scoped under
  `#tab-broll`. The organizer styles every `<button>` as its big glossy green
  one; a reset block stops that from leaking onto the B-roll controls.
- The B-roll script is the one plain `<script>` block, already private inside
  its own function. The organizer script stays the first
  `<script type="text/javascript">` block (its tests read it from there).
- The filter buttons were renamed `bf-all` / `bf-video` / `bf-image`: the
  organizer already had an `f-video` field, and `getElementById` returns the
  first one.

Two host scripts still share Premiere's single ExtendScript engine: everything
B-roll lives inside the `PQDBroll` global (`ImportBroll.jsx`), everything else
inside `IsmaOrganizer`. **Never add a top-level function to either `.jsx`.**

## The two modes

**My downloads** — the grid of the B-roll folder: setting *B-roll folder*;
when empty, the panel's own folder (2.7.2, asked 2026-10-09: "dans le dossier
de l'app"): out of sight, outside the folders macOS asks permission for,
local on Windows. The **Folder** button opens it. Until 2.7.1 the default was
`Downloads/Pinterest`: the settings migration (prefsVersion 4) moves a
setting still on that default and remembers the old folder in
`broll-old-dir`, which stays listed and watched here and by Auto-import —
its videos are never moved, projects use them where they are. A new user
never gets `broll-old-dir`, so Downloads is never read for them. One click selects one tile and opens it large (sound, controls, ← → to
browse, Esc to close). The tile and the large frame are both drag handles:
drop on the timeline or in a bin. Premiere accepts exactly one format from a
CEP panel, `com.adobe.cep.dnd.file.0` = absolute path. There are no import
buttons; the Organize tab files what Premiere imports.

**Pinterest** — type, Enter, and Pinterest's video results for that query show
as tiles. Click a tile to save the video into the downloads folder; it turns
teal, drags like any local b-roll, and also appears in *My downloads*.

## How the Pinterest mode gets its data (`PinterestClient.js`)

Pinterest has no public "search everything" API. The client calls the JSON
endpoint the website itself calls, `/resource/BaseSearchResource/get/` with
`scope: "videos"`, after one visit to the home page for the `csrftoken`
cookie, with the headers the site sends. **It is unofficial**: a 403 means
Pinterest changed its mind (wait a minute, or the endpoint moved).

Videos are mostly HLS (CMAF): one whole video file and one whole audio file,
joined with `ffmpeg -c copy` (~1 s). Older Pins with a progressive MP4 are
saved directly, no ffmpeg.

## Runs on any computer (2.6.0)

| | Mac | Windows |
|---|---|---|
| B-roll folder when the setting is empty (2.7.2) | `~/Library/Application Support/IsmaOrganizer/B-roll` | `%LOCALAPPDATA%\IsmaOrganizer\B-roll` |
| Thumbnail cache | `~/Library/Caches/PinterestBroll` (same as before the merge) | `%LOCALAPPDATA%\IsmaOrganizer\BrollThumbs` |
| ffmpeg looked for | `bin/` in the panel folder, `/opt/homebrew/bin`, `/usr/local/bin`, `/opt/local/bin`, `/usr/bin`, then the PATH | `bin\` in the panel folder, winget link, `C:\ffmpeg\bin`, Program Files, Chocolatey, Scoop, then the PATH (`;`) |
| Without ffmpeg | "ffmpeg is needed … (brew install ffmpeg)" | "… (winget install -e --id Gyan.FFmpeg)" |
| Red Finder tag | setting *Red Finder tag* (off for new users), and only with a real python3 (Homebrew, or Apple's command line tools); added next to the file's own tags | none |

`/usr/bin/python3` is never called on a Mac without Apple's command line
tools: there it is a stub that opens an "install developer tools" window. Every
path is joined by Node's `path`, and `fileUrl()` turns `C:\…` into
`file:///C:/…`. Linux falls back to `~/.cache/IsmaOrganizer`.

## Performance choices

- Thumbnails of local files are decoded lazily (IntersectionObserver, 3 at a
  time, 6 s guard) and cached as JPEG, pruned of vanished files 10 s after
  launch. A hidden tab has nothing intersecting, so nothing is decoded until
  the B-roll tab is opened.
- Nothing B-roll starts before the tab is first shown: no folder read at
  panel launch (macOS would ask for the Downloads permission for nothing).
- The downloads folder is watched (`fs.watch`, 800 ms settle) with a 30 s poll
  as fallback, skipped while the tab is hidden; the grid is rebuilt only when
  the folder signature changed.
- The "in project" badge reads the project's media list only while the tab is
  shown, one read of `children` per bin. Before, it ran every minute even
  with the tab hidden, and read `children` once per item: on a 28 000-clip
  project that is enough host calls to freeze Premiere for seconds (estimated
  from the call count, not timed in Premiere).

## Tests

```bash
node tests/check-broll-panel.mjs   # the real B-roll script in a stubbed DOM, real temp folder; Windows / fresh Mac
node tests/check-pinterest.mjs     # PinterestClient against a fake Pinterest (recorded fixture) and a fake ffmpeg; Windows lookup
```

`tests/fixtures/pinterest-search.json` is a slimmed real answer from the
search endpoint. If Pinterest changes its JSON, re-record it: the shape the
client reads is `resource_response.data.results[].videos.video_list.*.url`
and `resource_response.bookmark`.
