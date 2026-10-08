#!/usr/bin/env python3
"""Measure the script sandbox and write a plain-text report.

Usage:
    python3 probe_env.py [--out probe-output.txt]

Prints the report and writes it to --out (default probe-output.txt in the current
directory). Sections: Python version, platform, cwd, argv, sys.path, environment
variable NAMES (never values), listings of likely attachment directories, .zip/.md
files found up to depth 2, a zipfile open test, resource limits, an import matrix,
and tools on PATH. It never opens a network connection: the sandbox is documented to
have no network, and an unexpected outbound attempt can trip security monitoring.

Every section catches its own errors and reports them; the script never raises.
Python 3.8+, standard library only.
"""

import os
import sys

ROOTS = ["cwd", "home", "/mnt", "/mnt/data", "/mnt/user-data", "/tmp", "/home", "/workspace"]
LIST_LIMIT = 50
FIND_DEPTH = 2
FIND_LIMIT = 200
MODULES = [
    "json", "zipfile", "hashlib", "re", "fnmatch", "ast", "py_compile", "subprocess", "pathlib", "csv",
    "sqlite3", "xml.etree.ElementTree", "html.parser", "tarfile", "gzip", "bz2", "lzma", "ssl", "socket",
    "urllib.request", "yaml", "requests", "numpy", "pandas", "openpyxl", "docx", "pptx", "matplotlib",
    "PIL", "pytest", "typing_extensions", "tomli", "git",
]
TOOLS = ["git", "node", "npm", "python3", "pip"]

lines = []


def emit(text=""):
    lines.append(text)


def section(title, fn):
    emit("")
    emit("== %s ==" % title)
    try:
        fn()
    except BaseException as e:  # noqa: B902 - the probe must report, never raise
        if isinstance(e, KeyboardInterrupt):
            raise
        emit("ERROR %s: %s" % (type(e).__name__, e))


def resolve_root(root):
    if root == "cwd":
        return os.getcwd()
    if root == "home":
        return os.path.expanduser("~")
    return root


# -------------------------------------------------------------------- sections
def s_python():
    import platform
    emit("python_version: %s" % platform.python_version())
    emit("python_implementation: %s" % platform.python_implementation())
    emit("sys.version: %s" % sys.version.replace("\n", " "))
    emit("sys.executable: %s" % sys.executable)
    emit("sys.prefix: %s" % sys.prefix)
    emit("default encoding: %s  filesystem encoding: %s  stdout encoding: %s"
         % (sys.getdefaultencoding(), sys.getfilesystemencoding(), getattr(sys.stdout, "encoding", None)))


def s_platform():
    import platform
    emit("platform: %s" % platform.platform())
    emit("sys.platform: %s" % sys.platform)
    emit("machine: %s" % platform.machine())
    try:
        u = os.uname()
        emit("uname: sysname=%s release=%s version=%s machine=%s"
             % (u.sysname, u.release, u.version, u.machine))
    except AttributeError:
        emit("uname: not available on this platform")
    try:
        emit("uid: %s  gid: %s" % (os.getuid(), os.getgid()))
    except AttributeError:
        emit("uid/gid: not available on this platform")
    emit("cpu_count: %s" % os.cpu_count())


def s_cwd():
    emit("cwd: %s" % os.getcwd())
    emit("home: %s" % os.path.expanduser("~"))
    emit("__file__: %s" % os.path.abspath(__file__))


def s_argv():
    emit("sys.argv: %r" % (sys.argv,))


def s_path():
    for p in sys.path:
        emit("  %s" % p)


def s_env():
    names = sorted(os.environ.keys())
    emit("count: %d" % len(names))
    for n in names:
        emit("  %s" % n)


def s_listings():
    for root in ROOTS:
        path = resolve_root(root)
        label = path if root == path else "%s (%s)" % (root, path)
        try:
            entries = sorted(os.listdir(path))
        except BaseException as e:
            if isinstance(e, KeyboardInterrupt):
                raise
            emit("%s: ERROR %s: %s" % (label, type(e).__name__, e))
            continue
        emit("%s: %d entries%s" % (label, len(entries), " (first %d)" % LIST_LIMIT if len(entries) > LIST_LIMIT else ""))
        for name in entries[:LIST_LIMIT]:
            full = os.path.join(path, name)
            try:
                if os.path.isdir(full):
                    emit("  %s/" % name)
                else:
                    emit("  %s  %d bytes" % (name, os.path.getsize(full)))
            except OSError as e:
                emit("  %s  (stat failed: %s)" % (name, e))


found_zips = []


