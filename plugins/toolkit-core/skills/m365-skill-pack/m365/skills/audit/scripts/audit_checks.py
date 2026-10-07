#!/usr/bin/env python3
"""Deterministic audit checks and the _m365/AUDIT.md writer (see loop-protocol.md).

Usage:
    python3 audit_checks.py check <workdir> [--task TASK.md] [--out checks.json] [--allow-empty]
        Compare the working directory with _m365/manifest.json and run the
        deterministic checks against _m365/TASK.md:
          syntax     every added/modified .py compiles (compile(), so module-level
                     "return" and the like count); .sh/.bash start with "#!"
          json       every added/modified .json parses as strict JSON (no BOM, no
                     NaN/Infinity); tsconfig*.json, jsconfig*.json, .vscode/*.json,
                     devcontainer.json and *.jsonc may carry comments and trailing commas
          scope      every added/modified/deleted path matches a "## Scope" glob
          forbidden  no line of an added/modified text file matches a
                     "## Forbidden patterns" regex. The manifest holds only hashes, so
                     the whole file is checked, lines that were already there included.
          files      counts; FAIL when nothing changed (unless --allow-empty)
        Prints the result as JSON and writes it to --out (default
        <workdir>/_m365/checks.json). Exit 0 even when a check fails; read the JSON.

    python3 audit_checks.py report <workdir> --round N --ac AC-1=PASS
                                   --ac "AC-2=FAIL:detail" ... [--checks checks.json]
                                   [--allow-empty] [--notes TEXT]
        Merge the deterministic checks (re-run when --checks is missing; pass
        --allow-empty again for a task that changes nothing) with one
        judgement per acceptance criterion, then rewrite _m365/AUDIT.md: "# AUDIT", the
        m365-audit/1 JSON block (earlier rounds kept), and a "## Round N" section per
        round. Prints the JSON summary. Exit 2 when an AC is missing, unknown, or a
        FAIL has no detail.

TASK.md lists: "-", "*", "+" and "1." / "1)" items all count. Acceptance items are
"AC-n" followed by ":", "-", an en or em dash, or a space; the id may be bold or in
backticks. A "## Scope" or "## Acceptance" section with text but no usable item is an
error, never an unrestricted scope or an empty criteria list.

Scope globs: "**" crosses "/", "*" and "?" do not, "**/" may match nothing, and a
pattern ending in "/" covers everything below it. Python 3.8+, standard library only.
The walk-and-hash logic repeats bundle_io.py on purpose: each skill is packaged on its
own and cannot import from another skill.
"""

import argparse
import hashlib
import json
import os
import re
import sys
import warnings

CHECKS_SCHEMA = "m365-checks/1"
AUDIT_SCHEMA = "m365-audit/1"
PROTOCOL_DIR = "_m365"
# Same list as JUNK_DIRS in scripts/lib/m365-rules.mjs.
SKIP_DIRS = ("__pycache__", ".git", "node_modules", ".pytest_cache", ".mypy_cache")
DEFAULT_MAX_ROUNDS = 3
FORBIDDEN_CAP = 20
TASK_RE = re.compile(r"^# TASK\s+([A-Za-z0-9][A-Za-z0-9._-]*)\s*$", re.M)
HEADING_RE = re.compile(r"^##\s+(.+?)\s*$")
# AC-1: text | **AC-1**: text | **AC-1:** text | `AC-1` - text | AC-1 text, and an
# en or em dash (U+2013, U+2014) in place of "-".
AC_SEP = "[:\\-\u2013\u2014]"
AC_RE = re.compile(r"^(?:\*\*|__|`)?(AC-\d+)(?:\s*" + AC_SEP + r")?(?:\*\*|__|`)?(?:\s*" + AC_SEP + r"|\s|$)\s*(.*)$")
# "- item", "* item", "+ item", "1. item", "1) item"; an optional "[ ]" / "[x]" checkbox.
LIST_ITEM_RE = re.compile(r"^(?:[-*+]|\d+[.)])\s+(?:\[[ xX]\]\s+)?(.*)$")
AUDIT_JSON_RE = re.compile(r"```json\s*\n(.*?)\n```", re.S)
ROUND_HEADING_RE = re.compile(r"^## Round (\d+)\s*$", re.M)

