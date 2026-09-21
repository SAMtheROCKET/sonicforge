#!/usr/bin/env python3
"""
Style-guide linter for the SonicForge source tree.

Brief:
    Collects the files, runs every rule over each, and reports. The
    rules themselves live in style_rules.py; this module owns only the
    walking, the reporting and the command line.

Usage:
    python tools/lint_style.py                 # whole repo
    python tools/lint_style.py js/core         # one directory
    python tools/lint_style.py --by-rule       # group output by rule
    python tools/lint_style.py --summary       # counts only
"""

from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from style_rules import (                      # noqa: E402
    ENTRY_POINT_NAME_STR,
    SKIP_PATH_PARTS_TUPLE,
    LintReport,
    check_constant_casing,
    check_docstrings,
    check_entry_point_length,
    check_function_lengths,
    check_line_lengths,
    check_module_length,
    check_variable_naming,
)



# ---------------------------------------------------------------------------
# Driver
# ---------------------------------------------------------------------------


def lint_file(path_obj, root_obj, report_obj):
    """
    Run every rule against one source file.

    Arguments:
        path_obj (Path): Absolute path to the file.
        root_obj (Path): Repository root, for relative reporting.
        report_obj (LintReport): Collector to append to.

    Returns:
        (none)
    """
    source_str = path_obj.read_text(encoding="utf-8")
    lines_list = source_str.splitlines()
    path_str = str(path_obj.relative_to(root_obj)).replace("\\", "/")

    report_obj.files_checked_int += 1
    report_obj.lines_checked_int += len(lines_list)

    check_line_lengths(lines_list, path_str, report_obj)
    check_function_lengths(lines_list, path_str, report_obj)
    check_module_length(lines_list, path_str, report_obj)
    check_entry_point_length(lines_list, path_str, report_obj)
    check_constant_casing(lines_list, path_str, report_obj)
    check_variable_naming(lines_list, path_str, report_obj)
    check_docstrings(lines_list, path_str, report_obj)


def collect_source_files(target_obj, root_obj):
    """
    Gather every JavaScript module under a path, skipping vendor trees.

    Brief:
        Skip matching is done against the path *relative to the repository
        root*. Matching against absolute parts would exclude the whole
        project whenever it happens to live inside a directory that shares a
        name with a skip entry.

    Arguments:
        target_obj (Path): File or directory to walk.
        root_obj (Path): Repository root, used to relativise before matching.

    Returns:
        (list[Path]): Sorted list of source files.
    """
    if target_obj.is_file():
        return [target_obj]

    collected_list = []
    for path_obj in target_obj.rglob("*.js"):
        relative_parts_tuple = path_obj.relative_to(root_obj).parts
        if any(part_str in SKIP_PATH_PARTS_TUPLE
               for part_str in relative_parts_tuple):
            continue
        collected_list.append(path_obj)
    return sorted(collected_list)


def print_report(report_obj, group_by_rule_bool, summary_only_bool):
    """
    Render the violation list to stdout.

    Arguments:
        report_obj (LintReport): Completed report.
        group_by_rule_bool (bool): Group output by rule instead of by file.
        summary_only_bool (bool): Print counts only.

    Returns:
        (none)
    """
    counts_dict = {}
    for violation_obj in report_obj.violations_list:
        counts_dict[violation_obj.rule_str] = (
            counts_dict.get(violation_obj.rule_str, 0) + 1
        )

    print(
        f"checked {report_obj.files_checked_int} files, "
        f"{report_obj.lines_checked_int} lines"
    )
    print()

    if report_obj.is_clean_bool:
        print("CLEAN - every style rule satisfied.")
        return

    for rule_str, count_int in sorted(
        counts_dict.items(), key=lambda pair: -pair[1]
    ):
        print(f"  {count_int:>5}  {rule_str}")
    print(f"  {len(report_obj.violations_list):>5}  TOTAL")
    print()

    if summary_only_bool:
        return

    if group_by_rule_bool:
        for rule_str in sorted(counts_dict):
            print(f"--- {rule_str} ---")
            for violation_obj in report_obj.violations_list:
                if violation_obj.rule_str == rule_str:
                    print(
                        f"  {violation_obj.path_str}:"
                        f"{violation_obj.line_int}  {violation_obj.detail_str}"
                    )
            print()
        return

    current_path_str = None
    for violation_obj in report_obj.violations_list:
        if violation_obj.path_str != current_path_str:
            current_path_str = violation_obj.path_str
            print(f"--- {current_path_str} ---")
        print(
            f"  {violation_obj.line_int:>5}  {violation_obj.rule_str:<22}"
            f"  {violation_obj.detail_str}"
        )


def main():
    """
    Lint the requested path and exit non-zero on any violation.

    Arguments:
        (none)

    Returns:
        (none)
    """
    arguments_list = [
        argument_str for argument_str in sys.argv[1:]
        if not argument_str.startswith("--")
    ]
    flags_set = {
        argument_str for argument_str in sys.argv[1:]
        if argument_str.startswith("--")
    }

    root_obj = Path(__file__).resolve().parent.parent
    target_obj = (
        (root_obj / arguments_list[0]).resolve()
        if arguments_list
        else root_obj / "js"
    )

    report_obj = LintReport()
    for path_obj in collect_source_files(target_obj, root_obj):
        lint_file(path_obj, root_obj, report_obj)

    print_report(
        report_obj,
        "--by-rule" in flags_set,
        "--summary" in flags_set,
    )
    sys.exit(0 if report_obj.is_clean_bool else 1)


if __name__ == "__main__":
    main()
