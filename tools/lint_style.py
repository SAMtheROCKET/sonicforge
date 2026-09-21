#!/usr/bin/env python3
"""
Enforce the SonicForge style guide mechanically.

Brief:
    A style guide nobody can check is a style guide nobody follows. This
    walks the ES modules and asserts every rule from STYLE_GUIDE.md that a
    parser-free checker can assert: line length, function length, entry-point
    length, constant casing, identifier naming, dtype suffixes, and docstring
    completeness.

Usage:
    python tools/lint_style.py                 # whole repo
    python tools/lint_style.py js/core         # one directory
    python tools/lint_style.py --by-rule       # group output by rule
    python tools/lint_style.py --summary       # counts only
"""

from __future__ import annotations

import re
import sys
from dataclasses import dataclass, field
from pathlib import Path

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

MAX_LINE_LENGTH_INT = 79
MAX_FUNCTION_LINES_INT = 50
MAX_ENTRY_POINT_LINES_INT = 100
MAX_MODULE_LINES_INT = 600

ENTRY_POINT_NAME_STR = "main.js"

DTYPE_SUFFIXES_TUPLE = (
    "int", "float", "bool", "str", "list", "dict", "obj", "fn", "map",
    "set", "arr", "float32array", "float64array", "uint8array",
    "int8array", "uint32array", "promise", "node", "el", "canvas", "ctx",
    "hertz", "db", "ms", "seconds", "degrees", "cents", "samples", "ratio",
    "index", "count", "id", "name", "text", "url", "key", "type", "mode",
    "state", "deg", "px", "class", "json", "err", "event", "ref",
    "param", "node", "buffer", "bus", "gain", "filter", "source",
    "any", "promise", "date", "regex", "blob", "stream", "track",
)

REQUIRED_DOC_SECTIONS_TUPLE = ("Brief:", "Arguments:", "Returns:")

# Identifiers that are conventional, external, or otherwise exempt.
EXEMPT_IDENTIFIERS_SET = {
    "ctx", "gl", "el", "db", "id", "ui", "vm", "qr", "eq", "am", "fn",
    "x", "y", "z", "w", "h", "r", "g", "b", "a",  # only inside colour/geometry helpers
}

# Files that are not part of the refactored source surface.
SKIP_PATH_PARTS_TUPLE = ("node_modules", ".git", "chromeprofile", "tools")

FUNCTION_START_PATTERN = re.compile(
    r"^\s*(?:export\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)"
    r"|^\s*(?:static\s+)?(?:async\s+)?(?:get|set)?\s*"
    r"([A-Za-z_$#][\w$]*)\s*\([^)]*\)\s*\{"
)

FUNCTION_EXPRESSION_PATTERN = re.compile(
    r"^\s*(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*"
    r"(?:async\s+)?(?:function\b"
    r"|\([^)]*\)\s*=>"
    r"|[A-Za-z_$][\w$]*\s*=>)"
)

CONST_DECLARATION_PATTERN = re.compile(
    r"^\s*(?:export\s+)?const\s+([A-Za-z_$][\w$]*)\s*="
)

VARIABLE_DECLARATION_PATTERN = re.compile(
    r"\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*[=;]"
)


# ---------------------------------------------------------------------------
# Data model
# ---------------------------------------------------------------------------


@dataclass
class Violation:
    """One style-guide breach, located precisely enough to fix."""

    rule_str: str
    path_str: str
    line_int: int
    detail_str: str


@dataclass
class LintReport:
    """Accumulated violations plus the files that were inspected."""

    violations_list: list = field(default_factory=list)
    files_checked_int: int = 0
    lines_checked_int: int = 0

    def add(self, rule_str, path_str, line_int, detail_str):
        """Record one violation."""
        self.violations_list.append(
            Violation(rule_str, path_str, line_int, detail_str)
        )

    @property
    def is_clean_bool(self):
        """True when nothing was flagged."""
        return not self.violations_list


# ---------------------------------------------------------------------------
# Individual rule checks
# ---------------------------------------------------------------------------