# Same list as BINARY_EXT in scripts/lib/m365-rules.mjs.
BINARY_EXT = frozenset([
    ".png", ".jpg", ".jpeg", ".gif", ".bmp", ".ico", ".webp", ".pdf", ".zip", ".gz", ".tgz", ".7z", ".rar",
    ".exe", ".dll", ".so", ".dylib", ".class", ".jar", ".pyc", ".woff", ".woff2", ".ttf", ".otf",
    ".mp3", ".mp4", ".mov", ".wav", ".ogg", ".docx", ".xlsx", ".pptx", ".doc", ".xls", ".ppt",
])


class AuditError(Exception):
    def __init__(self, message, code=1):
        Exception.__init__(self, message)
        self.code = code


# -------------------------------------------------------------------- helpers
def proto(workdir, name):
    return os.path.join(workdir, PROTOCOL_DIR, name)


def native(workdir, rel):
    return os.path.join(workdir, *rel.split("/"))


def read_bytes(path):
    with open(path, "rb") as fh:
        return fh.read()


def read_text(path):
    text = read_bytes(path).decode("utf-8", errors="replace")
    if text.startswith("\ufeff"):
        text = text[1:]
    return text.replace("\r\n", "\n")


def write_text(path, text):
    parent = os.path.dirname(path)
    if parent:
        os.makedirs(parent, exist_ok=True)
    with open(path, "wb") as fh:
        fh.write(text.encode("utf-8"))


def read_json(path):
    try:
        return json.loads(read_text(path))
    except ValueError as e:
        raise AuditError("%s is not valid JSON: %s" % (path, e))


def ext_of(name):
    base = name[name.rfind("/") + 1:]
    dot = base.rfind(".")
    return "" if dot <= 0 else base[dot:].lower()


def is_binary(data, path):
    return ext_of(path) in BINARY_EXT or b"\0" in data[:8192]


def walk_files(root):
    """Relative '/' paths of repository files: skips _m365/ at the top and SKIP_DIRS
    everywhere; symbolic links are ignored."""
    out = []
    for dirpath, dirnames, filenames in os.walk(root):
        rel_dir = os.path.relpath(dirpath, root)
        rel_dir = "" if rel_dir == "." else rel_dir.replace(os.sep, "/")
        dirnames[:] = sorted(
            d for d in dirnames
            if d not in SKIP_DIRS and not os.path.islink(os.path.join(dirpath, d))
            and not (rel_dir == "" and d == PROTOCOL_DIR)
        )
        for f in filenames:
            full = os.path.join(dirpath, f)
            if os.path.islink(full) or not os.path.isfile(full):
                continue
            out.append(rel_dir + "/" + f if rel_dir else f)
    return sorted(out)


def compute_changes(workdir):
    path = proto(workdir, "manifest.json")
    if not os.path.isfile(path):
        raise AuditError("%s not found; unpack the bundle with bundle_io.py first" % path)
    manifest = read_json(path)
    base = manifest.get("files") if isinstance(manifest, dict) else None
    if not isinstance(base, dict):
        raise AuditError('%s has no "files" object' % path)
    added, modified = [], []
    seen = set()
    for rel in walk_files(workdir):
        seen.add(rel)
        digest = hashlib.sha256(read_bytes(native(workdir, rel))).hexdigest()
        if rel not in base:
            added.append(rel)
        elif base[rel] != digest:
            modified.append(rel)
    deleted = set(p for p in base if p not in seen)
    # An output bundle unpacked for a standalone audit carries its deletions here.
    deleted_txt = proto(workdir, "DELETED.txt")
    if os.path.isfile(deleted_txt):
        for line in read_text(deleted_txt).split("\n"):
            if line.strip():
                deleted.add(line.strip())
    return {"added": added, "modified": modified, "deleted": sorted(deleted)}


# --------------------------------------------------------------- TASK.md
def strip_code(item):
    """`pattern` -> pattern, so Markdown code spans can wrap a glob or regex."""
    if len(item) >= 2 and item[0] == "`" and item[-1] == "`" and "`" not in item[1:-1]:
        return item[1:-1]
    return item


