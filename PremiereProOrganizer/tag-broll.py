#!/usr/bin/env python3
"""
Tag every Pinterest download red in the Finder.

Downloads land in ~/Downloads/Pinterest. That folder sits inside a Downloads
folder holding thousands of unrelated files, and a b-roll saved twenty minutes
ago is indistinguishable from a screenshot from March. A colour is the one
attribute the Finder lets you sort and filter on at a glance.

A browser extension cannot do this: it may write files into the download folder
and nothing else. So this runs outside the browser, driven by launchd, and works
whether or not the browser or Premiere is open.

Idempotent and cheap: a file that already carries the tag is skipped, so the
whole tree costs one stat per file.

    python3 tag-broll.py [--dry-run] [folder]
"""

import ctypes
import ctypes.util
import os
import plistlib
import sys

# os.getxattr / os.setxattr are Linux-only in CPython — on macOS they simply do
# not exist. libSystem exports the BSD calls, so bind those instead of shelling
# out to `xattr` once or twice per file.
_libc = ctypes.CDLL(ctypes.util.find_library("c"), use_errno=True)
_libc.getxattr.argtypes = [ctypes.c_char_p, ctypes.c_char_p, ctypes.c_void_p,
                           ctypes.c_size_t, ctypes.c_uint32, ctypes.c_int]
_libc.getxattr.restype = ctypes.c_ssize_t
_libc.setxattr.argtypes = [ctypes.c_char_p, ctypes.c_char_p, ctypes.c_void_p,
                           ctypes.c_size_t, ctypes.c_uint32, ctypes.c_int]
_libc.setxattr.restype = ctypes.c_int


def _get(path, name):
    p, n = os.fsencode(path), name.encode()
    size = _libc.getxattr(p, n, None, 0, 0, 0)
    if size < 0:
        return None
    buf = ctypes.create_string_buffer(size)
    if _libc.getxattr(p, n, buf, size, 0, 0) < 0:
        return None
    return buf.raw


def _set(path, name, value):
    if _libc.setxattr(os.fsencode(path), name.encode(), value, len(value), 0, 0) < 0:
        raise OSError(ctypes.get_errno(), os.strerror(ctypes.get_errno()), path)

# Finder stores tags as a binary plist of "Name\nColourIndex" strings.
# 0 none · 1 grey · 2 green · 3 purple · 4 blue · 5 yellow · 6 red · 7 orange
TAG_ATTR = "com.apple.metadata:_kMDItemUserTags"
RED = "Red\n6"

MEDIA = {".mp4", ".mov", ".webm", ".m4v", ".mkv",
         ".jpg", ".jpeg", ".png", ".webp", ".gif", ".tiff", ".heic"}

# A download still being written must not be tagged: the browser renames it when
# it is finished, and the tag would be lost with the temporary name anyway.
PARTIAL = (".crdownload", ".part", ".download", ".tmp", ".partial")


def current_tags(path):
    raw = _get(path, TAG_ATTR)
    if not raw:
        return []
    try:
        tags = plistlib.loads(raw)
        return [str(t) for t in tags] if isinstance(tags, list) else []
    except Exception:
        return None          # unreadable: leave the file alone


def is_red(t):
    # By colour index, not by name: on a French Mac the red tag is "Rouge".
    return t.endswith("\n6")


def already_tagged(path):
    tags = current_tags(path)
    return tags is None or any(is_red(t) for t in tags)


def tag(path):
    # Added to the user's own tags, never in place of them.
    tags = current_tags(path) or []
    _set(path, TAG_ATTR, plistlib.dumps(tags + [RED], fmt=plistlib.FMT_BINARY))


def main():
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    dry = "--dry-run" in sys.argv
    root = args[0] if args else os.path.expanduser("~/Downloads/Pinterest")

    if not os.path.isdir(root):
        print("nothing to do: %s does not exist" % root)
        return 0

    tagged = skipped = failed = 0
    seen_dirs = 0
    walk_errors = []

    # os.walk swallows permission errors by default and yields nothing. Under
    # launchd that turned "macOS refused me access to Downloads" into a cheerful
    # "0 files, 0 failed" — the script reporting success over a folder it could
    # not read at all.
    def on_error(err):
        walk_errors.append(err)

    for dirpath, dirnames, filenames in os.walk(root, onerror=on_error):
        seen_dirs += 1
        dirnames[:] = [d for d in dirnames if not d.startswith(".")]
        for name in filenames:
            if name.startswith(".") or name.lower().endswith(PARTIAL):
                continue
            if os.path.splitext(name)[1].lower() not in MEDIA:
                continue
            path = os.path.join(dirpath, name)
            if already_tagged(path):
                skipped += 1
                continue
            if dry:
                print("would tag: %s" % path)
                tagged += 1
                continue
            try:
                tag(path)
                tagged += 1
            except OSError as e:
                failed += 1
                print("could not tag %s: %s" % (path, e), file=sys.stderr)

    for err in walk_errors:
        print("cannot read %s: %s" % (getattr(err, "filename", "?"), err), file=sys.stderr)
    if any(getattr(e, "errno", None) == 1 for e in walk_errors):
        # macOS gates ~/Downloads, ~/Documents and ~/Desktop behind TCC. A
        # launchd agent gets no access by default, and the refusal arrives as a
        # bare EPERM with nothing explaining it.
        print("  macOS is refusing access, not the filesystem.\n"
              "  System Settings > Privacy & Security > Full Disk Access,\n"
              "  then add /usr/bin/python3 (Cmd+Shift+G to type the path).\n"
              "  Grants every python script on this Mac full disk access — "
              "decide if that trade is worth it.", file=sys.stderr)

    if not walk_errors and seen_dirs and (tagged + skipped) == 0:
        print("read %s and found no media at all — check the folder is the right one"
              % root, file=sys.stderr)

    print("red tag: %d newly tagged, %d already done, %d failed, %d folder(s) read%s"
          % (tagged, skipped, failed, seen_dirs,
             ", %d UNREADABLE" % len(walk_errors) if walk_errors else ""))
    return 1 if (failed or walk_errors) else 0


if __name__ == "__main__":
    sys.exit(main())
