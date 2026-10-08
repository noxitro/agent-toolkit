#!/usr/bin/env python3
"""Rebuild the third-party skill packages from upstream clones.

Usage:
    python import_upstream.py --src <dir> [--only name,...]

<dir> holds one clone per upstream repository, named after the repository
(e.g. <dir>/awesome-copilot, <dir>/cat-agent-skills). overlays.json next to this
script lists the skills, the files to take and the Japanese "読み替え" section that is
inserted before the original text. For each skill this writes:

    <name>/SKILL.md        frontmatter (+ Japanese trigger words) + 読み替え + 原文
    <name>/<other files>   copied byte for byte
    <name>/LICENSE.txt     the repository's LICENSE, unchanged
    <name>/SOURCE.md       origin, commit and what was changed
    _upstream/<name>.SKILL.md   the untouched upstream SKILL.md, for diffing on updates

Every input is checked before an existing package is replaced: symbolic links and paths
that resolve outside the upstream folder are refused, so a hostile clone cannot pull a
local file into a package.

Python 3.8+, standard library only. Reads the clones; never runs anything inside them
except `git rev-parse` / `git log` for the commit id and date.
"""

import argparse
import json
import os
import re
import shutil
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
MARK_ORIGINAL = "## 原文"
NAME_RE = re.compile(r"^[a-z0-9][a-z0-9-]*$")


def fail(msg):
    print("error: " + msg, file=sys.stderr)
    sys.exit(2)


def read_text(path):
    with open(path, encoding="utf-8") as f:
        return f.read().replace("\r\n", "\n")


def write_text(path, text):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", encoding="utf-8", newline="\n") as f:
        f.write(text)


def split_frontmatter(text, where):
    if not text.startswith("---\n"):
        fail("%s: no YAML frontmatter" % where)
    end = text.find("\n---\n", 4)
    if end < 0:
        fail("%s: unterminated frontmatter" % where)
    return text[4:end].split("\n"), text[end + 5:]


def unquote(value, where):
    v = value.strip()
    if v.startswith("'") and v.endswith("'") and len(v) >= 2:
        return v[1:-1].replace("''", "'")
    if v.startswith('"') or v[:1] in (">", "|") or " #" in v:
        fail("%s: description style %r is not handled; edit by hand" % (where, v[:1]))
    return v


def rebuild_frontmatter(lines, trigger_ja, where):
    out, seen = [], False
    for line in lines:
        if line.startswith("description:"):
            desc = unquote(line[len("description:"):], where)
            desc = (desc + " " + trigger_ja).strip()
            out.append("description: '" + desc.replace("'", "''") + "'")
            seen = True
        elif line.startswith((" ", "\t")) and seen and out and out[-1].startswith("description:"):
            fail("%s: multi-line description is not handled" % where)
        else:
            out.append(line)
    if not seen:
        fail("%s: frontmatter has no description" % where)
    return out


def checked_source(root, rel, where):
    """Return the real path of root/rel, refusing links and paths that leave root."""
    parts = rel.split("/")
    if not rel or rel.startswith("/") or "\\" in rel or any(p in ("", ".", "..") for p in parts):
        fail("%s: bad file path %r" % (where, rel))
    probe = root
    for part in parts:
        probe = os.path.join(probe, part)
        if os.path.islink(probe):
            fail("%s: %s is a symbolic link; refusing to copy it" % (where, rel))
    real_root = os.path.realpath(root)
    real = os.path.realpath(os.path.join(root, *parts))
    if os.path.commonpath([real_root, real]) != real_root:
        fail("%s: %s resolves outside %s" % (where, rel, root))
    if not os.path.isfile(real):
        fail("%s: missing upstream file %s" % (where, rel))
    return real


def git(clone, *args):
    try:
        return subprocess.run(["git", "-C", clone] + list(args), check=True,
                              capture_output=True, text=True).stdout.strip()
    except (OSError, subprocess.CalledProcessError) as e:
        fail("git %s failed in %s: %s" % (" ".join(args), clone, e))


