#!/usr/bin/env python3
"""Read and write m365 bundles inside the Microsoft 365 Copilot script sandbox.

The format is specified in resources/bundle-format.md (references/bundle-format.md in
the source repository). Python 3.8+, standard library only, no network.

Usage:
    python3 bundle_io.py unpack <bundle> <workdir> [--kind auto|input|output]
        Extract a .zip or Markdown bundle. Repository files go to <workdir>/, protocol
        files (_m365/...) to <workdir>/_m365/. Writes <workdir>/_m365/manifest.json with
        the sha256 of every repository file (except under SKIP_DIRS, which are never
        walked) so that later changes can be detected. An unsafe path anywhere in the
        bundle, a path that is both a file and a directory (a and a/b, also against
        the existing workdir), or two delivered paths that differ only in letter case or
        Unicode normalisation (as unpack-output.mjs refuses them), aborts before anything
        is written.
        --kind output (auto-detected for output bundles): the auditor's view. A bundle
        from `pack --full` carries the input manifest, which is kept so that `status`
        shows the real changes; a bundle without one gets an empty manifest and every
        repository file in it counts as a change. A carried manifest marks a bundle as
        output even without AUDIT.md, ROUNDS.md or DELETED.txt. Files a Markdown bundle
        lists under "## Skipped" (binary) are dropped from the carried manifest, so they
        do not show as deleted; their changes cannot be seen (use a ZIP bundle for
        those). The bundle's _m365/AUDIT.md is kept as _m365/AUDIT.implementer.md so
        that the auditor's report starts fresh.

    python3 bundle_io.py status <workdir>
        Print {"added": [...], "modified": [...], "deleted": [...], "unchanged": N}
        comparing the working directory with the manifest.

    python3 bundle_io.py pack <workdir> <out.zip|out.md|out.txt>
                         [--kind output|audit] [--full] [--round N] [--task SLUG] [--store]
        Write an output bundle. By default it holds only added and modified repository
        files, the deletions, and every _m365/ file except manifest.json and state.json.
        --full (what the agent instructions use) holds every repository file plus the
        input manifest.json, so an independent auditor can tell real changes from
        untouched files. --kind audit packs only _m365/AUDIT.md. Paths that the local
        unpacker would refuse (unsafe, or folding together by case or Unicode
        normalisation) abort the pack before the bundle is written.

Exit codes: 0 success, 1 error (message on stderr).
"""

import argparse
import datetime
import hashlib
import io
import json
import os
import re
import sys
import time
import unicodedata
import zipfile
import zlib

BUNDLE_MAGIC = "# m365-bundle v1"
PROTOCOL_DIR = "_m365"
PROTOCOL_PREFIX = "_m365/"
MANIFEST_PATH = "_m365/manifest.json"
STATE_PATH = "_m365/state.json"
DELETED_PATH = "_m365/DELETED.txt"
TASK_PATH = "_m365/TASK.md"
AUDIT_PATH = "_m365/AUDIT.md"
IMPL_AUDIT_PATH = "_m365/AUDIT.implementer.md"
MANIFEST_SCHEMA = "m365-manifest/1"
# Same list as JUNK_DIRS in scripts/lib/m365-rules.mjs: never walked, packed or hashed.
SKIP_DIRS = ("__pycache__", ".git", "node_modules", ".pytest_cache", ".mypy_cache")
# Never packed from the working directory: bookkeeping, and DELETED.txt which pack
# regenerates from the manifest.
PACK_EXCLUDE = (MANIFEST_PATH, STATE_PATH, DELETED_PATH)
# A ZIP holding any of these came out of a round, not out of make-input.mjs. So does
# one carrying a valid MANIFEST_PATH (pack --full): make-input.mjs never writes one.
OUTPUT_MARKERS = (AUDIT_PATH, "_m365/ROUNDS.md", DELETED_PATH)

# Same list as BINARY_EXT in scripts/lib/m365-rules.mjs.
BINARY_EXT = frozenset([
    ".png", ".jpg", ".jpeg", ".gif", ".bmp", ".ico", ".webp", ".pdf", ".zip", ".gz", ".tgz", ".7z", ".rar",
    ".exe", ".dll", ".so", ".dylib", ".class", ".jar", ".pyc", ".woff", ".woff2", ".ttf", ".otf",
    ".mp3", ".mp4", ".mov", ".wav", ".ogg", ".docx", ".xlsx", ".pptx", ".doc", ".xls", ".ppt",
])