def parse_task(text):
    m = TASK_RE.search(text)
    sections = {}
    current = None
    for line in text.split("\n"):
        h = HEADING_RE.match(line)
        if h:
            current = h.group(1).strip().lower()
            sections.setdefault(current, [])
            continue
        if line.startswith("# "):
            current = None
            continue
        if current is not None:
            sections[current].append(line)

    def bullets(name):
        items = []
        for line in sections.get(name, []):
            s = line.strip()
            b = LIST_ITEM_RE.match(s)
            if b:
                items.append(b.group(1).strip())
            elif s and items and line[:1] in (" ", "\t"):
                items[-1] = items[-1] + " " + s  # indented continuation line
        return items

    def has_text(name):
        return any(line.strip() and not re.match(r"^<!--.*-->$", line.strip()) for line in sections.get(name, []))

    # "## Acceptance criteria" is as good as "## Acceptance".
    acc_name = "acceptance" if "acceptance" in sections else "acceptance criteria"
    acceptance = []
    for item in bullets(acc_name):
        a = AC_RE.match(item)
        if a:
            acceptance.append({"id": a.group(1), "text": a.group(2).strip()})
    if not acceptance and has_text(acc_name):
        # A criteria list nobody can read must not turn into "nothing to judge" (PASS).
        raise AuditError('TASK.md "## Acceptance" has text but no criterion in the form "- AC-1: ..."; '
                         "fix the task file")
    ids = [a["id"] for a in acceptance]
    dupes = sorted(set(i for i in ids if ids.count(i) > 1))
    if dupes:
        raise AuditError("TASK.md lists %s more than once" % ", ".join(dupes))

    scope = None
    if "scope" in sections:
        scope = [strip_code(s) for s in bullets("scope")]
        if not scope and has_text("scope"):
            # Same reasoning: an unreadable scope must not become "no restriction".
            raise AuditError('TASK.md "## Scope" has text but no list item such as "- src/**"; fix the task file')

    max_rounds = None
    for line in sections.get("max rounds", []):
        if line.strip():
            value = line.strip().lstrip("-* ").strip()
            if not re.match(r"^\d+$", value):
                raise AuditError('TASK.md "## Max rounds" must be followed by an integer, got "%s"' % line.strip())
            max_rounds = int(value)
            break
    return {
        "slug": m.group(1) if m else None,
        "scope": scope,
        "forbidden": [strip_code(s) for s in bullets("forbidden patterns")],
        "acceptance": acceptance,
        "max_rounds": max_rounds,
    }


def load_task(workdir, task_path=None):
    path = task_path or proto(workdir, "TASK.md")
    if not os.path.isfile(path):
        raise AuditError("%s not found; the task contract is required" % path)
    return parse_task(read_text(path))


def glob_to_regex(glob):
    if glob.endswith("/"):
        glob += "**"
    out = []
    i, n = 0, len(glob)
    while i < n:
        c = glob[i]
        if c == "*":
            if glob[i + 1:i + 2] == "*":
                if glob[i + 2:i + 3] == "/":
                    out.append("(?:.*/)?")
                    i += 3
                else:
                    out.append(".*")
                    i += 2
            else:
                out.append("[^/]*")
                i += 1
        elif c == "?":
            out.append("[^/]")
            i += 1
        elif c == "[":
            j = i + 1
            if j < n and glob[j] == "!":
                j += 1
            if j < n and glob[j] == "]":
                j += 1
            while j < n and glob[j] != "]":
                j += 1
            if j >= n:
                out.append("\\[")
                i += 1
            else:
                stuff = glob[i + 1:j].replace("\\", "\\\\")
                if stuff.startswith("!"):
                    stuff = "^" + stuff[1:]
                elif stuff.startswith("^"):
                    stuff = "\\" + stuff
                out.append("[" + stuff + "]")
                i = j + 1
        else:
            out.append(re.escape(c))
            i += 1
    return re.compile("^" + "".join(out) + "$")


