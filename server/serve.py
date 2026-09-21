#!/usr/bin/env python3
"""
SonicForge local development server  -  pure Python standard library, zero dependencies.

Serves the static app AND runs an optional WebSocket relay for Concert Mode tier-3
(cross-network multi-device sync). Neither is required for production: SonicForge
deploys as a fully static site to GitHub Pages / Vercel, where Concert Mode falls
back to BroadcastChannel (same browser) and WebRTC (cross-device, peer-to-peer).

    python server/serve.py                  # http://localhost:8080  + ws://localhost:8787
    python server/serve.py --port 3000
    python server/serve.py --no-relay

The relay is a dumb room-based fan-out. It never inspects, stores, or logs payloads.
"""

from __future__ import annotations

import argparse
import base64
import hashlib
import json
import os
import socket
import struct
import sys
import threading
import time
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"

# ---------------------------------------------------------------------------
# Static file server
# ---------------------------------------------------------------------------


class SonicForgeHandler(SimpleHTTPRequestHandler):
    """Static handler with correct ES-module MIME types and no-cache dev headers."""

    extensions_map = {
        **SimpleHTTPRequestHandler.extensions_map,
        ".js": "text/javascript",
        ".mjs": "text/javascript",
        ".json": "application/json",
        ".css": "text/css",
        ".svg": "image/svg+xml",
        ".webmanifest": "application/manifest+json",
        "": "application/octet-stream",
    }

    def end_headers(self) -> None:
        self.send_header("Cache-Control", "no-store, must-revalidate")
        self.send_header("X-Content-Type-Options", "nosniff")
        super().end_headers()

    def do_POST(self) -> None:
        """Receive a test report from tests.html so headless runs are assertable."""
        if self.path != "/__results":
            self.send_error(404)
            return
        try:
            length = int(self.headers.get("Content-Length", "0"))
            body = self.rfile.read(min(length, 4 << 20))
            report = json.loads(body.decode("utf-8"))
        except (ValueError, UnicodeDecodeError):
            self.send_error(400, "malformed report")
            return

        name = "app-results.json" if report.get("kind") == "app" else "test-results.json"
        out = os.path.join(ROOT, name)
        with open(out, "w", encoding="utf-8") as fh:
            json.dump(report, fh, indent=2)

        sys.stderr.write(
            "  tests  %s passed, %s failed in %sms -> %s\n"
            % (report.get("pass"), report.get("fail"), report.get("ms"), name)
        )
        self.send_response(204)
        self.send_header("Content-Length", "0")
        self.end_headers()

    def log_message(self, fmt: str, *args) -> None:
        sys.stderr.write("  http  %s\n" % (fmt % args))


# ---------------------------------------------------------------------------
# Minimal RFC 6455 WebSocket relay
# ---------------------------------------------------------------------------


class WSError(Exception):
    pass


def _recv_exact(sock: socket.socket, count: int) -> bytes:
    buf = b""
    while len(buf) < count:
        chunk = sock.recv(count - len(buf))
        if not chunk:
            raise WSError("peer closed")
        buf += chunk
    return buf


def ws_handshake(sock: socket.socket) -> bool:
    """Complete the HTTP Upgrade dance. Returns True on success."""
    raw = b""
    while b"\r\n\r\n" not in raw:
        chunk = sock.recv(4096)
        if not chunk:
            return False
        raw += chunk
        if len(raw) > 65536:
            return False

    head = raw.split(b"\r\n\r\n", 1)[0].decode("latin-1")
    headers = {}
    for line in head.split("\r\n")[1:]:
        if ":" in line:
            k, v = line.split(":", 1)
            headers[k.strip().lower()] = v.strip()

    key = headers.get("sec-websocket-key")
    if not key or headers.get("upgrade", "").lower() != "websocket":
        sock.sendall(b"HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n")
        return False

    accept = base64.b64encode(hashlib.sha1((key + WS_GUID).encode()).digest()).decode()
    sock.sendall(
        (
            "HTTP/1.1 101 Switching Protocols\r\n"
            "Upgrade: websocket\r\n"
            "Connection: Upgrade\r\n"
            "Sec-WebSocket-Accept: " + accept + "\r\n\r\n"
        ).encode()
    )
    return True


def ws_read(sock: socket.socket):
    """Read one frame. Returns (opcode, payload_bytes) or None on close."""
    hdr = _recv_exact(sock, 2)
    b0, b1 = hdr[0], hdr[1]
    opcode = b0 & 0x0F
    masked = bool(b1 & 0x80)
    length = b1 & 0x7F

    if length == 126:
        length = struct.unpack(">H", _recv_exact(sock, 2))[0]
    elif length == 127:
        length = struct.unpack(">Q", _recv_exact(sock, 8))[0]

    if length > 1 << 20:  # 1 MiB frame ceiling
        raise WSError("frame too large")

    mask = _recv_exact(sock, 4) if masked else None
    payload = _recv_exact(sock, length) if length else b""

    if mask:
        payload = bytes(byte ^ mask[i & 3] for i, byte in enumerate(payload))

    if opcode == 0x8:
        return None
    return opcode, payload