# Same map as INFO_BY_EXT in scripts/lib/bundle.mjs.
INFO_BY_EXT = {
    ".py": "python", ".js": "javascript", ".mjs": "javascript", ".cjs": "javascript", ".ts": "typescript",
    ".md": "markdown", ".json": "json", ".yaml": "yaml", ".yml": "yaml", ".sh": "bash", ".html": "html",
    ".css": "css", ".toml": "toml", ".xml": "xml", ".txt": "text",
}

HEADER_LINE_RE = re.compile(r"^- ([a-z]+): (.*)$")
SECTION_RE = re.compile(r"^### (FILE|DELETE) (.+?)(?: \[([a-z,]+)\])?$")
SKIPPED_RE = re.compile(r"^- (.+?) \((.+)\)$")
FENCE_OPEN_RE = re.compile(r"^(`{3,})")
DRIVE_RE = re.compile(r"^[A-Za-z]:")
# "notes [draft]" would read back as "### FILE notes" with flags "draft".
FLAG_LIKE_RE = re.compile(r" \[[^\]]*\]$")
TASK_RE = re.compile(r"^# TASK\s+([A-Za-z0-9][A-Za-z0-9._-]*)\s*$", re.M)


class BundleError(Exception):
    """A problem with the bundle or the working directory, reported as exit 1."""


# --------------------------------------------------------------------- helpers
def unsafe_path_reason(p):
    """Why a path breaks the path model, or None when it is fine."""
    if not isinstance(p, str) or p == "":
        return "empty path"
    if "\\" in p:
        return "backslash in path"
    if p.startswith("/"):
        return "absolute path"
    if DRIVE_RE.match(p):
        return "drive letter in path"
    if "\0" in p:
        return "NUL in path"
    segs = p.split("/")
    # _M365/... would bypass every exact-case protocol check, and on a case-insensitive
    # file system it is the same directory as _m365/.
    if segs[0] != PROTOCOL_DIR and segs[0].lower() == PROTOCOL_DIR:
        return "case variant of the reserved _m365/ prefix"
    for seg in segs:
        if seg == "":
            return "empty segment"
        if seg in (".", ".."):
            return '"%s" segment' % seg
        if is_git_segment(seg):
            return ".git segment"
        if RESERVED_CHAR_RE.search(seg):
            return "reserved character in segment"
        if seg[-1] in ". ":
            return "segment ends with a dot or space"
        if FLAG_LIKE_RE.search(seg):
            return 'segment ends in " [...]" (reads as Markdown bundle flags)'
        if is_windows_device_name(seg):
            return "Windows reserved device name"
        if SHORT_NAME_RE.search(seg):
            return "8.3 short-name pattern (~N) in segment"
    return None


RESERVED_CHAR_RE = re.compile(r'[:<>"|?*\x00-\x1f]')
GIT_SHORT_RE = re.compile(r"^git~[0-9]+$")
# Same rules as isWindowsDeviceName and the ~N check in scripts/lib/bundle.mjs, so the
# sandbox refuses at pack time what a Windows checkout would refuse at unpack time.
DEVICE_NAME_RE = re.compile(r"^(con|prn|aux|nul|com[1-9]|lpt[1-9])$", re.I)
SHORT_NAME_RE = re.compile(r"~[0-9]")


def is_windows_device_name(seg):
    """CON, PRN, AUX, NUL, COM1-9, LPT1-9 in any letter case, with or without an extension."""
    stem = seg.rstrip(". ").split(".")[0].rstrip(" ")
    return bool(DEVICE_NAME_RE.match(stem))


def is_git_segment(seg):
    """Case-insensitive .git, its 8.3 short names (GIT~1) and trailing-junk variants."""
    s = seg.lower().rstrip(". ")
    return s == ".git" or bool(GIT_SHORT_RE.match(s)) or s.startswith(".git:")


def assert_safe_path(p):
    why = unsafe_path_reason(p)
    if why:
        raise BundleError('unsafe path "%s": %s' % (p, why))
    return p


def is_protocol_path(p):
    """Under the reserved _m365/ prefix, in any letter case (unsafe_path_reason refuses the variants)."""
    return p[:len(PROTOCOL_PREFIX)].lower() == PROTOCOL_PREFIX


def fold_path(p):
    """Case- and normalisation-insensitive key, as foldPath in scripts/lib/bundle.mjs
    (NFC, then lower case): how the default macOS and Windows file systems compare names."""
    return unicodedata.normalize("NFC", p).lower()