# ------------------------------------------------------------------ checks
def compile_error(data, rel):
    """Why the source does not compile, or None. compile() rather than ast.parse(), so
    that errors raised after parsing ("return" outside a function, "break" outside a
    loop, "global" after assignment) count as well."""
    try:
        with warnings.catch_warnings():
            warnings.simplefilter("ignore")  # SyntaxWarning noise, or an error under -W error
            compile(data, rel, "exec", dont_inherit=True)
    except SyntaxError as e:
        return "%s:%s: %s" % (rel, e.lineno or 0, e.msg)
    except ValueError as e:  # e.g. NUL bytes in the source on older interpreters
        return "%s:0: %s" % (rel, e)
    except (MemoryError, RecursionError) as e:  # e.g. a deeply nested expression
        return "%s:0: too deeply nested to compile (%s)" % (rel, type(e).__name__)
    return None


def check_syntax(workdir, changed):
    failures = []
    count = 0
    for rel in changed:
        ext = ext_of(rel)
        if ext == ".py":
            count += 1
            why = compile_error(read_bytes(native(workdir, rel)), rel)
            if why:
                failures.append(why)
        elif ext in (".sh", ".bash"):
            count += 1
            if not read_bytes(native(workdir, rel)).startswith(b"#!"):
                failures.append("%s:1: no shebang line" % rel)
    if failures:
        return {"id": "syntax", "status": "FAIL", "detail": "; ".join(failures)}
    if count == 0:
        return {"id": "syntax", "status": "PASS", "detail": "no .py or .sh files changed"}
    return {"id": "syntax", "status": "PASS", "detail": "%d file(s) checked" % count}


def is_jsonc(rel):
    """Files whose tools accept comments and trailing commas (JSON with Comments)."""
    base = rel[rel.rfind("/") + 1:].lower()
    if ext_of(rel) == ".jsonc" or base == "devcontainer.json":
        return True
    if (base.startswith("tsconfig") or base.startswith("jsconfig")) and base.endswith(".json"):
        return True
    parent = rel.split("/")[-2:-1]
    return bool(parent) and parent[0] == ".vscode" and base.endswith(".json")


def strip_jsonc(text):
    """Drop // and /* */ comments and trailing commas outside strings. Both become
    spaces (newlines kept) so that error positions still point at the right line."""
    out = []
    comma = None  # index in out of a "," that only blanks and comments have followed
    i, n = 0, len(text)
    while i < n:
        c = text[i]
        if c == '"':
            j = i + 1
            while j < n and text[j] != '"':
                j += 2 if text[j] == "\\" else 1
            out.append(text[i:j + 1])
            comma = None
            i = j + 1
        elif text.startswith("//", i):
            j = text.find("\n", i)
            j = n if j < 0 else j
            out.append(" " * (j - i))
            i = j
        elif text.startswith("/*", i):
            j = text.find("*/", i + 2)
            if j < 0:
                raise ValueError("unterminated /* comment")
            out.append("".join(ch if ch == "\n" else " " for ch in text[i:j + 2]))
            i = j + 2
        else:
            if c in "]}" and comma is not None:
                out[comma] = " "
            if c == ",":
                comma = len(out)
            elif c not in " \t\r\n":
                comma = None
            out.append(c)
            i += 1
    return "".join(out)


def reject_constant(name):
    raise ValueError("%s is not valid JSON" % name)


def json_error(data, rel):
    """Why the file is not valid JSON, or None. A UTF-8 BOM is tolerated: Visual Studio
    writes one into appsettings.json and its readers accept it."""
    if data.startswith(b"\xef\xbb\xbf"):
        data = data[3:]
    try:
        text = data.decode("utf-8")
    except UnicodeDecodeError as e:
        return "%s: not UTF-8 (%s)" % (rel, e)
    try:
        if is_jsonc(rel):
            text = strip_jsonc(text)
        json.loads(text, parse_constant=reject_constant)
    except (ValueError, RecursionError) as e:
        return "%s: %s" % (rel, e)
    return None


def check_json(workdir, changed):
    failures = []
    count = 0
    for rel in changed:
        if ext_of(rel) not in (".json", ".jsonc"):
            continue
        count += 1
        why = json_error(read_bytes(native(workdir, rel)), rel)
        if why:
            failures.append(why)
    if failures:
        return {"id": "json", "status": "FAIL", "detail": "; ".join(failures)}
    if count == 0:
        return {"id": "json", "status": "PASS", "detail": "no .json files changed"}
    return {"id": "json", "status": "PASS", "detail": "%d file(s) parsed" % count}


