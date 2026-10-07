#!/usr/bin/env python3
"""Round bookkeeping for the implement-audit loop (see loop-protocol.md).

State lives in <workdir>/_m365/state.json:
    {"schema": "m365-state/1", "task": slug, "round": N, "max_rounds": M,
     "history": [{"round": n, "verdict": "PASS|FAIL", "notes": "..."}]}

Usage:
    python3 run_round.py start <workdir>
        Begin the next round. The first call reads "## Max rounds" from
        _m365/TASK.md (default 3). Exits 2 when the next round would exceed it.
        Prints {"round": N, "max_rounds": M, "task": slug}.

    python3 run_round.py finish <workdir> --verdict PASS|FAIL [--notes TEXT]
        Record the verdict of the current round in state.json and as a "## Round N"
        section of _m365/ROUNDS.md (changed files, check results, notes). Exits 2 when
        _m365/AUDIT.md already holds a different verdict for this round, and for
        --verdict PASS unless AUDIT.md records PASS for this round (a PASS needs an
        audit; FAIL may be recorded without one).
        Prints {"round": N, "verdict": V, "next": "continue"|"stop", "reason": "..."}.

    python3 run_round.py show <workdir>
        Print state.json.

Python 3.8+, standard library only. This file deliberately repeats the small
walk-and-hash logic of bundle_io.py: each skill is packaged on its own, so it cannot
import from another skill.

Exit codes: 0 success, 1 error, 2 refused (round limit, inconsistent verdict).
"""

import argparse
import hashlib
import json
import os
import re
import sys

STATE_SCHEMA = "m365-state/1"
DEFAULT_MAX_ROUNDS = 3
PROTOCOL_DIR = "_m365"
# Same list as JUNK_DIRS in scripts/lib/m365-rules.mjs.
SKIP_DIRS = ("__pycache__", ".git", "node_modules", ".pytest_cache", ".mypy_cache")
TASK_RE = re.compile(r"^# TASK\s+([A-Za-z0-9][A-Za-z0-9._-]*)\s*$", re.M)
ROUND_HEADING_RE = re.compile(r"^## Round (\d+)\s*$", re.M)
AUDIT_JSON_RE = re.compile(r"```json\s*\n(.*?)\n```", re.S)


class RoundError(Exception):
    def __init__(self, message, code=1):
        Exception.__init__(self, message)
        self.code = code


# -------------------------------------------------------------------- helpers
def proto(workdir, name):
    return os.path.join(workdir, PROTOCOL_DIR, name)


def read_text(path):
    with open(path, "rb") as fh:
        text = fh.read().decode("utf-8", errors="replace")
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
        raise RoundError("%s is not valid JSON: %s" % (path, e))


def write_json(path, obj):
    write_text(path, json.dumps(obj, indent=2, ensure_ascii=False) + "\n")


def parse_task(text):
    """Return (slug or None, max_rounds or None) from TASK.md text."""
    m = TASK_RE.search(text)
    slug = m.group(1) if m else None
    max_rounds = None
    lines = text.split("\n")
    for i, line in enumerate(lines):
        if re.match(r"^##\s+max rounds\s*$", line.strip(), re.I):
            for nxt in lines[i + 1:]:
                if not nxt.strip():
                    continue
                value = nxt.strip().lstrip("-* ").strip()
                if not re.match(r"^\d+$", value):
                    raise RoundError('TASK.md "## Max rounds" must be followed by an integer, got "%s"' % nxt.strip())
                max_rounds = int(value)
                break
            break
    if max_rounds is not None and max_rounds < 1:
        raise RoundError('TASK.md "## Max rounds" must be at least 1')
    return slug, max_rounds


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


def compute_status(workdir):
    path = proto(workdir, "manifest.json")
    if not os.path.isfile(path):
        raise RoundError("%s not found; unpack the bundle with bundle_io.py first" % path)
    manifest = read_json(path)
    base = manifest.get("files") if isinstance(manifest, dict) else None
    if not isinstance(base, dict):
        raise RoundError('%s has no "files" object' % path)
    added, modified = [], []
    seen = set()
    for rel in walk_files(workdir):
        seen.add(rel)
        with open(os.path.join(workdir, *rel.split("/")), "rb") as fh:
            digest = hashlib.sha256(fh.read()).hexdigest()
        if rel not in base:
            added.append(rel)
        elif base[rel] != digest:
            modified.append(rel)
    deleted = sorted(p for p in base if p not in seen)
    return {"added": added, "modified": modified, "deleted": deleted}


def load_state(workdir):
    path = proto(workdir, "state.json")
    if os.path.isfile(path):
        state = read_json(path)
        if not isinstance(state, dict) or state.get("schema") != STATE_SCHEMA:
            raise RoundError('%s is not an "%s" state file' % (path, STATE_SCHEMA))
        return state
    task_path = proto(workdir, "TASK.md")
    if not os.path.isfile(task_path):
        raise RoundError("%s not found; unpack the input bundle first" % task_path)
    slug, max_rounds = parse_task(read_text(task_path))
    return {"schema": STATE_SCHEMA, "task": slug, "round": 0,
            "max_rounds": max_rounds if max_rounds is not None else DEFAULT_MAX_ROUNDS, "history": []}


def audit_verdict_for(workdir, round_no):
    """Verdict that _m365/AUDIT.md records for round_no, or None."""
    path = proto(workdir, "AUDIT.md")
    if not os.path.isfile(path):
        return None
    m = AUDIT_JSON_RE.search(read_text(path))
    if not m:
        return None
    try:
        summary = json.loads(m.group(1))
    except ValueError:
        return None
    for r in summary.get("rounds", []) if isinstance(summary, dict) else []:
        if isinstance(r, dict) and r.get("round") == round_no:
            return r.get("verdict")
    return None


