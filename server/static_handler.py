"""
The static file handler for the development server.

Brief:
    Two things the stdlib handler does not do on its own. It serves .js as
    text/javascript, without which the browser refuses to execute an ES
    module at all; and it disables caching, because a cached module during
    development means editing a file and watching nothing change.

    It also accepts the test suites' reports, which is what lets a headless
    run be asserted on from a command line.
"""

from __future__ import annotations

import json
import os
import sys
from http.server import SimpleHTTPRequestHandler

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

#: Repository root, two levels up from this file.
REPOSITORY_ROOT_STR = os.path.dirname(
    os.path.dirname(os.path.abspath(__file__))
)

#: Endpoint the test suites post their reports to.
RESULTS_PATH_STR = "/__results"

#: Largest report accepted, in bytes.
MAX_REPORT_BYTES_INT = 4 << 20

#: Where each report is written, by its declared kind.
APP_RESULTS_NAME_STR = "app-results.json"
UNIT_RESULTS_NAME_STR = "test-results.json"


class SonicForgeHandler(SimpleHTTPRequestHandler):
    """
    Static handler with ES-module MIME types and no-cache headers.

    Arguments:
        (inherited)

    Returns:
        (SonicForgeHandler): The handler.
    """

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

    def end_headers(self):
        """
        Add the development cache and sniffing headers.

        Arguments:
            (none)

        Returns:
            (none)
        """
        self.send_header("Cache-Control", "no-store, must-revalidate")
        self.send_header("X-Content-Type-Options", "nosniff")
        super().end_headers()

    def do_POST(self):
        """
        Receive a test report so a headless run is assertable.

        Arguments:
            (none)

        Returns:
            (none)

        Warning:
            The body is untrusted and size-capped before it is parsed. A
            malformed report is answered with 400 rather than raising, so a
            broken suite cannot take the server down mid-run.
        """
        if self.path != RESULTS_PATH_STR:
            self.send_error(404)
            return

        report_dict = self.read_report()
        if report_dict is None:
            return

        file_name_str = (
            APP_RESULTS_NAME_STR if report_dict.get("kind") == "app"
            else UNIT_RESULTS_NAME_STR
        )
        output_path_str = os.path.join(REPOSITORY_ROOT_STR, file_name_str)
        with open(output_path_str, "w", encoding="utf-8") as file_obj:
            json.dump(report_dict, file_obj, indent=2)

        sys.stderr.write(
            f"  tests  {report_dict.get('pass')} passed, "
            f"{report_dict.get('fail')} failed in "
            f"{report_dict.get('ms')}ms -> {file_name_str}\n"
        )
        self.send_response(204)
        self.send_header("Content-Length", "0")
        self.end_headers()

    def read_report(self):
        """
        Read and decode the posted report.

        Arguments:
            (none)

        Returns:
            (dict|None): The report, or None once an error has been sent.
        """
        try:
            length_int = int(self.headers.get("Content-Length", "0"))
            body_bytes = self.rfile.read(min(length_int, MAX_REPORT_BYTES_INT))
            return json.loads(body_bytes.decode("utf-8"))
        except (ValueError, UnicodeDecodeError):
            self.send_error(400, "malformed report")
            return None

    def log_message(self, format_str, *arguments_tuple):
        """
        Write one request line to stderr.

        Arguments:
            format_str (str): Printf-style format.
            arguments_tuple (tuple): Its arguments.

        Returns:
            (none)
        """
        sys.stderr.write(f"  http  {format_str % arguments_tuple}\n")