def check_scope(task, changes):
    if not task["scope"]:
        return {"id": "scope", "status": "PASS", "detail": "no scope restriction"}
    regexes = [glob_to_regex(g) for g in task["scope"]]
    touched = sorted(set(changes["added"] + changes["modified"] + changes["deleted"]))
    outside = [p for p in touched if not any(r.match(p) for r in regexes)]
    if outside:
        return {"id": "scope", "status": "FAIL", "detail": "outside scope: " + ", ".join(outside)}
    return {"id": "scope", "status": "PASS", "detail": "%d path(s) within %s" % (len(touched), ", ".join(task["scope"]))}


def check_forbidden(workdir, task, changed):
    if not task["forbidden"]:
        return {"id": "forbidden", "status": "PASS", "detail": "no forbidden patterns"}
    compiled, invalid = [], []
    for pat in task["forbidden"]:
        try:
            compiled.append((pat, re.compile(pat)))
        except re.error as e:
            invalid.append("invalid pattern %s: %s" % (pat, e))
    hits = []
    # The manifest keeps hashes, not the original text, so a changed file is checked as
    # a whole: a line that was already there before the change matches as well.
    for rel in changed:
        data = read_bytes(native(workdir, rel))
        if is_binary(data, rel):
            continue
        text = data.decode("utf-8", errors="replace").replace("\r\n", "\n")
        for lineno, line in enumerate(text.split("\n"), 1):
            for pat, rx in compiled:
                if rx.search(line):
                    hits.append("%s:%d: %s" % (rel, lineno, pat))
    problems = invalid + hits
    if problems:
        shown = problems[:FORBIDDEN_CAP]
        more = len(problems) - len(shown)
        detail = "; ".join(shown) + ("; ... and %d more" % more if more else "")
        return {"id": "forbidden", "status": "FAIL", "detail": detail}
    return {"id": "forbidden", "status": "PASS", "detail": "%d pattern(s), no match" % len(compiled)}


def check_files(changes, allow_empty):
    a, m, d = len(changes["added"]), len(changes["modified"]), len(changes["deleted"])
    total = a + m + d
    if total == 0 and not allow_empty:
        return {"id": "files", "status": "FAIL", "detail": "nothing changed"}
    return {"id": "files", "status": "PASS",
            "detail": "%d changed (%d added, %d modified, %d deleted)" % (total, a, m, d)}


def run_checks(workdir, task_path=None, allow_empty=False):
    task = load_task(workdir, task_path)
    changes = compute_changes(workdir)
    changed = changes["added"] + changes["modified"]
    return {
        "schema": CHECKS_SCHEMA,
        "changed": changes,
        "acceptance": task["acceptance"],
        "checks": [
            check_syntax(workdir, changed),
            check_json(workdir, changed),
            check_scope(task, changes),
            check_forbidden(workdir, task, changed),
            check_files(changes, allow_empty),
        ],
    }


def dump(obj):
    return json.dumps(obj, indent=2, ensure_ascii=False)


def is_scalar(v):
    return not isinstance(v, (dict, list))


def dump_compact(obj, level=0):
    """Indented JSON that keeps scalar-only objects and lists on one line, as in
    loop-protocol.md: { "id": "syntax", "status": "PASS" }."""
    pad = "  " * level
    if isinstance(obj, dict):
        if not obj:
            return "{}"
        if all(is_scalar(v) for v in obj.values()):
            return "{ " + ", ".join("%s: %s" % (json.dumps(k, ensure_ascii=False), json.dumps(v, ensure_ascii=False))
                                    for k, v in obj.items()) + " }"
        items = ["%s  %s: %s" % (pad, json.dumps(k, ensure_ascii=False), dump_compact(v, level + 1))
                 for k, v in obj.items()]
        return "{\n" + ",\n".join(items) + "\n" + pad + "}"
    if isinstance(obj, list):
        if not obj:
            return "[]"
        if all(is_scalar(v) for v in obj):
            return json.dumps(obj, ensure_ascii=False)
        items = ["%s  %s" % (pad, dump_compact(v, level + 1)) for v in obj]
        return "[\n" + ",\n".join(items) + "\n" + pad + "]"
    return json.dumps(obj, ensure_ascii=False)