def count_code_lines(lines_list, start_index_int=0, end_index_int=None):
    """
    Count lines that carry code, ignoring blanks and comments.

    Brief:
        Length limits exist to bound how much logic a reader must hold in
        their head. Docstrings reduce that load rather than adding to it, so
        counting them against the limit would penalise documentation and
        push authors to split cohesive units for no benefit.

    Arguments:
        lines_list (list[str]): Source lines.
        start_index_int (int): First line to count, zero-based.
        end_index_int (int): One past the last line, or None for the end.

    Returns:
        (int): Number of lines containing executable code.
    """
    stop_int = len(lines_list) if end_index_int is None else end_index_int
    inside_block_comment_bool = False
    code_line_count_int = 0

    for line_str in lines_list[start_index_int:stop_int]:
        stripped_str = line_str.strip()

        if inside_block_comment_bool:
            if "*/" in stripped_str:
                inside_block_comment_bool = False
            continue
        if stripped_str.startswith("/*"):
            inside_block_comment_bool = "*/" not in stripped_str
            continue
        if not stripped_str:
            continue
        if stripped_str.startswith(("//", "*")):
            continue

        code_line_count_int += 1

    return code_line_count_int


def check_line_lengths(lines_list, path_str, report_obj):
    """
    Flag every source line longer than the configured column limit.

    Arguments:
        lines_list (list[str]): Source lines without terminators.
        path_str (str): Repo-relative path, for reporting.
        report_obj (LintReport): Collector to append to.

    Returns:
        (none)
    """
    for line_index_int, line_str in enumerate(lines_list, start=1):
        length_int = len(line_str.rstrip("\n"))
        if length_int > MAX_LINE_LENGTH_INT:
            report_obj.add(
                "line-length",
                path_str,
                line_index_int,
                f"{length_int} chars (limit {MAX_LINE_LENGTH_INT})",
            )


def measure_block_length(lines_list, start_index_int):
    """
    Count the lines spanned by a brace-delimited block.

    Brief:
        Counts braces outside of strings, template literals, comments and
        regular expressions, which is accurate enough for length limits
        without embedding a JavaScript parser.

    Arguments:
        lines_list (list[str]): Full file, split into lines.
        start_index_int (int): Zero-based index of the opening line.

    Returns:
        (int): Number of lines from the opening brace to its match.

    Warning:
        Returns 1 when no opening brace appears on the starting line.
    """
    depth_int = 0
    has_opened_bool = False

    for offset_int in range(start_index_int, len(lines_list)):
        line_str = strip_non_code(lines_list[offset_int])
        for character_str in line_str:
            if character_str == "{":
                depth_int += 1
                has_opened_bool = True
            elif character_str == "}":
                depth_int -= 1
        if has_opened_bool and depth_int <= 0:
            return offset_int - start_index_int + 1

    return 1


def strip_non_code(line_str):
    """
    Remove string literals and comments so brace counting stays honest.

    Arguments:
        line_str (str): One source line.

    Returns:
        (str): The same line with literal and comment content blanked.
    """
    without_comment_str = re.sub(r"//.*$", "", line_str)
    without_comment_str = re.sub(r"/\*.*?\*/", "", without_comment_str)
    without_strings_str = re.sub(r"'(?:\\.|[^'\\])*'", "''",
                                 without_comment_str)
    without_strings_str = re.sub(r'"(?:\\.|[^"\\])*"', '""',
                                 without_strings_str)
    without_strings_str = re.sub(r"`(?:\\.|[^`\\])*`", "``",
                                 without_strings_str)
    return without_strings_str


