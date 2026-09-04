#!/usr/bin/env python3
"""Canonical WSL -> Windows RAG service client.

Why this exists: the WSL2 NAT path (portproxy gw IP -> 127.0.0.1) mangles
requests whose HTTP body arrives in the same TCP segment as the headers —
the daemon then reads a truncated/missing body and answers 400 "request
body must be valid JSON", or blocks on read() until the client times out.
Sending the body in a separate segment, after a short delay, is verified
working (200 + real query results). Plain curl/urllib coalesce small
bodies into the header segment and therefore FAIL via the gw IP; use this
helper instead.

The daemon validates Host against its own bind address, so the request must
carry "Host: 127.0.0.1:<port>" even when connected via the gateway IP.

Usage (from WSL):
    python3 scripts/rag_client.py "your query"
    python3 scripts/rag_client.py "ping" --no-token      # expect HTTP 401
    python3 scripts/rag_client.py "ping" --host 127.0.0.1   # Windows-side interop use

Stdlib only; runs under WSL python3 or Windows python via interop.
"""
import argparse
import json
import socket
import subprocess
import sys
import time

DEFAULT_TOKEN_PATH = "/mnt/c/Users/erich/OneDrive/Documents/Memory/db/rag_service.token"


def default_gateway():
    try:
        out = subprocess.run(
            ["ip", "-4", "route", "show", "default"],
            capture_output=True, text=True, timeout=5,
        ).stdout
        for line in out.splitlines():
            parts = line.split()
            if len(parts) >= 3 and parts[1] == "via":
                return parts[2]
    except Exception:
        pass
    return "172.31.208.1"


def load_token(path):
    with open(path, "r", encoding="utf-8") as f:
        token = f.read().strip()
    if len(token) < 32:
        raise RuntimeError(f"token file {path} looks too short ({len(token)} chars)")
    return token


def post_query(host, port, query, token, timeout, delay):
    body = json.dumps({"query": query}).encode("utf-8")
    headers = (
        "POST /query HTTP/1.1\r\n"
        f"Host: 127.0.0.1:{port}\r\n"
        "Content-Type: application/json\r\n"
    )
    if token is not None:
        headers += f"X-RAG-Token: {token}\r\n"
    headers += f"Content-Length: {len(body)}\r\nConnection: close\r\n\r\n"

    sock = socket.create_connection((host, port), timeout=timeout)
    try:
        sock.sendall(headers.encode("utf-8"))
        time.sleep(delay)  # THE KEY: body in a separate segment
        sock.sendall(body)
        data = b""
        while True:
            chunk = sock.recv(65536)
            if not chunk:
                break
            data += chunk
            if len(data) > 8 * 1024 * 1024:
                break
    finally:
        sock.close()

    if b"\r\n\r\n" not in data:
        return None, data
    head, _, payload = data.partition(b"\r\n\r\n")
    status_line = head.splitlines()[0].decode("utf-8", "replace") if head else ""
    return status_line, payload


def main():
    ap = argparse.ArgumentParser(description="WSL -> Windows RAG service client")
    ap.add_argument("query", help="query text sent as {\"query\": ...}")
    ap.add_argument("--host", default=None, help="connect target (default: WSL default gateway)")
    ap.add_argument("--port", type=int, default=8765)
    ap.add_argument("--token-file", default=DEFAULT_TOKEN_PATH)
    ap.add_argument("--no-token", action="store_true", help="omit X-RAG-Token (expect 401)")
    ap.add_argument("--timeout", type=float, default=60.0)
    ap.add_argument("--delay", type=float, default=0.5,
                    help="seconds between headers and body (must stay > 0 via gw IP)")
    args = ap.parse_args()

    try:
        token = None if args.no_token else load_token(args.token_file)
    except Exception as exc:
        print(f"token error: {exc}", file=sys.stderr)
        return 2

    host = args.host or default_gateway()
    try:
        status_line, payload = post_query(host, args.port, args.query, token,
                                          args.timeout, args.delay)
    except Exception as exc:
        print(f"connection error: {exc}", file=sys.stderr)
        return 3

    if status_line is None:
        print("no http response", file=sys.stderr)
        print(payload[:400])
        return 4
    code = 0
    parts = status_line.split(" ", 2)
    if len(parts) >= 2 and parts[1].isdigit():
        code = int(parts[1])
    print(status_line)
    if payload:
        try:
            print(json.dumps(json.loads(payload), ensure_ascii=False, indent=1)[:4000])
        except Exception:
            print(payload[:4000].decode("utf-8", "replace"))
    return 0 if 200 <= code < 300 else 1


if __name__ == "__main__":
    sys.exit(main())