def cmd_check(args):
    result = run_checks(args.workdir, args.task, args.allow_empty)
    out = args.out or proto(args.workdir, "checks.json")
    write_text(out, dump(result) + "\n")
    print(dump(result))
    return 0


# ------------------------------------------------------------------ report
def parse_ac_args(values):
    judged = {}
    for raw in values:
        if "=" not in raw:
            raise AuditError('--ac "%s" must look like AC-1=PASS or "AC-2=FAIL:detail"' % raw, code=2)
        ac_id, verdict = raw.split("=", 1)
        ac_id = ac_id.strip()
        status, _, detail = verdict.partition(":")
        status = status.strip().upper()
        detail = detail.strip()
        if status not in ("PASS", "FAIL"):
            raise AuditError('--ac %s: status must be PASS or FAIL, got "%s"' % (ac_id, status), code=2)
        if status == "FAIL" and not detail:
            raise AuditError('--ac %s=FAIL needs a detail: "%s=FAIL:what is wrong and where"' % (ac_id, ac_id), code=2)
        if ac_id in judged:
            raise AuditError("--ac %s given twice" % ac_id, code=2)
        judged[ac_id] = (status, detail)
    return judged


def entry(check_id, status, detail, always_detail=False):
    e = {"id": check_id, "status": status}
    if detail and (status == "FAIL" or always_detail):
        e["detail"] = detail
    return e


def read_existing_audit(path):
    """(rounds from the JSON block, {round: prose section}) of an existing AUDIT.md."""
    if not os.path.isfile(path):
        return [], {}
    text = read_text(path)
    m = AUDIT_JSON_RE.search(text)
    if not text.startswith("# AUDIT") or not m:
        raise AuditError("%s exists but has no '# AUDIT' heading with a json block; "
                         "remove it to start a fresh report" % path)
    try:
        summary = json.loads(m.group(1))
    except ValueError as e:
        raise AuditError("%s json block is invalid (%s); remove it to start a fresh report" % (path, e))
    rounds = summary.get("rounds", []) if isinstance(summary, dict) else []
    rest = text[m.end():]
    prose = {}
    heads = list(ROUND_HEADING_RE.finditer(rest))
    for k, h in enumerate(heads):
        end = heads[k + 1].start() if k + 1 < len(heads) else len(rest)
        prose[int(h.group(1))] = rest[h.start():end].rstrip("\n") + "\n"
    return [r for r in rounds if isinstance(r, dict) and "round" in r], prose


def cell(text):
    return (text or "").replace("|", "\\|").replace("\n", " ")


def prose_section(round_entry, changes=None, notes=""):
    lines = ["## Round %d" % round_entry["round"], "", "Verdict: %s" % round_entry["verdict"], ""]
    if changes is not None:
        lines += ["Changed: %d added, %d modified, %d deleted"
                  % (len(changes["added"]), len(changes["modified"]), len(changes["deleted"])), ""]
    lines += ["| Check | Status | Detail |", "| --- | --- | --- |"]
    for c in round_entry.get("checks", []):
        lines.append("| %s | %s | %s |" % (cell(c.get("id")), cell(c.get("status")), cell(c.get("detail"))))
    lines.append("")
    if notes and notes.strip():
        lines += ["Notes: " + notes.strip(), ""]
    return "\n".join(lines)