def check_function_lengths(lines_list, path_str, report_obj):
    """
    Flag functions and methods exceeding the line budget.

    Arguments:
        lines_list (list[str]): Source lines.
        path_str (str): Repo-relative path.
        report_obj (LintReport): Collector to append to.

    Returns:
        (none)
    """
    for line_index_int, line_str in enumerate(lines_list):
        match_obj = (
            FUNCTION_START_PATTERN.match(line_str)
            or FUNCTION_EXPRESSION_PATTERN.match(line_str)
        )
        if not match_obj:
            continue
        if "{" not in line_str:
            continue

        function_name_str = next(
            (group_str for group_str in match_obj.groups() if group_str), "?"
        )
        if function_name_str in ("if", "for", "while", "switch", "catch"):
            continue

        span_int = measure_block_length(lines_list, line_index_int)
        length_int = count_code_lines(
            lines_list, line_index_int, line_index_int + span_int
        )
        if length_int > MAX_FUNCTION_LINES_INT:
            report_obj.add(
                "function-length",
                path_str,
                line_index_int + 1,
                f"{function_name_str}() has {length_int} code lines "
                f"(limit {MAX_FUNCTION_LINES_INT})",
            )


def check_module_length(lines_list, path_str, report_obj):
    """
    Flag modules that have grown past the split threshold.

    Arguments:
        lines_list (list[str]): Source lines.
        path_str (str): Repo-relative path.
        report_obj (LintReport): Collector to append to.

    Returns:
        (none)
    """
    code_line_count_int = count_code_lines(lines_list)
    if code_line_count_int > MAX_MODULE_LINES_INT:
        report_obj.add(
            "module-length",
            path_str,
            len(lines_list),
            f"{code_line_count_int} code lines "
            f"(limit {MAX_MODULE_LINES_INT}) - split this module",
        )


def check_entry_point_length(lines_list, path_str, report_obj):
    """
    Flag an oversized entry point.

    Brief:
        The entry point may only wire modules together. Counting excludes
        blank lines and comments so that documentation is never penalised.

    Arguments:
        lines_list (list[str]): Source lines.
        path_str (str): Repo-relative path.
        report_obj (LintReport): Collector to append to.

    Returns:
        (none)
    """
    if not path_str.endswith(ENTRY_POINT_NAME_STR):
        return

    executable_lines_int = 0
    inside_block_comment_bool = False

    for line_str in lines_list:
        stripped_str = line_str.strip()
        if inside_block_comment_bool:
            if "*/" in stripped_str:
                inside_block_comment_bool = False
            continue
        if stripped_str.startswith("/*"):
            inside_block_comment_bool = "*/" not in stripped_str
            continue
        if not stripped_str or stripped_str.startswith("//"):
            continue
        executable_lines_int += 1

    if executable_lines_int > MAX_ENTRY_POINT_LINES_INT:
        report_obj.add(
            "entry-point-length",
            path_str,
            executable_lines_int,
            f"{executable_lines_int} executable lines "
            f"(limit {MAX_ENTRY_POINT_LINES_INT})",
        )


def check_constant_casing(lines_list, path_str, report_obj):
    """
    Require module-level constants to be UPPER_SNAKE_CASE.

    Brief:
        Only top-level `const` declarations holding literals or frozen
        structures are treated as constants. Function-valued and
        instance-valued bindings are ordinary variables.

    Arguments:
        lines_list (list[str]): Source lines.
        path_str (str): Repo-relative path.
        report_obj (LintReport): Collector to append to.

    Returns:
        (none)
    """
    for line_index_int, line_str in enumerate(lines_list, start=1):
        if line_str.startswith((" ", "\t")):
            continue
        match_obj = CONST_DECLARATION_PATTERN.match(line_str)
        if not match_obj:
            continue

        name_str = match_obj.group(1)
        value_str = line_str.split("=", 1)[1].strip()

        looks_like_constant_bool = (
            value_str.startswith(("Object.freeze", "[", "{"))
            or re.match(r"^-?[\d.]+[;,]?$", value_str)
            or re.match(r"^['\"`]", value_str)
            or value_str.startswith("new Map(")
            or value_str.startswith("new Set(")
        )
        if not looks_like_constant_bool:
            continue
        if name_str != name_str.upper():
            report_obj.add(
                "constant-casing",
                path_str,
                line_index_int,
                f"'{name_str}' should be UPPER_SNAKE_CASE",
            )


