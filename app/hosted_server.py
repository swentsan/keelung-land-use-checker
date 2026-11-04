"""Public read-only hosting entry point. No uploaded documents or write endpoints."""
import ipaddress
import json
import os
import threading
import urllib.parse
from http.server import ThreadingHTTPServer
import auto_server

PORT = int(os.environ.get('PORT', '8766'))
HOSTS = {'localhost', '127.0.0.1', *filter(None, os.environ.get('ALLOWED_HOSTS', '').split(','))}
if os.environ.get('RENDER_EXTERNAL_HOSTNAME'):
    HOSTS.add(os.environ['RENDER_EXTERNAL_HOSTNAME'])
ORIGINS = set(filter(None, os.environ.get('ALLOWED_ORIGINS', 'https://swentsan.github.io').split(',')))
SLOTS = threading.BoundedSemaphore(4)


class Handler(auto_server.Handler):
    def end_headers(self):
        origin = self.headers.get('Origin')
        if origin in ORIGINS:
            self.send_header('Access-Control-Allow-Origin', origin)
            self.send_header('Vary', 'Origin')
        super().end_headers()

    def valid_request(self):
        try:
            host = urllib.parse.urlsplit('http://' + self.headers.get('Host', '')).hostname
            origin = self.headers.get('Origin')
            same_host = origin and urllib.parse.urlsplit(origin).hostname == host
            return host in HOSTS and (not origin or origin in ORIGINS or same_host)
        except ValueError:
            return False

    def do_OPTIONS(self):
        if not self.valid_request():
            return self.send(403, b'Forbidden', 'text/plain')
        self.send_response(204)
        self.send_header('Access-Control-Allow-Methods', 'GET, OPTIONS')
        self.end_headers()

    def do_GET(self):
        if len(self.path) > 8192:
            return self.send(414, b'Request too long', 'text/plain')
        if not self.valid_request():
            return self.send(403, b'Forbidden', 'text/plain')
        lookup = urllib.parse.urlsplit(self.path).path == '/api/lookup'
        if lookup and not SLOTS.acquire(blocking=False):
            return self.send(429, json.dumps({'error': '查詢較多，請稍後重試。'}, ensure_ascii=False).encode(), 'application/json; charset=utf-8')
        try:
            # Base handler deliberately only trusts loopback. Validate the real
            # public Host and Origin above before invoking its fixed-route API.
            original = self.headers['Host']
            self.headers.replace_header('Host', f'127.0.0.1:{self.server.server_port}')
            try:
                super().do_GET()
            finally:
                self.headers.replace_header('Host', original)
        finally:
            if lookup:
                SLOTS.release()


if __name__ == '__main__':
    ThreadingHTTPServer(('0.0.0.0', PORT), Handler).serve_forever()
