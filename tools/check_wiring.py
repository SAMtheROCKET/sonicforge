#!/usr/bin/env python3
"""
Verify that the application is wired together correctly.

Brief:
    Two classes of failure account for nearly every white screen in a
    dependency-free ES-module application, and both are detectable without
    running it:

      1. An import naming something the target module does not export.
      2. JavaScript reaching for a DOM id the HTML does not contain.

    Neither is caught by a unit test, because both fail at module-load time
    before any test can run. This checks both, plus a few structural
    invariants that would break subpath hosting.

Usage:
    python tools/check_wiring.py
"""

from __future__ import annotations

import re
import sys
from pathlib import Path

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

REPOSITORY_ROOT_OBJ = Path(__file__).resolve().parent.parent

HTML_ENTRY_POINTS_TUPLE = ("index.html", "tests.html")

MODULE_SCRIPT_PATTERN = re.compile(
    r'<script[^>]*type="module"[^>]*>(.*?)</script>', re.S
)

SKIP_PATH_PARTS_TUPLE = ("node_modules", ".git", "tools")

EXPORT_PATTERNS_TUPLE = (
    re.compile(r"^export\s+(?:async\s+)?function\s+\*?\s*([A-Za-z_$][\w$]*)",
               re.MULTILINE),
    re.compile(r"^export\s+class\s+([A-Za-z_$][\w$]*)", re.MULTILINE),
    re.compile(r"^export\s+(?:const|let|var)\s+([A-Za-z_$][\w$]*)",
               re.MULTILINE),
)

EXPORT_LIST_PATTERN = re.compile(r"^export\s*\{([^}]*)\}", re.MULTILINE)

IMPORT_PATTERN = re.compile(
    r"^import\s+(?:\{([^}]*)\}|(\*\s+as\s+[\w$]+)|([\w$]+))?\s*"
    r"(?:,\s*\{([^}]*)\})?\s*from\s*['\"]([^'\"]+)['\"]",
    re.MULTILINE,
)

GET_ELEMENT_PATTERN = re.compile(
    r"""getElementById\(\s*['"]([^'"]+)['"]\s*\)"""
)
DOLLAR_HELPER_PATTERN = re.compile(
    r"""(?<![\w$])\$\(\s*['"]([^'"]+)['"]\s*\)"""
)
DATA_TERM_PATTERN = re.compile(r"""\[data-term="([^"]+)"\]""")

VAR_USE_PATTERN = re.compile(r"var\(\s*(--[\w-]+)\s*([,)])")
VAR_DEFINITION_PATTERN = re.compile(r"(--[\w-]+)\s*:")
SET_PROPERTY_PATTERN = re.compile(r"""setProperty\(\s*['"](--[\w-]+)['"]""")

ABSOLUTE_ASSET_PATTERN = re.compile(r'(?:src|href)="(/[^/][^"]*)"')

# Element ids created at runtime rather than present in the markup.
RUNTIME_ELEMENT_IDS_SET = frozenset({"dtmf-pad-host", "modal-title"})


def collect_module_paths(root_obj):
    """
    Gather every first-party JavaScript module.

    Brief:
        Skip matching runs against the path relative to the repository root,
        so a project living inside a directory that happens to share a name
        with a skip entry is not excluded entirely.

    Arguments:
        root_obj (Path): Repository root.

    Returns:
        (list[Path]): Sorted module paths.
    """
    collected_list = []

    for path_obj in root_obj.rglob("*.js"):
        relative_parts_tuple = path_obj.relative_to(root_obj).parts
        if any(part_str in SKIP_PATH_PARTS_TUPLE
               for part_str in relative_parts_tuple):
            continue
        collected_list.append(path_obj)

    return sorted(collected_list)


def read_exported_names(source_str):
    """
    Collect every name a module exports.

    Arguments:
        source_str (str): Module source.

    Returns:
        (set[str]): Exported names, including 'default' when present.
    """
    names_set = set()

    for pattern_obj in EXPORT_PATTERNS_TUPLE:
        names_set.update(pattern_obj.findall(source_str))

    for block_str in EXPORT_LIST_PATTERN.findall(source_str):
        for part_str in block_str.split(","):
            cleaned_str = part_str.strip()
            if not cleaned_str:
                continue
            if " as " in cleaned_str:
                cleaned_str = cleaned_str.split(" as ")[-1].strip()
            names_set.add(cleaned_str)

    if re.search(r"^export\s+default\b", source_str, re.MULTILINE):
        names_set.add("default")

    return names_set


