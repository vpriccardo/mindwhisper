#!/usr/bin/env python3
"""Dual-origin local runner: spectator :8000, performer :8001."""

from __future__ import annotations

import argparse
import json
import sys
import threading
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any, Optional
from urllib.parse import unquote, urlparse

ROOT = Path(__file__).resolve().parent.parent
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from engine import Engine
from prototype.protocol import load_candidates, recover, recover_to_json

PROTOTYPE_DIR = Path(__file__).resolve().parent
DIST_SPECTATOR = PROTOTYPE_DIR / "dist" / "spectator"
DIST_PERFORMER = PROTOTYPE_DIR / "dist" / "performer"

MAX_BODY_BYTES = 4096

SPECTATOR_CSP = (
    "default-src 'self'; "
    "script-src 'self'; "
    "style-src 'self'; "
    "img-src 'self' data: blob:; "
    "connect-src 'self'; "
    "font-src 'self'; "
    "object-src 'none'; "
    "base-uri 'none'; "
    "form-action 'none'; "
    "frame-ancestors 'none'; "
    "worker-src 'none'"
)

PERFORMER_CSP = (
    # OpenCV.js (Emscripten) evaluates generated JS glue and compiles WASM.
    # Keep this scoped to the performer origin only; spectator stays strict.
    "default-src 'self'; "
    "script-src 'self' 'wasm-unsafe-eval' 'unsafe-eval'; "
    "style-src 'self'; "
    "img-src 'self' data: blob:; "
    "media-src 'self' blob:; "
    "connect-src 'self'; "
    "font-src 'self'; "
    "object-src 'none'; "
    "base-uri 'none'; "
    "form-action 'none'; "
    "frame-ancestors 'none'; "
    "worker-src 'self'; "
    "child-src 'self'"
)

MIME = {
    ".html": "text/html; charset=utf-8",
    ".js": "application/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".svg": "image/svg+xml",
    ".png": "image/png",
    ".ico": "image/x-icon",
    ".map": "application/json",
    ".wasm": "application/wasm",
    ".bin": "application/octet-stream",
    ".wav": "audio/wav",
}


def _common_headers(handler: BaseHTTPRequestHandler, csp: str, *, performer: bool = False) -> None:
    handler.send_header("Content-Security-Policy", csp)
    handler.send_header("Referrer-Policy", "no-referrer")
    handler.send_header("X-Content-Type-Options", "nosniff")
    handler.send_header("Cache-Control", "no-store")
    if performer:
        handler.send_header(
            "Permissions-Policy",
            "camera=(self), microphone=(self)",
        )


def _safe_path(root: Path, url_path: str) -> Optional[Path]:
    raw = unquote(url_path)
    if raw.endswith("/"):
        raw = raw + "index.html"
    if raw == "" or raw == "/":
        raw = "/index.html"
    # Disallow traversal
    rel = raw.lstrip("/")
    if ".." in rel.split("/"):
        return None
    candidate = (root / rel).resolve()
    try:
        candidate.relative_to(root.resolve())
    except ValueError:
        return None
    if not candidate.is_file():
        return None
    # Never serve source maps even if present
    if candidate.suffix == ".map":
        return None
    return candidate


def make_static_handler(root: Path, csp: str) -> type[BaseHTTPRequestHandler]:
    class StaticHandler(BaseHTTPRequestHandler):
        def log_message(self, fmt: str, *args: Any) -> None:
            sys.stderr.write("%s - %s\n" % (self.address_string(), fmt % args))

        def do_GET(self) -> None:  # noqa: N802
            parsed = urlparse(self.path)
            path = _safe_path(root, parsed.path)
            if path is None:
                self.send_error(HTTPStatus.NOT_FOUND, "Not found")
                return
            data = path.read_bytes()
            ctype = MIME.get(path.suffix.lower(), "application/octet-stream")
            self.send_response(HTTPStatus.OK)
            self.send_header("Content-Type", ctype)
            self.send_header("Content-Length", str(len(data)))
            _common_headers(self, csp)
            self.end_headers()
            self.wfile.write(data)

        def do_POST(self) -> None:  # noqa: N802
            self.send_error(HTTPStatus.METHOD_NOT_ALLOWED, "Method not allowed")

    return StaticHandler


