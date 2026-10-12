#!/usr/bin/env python3
"""Serve a fixture documentation site that requires a bearer token.

Usage:
    python3 doc-site-server.py <dir> [--port N] [--token T]

Prints "READY <port>" once listening. Every request must carry
"Authorization: Bearer <token>" (default test-token) or it gets 401. Sends ETag headers so
conditional requests can be exercised. Standard library only.
"""

import argparse
import hashlib
import os
import sys
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("dir")
    ap.add_argument("--port", type=int, default=0)
    ap.add_argument("--token", default="test-token")
    a = ap.parse_args()
    root = os.path.abspath(a.dir)

    class H(SimpleHTTPRequestHandler):
        def __init__(self, *args, **kw):
            super().__init__(*args, directory=root, **kw)

        def log_message(self, *args):
            pass

        def do_GET(self):
            if self.headers.get("Authorization") != "Bearer " + a.token:
                self.send_response(401)
                self.end_headers()
                return
            path = self.translate_path(self.path)
            if os.path.isfile(path):
                with open(path, "rb") as f:
                    etag = '"' + hashlib.sha1(f.read()).hexdigest()[:16] + '"'
                if self.headers.get("If-None-Match") == etag:
                    self.send_response(304)
                    self.end_headers()
                    return
                self._etag = etag
            super().do_GET()

        def end_headers(self):
            if getattr(self, "_etag", None):
                self.send_header("ETag", self._etag)
            super().end_headers()

    srv = ThreadingHTTPServer(("127.0.0.1", a.port), H)
    print("READY %d" % srv.server_address[1], flush=True)
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    sys.exit(main())