def s_find():
    seen = set()
    count = 0
    for root in ROOTS:
        base = resolve_root(root)
        if not os.path.isdir(base):
            continue
        base_depth = base.rstrip(os.sep).count(os.sep)
        try:
            for dirpath, dirnames, filenames in os.walk(base, onerror=lambda e: emit("  walk error: %s" % e)):
                depth = dirpath.rstrip(os.sep).count(os.sep) - base_depth
                if depth >= FIND_DEPTH:
                    dirnames[:] = []
                dirnames[:] = sorted(d for d in dirnames if d not in ("proc", "sys", "dev"))
                for f in sorted(filenames):
                    if not (f.lower().endswith(".zip") or f.lower().endswith(".md")):
                        continue
                    full = os.path.realpath(os.path.join(dirpath, f))
                    if full in seen:
                        continue
                    seen.add(full)
                    count += 1
                    if count > FIND_LIMIT:
                        continue
                    try:
                        size = os.path.getsize(full)
                    except OSError as e:
                        size = "stat failed: %s" % e
                    emit("  %s  %s bytes" % (full, size))
                    if f.lower().endswith(".zip"):
                        found_zips.append(full)
        except BaseException as e:
            if isinstance(e, KeyboardInterrupt):
                raise
            emit("  %s: ERROR %s: %s" % (base, type(e).__name__, e))
    if count == 0:
        emit("  (none found)")
    elif count > FIND_LIMIT:
        emit("  ... %d more not shown" % (count - FIND_LIMIT))


def s_zip_test():
    if not found_zips:
        emit("no .zip found; nothing to open")
        return
    import zipfile
    target = found_zips[0]
    with zipfile.ZipFile(target) as zf:
        names = zf.namelist()
    emit("opened %s: %d names" % (target, len(names)))
    for n in names[:10]:
        emit("  %s" % n)


def s_limits():
    emit("recursionlimit: %d" % sys.getrecursionlimit())
    try:
        import resource
    except ImportError as e:
        emit("resource: not importable (%s)" % e)
        return
    for name in ("RLIMIT_CPU", "RLIMIT_AS", "RLIMIT_DATA", "RLIMIT_FSIZE", "RLIMIT_NOFILE", "RLIMIT_NPROC"):
        if hasattr(resource, name):
            try:
                emit("%s: %s" % (name, resource.getrlimit(getattr(resource, name))))
            except (ValueError, OSError) as e:
                emit("%s: ERROR %s" % (name, e))
    try:
        import shutil
        usage = shutil.disk_usage(os.getcwd())
        emit("disk (cwd): total=%d used=%d free=%d" % usage)
    except (OSError, AttributeError) as e:
        emit("disk (cwd): ERROR %s" % e)


def s_imports():
    import importlib
    for name in MODULES:
        try:
            mod = importlib.import_module(name)
            version = getattr(mod, "__version__", None)
            emit("PASS %s%s" % (name, " %s" % version if isinstance(version, str) else ""))
        except BaseException as e:
            if isinstance(e, KeyboardInterrupt):
                raise
            emit("FAIL %s: %s: %s" % (name, type(e).__name__, str(e).replace("\n", " ")[:200]))


def s_tools():
    import shutil
    for tool in TOOLS:
        emit("%s: %s" % (tool, shutil.which(tool) or "not on PATH"))
    emit("PATH entries:")
    for p in os.environ.get("PATH", "").split(os.pathsep):
        emit("  %s" % p)



def main():
    out = "probe-output.txt"
    args = sys.argv[1:]
    if "--out" in args:
        i = args.index("--out")
        if i + 1 < len(args):
            out = args[i + 1]
    elif any(a.startswith("--out=") for a in args):
        out = [a for a in args if a.startswith("--out=")][0][len("--out="):]

    emit("# m365 sandbox probe")
    section("python", s_python)
    section("platform", s_platform)
    section("cwd", s_cwd)
    section("argv", s_argv)
    section("sys.path", s_path)
    section("environment variable names (values not shown)", s_env)
    section("directory listings", s_listings)
    section(".zip / .md files (depth %d)" % FIND_DEPTH, s_find)
    section("zipfile open test", s_zip_test)
    section("limits", s_limits)
    section("import matrix", s_imports)
    section("tools on PATH", s_tools)

    text = "\n".join(lines) + "\n"
    try:
        sys.stdout.write(text)
        sys.stdout.flush()
    except BaseException as e:  # e.g. an encoding the console cannot show
        if isinstance(e, KeyboardInterrupt):
            raise
        try:
            sys.stdout.buffer.write(text.encode("utf-8", errors="replace"))
        except BaseException:
            pass
    try:
        with open(out, "wb") as fh:
            fh.write(text.encode("utf-8", errors="replace"))
        sys.stdout.write("\nreport written to %s\n" % os.path.abspath(out))
    except BaseException as e:
        if isinstance(e, KeyboardInterrupt):
            raise
        sys.stdout.write("\nERROR writing %s: %s: %s\n" % (out, type(e).__name__, e))
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except SystemExit:
        raise
    except BaseException as e:  # last resort: report, exit 0
        sys.stdout.write("probe failed unexpectedly: %s: %s\n" % (type(e).__name__, e))
        sys.exit(0)
