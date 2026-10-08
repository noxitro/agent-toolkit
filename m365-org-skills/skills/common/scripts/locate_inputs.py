#!/usr/bin/env python3
"""List files that the user may have attached to the conversation.

Usage:
    python3 locate_inputs.py [--ext .csv,.xlsx] [--max-depth 2] [--limit 100]

Microsoft does not document where the Copilot sandbox places chat attachments, so the
skills call this helper instead of guessing a path. It walks the working directory and a
few likely roots, skips the skill's own files, and prints one absolute path per line,
newest first. Exit code 0 when at least one file was found, 1 otherwise.

Python 3.8+, standard library only. Reads directory listings only; opens no file.
"""

import argparse
import os
import sys

ROOTS = [".", "/mnt/data", "/mnt/user-data", "/mnt/user", "/mnt", "/tmp", "~", "/workspace", "/home"]
SKIP_DIRS = {"__pycache__", ".git", "node_modules", "proc", "sys", "dev", "usr", "lib", "bin", "etc"}


def skill_root():
    # scripts/locate_inputs.py -> the skill directory; its files are not attachments
    return os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def walk(root, max_depth, exts, skip_under, seen, found):
    root = os.path.abspath(os.path.expanduser(root))
    if not os.path.isdir(root):
        return
    base_depth = root.rstrip(os.sep).count(os.sep)
    for cur, dirs, files in os.walk(root):
        depth = cur.rstrip(os.sep).count(os.sep) - base_depth
        if depth >= max_depth:
            dirs[:] = []
        dirs[:] = [d for d in dirs if d not in SKIP_DIRS and not d.startswith(".")]
        if os.path.abspath(cur).startswith(skip_under):
            dirs[:] = []
            continue
        for name in files:
            path = os.path.abspath(os.path.join(cur, name))
            if path in seen or path.startswith(skip_under):
                continue
            if exts and os.path.splitext(name)[1].lower() not in exts:
                continue
            seen.add(path)
            try:
                found.append((os.path.getmtime(path), os.path.getsize(path), path))
            except OSError:
                pass


def main(argv=None):
    ap = argparse.ArgumentParser(description="List candidate attachment files.")
    ap.add_argument("--ext", default="", help="comma-separated extensions, e.g. .csv,.xlsx")
    ap.add_argument("--max-depth", type=int, default=2)
    ap.add_argument("--limit", type=int, default=100)
    args = ap.parse_args(argv)

    exts = {e.strip().lower() if e.strip().startswith(".") else "." + e.strip().lower()
            for e in args.ext.split(",") if e.strip()}
    skip_under = skill_root() + os.sep
    seen, found = set(), []
    for root in ROOTS:
        try:
            walk(root, args.max_depth, exts, skip_under, seen, found)
        except OSError as e:
            print("# skipped %s: %s" % (root, e), file=sys.stderr)
    found.sort(reverse=True)
    for _mtime, size, path in found[: args.limit]:
        print("%s\t%d bytes" % (path, size))
    if not found:
        print("# no candidate files found under: %s" % ", ".join(ROOTS), file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