def check_imports(module_paths_list, root_obj, errors_list):
    """
    Verify every named import resolves to a real export.

    Arguments:
        module_paths_list (list[Path]): Modules to inspect.
        root_obj (Path): Repository root, for relative reporting.
        errors_list (list[str]): Collector to append to.

    Returns:
        (int): Number of named imports checked.
    """
    exports_by_path_dict = {
        path_obj.resolve(): read_exported_names(
            path_obj.read_text(encoding="utf-8")
        )
        for path_obj in module_paths_list
    }
    checked_count_int = 0

    for path_obj in module_paths_list:
        source_str = path_obj.read_text(encoding="utf-8")
        relative_str = str(path_obj.relative_to(root_obj)).replace("\\", "/")

        for match_obj in IMPORT_PATTERN.finditer(source_str):
            named_first_str = match_obj.group(1)
            named_second_str = match_obj.group(4)
            specifier_str = match_obj.group(5)

            if not specifier_str.startswith("."):
                continue

            target_obj = (path_obj.parent / specifier_str).resolve()
            if not target_obj.exists():
                errors_list.append(
                    f"{relative_str}: imports '{specifier_str}', "
                    "which does not exist"
                )
                continue

            available_set = exports_by_path_dict.get(target_obj, set())
            for block_str in (named_first_str, named_second_str):
                if not block_str:
                    continue
                checked_count_int += check_named_block(
                    block_str,
                    available_set,
                    relative_str,
                    specifier_str,
                    errors_list,
                )

    return checked_count_int


def check_named_block(block_str, available_set, relative_str, specifier_str,
                      errors_list):
    """
    Verify one braced import block against a module's exports.

    Arguments:
        block_str (str): Comma-separated import names.
        available_set (set[str]): Names the target module exports.
        relative_str (str): Importing module, for reporting.
        specifier_str (str): Import specifier, for reporting.
        errors_list (list[str]): Collector to append to.

    Returns:
        (int): Number of names checked.
    """
    checked_count_int = 0

    for part_str in block_str.split(","):
        cleaned_str = part_str.strip()
        if not cleaned_str:
            continue

        original_str = cleaned_str.split(" as ")[0].strip()
        checked_count_int += 1

        if original_str not in available_set:
            available_str = ", ".join(sorted(available_set)) or "(nothing)"
            errors_list.append(
                f"{relative_str}: imports '{original_str}' from "
                f"'{specifier_str}' but that module exports: {available_str}"
            )

    return checked_count_int


def check_html_imports(root_obj, module_paths_list, errors_list):
    """
    Verify the imports inside inline module scripts resolve.

    Brief:
        index.html and tests.html each carry a `<script type="module">` that
        imports from js/. Those imports were outside every check, so moving
        an export between modules broke the unit suite silently: the page
        failed to load at all, and a page that never runs reports nothing.

    Arguments:
        root_obj (Path): Repository root.
        module_paths_list (list[Path]): Modules whose exports are known.
        errors_list (list[str]): Collector to append to.

    Returns:
        (int): Number of named imports checked.
    """
    exports_by_path_dict = {
        path_obj.resolve(): read_exported_names(
            path_obj.read_text(encoding="utf-8")
        )
        for path_obj in module_paths_list
    }
    checked_count_int = 0

    for html_name_str in HTML_ENTRY_POINTS_TUPLE:
        html_path_obj = root_obj / html_name_str
        if not html_path_obj.exists():
            continue

        html_str = html_path_obj.read_text(encoding="utf-8")
        for script_str in MODULE_SCRIPT_PATTERN.findall(html_str):
            for match_obj in IMPORT_PATTERN.finditer(script_str):
                specifier_str = match_obj.group(5)
                if not specifier_str.startswith("."):
                    continue

                target_obj = (root_obj / specifier_str).resolve()
                if not target_obj.exists():
                    errors_list.append(
                        f"{html_name_str}: imports '{specifier_str}', "
                        "which does not exist"
                    )
                    continue

                available_set = exports_by_path_dict.get(target_obj, set())
                for block_str in (match_obj.group(1), match_obj.group(4)):
                    if not block_str:
                        continue
                    checked_count_int += check_named_block(
                        block_str,
                        available_set,
                        html_name_str,
                        specifier_str,
                        errors_list,
                    )

    return checked_count_int