def in_skip_dir(p):
    return any(seg in SKIP_DIRS for seg in p.split("/")[:-1])


def assert_no_file_dir_clash(paths):
    """Refuse a set where one path is a directory of another (a and a/b): writing both
    fails half-way, so this runs before anything is written."""
    files = set(paths)
    for p in sorted(files):
        parts = p.split("/")
        for k in range(1, len(parts)):
            prefix = "/".join(parts[:k])
            if prefix in files:
                raise BundleError("%s is both a file and the directory of %s" % (prefix, p))


def assert_no_fold_collision(paths, hint=""):
    """Refuse delivered paths that fold to one name, or a file that folds to the directory
    of another (Docs and docs/x.md): the local unpacker refuses such a bundle whole.
    Deletions are not passed in, since one that folds to a delivered path is a rename."""
    by_fold = {}
    for p in paths:
        k = fold_path(p)
        if k in by_fold:
            raise BundleError("%s and %s differ only in letter case or Unicode normalisation%s" % (by_fold[k], p, hint))
        by_fold[k] = p
    for p in paths:
        segs = fold_path(p).split("/")
        for k in range(1, len(segs)):
            prefix = "/".join(segs[:k])
            if prefix in by_fold:
                raise BundleError("%s is delivered as a file but is also the directory of %s%s" % (by_fold[prefix], p, hint))


def parse_manifest_bytes(data):
    """The manifest dict when data is a valid m365-manifest/1 file, else None."""
    try:
        m = json.loads(data.decode("utf-8"))
    except (ValueError, UnicodeDecodeError):
        return None
    if isinstance(m, dict) and m.get("schema") == MANIFEST_SCHEMA and isinstance(m.get("files"), dict):
        return m
    return None


def ext_of(name):
    base = name[name.rfind("/") + 1:]
    dot = base.rfind(".")
    return "" if dot <= 0 else base[dot:].lower()


def is_binary(data, path=""):
    if ext_of(path) in BINARY_EXT:
        return True
    return b"\0" in data[:8192]


def sha256_hex(data):
    return hashlib.sha256(data).hexdigest()


def read_bytes(path):
    with open(path, "rb") as fh:
        return fh.read()


def write_bytes(path, data):
    parent = os.path.dirname(path)
    if parent:
        os.makedirs(parent, exist_ok=True)
    with open(path, "wb") as fh:
        fh.write(data)


def write_json(path, obj):
    write_bytes(path, (json.dumps(obj, indent=2, ensure_ascii=False) + "\n").encode("utf-8"))


def read_text(path):
    text = read_bytes(path).decode("utf-8", errors="replace")
    if text.startswith("\ufeff"):
        text = text[1:]
    return text.replace("\r\n", "\n")


def native(workdir, rel):
    return os.path.join(workdir, *rel.split("/"))


def walk_files(root, skip_top=None):
    """Relative '/' paths of regular files under root, skipping SKIP_DIRS everywhere and
    skip_top at the top level. Symbolic links are not followed or listed."""
    out = []
    for dirpath, dirnames, filenames in os.walk(root):
        rel_dir = os.path.relpath(dirpath, root)
        rel_dir = "" if rel_dir == "." else rel_dir.replace(os.sep, "/")
        keep = []
        for d in dirnames:
            if d in SKIP_DIRS or os.path.islink(os.path.join(dirpath, d)):
                continue
            if rel_dir == "" and skip_top is not None and d == skip_top:
                continue
            keep.append(d)
        dirnames[:] = sorted(keep)
        for f in filenames:
            full = os.path.join(dirpath, f)
            if os.path.islink(full) or not os.path.isfile(full):
                continue
            out.append(rel_dir + "/" + f if rel_dir else f)
    return sorted(out)


def task_slug_from_text(text):
    m = TASK_RE.search(text)
    return m.group(1) if m else None


def load_manifest(workdir):
    path = native(workdir, MANIFEST_PATH)
    if not os.path.isfile(path):
        raise BundleError("%s not found; run `bundle_io.py unpack` first" % path)
    try:
        manifest = json.loads(read_text(path))
    except ValueError as e:
        raise BundleError("%s is not valid JSON: %s" % (path, e))
    if not isinstance(manifest, dict) or not isinstance(manifest.get("files"), dict):
        raise BundleError('%s has no "files" object' % path)
    return manifest


def load_state(workdir):
    path = native(workdir, STATE_PATH)
    if not os.path.isfile(path):
        return None
    try:
        return json.loads(read_text(path))
    except ValueError as e:
        raise BundleError("%s is not valid JSON: %s" % (path, e))


