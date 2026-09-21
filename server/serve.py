#!/usr/bin/env python3
"""
SonicForge development server: standard library only, zero dependencies.

Brief:
    Serves the static application and, optionally, a WebSocket relay for
    Concert Mode's cross-device tier. Neither is needed in production:
    SonicForge deploys as a fully static site, where Concert Mode falls back
    to BroadcastChannel in one browser and WebRTC between devices.

        python server/serve.py
        python server/serve.py --port 3000
        python server/serve.py --no-relay

Warning:
    A development tool. It binds every interface so a phone on the same
    network can reach it, disables caching, and has no authentication. Do
    not put it on a network you do not trust.
"""

from __future__ import annotations

import argparse
import socket
import sys
import threading
from functools import partial
from http.server import ThreadingHTTPServer
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from relay import run_relay                      # noqa: E402
from static_handler import (                     # noqa: E402
    REPOSITORY_ROOT_STR,
    SonicForgeHandler,
)

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

#: Default ports for the static server and the relay.
DEFAULT_HTTP_PORT_INT = 8080
DEFAULT_RELAY_PORT_INT = 8787

#: Address used only to discover which interface routes outward.
ROUTE_PROBE_ADDRESS_TUPLE = ("8.8.8.8", 80)

#: Reported when no outward route can be found.
LOOPBACK_ADDRESS_STR = "127.0.0.1"


def find_lan_address():
    """
    Discover this machine's address on the local network.

    Brief:
        Opens a UDP socket toward a public address and reads back the local
        end. Nothing is sent: UDP needs no handshake, so this resolves the
        routing table without any traffic leaving the machine.

    Arguments:
        (none)

    Returns:
        (str): The local address, or loopback when there is no route.
    """
    try:
        probe_socket = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        probe_socket.connect(ROUTE_PROBE_ADDRESS_TUPLE)
        address_str = probe_socket.getsockname()[0]
        probe_socket.close()
        return address_str
    except OSError:
        return LOOPBACK_ADDRESS_STR


def parse_arguments():
    """
    Parse the command line.

    Arguments:
        (none)

    Returns:
        (argparse.Namespace): The parsed options.
    """
    parser_obj = argparse.ArgumentParser(
        description="SonicForge development server"
    )
    parser_obj.add_argument(
        "--port", type=int, default=DEFAULT_HTTP_PORT_INT,
        help=f"HTTP port (default {DEFAULT_HTTP_PORT_INT})",
    )
    parser_obj.add_argument(
        "--relay-port", type=int, default=DEFAULT_RELAY_PORT_INT,
        help=f"WebSocket relay port (default {DEFAULT_RELAY_PORT_INT})",
    )
    parser_obj.add_argument(
        "--no-relay", action="store_true",
        help="disable the Concert Mode relay",
    )
    return parser_obj.parse_args()


def print_banner(options_obj, address_str):
    """
    Print the addresses the server is reachable on.

    Arguments:
        options_obj (argparse.Namespace): The parsed options.
        address_str (str): This machine's local network address.

    Returns:
        (none)
    """
    print("")
    print("  SonicForge dev server")
    print("")
    print(f"    local     http://localhost:{options_obj.port}/")
    print(
        f"    network   http://{address_str}:{options_obj.port}/"
        "          <- open this on your phone"
    )
    print(f"    tests     http://localhost:{options_obj.port}/tests.html")
    if not options_obj.no_relay:
        print(
            f"    relay     ws://{address_str}:{options_obj.relay_port}"
            "         <- paste into Concert Mode / Relay URL"
        )
    print("")
    print("    Ctrl+C to stop.")
    print("")


def main():
    """
    Start the static server, and the relay unless it was disabled.

    Arguments:
        (none)

    Returns:
        (none)
    """
    options_obj = parse_arguments()

    if not options_obj.no_relay:
        threading.Thread(
            target=run_relay, args=(options_obj.relay_port,), daemon=True
        ).start()

    handler_factory = partial(
        SonicForgeHandler, directory=REPOSITORY_ROOT_STR
    )
    server_obj = ThreadingHTTPServer(
        ("0.0.0.0", options_obj.port), handler_factory
    )

    print_banner(options_obj, find_lan_address())

    try:
        server_obj.serve_forever()
    except KeyboardInterrupt:
        print("\n  stopped.\n")


if __name__ == "__main__":
    main()
