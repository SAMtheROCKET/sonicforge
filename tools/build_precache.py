#!/usr/bin/env python3
"""
Generate the service-worker precache manifest.

Brief:
    SonicForge has no bundler, so the service worker cannot discover the
    module graph by itself. This walks the shipped static files, hashes
    their contents, and writes a classic script the worker can importScripts.

    The content hash becomes the cache version, so a deploy that changes any
    file automatically invalidates the old cache and a deploy that changes
    nothing leaves every client's cache intact.

Usage:
    python tools/build_precache.py
    python tools/build_precache.py --check   # fail if the manifest is stale
"""

from __future__ import annotations

import hashlib
import sys
from pathlib import Path

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

REPOSITORY_ROOT_OBJ = Path(__file__).resolve().parent.parent

MANIFEST_PATH_STR = "precache-manifest.js"

PRECACHE_GLOBS_TUPLE = (
    "index.html",
    "manifest.webmanifest",
    "css/*.css",
    "js/**/*.js",
    "assets/*.svg",
)

EXCLUDED_NAMES_TUPLE = (
    "selftest.js",
    "precache-manifest.js",
    "sw.js",
)

HASH_LENGTH_INT = 12

MANIFEST_HEADER_STR = """/**
 * Service-worker precache manifest - GENERATED, do not edit by hand.
 *
 * Brief:
 *   Written by tools/build_precache.py. The version is a hash of every
 *   listed file's contents, so a deploy that changes nothing leaves every
 *   client's cache intact, and a deploy that changes anything invalidates
 *   it exactly once.
 *
 * Regenerate with:
 *   python tools/build_precache.py
 */

self.__SONICFORGE_PRECACHE = {
"""


def collect_precache_files(root_obj):
    """
    Gather every static file the application needs to run offline.

    Arguments:
        root_obj (Path): Repository root.

    Returns:
        (list[str]): Repo-relative paths, sorted for stable output.
    """
    collected_set = set()

    for glob_pattern_str in PRECACHE_GLOBS_TUPLE:
        for path_obj in root_obj.glob(glob_pattern_str):
            if not path_obj.is_file():
                continue
            if path_obj.name in EXCLUDED_NAMES_TUPLE:
                continue
            collected_set.add(
                str(path_obj.relative_to(root_obj)).replace("\\", "/")
            )

    return sorted(collected_set)


def compute_content_hash(root_obj, relative_paths_list):
    """
    Hash the contents of every precached file into one version string.

    Brief:
        Paths are included alongside contents so that renaming a file
        changes the version even when its bytes do not.

        Line endings are normalised to LF before hashing. Every precached
        file is text, and the host serves the repository's own LF bytes, so
        LF content is what the browser actually caches -- a checkout that
        materialised CRLF locally would otherwise produce a version string
        describing bytes nobody is ever served. .gitattributes asks Git for
        the same normalisation, but that only governs files as they are
        checked out: anything already in a working copy keeps whatever
        endings it had, which is exactly how this drifted far enough to
        fail CI while passing locally.

    Arguments:
        root_obj (Path): Repository root.
        relative_paths_list (list[str]): Files to hash, in order.

    Returns:
        (str): A short hexadecimal version string.

    Warning:
        Assumes every precached file is text. That holds for
        PRECACHE_GLOBS_TUPLE as written; adding a binary glob to it would
        need this normalisation made conditional on the extension.
    """
    digest_obj = hashlib.sha256()

    for relative_path_str in relative_paths_list:
        content_bytes = (root_obj / relative_path_str).read_bytes()
        digest_obj.update(relative_path_str.encode("utf-8"))
        digest_obj.update(content_bytes.replace(b"\r\n", b"\n"))

    return digest_obj.hexdigest()[:HASH_LENGTH_INT]


def render_manifest(version_str, relative_paths_list):
    """
    Render the manifest as a classic script the worker can import.

    Arguments:
        version_str (str): Cache version.
        relative_paths_list (list[str]): Files to precache.

    Returns:
        (str): Complete file contents.
    """
    file_lines_list = [
        f"    './{path_str}'," for path_str in relative_paths_list
    ]
    return (
        MANIFEST_HEADER_STR
        + f"  version: '{version_str}',\n"
        + "  files: [\n"
        + "\n".join(file_lines_list)
        + "\n  ],\n};\n"
    )


def main():
    """
    Write the manifest, or verify it is current.

    Arguments:
        (none)

    Returns:
        (none)
    """
    is_check_only_bool = "--check" in sys.argv

    relative_paths_list = collect_precache_files(REPOSITORY_ROOT_OBJ)
    version_str = compute_content_hash(
        REPOSITORY_ROOT_OBJ, relative_paths_list
    )
    rendered_str = render_manifest(version_str, relative_paths_list)

    manifest_obj = REPOSITORY_ROOT_OBJ / MANIFEST_PATH_STR
    existing_str = (
        manifest_obj.read_text(encoding="utf-8")
        if manifest_obj.exists()
        else ""
    )

    if is_check_only_bool:
        if existing_str != rendered_str:
            print("precache manifest is STALE - run tools/build_precache.py")
            sys.exit(1)
        print(f"precache manifest current: {len(relative_paths_list)} files")
        return

    manifest_obj.write_text(rendered_str, encoding="utf-8")
    total_bytes_int = sum(
        (REPOSITORY_ROOT_OBJ / path_str).stat().st_size
        for path_str in relative_paths_list
    )
    print(
        f"precache manifest written: {len(relative_paths_list)} files, "
        f"{total_bytes_int // 1024} KB, version {version_str}"
    )


if __name__ == "__main__":
    main()