def compute_status(workdir, manifest):
    base = manifest["files"]
    current = walk_files(workdir, skip_top=PROTOCOL_DIR)
    added, modified = [], []
    unchanged = 0
    seen = set()
    for rel in current:
        seen.add(rel)
        digest = sha256_hex(read_bytes(native(workdir, rel)))
        if rel not in base:
            added.append(rel)
        elif base[rel] != digest:
            modified.append(rel)
        else:
            unchanged += 1
    deleted = sorted(p for p in base if p not in seen)
    return {"added": added, "modified": modified, "deleted": deleted, "unchanged": unchanged}


# ------------------------------------------------------------------ ZIP codec
# Bundles are repository subsets; anything near these caps is hostile or a mistake.
ZIP_MAX_ENTRIES = 10000
ZIP_MAX_ENTRY_BYTES = 64 * 1024 * 1024
ZIP_MAX_TOTAL_BYTES = 256 * 1024 * 1024


def read_zip(raw):
    """Return [(path, bytes)] for every file entry. Validates every name first."""
    try:
        zf = zipfile.ZipFile(io.BytesIO(raw))
    except zipfile.BadZipFile as e:
        raise BundleError("not a readable ZIP file: %s" % e)
    entries = []
    names = set()
    total = 0
    with zf:
        infos = zf.infolist()
        if len(infos) > ZIP_MAX_ENTRIES:
            raise BundleError("zip has %d entries (limit %d)" % (len(infos), ZIP_MAX_ENTRIES))
        # Pass 1: names, flags and declared sizes, before a single payload is read.
        for info in infos:
            # orig_filename is the name as stored; filename may have had "\" rewritten.
            name = info.orig_filename
            if name.endswith("/"):
                continue  # directory entry; directories are implied by file paths
            assert_safe_path(name)
            if info.flag_bits & 0x1:
                raise BundleError("zip entry %s is encrypted" % name)
            if name in names:
                raise BundleError("zip contains %s twice" % name)
            names.add(name)
            if info.file_size > ZIP_MAX_ENTRY_BYTES:
                raise BundleError("zip entry %s declares %d bytes (limit %d)" % (name, info.file_size, ZIP_MAX_ENTRY_BYTES))
            total += info.file_size
            if total > ZIP_MAX_TOTAL_BYTES:
                raise BundleError("zip entries declare more than %d bytes in total" % ZIP_MAX_TOTAL_BYTES)
        # Pass 2: read, and hold every entry to its declared size.
        for info in infos:
            name = info.orig_filename
            if name.endswith("/"):
                continue
            try:
                with zf.open(info) as fh:
                    data = fh.read(info.file_size + 1)
            except (zipfile.BadZipFile, NotImplementedError, RuntimeError, zlib.error) as e:
                raise BundleError("cannot read zip entry %s: %s" % (name, e))
            if len(data) != info.file_size:
                raise BundleError("zip entry %s does not match its declared size" % name)
            entries.append((name, data))
    return entries


def write_zip(out_path, entries, store=False):
    method = zipfile.ZIP_STORED if store else zipfile.ZIP_DEFLATED
    stamp = time.localtime()[:6]
    if stamp[0] < 1980:
        stamp = (1980, 1, 1, 0, 0, 0)
    try:
        with zipfile.ZipFile(out_path, "w", compression=method, allowZip64=False) as zf:
            for name, data in entries:
                assert_safe_path(name)
                info = zipfile.ZipInfo(name, date_time=stamp)
                info.compress_type = method
                info.external_attr = 0o644 << 16
                zf.writestr(info, data)
    except zipfile.LargeZipFile as e:
        raise BundleError("bundle too large for a non-ZIP64 archive: %s" % e)