def bullet_list(items):
    return "\n".join("- %s" % p for p in items) if items else "- (none)"


def round_section(round_no, verdict, status, checks, notes):
    parts = [
        "## Round %d" % round_no,
        "",
        "Verdict: %s" % verdict,
        "",
        "Added:",
        "",
        bullet_list(status["added"]),
        "",
        "Modified:",
        "",
        bullet_list(status["modified"]),
        "",
        "Deleted:",
        "",
        bullet_list(status["deleted"]),
        "",
    ]
    if checks:
        parts += ["Checks: " + ", ".join(checks), ""]
    parts += ["Notes:", "", notes.strip() if notes and notes.strip() else "(none)", ""]
    return "\n".join(parts)


def update_rounds_md(workdir, slug, round_no, section):
    path = proto(workdir, "ROUNDS.md")
    text = read_text(path) if os.path.isfile(path) else "# ROUNDS %s\n" % (slug or "unknown")
    heads = list(ROUND_HEADING_RE.finditer(text))
    for k, h in enumerate(heads):
        if int(h.group(1)) == round_no:  # re-finishing a round replaces its section
            end = heads[k + 1].start() if k + 1 < len(heads) else len(text)
            text = text[:h.start()] + section + ("\n" if k + 1 < len(heads) else "") + text[end:]
            write_text(path, text.rstrip("\n") + "\n")
            return
    write_text(path, text.rstrip("\n") + "\n\n" + section)


def checks_summary(workdir):
    path = proto(workdir, "checks.json")
    if not os.path.isfile(path):
        return []
    try:
        data = json.loads(read_text(path))
        return ["%s %s" % (c["id"], c["status"]) for c in data.get("checks", [])]
    except (ValueError, KeyError, TypeError, AttributeError):
        return ["(checks.json unreadable)"]


# ------------------------------------------------------------------- commands
def cmd_start(args):
    state = load_state(args.workdir)
    nxt = int(state.get("round", 0)) + 1
    max_rounds = int(state.get("max_rounds", DEFAULT_MAX_ROUNDS))
    if nxt > max_rounds:
        raise RoundError("round %d would exceed max rounds (%d); stop and pack the output bundle"
                         % (nxt, max_rounds), code=2)
    state["round"] = nxt
    write_json(proto(args.workdir, "state.json"), state)
    print(json.dumps({"round": nxt, "max_rounds": max_rounds, "task": state.get("task")}))
    return 0


def cmd_finish(args):
    state = load_state(args.workdir)
    round_no = int(state.get("round", 0))
    if round_no < 1:
        raise RoundError("no round in progress; run `run_round.py start` first", code=2)
    recorded = audit_verdict_for(args.workdir, round_no)
    if recorded is not None and recorded != args.verdict:
        raise RoundError("_m365/AUDIT.md records %s for round %d but --verdict is %s"
                         % (recorded, round_no, args.verdict), code=2)
    if args.verdict == "PASS" and recorded is None:
        raise RoundError("--verdict PASS needs _m365/AUDIT.md to record PASS for round %d; run "
                         "`audit_checks.py report --round %d` first, or record FAIL" % (round_no, round_no), code=2)
    max_rounds = int(state.get("max_rounds", DEFAULT_MAX_ROUNDS))
    status = compute_status(args.workdir)
    notes = args.notes or ""

    history = [h for h in state.get("history", []) if h.get("round") != round_no]
    history.append({"round": round_no, "verdict": args.verdict, "notes": notes})
    history.sort(key=lambda h: h.get("round", 0))
    state["history"] = history
    write_json(proto(args.workdir, "state.json"), state)
    update_rounds_md(args.workdir, state.get("task"), round_no,
                     round_section(round_no, args.verdict, status, checks_summary(args.workdir), notes))

    if args.verdict == "PASS":
        nxt, reason = "stop", "verdict PASS"
    elif round_no < max_rounds:
        nxt, reason = "continue", "verdict FAIL in round %d of %d" % (round_no, max_rounds)
    else:
        nxt, reason = "stop", "verdict FAIL and max rounds (%d) reached" % max_rounds
    print(json.dumps({"round": round_no, "verdict": args.verdict, "next": nxt, "reason": reason}))
    return 0


def cmd_show(args):
    path = proto(args.workdir, "state.json")
    if not os.path.isfile(path):
        raise RoundError("%s not found; run `run_round.py start` first" % path)
    print(json.dumps(read_json(path), indent=2, ensure_ascii=False))
    return 0


def build_parser():
    ap = argparse.ArgumentParser(prog="run_round.py", description="Round bookkeeping for the implement-audit loop.")
    sub = ap.add_subparsers(dest="cmd")
    sub.required = True
    p = sub.add_parser("start", help="begin the next round")
    p.add_argument("workdir")
    p.set_defaults(func=cmd_start)
    p = sub.add_parser("finish", help="record the verdict of the current round")
    p.add_argument("workdir")
    p.add_argument("--verdict", required=True, choices=["PASS", "FAIL"])
    p.add_argument("--notes", default="")
    p.set_defaults(func=cmd_finish)
    p = sub.add_parser("show", help="print state.json")
    p.add_argument("workdir")
    p.set_defaults(func=cmd_show)
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
    except RoundError as e:
        sys.stderr.write("error: %s\n" % e)
        return e.code
    except (OSError, IOError) as e:
        sys.stderr.write("error: %s\n" % e)
        return 1


if __name__ == "__main__":
    sys.exit(main())