def ws_write(sock: socket.socket, payload: bytes, opcode: int = 0x1) -> None:
    header = bytearray([0x80 | opcode])
    n = len(payload)
    if n < 126:
        header.append(n)
    elif n < (1 << 16):
        header.append(126)
        header += struct.pack(">H", n)
    else:
        header.append(127)
        header += struct.pack(">Q", n)
    sock.sendall(bytes(header) + payload)


class Relay:
    """Room-keyed broadcast hub. Payloads are forwarded verbatim, never inspected."""

    def __init__(self) -> None:
        self.rooms = {}
        self.lock = threading.Lock()

    def join(self, room: str, peer) -> int:
        with self.lock:
            members = self.rooms.setdefault(room, set())
            members.add(peer)
            return len(members)

    def leave(self, room: str, peer) -> None:
        with self.lock:
            members = self.rooms.get(room)
            if not members:
                return
            members.discard(peer)
            if not members:
                self.rooms.pop(room, None)

    def broadcast(self, room: str, sender, data: bytes) -> None:
        with self.lock:
            members = list(self.rooms.get(room, ()))
        for peer in members:
            if peer is sender:
                continue
            try:
                ws_write(peer.sock, data)
            except OSError:
                pass


class Peer:
    __slots__ = ("sock", "room", "addr")

    def __init__(self, sock, addr) -> None:
        self.sock = sock
        self.addr = addr
        self.room = None


def relay_client(sock: socket.socket, addr, relay: Relay) -> None:
    peer = Peer(sock, addr)
    try:
        sock.settimeout(10)
        if not ws_handshake(sock):
            return
        sock.settimeout(None)

        while True:
            frame = ws_read(sock)
            if frame is None:
                break
            opcode, payload = frame

            if opcode == 0x9:  # ping
                ws_write(sock, payload, opcode=0xA)
                continue
            if opcode == 0xA:  # pong
                continue
            if opcode not in (0x1, 0x2):
                continue

            # Peek only at the envelope's routing fields.
            try:
                msg = json.loads(payload.decode("utf-8"))
            except (ValueError, UnicodeDecodeError):
                continue

            kind = msg.get("t")
            if kind == "join":
                room = str(msg.get("room", ""))[:32]
                if not room:
                    continue
                if peer.room:
                    relay.leave(peer.room, peer)
                peer.room = room
                count = relay.join(room, peer)
                ws_write(sock, json.dumps({"t": "joined", "room": room, "peers": count}).encode())
                relay.broadcast(room, peer, json.dumps({"t": "peer-joined", "peers": count}).encode())
                sys.stderr.write("  relay  %s joined room %s (%d peers)\n" % (addr[0], room, count))
            elif kind == "ping":
                # Clock-sync probe: echo immediately with the server receive time.
                ws_write(sock, json.dumps({"t": "pong", "id": msg.get("id"), "st": time.time() * 1000}).encode())
            elif peer.room:
                relay.broadcast(peer.room, peer, payload)
    except (OSError, WSError):
        pass
    finally:
        if peer.room:
            relay.leave(peer.room, peer)
        try:
            sock.close()
        except OSError:
            pass


def run_relay(port: int) -> None:
    relay = Relay()
    srv = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    srv.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    srv.bind(("0.0.0.0", port))
    srv.listen(64)
    while True:
        try:
            conn, addr = srv.accept()
        except OSError:
            break
        threading.Thread(target=relay_client, args=(conn, addr, relay), daemon=True).start()


# ---------------------------------------------------------------------------


def lan_ip() -> str:
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.connect(("8.8.8.8", 80))
        ip = s.getsockname()[0]
        s.close()
        return ip
    except OSError:
        return "127.0.0.1"


def main() -> None:
    ap = argparse.ArgumentParser(description="SonicForge dev server")
    ap.add_argument("--port", type=int, default=8080, help="HTTP port (default 8080)")
    ap.add_argument("--relay-port", type=int, default=8787, help="WebSocket relay port (default 8787)")
    ap.add_argument("--no-relay", action="store_true", help="disable the Concert Mode relay")
    args = ap.parse_args()

    if not args.no_relay:
        threading.Thread(target=run_relay, args=(args.relay_port,), daemon=True).start()

    handler = partial(SonicForgeHandler, directory=ROOT)
    httpd = ThreadingHTTPServer(("0.0.0.0", args.port), handler)

    ip = lan_ip()
    print("")
    print("  SonicForge dev server")
    print("")
    print("    local     http://localhost:%d/" % args.port)
    print("    network   http://%s:%d/          <- open this on your phone" % (ip, args.port))
    print("    tests     http://localhost:%d/tests.html" % args.port)
    if not args.no_relay:
        print("    relay     ws://%s:%d         <- paste into Concert Mode / Relay URL" % (ip, args.relay_port))
    print("")
    print("    Ctrl+C to stop.")
    print("")

    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\n  stopped.\n")


if __name__ == "__main__":
    main()