# ------------------------------------------------------------- Markdown codec
def parse_markdown(text):
    """Parse a Markdown bundle. Mirrors parseBundle in scripts/lib/bundle.mjs."""
    if text.startswith("\ufeff"):
        text = text[1:]
    text = text.replace("\r\n", "\n")
    lines = text.split("\n")
    if lines[0] != BUNDLE_MAGIC:
        raise BundleError('not a bundle: first line must be "%s"' % BUNDLE_MAGIC)
    header = {}
    i = 1
    while i < len(lines):
        m = HEADER_LINE_RE.match(lines[i])
        if not m:
            break
        header[m.group(1)] = m.group(2)
        i += 1
    kind = header.get("kind")
    if kind is not None and kind not in ("input", "output", "audit"):
        raise BundleError('bundle: unknown kind "%s"' % kind)

    files, deletes, skipped = [], [], []
    seen = set()
    in_skipped = False
    while i < len(lines):
        line = lines[i]
        if line == "## Skipped":
            in_skipped = True
            i += 1
            continue
        if in_skipped:
            m = SKIPPED_RE.match(line)
            if m:
                skipped.append((m.group(1), m.group(2)))
            i += 1
            continue
        h = SECTION_RE.match(line)
        if not h:
            i += 1
            continue
        path = assert_safe_path(h.group(2))
        if path in seen:
            raise BundleError("bundle: %s appears twice" % path)
        seen.add(path)
        if h.group(1) == "DELETE":
            deletes.append(path)
            i += 1
            continue
        flags = set(f for f in (h.group(3) or "").split(",") if f)
        nxt = lines[i + 1] if i + 1 < len(lines) else ""
        o = FENCE_OPEN_RE.match(nxt)
        if not o:
            raise BundleError("bundle: %s is not followed by a code fence" % path)
        fence = o.group(1)
        j = i + 2
        body = []
        while j < len(lines) and lines[j] != fence:
            body.append(lines[j])
            j += 1
        if j >= len(lines):
            raise BundleError("bundle: unterminated fence for %s" % path)
        content = "\n".join(body)
        noeol = "noeol" in flags
        if body and not noeol:
            content += "\n"
        files.append((path, content.encode("utf-8")))
        i = j + 1
    return {"header": header, "files": files, "deletes": deletes, "skipped": skipped}


def longest_backtick_run(text):
    best = run = 0
    for ch in text:
        if ch == "`":
            run += 1
            if run > best:
                best = run
        else:
            run = 0
    return best


