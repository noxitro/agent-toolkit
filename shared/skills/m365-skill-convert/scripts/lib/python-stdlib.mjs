// Top-level Python standard library modules for 3.8 to 3.13. Taken from Python 3.13's
// sys.stdlib_module_names (public names), plus the modules removed in 3.10 to 3.13,
// which are reported separately because a 3.12+ sandbox no longer has them.

const CURRENT = `__future__ abc antigravity argparse array ast asyncio atexit base64 bdb binascii bisect builtins bz2 cProfile
calendar cmath cmd code codecs codeop collections colorsys compileall concurrent configparser contextlib contextvars copy
copyreg csv ctypes curses dataclasses datetime dbm decimal difflib dis doctest email encodings ensurepip enum errno
faulthandler fcntl filecmp fileinput fnmatch fractions ftplib functools gc genericpath getopt getpass gettext glob graphlib
grp gzip hashlib heapq hmac html http idlelib imaplib importlib inspect io ipaddress itertools json keyword linecache locale
logging lzma mailbox marshal math mimetypes mmap modulefinder msvcrt multiprocessing netrc nt ntpath nturl2path numbers
opcode operator optparse os pathlib pdb pickle pickletools pkgutil platform plistlib poplib posix posixpath pprint profile
pstats pty pwd py_compile pyclbr pydoc pydoc_data pyexpat queue quopri random re readline reprlib resource rlcompleter
runpy sched secrets select selectors shelve shlex shutil signal site smtplib socket socketserver sqlite3 sre_compile
sre_constants sre_parse ssl stat statistics string stringprep struct subprocess symtable sys sysconfig syslog tabnanny
tarfile tempfile termios textwrap this threading time timeit tkinter token tokenize tomllib trace traceback tracemalloc tty
turtle turtledemo types typing unicodedata unittest urllib uuid venv warnings wave weakref webbrowser winreg winsound
wsgiref xml xmlrpc zipapp zipfile zipimport zlib zoneinfo`

/** Removed from the standard library, with the version that removed them. */
export const REMOVED = Object.freeze({
  formatter: '3.10', parser: '3.10', symbol: '3.10', binhex: '3.11',
  asynchat: '3.12', asyncore: '3.12', distutils: '3.12', imp: '3.12', smtpd: '3.12',
  aifc: '3.13', audioop: '3.13', cgi: '3.13', cgitb: '3.13', chunk: '3.13', crypt: '3.13', imghdr: '3.13',
  lib2to3: '3.13', mailcap: '3.13', msilib: '3.13', nis: '3.13', nntplib: '3.13', ossaudiodev: '3.13', pipes: '3.13',
  sndhdr: '3.13', spwd: '3.13', sunau: '3.13', telnetlib: '3.13', uu: '3.13', xdrlib: '3.13',
})

/** Added after 3.8, with the version that added them. */
export const ADDED = Object.freeze({ graphlib: '3.9', zoneinfo: '3.9', tomllib: '3.11' })

/** Only on Windows; the Microsoft 365 sandbox runs Linux. */
export const WINDOWS_ONLY = new Set(['msvcrt', 'winreg', 'winsound', 'nt', 'msilib', '_winapi'])

export const STDLIB = new Set([...CURRENT.split(/\s+/).filter(Boolean), ...Object.keys(REMOVED)])