def check_dom_references(module_paths_list, root_obj, index_html_str,
                         errors_list):
    """
    Verify every DOM id referenced from JavaScript exists in the markup.

    Arguments:
        module_paths_list (list[Path]): Modules to inspect.
        root_obj (Path): Repository root.
        index_html_str (str): Contents of index.html.
        errors_list (list[str]): Collector to append to.

    Returns:
        (int): Number of ids found in the markup.
    """
    html_ids_set = set(re.findall(r'\bid="([^"]+)"', index_html_str))
    html_terms_set = set(
        re.findall(r'data-term="([^"]+)"', index_html_str)
    )

    for path_obj in module_paths_list:
        source_str = path_obj.read_text(encoding="utf-8")
        relative_str = str(path_obj.relative_to(root_obj)).replace("\\", "/")

        for pattern_obj in (GET_ELEMENT_PATTERN, DOLLAR_HELPER_PATTERN):
            for element_id_str in pattern_obj.findall(source_str):
                if element_id_str in RUNTIME_ELEMENT_IDS_SET:
                    continue
                if element_id_str not in html_ids_set:
                    errors_list.append(
                        f"{relative_str}: references #{element_id_str}, "
                        "which is not in index.html"
                    )

        for term_str in DATA_TERM_PATTERN.findall(source_str):
            if term_str not in html_terms_set:
                errors_list.append(
                    f'{relative_str}: references [data-term="{term_str}"], '
                    "not present in index.html"
                )

    return len(html_ids_set)


def check_style_tokens(root_obj, index_html_str, module_paths_list,
                       errors_list):
    """
    Verify every CSS custom property is defined or has a fallback.

    Brief:
        A var() with a fallback is legitimate even when nothing defines it -
        that is how properties set from JavaScript at runtime work.

    Arguments:
        root_obj (Path): Repository root.
        index_html_str (str): Contents of index.html.
        module_paths_list (list[Path]): Modules that may set properties.
        errors_list (list[str]): Collector to append to.

    Returns:
        (none)
    """
    stylesheet_str = "".join(
        (root_obj / "css" / name_str).read_text(encoding="utf-8")
        for name_str in ("theme.css", "components.css")
    )
    defined_set = set(VAR_DEFINITION_PATTERN.findall(stylesheet_str))

    runtime_set = set()
    for path_obj in module_paths_list:
        runtime_set.update(
            SET_PROPERTY_PATTERN.findall(
                path_obj.read_text(encoding="utf-8")
            )
        )

    for label_str, source_str in (
        ("css", stylesheet_str),
        ("index.html", index_html_str),
    ):
        for name_str, terminator_str in VAR_USE_PATTERN.findall(source_str):
            if name_str in defined_set or name_str in runtime_set:
                continue
            if terminator_str == ",":
                continue
            errors_list.append(
                f"{label_str}: var({name_str}) has no definition "
                "and no fallback"
            )


def check_relative_paths(root_obj, errors_list):
    """
    Verify no HTML file uses an absolute asset path.

    Brief:
        GitHub Pages serves a project site under /repo-name/, so an absolute
        path resolves to the wrong place and the page loads unstyled.

    Arguments:
        root_obj (Path): Repository root.
        errors_list (list[str]): Collector to append to.

    Returns:
        (none)
    """
    for path_obj in root_obj.glob("*.html"):
        source_str = path_obj.read_text(encoding="utf-8")
        for match_obj in ABSOLUTE_ASSET_PATTERN.finditer(source_str):
            errors_list.append(
                f"{path_obj.name}: absolute asset path "
                f"'{match_obj.group(1)}' breaks subpath hosting"
            )


def main():
    """
    Run every wiring check and exit non-zero on any failure.

    Arguments:
        (none)

    Returns:
        (none)
    """
    root_obj = REPOSITORY_ROOT_OBJ
    module_paths_list = collect_module_paths(root_obj)
    index_html_str = (root_obj / "index.html").read_text(encoding="utf-8")
    errors_list = []

    import_count_int = check_imports(
        module_paths_list, root_obj, errors_list
    )
    import_count_int += check_html_imports(
        root_obj, module_paths_list, errors_list
    )
    element_count_int = check_dom_references(
        module_paths_list, root_obj, index_html_str, errors_list
    )
    check_style_tokens(
        root_obj, index_html_str, module_paths_list, errors_list
    )
    check_relative_paths(root_obj, errors_list)

    print(
        f"modules: {len(module_paths_list)}   "
        f"named imports: {import_count_int}   "
        f"element ids: {element_count_int}"
    )
    print()

    if not errors_list:
        print("OK - imports resolve, DOM ids exist, style tokens defined.")
        return

    for error_str in errors_list:
        print(f"  x {error_str}")
    print()
    print(f"{len(errors_list)} wiring errors")
    sys.exit(1)


if __name__ == "__main__":
    main()