def iso_now():
    now = datetime.datetime.now(datetime.timezone.utc)
    return now.strftime("%Y-%m-%dT%H:%M:%S.") + "%03dZ" % (now.microsecond // 1000)


def format_markdown(task, kind, round_no, files, deletes, skipped):
    """files: [(path, text)] with text already decoded. Mirrors formatBundle."""
    out = [
        BUNDLE_MAGIC,
        "- task: %s" % task,
        "- kind: %s" % kind,
        "- round: %s" % round_no,
        "- created: %s" % iso_now(),
        "- eol: lf",
        "- files: %d" % len(files),
        "",
        "## Files",
        "",
    ]
    for path, text in files:
        assert_safe_path(path)
        if text.startswith("\ufeff"):
            text = text[1:]
        text = text.replace("\r\n", "\n").replace("\r", "\n")
        had_content = len(text) > 0
        noeol = had_content and not text.endswith("\n")
        if not noeol and text.endswith("\n"):
            text = text[:-1]
        fence = "`" * max(3, longest_backtick_run(text) + 1)
        info = INFO_BY_EXT.get(ext_of(path), "")
        out.append("### FILE %s%s" % (path, " [noeol]" if noeol else ""))
        out.append(fence + info)
        # A file that is exactly "\n" leaves text == "" here; one empty line keeps it.
        if had_content:
            out.append(text)
        out.append(fence)
        out.append("")
    for d in deletes:
        assert_safe_path(d)
        out.append("### DELETE %s" % d)
        out.append("")
    if skipped:
        out.append("## Skipped")
        out.append("")
        for path, reason in skipped:
            out.append("- %s (%s)" % (path, reason))
        out.append("")
    return "\n".join(out)


# -------------------------------------------------------------------- unpack
def read_bundle(bundle_path):
    raw = read_bytes(bundle_path)
    if raw[:4] == b"PK\x03\x04":
        files = read_zip(raw)
        deletes = []
        for path, data in files:
            if path == DELETED_PATH:
                for line in data.decode("utf-8", errors="replace").splitlines():
                    line = line.strip()
                    if line:
                        deletes.append(assert_safe_path(line))
        is_output = any(p in OUTPUT_MARKERS or (p == MANIFEST_PATH and parse_manifest_bytes(d) is not None)
                        for p, d in files)
        file_paths = set(p for p, _ in files)
        seen_del = set()
        for d in deletes:
            if is_protocol_path(d):
                raise BundleError("deletion list names a protocol path: %s" % d)
            if d in file_paths:
                raise BundleError("%s is both delivered and listed for deletion" % d)
            if d in seen_del:
                raise BundleError("%s is listed for deletion twice" % d)
            seen_del.add(d)
        # Deletions are only recorded, never written, so a deleted file may become a
        # directory (docs -> docs/index.md); only delivered paths can clash.
        assert_no_file_dir_clash(list(file_paths))
        assert_no_fold_collision([p for p, _ in files])
        return {"encoding": "zip", "header": {}, "files": files, "deletes": deletes,
                "skipped": [], "detected_kind": "output" if is_output else "input"}
    try:
        text = raw.decode("utf-8")
    except UnicodeDecodeError:
        raise BundleError("%s is neither a ZIP file nor UTF-8 text" % bundle_path)
    first = text[1:] if text.startswith("\ufeff") else text
    if not first.split("\n", 1)[0].rstrip("\r") == BUNDLE_MAGIC:
        raise BundleError('%s is neither a ZIP file nor a Markdown bundle (first line must be "%s")'
                          % (bundle_path, BUNDLE_MAGIC))
    b = parse_markdown(text)
    for d in b["deletes"]:
        if is_protocol_path(d):
            raise BundleError("bundle deletes a protocol path: %s" % d)
    assert_no_file_dir_clash([p for p, _ in b["files"]])
    assert_no_fold_collision([p for p, _ in b["files"]])
    kind = b["header"].get("kind")
    if kind is None:
        carried = any(p == MANIFEST_PATH and parse_manifest_bytes(d) is not None for p, d in b["files"])
        kind = "output" if carried else "input"
    return {"encoding": "markdown", "header": b["header"], "files": b["files"], "deletes": b["deletes"],
            "skipped": b["skipped"], "detected_kind": "input" if kind == "input" else "output"}


def cmd_unpack(args):
    bundle = read_bundle(args.bundle)  # validates every path before anything is written
    workdir = args.workdir
    kind = bundle["detected_kind"] if args.kind == "auto" else args.kind
    if os.path.isdir(workdir) and os.listdir(workdir):
        sys.stderr.write("warning: %s is not empty; existing files outside the bundle will show as added\n" % workdir)

    repo_files = [(p, d) for p, d in bundle["files"] if not is_protocol_path(p)]
    proto_files = [(p, d) for p, d in bundle["files"] if is_protocol_path(p)]
    # A full output bundle (pack --full) carries the input manifest so that an independent
    # audit can tell real changes from untouched files. Anything else is replaced.
    carried_manifest = None
    for p, d in proto_files:
        if p == MANIFEST_PATH:
            carried_manifest = parse_manifest_bytes(d)
            if carried_manifest is None:
                sys.stderr.write("warning: the bundle carries an unreadable %s; it is replaced\n" % MANIFEST_PATH)
    proto_files = [(p, d) for p, d in proto_files if p != MANIFEST_PATH]
    renamed_audit = False
    if kind == "output" and any(p == AUDIT_PATH for p, _ in proto_files):
        # The implementer's self-audit stays readable, but a standalone audit of this
        # bundle must start its own AUDIT.md instead of appending to it.
        proto_files = [(IMPL_AUDIT_PATH if p == AUDIT_PATH else p, d) for p, d in proto_files]
        renamed_audit = True

    # Everything this unpack writes, checked against itself and the existing workdir
    # before the first byte goes out, so that a clash cannot leave half a bundle behind.
    targets = [p for p, _ in repo_files] + [p for p, _ in proto_files] + [MANIFEST_PATH]
    if bundle["encoding"] == "markdown" and bundle["deletes"]:
        targets.append(DELETED_PATH)
    assert_no_file_dir_clash(targets)
    for path in targets:
        parts = path.split("/")
        for k in range(1, len(parts)):
            prefix = native(workdir, "/".join(parts[:k]))
            if os.path.lexists(prefix) and not os.path.isdir(prefix):
                raise BundleError("cannot unpack %s: %s exists in %s and is not a directory"
                                  % (path, "/".join(parts[:k]), workdir))
        if os.path.isdir(native(workdir, path)):
            raise BundleError("cannot unpack %s: a directory of that name exists in %s" % (path, workdir))

    os.makedirs(workdir, exist_ok=True)
    hashes = {}
    for path, data in repo_files:
        write_bytes(native(workdir, path), data)
        if not in_skip_dir(path):  # status never walks these, so they would read as deleted
            hashes[path] = sha256_hex(data)
    for path, data in proto_files:
        write_bytes(native(workdir, path), data)
    removed = []
    for path in bundle["deletes"]:
        target = native(workdir, path)
        if os.path.isfile(target):
            os.remove(target)
            removed.append(path)
    if bundle["encoding"] == "markdown" and bundle["deletes"]:
        write_bytes(native(workdir, DELETED_PATH), ("\n".join(bundle["deletes"]) + "\n").encode("utf-8"))

    task = None
    task_file = native(workdir, TASK_PATH)
    if os.path.isfile(task_file):
        task = task_slug_from_text(read_text(task_file))
    if task is None:
        task = bundle["header"].get("task") or None

    not_carried = []
    if kind == "output":
        base = dict(sorted((p, h) for p, h in carried_manifest["files"].items() if not in_skip_dir(p))) \
            if carried_manifest else {}
        # A Markdown bundle cannot carry binary files and lists them under "## Skipped".
        # They are still in the repository, so they must not count as deleted.
        delivered = set(p for p, _ in repo_files)
        for p, _ in bundle["skipped"]:
            if p in base and p not in delivered:
                del base[p]
                not_carried.append(p)
        if task is None and carried_manifest:
            task = carried_manifest.get("task") or None
    else:
        base = dict(sorted(hashes.items()))
    manifest = {"schema": MANIFEST_SCHEMA, "task": task, "files": base}
    write_json(native(workdir, MANIFEST_PATH), manifest)

    proto_present = sorted(p for p, _ in proto_files)
    print("unpacked %s -> %s" % (args.bundle, workdir))
    print("  encoding: %s  kind: %s" % (bundle["encoding"], kind))
    print("  task: %s" % (task if task else "(none: _m365/TASK.md missing or has no '# TASK <slug>')"))
    print("  repository files: %d" % len(repo_files))
    print("  protocol files: %s" % (", ".join(proto_present) if proto_present else "(none)"))
    if bundle["deletes"]:
        print("  deletions listed: %s" % ", ".join(bundle["deletes"]))
    if removed:
        print("  removed from workdir: %s" % ", ".join(removed))
    if bundle["skipped"]:
        print("  skipped by the packer (not in this bundle): %s"
              % ", ".join("%s (%s)" % s for s in bundle["skipped"]))
    if not_carried:
        print("  not carried, left out of the manifest (status cannot tell whether they changed): %s"
              % ", ".join(not_carried))
    if renamed_audit:
        print("  %s from the bundle saved as %s; a new audit report starts fresh" % (AUDIT_PATH, IMPL_AUDIT_PATH))
    if kind == "output" and carried_manifest:
        print("  manifest: carried from the input (%d files) - status shows the real changes" % len(base))
    elif kind == "output":
        print("  manifest: empty (output bundle without a manifest) - every repository file above counts as a change")
    else:
        print("  manifest: %s (%d files)" % (MANIFEST_PATH, len(hashes)))
    if task is None:
        sys.stderr.write("warning: no task slug found; pass --task to pack\n")
    return 0


# -------------------------------------------------------------------- status
def cmd_status(args):
    status = compute_status(args.workdir, load_manifest(args.workdir))
    print(json.dumps(status, indent=2, ensure_ascii=False))
    return 0


# ---------------------------------------------------------------------- pack
def cmd_pack(args):
    workdir = args.workdir
    out = args.out
    lower = out.lower()
    if lower.endswith(".zip"):
        encoding = "zip"
    elif lower.endswith(".md") or lower.endswith(".txt"):
        encoding = "markdown"
    else:
        raise BundleError("output must end in .zip, .md or .txt: %s" % out)

    manifest = load_manifest(workdir)
    state = load_state(workdir)
    round_no = args.round
    if round_no is None:
        round_no = state.get("round") if isinstance(state, dict) and state.get("round") else 1
    task = args.task or manifest.get("task")
    if not task and os.path.isfile(native(workdir, TASK_PATH)):
        task = task_slug_from_text(read_text(native(workdir, TASK_PATH)))

    # Never pack the output file itself when it lives inside the working directory.
    out_rel = None
    rel = os.path.relpath(os.path.abspath(out), os.path.abspath(workdir))
    if not rel.startswith("..") and not os.path.isabs(rel):
        out_rel = rel.replace(os.sep, "/")
        sys.stderr.write("warning: %s is inside the working directory; later `status` runs will list it\n" % out)

    if args.kind == "audit":
        if not os.path.isfile(native(workdir, AUDIT_PATH)):
            raise BundleError("%s not found; run `audit_checks.py report` first" % native(workdir, AUDIT_PATH))
        paths = [AUDIT_PATH]
        deletes = []
    else:
        status = compute_status(workdir, manifest)
        deletes = status["deleted"]
        if args.full:
            # Everything that exists now: the untouched files plus additions, so that an
            # independent auditor sees callers and tests, not just the delta. The input
            # manifest rides along so the auditor can still tell what changed.
            present = (set(manifest["files"]) - set(deletes)) | set(status["added"])
            repo = sorted(p for p in present if p != out_rel)
        else:
            repo = sorted(p for p in status["added"] + status["modified"] if p != out_rel)
        proto = [PROTOCOL_PREFIX + p for p in walk_files(native(workdir, PROTOCOL_DIR))] \
            if os.path.isdir(native(workdir, PROTOCOL_DIR)) else []
        exclude = tuple(p for p in PACK_EXCLUDE if not (args.full and p == MANIFEST_PATH))
        proto = [p for p in proto if p not in exclude and p != out_rel]
        paths = repo + proto
        if AUDIT_PATH not in proto:
            sys.stderr.write("warning: no %s; the local unpacker will report no verdict\n" % AUDIT_PATH)

    # Everything the local unpacker would refuse stops the pack here, before the output
    # file is opened, so that a refusal never leaves half a ZIP behind.
    for p in paths + deletes:
        assert_safe_path(p)
    assert_no_fold_collision(paths + ([DELETED_PATH] if deletes and encoding == "zip" else []),
                             hint="; rename or remove one of them before packing")

    packed = []
    skipped = []
    if encoding == "zip":
        entries = [(p, read_bytes(native(workdir, p))) for p in paths]
        if deletes:
            entries.append((DELETED_PATH, ("\n".join(deletes) + "\n").encode("utf-8")))
        write_zip(out, entries, store=args.store)
        packed = [p for p, _ in entries]
    else:
        if not task:
            raise BundleError("no task slug in the manifest or _m365/TASK.md; pass --task")
        files = []
        for p in paths:
            data = read_bytes(native(workdir, p))
            if is_binary(data, p):
                skipped.append((p, "binary"))
                continue
            try:
                text = data.decode("utf-8")
            except UnicodeDecodeError:
                skipped.append((p, "not UTF-8 text"))
                continue
            files.append((p, text))
        kind = "audit" if args.kind == "audit" else "output"
        text = format_markdown(task, kind, round_no, files, deletes, skipped)
        write_bytes(out, text.encode("utf-8"))
        packed = [p for p, _ in files] + ["DELETE " + d for d in deletes]

    print("packed %s (%s, kind %s, round %s)" % (out, encoding, args.kind, round_no))
    for p in packed:
        print("  %s" % p)
    for p, reason in skipped:
        sys.stderr.write("warning: %s not packed (%s); the Markdown encoding cannot carry it\n" % (p, reason))
    return 0


# ----------------------------------------------------------------------- main
def build_parser():
    ap = argparse.ArgumentParser(prog="bundle_io.py", description="Read and write m365 bundles.")
    sub = ap.add_subparsers(dest="cmd")
    sub.required = True

    p = sub.add_parser("unpack", help="extract a bundle into a working directory")
    p.add_argument("bundle")
    p.add_argument("workdir")
    p.add_argument("--kind", choices=["auto", "input", "output"], default="auto",
                   help="input: hash every file into the manifest; output: keep the carried manifest, or an empty one if absent (default: detect)")
    p.set_defaults(func=cmd_unpack)

    p = sub.add_parser("status", help="list changes since unpack as JSON")
    p.add_argument("workdir")
    p.set_defaults(func=cmd_status)

    p = sub.add_parser("pack", help="write an output or audit bundle")
    p.add_argument("workdir")
    p.add_argument("out")
    p.add_argument("--kind", choices=["output", "audit"], default="output")
    p.add_argument("--full", action="store_true",
                   help="pack every repository file (not only changes) plus the input manifest, for an independent audit")
    p.add_argument("--round", type=int, default=None)
    p.add_argument("--task", default=None)
    p.add_argument("--store", action="store_true", help="ZIP without compression")
    p.set_defaults(func=cmd_pack)
    return ap


def main(argv=None):
    if hasattr(sys.stdout, "reconfigure"):
        try:
            sys.stdout.reconfigure(encoding="utf-8", errors="replace")
        except (ValueError, OSError):
            pass
    args = build_parser().parse_args(argv)
    try:
        return args.func(args)
    except BundleError as e:
        sys.stderr.write("error: %s\n" % e)
        return 1
    except (OSError, IOError) as e:
        sys.stderr.write("error: %s\n" % e)
        return 1


if __name__ == "__main__":
    sys.exit(main())