def cmd_report(args):
    workdir = args.workdir
    task = load_task(workdir, args.task)
    state_path = proto(workdir, "state.json")
    state = read_json(state_path) if os.path.isfile(state_path) else None
    round_no = args.round
    if round_no is None:
        if isinstance(state, dict) and state.get("round"):
            round_no = int(state["round"])
        else:
            raise AuditError("--round is required (no round in _m365/state.json)", code=2)
    if round_no < 1:
        raise AuditError("--round must be 1 or more", code=2)

    judged = parse_ac_args(args.ac or [])
    listed = [a["id"] for a in task["acceptance"]]
    missing = [i for i in listed if i not in judged]
    if missing:
        raise AuditError("no --ac judgement for %s (every acceptance criterion in TASK.md needs one)"
                         % ", ".join(missing), code=2)
    unknown = sorted(i for i in judged if i not in listed)
    if unknown:
        raise AuditError("--ac %s not listed in TASK.md (known: %s)"
                         % (", ".join(unknown), ", ".join(listed) or "none"), code=2)

    # The checks are cheap and the working directory may have changed since the last
    # `check`, so they are re-run unless an explicit --checks file is given.
    if args.checks:
        checks = read_json(args.checks)
        if not isinstance(checks, dict) or checks.get("schema") != CHECKS_SCHEMA:
            raise AuditError('%s is not an "%s" file' % (args.checks, CHECKS_SCHEMA))
    else:
        checks = run_checks(workdir, args.task, args.allow_empty)
        write_text(proto(workdir, "checks.json"), dump(checks) + "\n")

    round_checks = [entry(c["id"], c["status"], c.get("detail"), always_detail=(c["id"] == "files"))
                    for c in checks.get("checks", [])]
    for ac_id in listed:
        status, detail = judged[ac_id]
        round_checks.append(entry(ac_id, status, detail, always_detail=True))
    verdict = "PASS" if all(c["status"] == "PASS" for c in round_checks) else "FAIL"
    this_round = {"round": round_no, "verdict": verdict, "checks": round_checks}

    audit_path = proto(workdir, "AUDIT.md")
    rounds, prose = read_existing_audit(audit_path)
    rounds = [r for r in rounds if r.get("round") != round_no] + [this_round]
    rounds.sort(key=lambda r: r["round"])
    latest = rounds[-1]

    max_rounds = None
    if isinstance(state, dict) and state.get("max_rounds"):
        max_rounds = int(state["max_rounds"])
    if max_rounds is None:
        max_rounds = task["max_rounds"] or DEFAULT_MAX_ROUNDS
    slug = task["slug"] or (state.get("task") if isinstance(state, dict) else None) or "unknown"

    summary = {
        "schema": AUDIT_SCHEMA,
        "task": slug,
        "verdict": latest["verdict"],
        "final_round": latest["round"],
        "max_rounds": max_rounds,
        "rounds": rounds,
    }
    prose[round_no] = prose_section(this_round, checks.get("changed"), args.notes)
    sections = [prose.get(r["round"]) or prose_section(r) for r in rounds]
    text = "# AUDIT\n\n```json\n" + dump_compact(summary) + "\n```\n\n" + "\n".join(s.rstrip("\n") + "\n" for s in sections)
    write_text(audit_path, text)
    print(dump_compact(summary))
    return 0


# -------------------------------------------------------------------- main
def build_parser():
    ap = argparse.ArgumentParser(prog="audit_checks.py", description="Deterministic audit checks and AUDIT.md writer.")
    sub = ap.add_subparsers(dest="cmd")
    sub.required = True

    p = sub.add_parser("check", help="run the deterministic checks")
    p.add_argument("workdir")
    p.add_argument("--task", default=None, help="TASK.md path (default <workdir>/_m365/TASK.md)")
    p.add_argument("--out", default=None, help="JSON output (default <workdir>/_m365/checks.json)")
    p.add_argument("--allow-empty", action="store_true", help="files check passes when nothing changed")
    p.set_defaults(func=cmd_check)

    p = sub.add_parser("report", help="write _m365/AUDIT.md for one round")
    p.add_argument("workdir")
    p.add_argument("--round", type=int, default=None)
    p.add_argument("--ac", action="append", default=[], metavar="AC-n=PASS|FAIL:detail")
    p.add_argument("--checks", default=None,
                   help="checks JSON written by `check` (default: re-run the checks and rewrite <workdir>/_m365/checks.json)")
    p.add_argument("--task", default=None, help="TASK.md path (default <workdir>/_m365/TASK.md)")
    p.add_argument("--allow-empty", action="store_true",
                   help="files check passes when nothing changed (used when the checks are re-run)")
    p.add_argument("--notes", default="")
    p.set_defaults(func=cmd_report)
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
    except AuditError as e:
        sys.stderr.write("error: %s\n" % e)
        return e.code
    except (OSError, IOError) as e:
        sys.stderr.write("error: %s\n" % e)
        return 1


if __name__ == "__main__":
    sys.exit(main())
