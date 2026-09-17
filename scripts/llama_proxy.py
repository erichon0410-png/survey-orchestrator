#!/usr/bin/env python3
"""
Lightweight TCP proxy that forwards 127.0.0.1:8080 to the Windows host gateway:8080.
Ensures WSL2 can always reach llama-server on 127.0.0.1:8080 regardless of NAT IP changes.
"""
import socket
import select
import subprocess
import sys

def get_gateway_ip():
    try:
        out = subprocess.check_output(["ip", "-4", "route", "show", "default"], timeout=3).decode()
        for line in out.splitlines():
            parts = line.split()
            if len(parts) >= 3 and parts[1] == "via":
                return parts[2]
    except Exception:
        pass
    return "172.31.208.1"

def forward_sockets(src, dst):
    try:
        while True:
            r, _, _ = select.select([src, dst], [], [], 60)
            if not r:
                break
            if src in r:
                data = src.recv(65536)
                if not data:
                    break
                dst.sendall(data)
            if dst in r:
                data = dst.recv(65536)
                if not data:
                    break
                src.sendall(data)
    except Exception:
        pass
    finally:
        try:
            src.close()
        except Exception:
            pass
        try:
            dst.close()
        except Exception:
            pass

def main():
    listen_port = 8080
    server_sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    server_sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    try:
        server_sock.bind(("127.0.0.1", listen_port))
    except OSError as e:
        # If already bound, exit silently
        print(f"Port {listen_port} already bound ({e}), exiting.")
        sys.exit(0)

    server_sock.listen(50)
    print(f"Llama proxy listening on 127.0.0.1:{listen_port}...")
    import threading

    while True:
        try:
            client_sock, _ = server_sock.accept()
            gw_ip = get_gateway_ip()
            target_sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
            target_sock.connect((gw_ip, listen_port))
            t = threading.Thread(target=forward_sockets, args=(client_sock, target_sock), daemon=True)
            t.start()
        except Exception as e:
            print(f"Connection error: {e}", file=sys.stderr)

if __name__ == "__main__":
    main()