def has_recognised_dtype_suffix(name_str):
    """
    Report whether an identifier ends in an approved dtype suffix.

    Arguments:
        name_str (str): Identifier to inspect.

    Returns:
        (bool): True when the name carries a recognised suffix.
    """
    lowered_str = name_str.lower()
    return any(
        lowered_str.endswith("_" + suffix_str)
        for suffix_str in DTYPE_SUFFIXES_TUPLE
    )


def check_variable_naming(lines_list, path_str, report_obj):
    """
    Flag single-character names and variables missing a dtype suffix.

    Brief:
        Applies to `const`/`let`/`var` declarations only. Destructuring,
        imports and parameters are reviewed by eye rather than flagged, to
        keep the signal-to-noise ratio usable.

    Arguments:
        lines_list (list[str]): Source lines.
        path_str (str): Repo-relative path.
        report_obj (LintReport): Collector to append to.

    Returns:
        (none)

    Warning:
        Identifiers listed in EXEMPT_IDENTIFIERS_SET are always allowed.
    """
    for line_index_int, line_str in enumerate(lines_list, start=1):
        if line_str.lstrip().startswith(("import ", "export {", "//", "*")):
            continue

        function_match_obj = FUNCTION_EXPRESSION_PATTERN.match(line_str)

        for name_str in VARIABLE_DECLARATION_PATTERN.findall(line_str):
            if function_match_obj and function_match_obj.group(1) == name_str:
                continue
            if name_str in EXEMPT_IDENTIFIERS_SET:
                continue
            if name_str.isupper():
                continue
            if len(name_str) == 1:
                report_obj.add(
                    "single-char-name",
                    path_str,
                    line_index_int,
                    f"'{name_str}' is a single character",
                )
            elif not has_recognised_dtype_suffix(name_str):
                report_obj.add(
                    "missing-dtype-suffix",
                    path_str,
                    line_index_int,
                    f"'{name_str}' has no <meaning>_<dtype> suffix",
                )


def check_docstrings(lines_list, path_str, report_obj):
    """
    Require a complete docstring above every exported declaration.

    Brief:
        Looks upward from each `export function` / `export class` for a
        block comment and verifies it carries the mandated sections.

    Arguments:
        lines_list (list[str]): Source lines.
        path_str (str): Repo-relative path.
        report_obj (LintReport): Collector to append to.

    Returns:
        (none)
    """
    for line_index_int, line_str in enumerate(lines_list):
        is_exported_bool = re.match(
            r"^export\s+(?:async\s+)?(?:function|class)\s+(\w+)", line_str
        )
        if not is_exported_bool:
            continue

        declaration_name_str = is_exported_bool.group(1)
        comment_lines_list = collect_preceding_comment(
            lines_list, line_index_int
        )

        if not comment_lines_list:
            report_obj.add(
                "missing-docstring",
                path_str,
                line_index_int + 1,
                f"{declaration_name_str} has no docstring",
            )
            continue

        comment_text_str = "\n".join(comment_lines_list)
        missing_sections_list = [
            section_str
            for section_str in REQUIRED_DOC_SECTIONS_TUPLE
            if section_str not in comment_text_str
        ]
        if missing_sections_list:
            report_obj.add(
                "incomplete-docstring",
                path_str,
                line_index_int + 1,
                f"{declaration_name_str} missing "
                f"{', '.join(missing_sections_list)}",
            )


def collect_preceding_comment(lines_list, declaration_index_int):
    """
    Return the block comment immediately above a declaration.

    Arguments:
        lines_list (list[str]): Source lines.
        declaration_index_int (int): Zero-based index of the declaration.

    Returns:
        (list[str]): Comment lines, or an empty list when none precede it.
    """
    cursor_int = declaration_index_int - 1
    while cursor_int >= 0 and not lines_list[cursor_int].strip():
        cursor_int -= 1
    if cursor_int < 0 or not lines_list[cursor_int].strip().endswith("*/"):
        return []

    collected_list = []
    while cursor_int >= 0:
        collected_list.insert(0, lines_list[cursor_int])
        if lines_list[cursor_int].strip().startswith("/**"):
            return collected_list
        cursor_int -= 1
    return []


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