def make_performer_handler(
    root: Path,
    candidates: Any,
) -> type[BaseHTTPRequestHandler]:
    class PerformerHandler(BaseHTTPRequestHandler):
        def log_message(self, fmt: str, *args: Any) -> None:
            # Do not log request bodies / payloads
            sys.stderr.write("%s - %s\n" % (self.address_string(), fmt % args))

        def _send_json(self, status: int, body: dict[str, Any]) -> None:
            raw = json.dumps(body, ensure_ascii=True).encode("utf-8")
            self.send_response(status)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(raw)))
            _common_headers(self, PERFORMER_CSP, performer=True)
            self.end_headers()
            self.wfile.write(raw)

        def do_GET(self) -> None:  # noqa: N802
            parsed = urlparse(self.path)
            if parsed.path == "/api/recover":
                self._send_json(
                    HTTPStatus.METHOD_NOT_ALLOWED,
                    {
                        "ok": False,
                        "error": {
                            "code": "METHOD_NOT_ALLOWED",
                            "message": "Use POST /api/recover.",
                        },
                    },
                )
                return
            path = _safe_path(root, parsed.path)
            if path is None:
                self.send_error(HTTPStatus.NOT_FOUND, "Not found")
                return
            data = path.read_bytes()
            ctype = MIME.get(path.suffix.lower(), "application/octet-stream")
            self.send_response(HTTPStatus.OK)
            self.send_header("Content-Type", ctype)
            self.send_header("Content-Length", str(len(data)))
            _common_headers(self, PERFORMER_CSP, performer=True)
            self.end_headers()
            self.wfile.write(data)

        def do_POST(self) -> None:  # noqa: N802
            parsed = urlparse(self.path)
            if parsed.path != "/api/recover":
                self._send_json(
                    HTTPStatus.NOT_FOUND,
                    {
                        "ok": False,
                        "error": {"code": "NOT_FOUND", "message": "Unknown endpoint."},
                    },
                )
                return

            length_hdr = self.headers.get("Content-Length", "")
            try:
                length = int(length_hdr)
            except ValueError:
                self._send_json(
                    HTTPStatus.BAD_REQUEST,
                    {
                        "ok": False,
                        "error": {
                            "code": "BAD_REQUEST",
                            "message": "Content-Length required.",
                        },
                    },
                )
                return

            if length < 0 or length > MAX_BODY_BYTES:
                self._send_json(
                    HTTPStatus.REQUEST_ENTITY_TOO_LARGE,
                    {
                        "ok": False,
                        "error": {
                            "code": "BODY_TOO_LARGE",
                            "message": "Request body too large.",
                        },
                    },
                )
                return

            ctype = (self.headers.get("Content-Type") or "").split(";")[0].strip().lower()
            if ctype != "application/json":
                self._send_json(
                    HTTPStatus.UNSUPPORTED_MEDIA_TYPE,
                    {
                        "ok": False,
                        "error": {
                            "code": "UNSUPPORTED_MEDIA_TYPE",
                            "message": "Content-Type must be application/json.",
                        },
                    },
                )
                return

            raw_body = self.rfile.read(length)
            try:
                data = json.loads(raw_body.decode("utf-8"))
            except (UnicodeDecodeError, json.JSONDecodeError):
                self._send_json(
                    HTTPStatus.BAD_REQUEST,
                    {
                        "ok": False,
                        "error": {
                            "code": "INVALID_JSON",
                            "message": "Request body must be valid JSON.",
                        },
                    },
                )
                return

            if not isinstance(data, dict) or "payload" not in data:
                self._send_json(
                    HTTPStatus.BAD_REQUEST,
                    {
                        "ok": False,
                        "error": {
                            "code": "MISSING_PAYLOAD",
                            "message": 'JSON body must include a "payload" field.',
                        },
                    },
                )
                return

            payload_value = data.get("payload")
            if not isinstance(payload_value, str):
                self._send_json(
                    HTTPStatus.BAD_REQUEST,
                    {
                        "ok": False,
                        "error": {
                            "code": "INVALID_PAYLOAD_TYPE",
                            "message": "payload must be a string.",
                        },
                    },
                )
                return

            try:
                response = recover(payload_value, candidates)
            except Exception:  # noqa: BLE001 — never leak tracebacks to client
                self._send_json(
                    HTTPStatus.INTERNAL_SERVER_ERROR,
                    {
                        "ok": False,
                        "error": {
                            "code": "INTERNAL_ERROR",
                            "message": "Internal processing error.",
                        },
                    },
                )
                return

            body = recover_to_json(response)
            # Malformed payload → non-2xx; valid-but-no-match → 200
            if response.error and response.error["code"] in {
                "EMPTY_INPUT",
                "INVALID_LENGTH",
                "INVALID_CHARSET",
                "DECODE_FAILED",
                "INVALID_PAYLOAD_SIZE",
            }:
                status = HTTPStatus.BAD_REQUEST
            else:
                status = HTTPStatus.OK
            self._send_json(status, body)

    return PerformerHandler


def run_server(
    host: str,
    port: int,
    handler_cls: type[BaseHTTPRequestHandler],
    label: str,
) -> ThreadingHTTPServer:
    httpd = ThreadingHTTPServer((host, port), handler_cls)
    thread = threading.Thread(target=httpd.serve_forever, name=label, daemon=True)
    thread.start()
    return httpd


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="QR Seal dual-origin local prototype")
    parser.add_argument("--host", default="127.0.0.1", help="Bind address (default 127.0.0.1)")
    parser.add_argument("--spectator-port", type=int, default=8000)
    parser.add_argument("--performer-port", type=int, default=8001)
    args = parser.parse_args(argv)

    if not DIST_SPECTATOR.is_dir() or not DIST_PERFORMER.is_dir():
        print(
            "Built assets missing. Run: cd prototype && npm ci && npm run build",
            file=sys.stderr,
        )
        return 1

    engine = Engine.load()
    candidates = load_candidates(engine)
    print(f"{candidates.concept_count} concepts", flush=True)
    print(f"{candidates.alias_count} aliases", flush=True)
    print(f"{candidates.candidate_count} unique candidate surfaces", flush=True)
    print(f"{candidates.ambiguous_count} ambiguous surfaces", flush=True)

    spectator = run_server(
        args.host,
        args.spectator_port,
        make_static_handler(DIST_SPECTATOR, SPECTATOR_CSP),
        "spectator",
    )
    performer = run_server(
        args.host,
        args.performer_port,
        make_performer_handler(DIST_PERFORMER, candidates),
        "performer",
    )

    print(f"spectator  http://{args.host}:{args.spectator_port}/", flush=True)
    print(f"performer  http://{args.host}:{args.performer_port}/", flush=True)
    print("Press Ctrl+C to stop.", flush=True)

    try:
        threading.Event().wait()
    except KeyboardInterrupt:
        print("\nShutting down…")
    finally:
        spectator.shutdown()
        performer.shutdown()
        spectator.server_close()
        performer.server_close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