def main(argv=None):
    ap = argparse.ArgumentParser(description="Rebuild third-party skill packages.")
    ap.add_argument("--src", required=True, help="directory holding the upstream clones")
    ap.add_argument("--only", default="", help="comma-separated skill names")
    args = ap.parse_args(argv)

    cfg = json.loads(read_text(os.path.join(HERE, "overlays.json")))
    common = "\n".join(cfg["common"])
    names = [s["name"] for s in cfg["skills"]]
    for n in names:
        if not NAME_RE.match(n):
            fail("bad skill name %r in overlays.json" % n)
    only = {n.strip() for n in args.only.split(",") if n.strip()}
    unknown = sorted(only - set(names))
    if unknown:
        fail("--only names not in overlays.json: %s" % ", ".join(unknown))

    for skill in cfg["skills"]:
        name = skill["name"]
        if only and name not in only:
            continue
        clone = os.path.join(args.src, skill["repo"].split("/")[1])
        upstream = os.path.join(clone, *skill["path"].split("/"))
        if os.path.islink(upstream) or not os.path.isdir(upstream):
            fail("%s: not a plain directory: %s" % (name, upstream))
        if "SKILL.md" not in skill["files"]:
            fail("%s: files must include SKILL.md" % name)
        commit = git(clone, "rev-parse", "HEAD")
        date = git(clone, "log", "-1", "--format=%cs")

        # Check every input before the existing package is touched.
        sources = {rel: checked_source(upstream, rel, name) for rel in skill["files"]}
        license_src = checked_source(clone, "LICENSE", name)
        upstream_files = sorted(
            os.path.relpath(os.path.join(d, f), upstream).replace(os.sep, "/")
            for d, _dirs, files in os.walk(upstream) for f in files
        )
        left_out = [f for f in upstream_files if f not in skill["files"]]

        original = read_text(sources["SKILL.md"])
        fm, body = split_frontmatter(original, name)
        fm = rebuild_frontmatter(fm, skill["trigger_ja"], name)
        overlay = common + ("\n" + "\n".join(skill["extra"]) if skill.get("extra") else "")
        skill_md = "---\n" + "\n".join(fm) + "\n---\n\n" + overlay + "\n\n" + MARK_ORIGINAL + "\n\n" + body.lstrip("\n")

        dest = os.path.join(HERE, name)
        if os.path.isdir(dest):
            shutil.rmtree(dest)
        write_text(os.path.join(dest, "SKILL.md"), skill_md)
        for rel in skill["files"]:
            if rel == "SKILL.md":
                continue
            target = os.path.join(dest, *rel.split("/"))
            os.makedirs(os.path.dirname(target), exist_ok=True)
            shutil.copyfile(sources[rel], target)
        shutil.copyfile(license_src, os.path.join(dest, "LICENSE.txt"))
        url = "https://github.com/%s/tree/%s/%s" % (skill["repo"], commit, skill["path"])
        write_text(os.path.join(dest, "SOURCE.md"), "\n".join([
            "# 出典",
            "",
            "- 元のスキル: [%s/%s](%s)" % (skill["repo"], skill["path"], url),
            "- 取り込んだ版: コミット `%s`(%s)" % (commit, date),
            "- ライセンス: `LICENSE.txt`(元のリポジトリの LICENSE をそのまま同梱)",
            "",
            "## 変更点",
            "",
            "- `SKILL.md` の description の末尾に、日本語での依頼例と使い分けを追加した。",
            "- `SKILL.md` の先頭に「Microsoft 365 Copilot で使うときの読み替え」の節を追加した。",
            "  原文は「%s」以降に、手を加えずに残している。" % MARK_ORIGINAL,
            ("- 同梱しなかった元のファイル: %s。" % ", ".join("`%s`" % f for f in left_out))
            if left_out else "- 元のフォルダにあるファイルはすべて同梱した。",
            "",
        ]))
        write_text(os.path.join(HERE, "_upstream", name + ".SKILL.md"), original)
        print("%s: %s @ %s" % (name, skill["repo"], commit[:12]))
    return 0


if __name__ == "__main__":
    sys.exit(main())
