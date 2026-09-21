# SonicForge — Code Style Guide

Every rule here is enforced mechanically by `tools/lint_style.py`. If the
linter passes, the code complies. If a rule cannot be enforced automatically,
it is marked **(review)** and is checked at review time instead.

> **Platform note.** SonicForge is a browser application: the audio engine is
> the Web Audio API and the visualiser is WebGL. Neither exists in Python, so
> the code is ES2022 modules. Every structural rule below — one concern per
> module, a thin entry point, size limits, docstrings, typed signatures,
> descriptive names — is applied to those modules exactly as it would be to
> Python packages.

---

## 1. File and module structure

| Rule | Limit |
|---|---|
| One responsibility per module | strict |
| Entry point (`js/main.js`) body | ≤ 100 lines of executable code |
| Any single function or method | ≤ 50 **code** lines |
| Any single line | ≤ 79 characters |
| Module length | ≤ 600 **code** lines (split beyond this) |

> **Why code lines, not raw lines.** These limits exist to bound how much
> *logic* a reader must hold in their head. A fully documented class is around
> 60% docstring, so counting comments against the limit would penalise
> documentation and force cohesive units to be split for no benefit. The
> linter therefore ignores blank and comment lines when measuring length.

Module order is fixed:

1. Module docstring (`/** … */`) — what this module owns and why it exists.
2. Imports, grouped: standard → internal utilities → internal domain.
3. **Constants, in `UPPER_SNAKE_CASE`**, immediately after the imports.
4. Types / shape documentation.
5. Classes and functions.
6. Exports.

---

## 2. Naming

### 2.1 Variables — `<meaning>_<dtype>`

Every variable carries its physical meaning **and** its data type.
The meaning comes first because that is what the reader is looking for.

| Bad | Good |
|---|---|
| `f` | `frequency_hertz_float` |
| `g` | `gain_linear_float` |
| `n` | `sample_count_int` |
| `buf` | `noise_samples_float32array` |
| `ch` | `tone_channel_obj` |
| `arr` | `band_gains_list` |
| `t` | `elapsed_seconds_float` |
| `ok` | `is_valid_bool` |
| `cb` | `on_complete_fn` |

Recognised dtype suffixes:

`_int` `_float` `_bool` `_str` `_list` `_dict` `_obj` `_fn` `_map` `_set`
`_float32array` `_float64array` `_uint8array` `_int8array` `_uint32array`
`_promise` `_node` `_el` `_canvas` `_ctx` `_arr` `_param` `_any`

`_any` is reserved for genuinely polymorphic values, such as a field parsed
from untrusted JSON before it has been validated. It is not a licence to skip
typing something you do know the type of.

Physical-unit prefixes are required wherever a quantity has units:
`_hertz_`, `_db_`, `_ms_`, `_seconds_`, `_degrees_`, `_cents_`, `_samples_`.

**Single-character identifiers are forbidden**, with one exception: the
conventional loop index in a numeric `for` loop may be `index_int`, never `i`.

### 2.2 Functions — verb-first, typed

A function name states the **operation**, not the noun:

```
compute_spectral_slope_db_per_octave()   not  slope()
build_phase_rotated_wave_tables()        not  tables()
is_frequency_within_nyquist()            not  check()
```

Boolean-returning functions begin `is_`, `has_`, `can_`, or `should_`.

### 2.3 Classes — `PascalCase` nouns naming the thing they model

`AudioEngine`, `ToneChannel`, `NoiseGenerator`, `RoomCalibrator`.

### 2.4 Constants — `UPPER_SNAKE_CASE`, declared after imports

```js
const DEFAULT_SAMPLE_RATE_HERTZ_INT = 48000;
const SILENCE_THRESHOLD_DB_FLOAT = -90;
```

---

## 3. Docstrings

Every exported function, every class, and every public method carries a
docstring with these sections, in this order:

```js
/**
 * Convert a decibel level into a linear amplitude multiplier.
 *
 * Brief:
 *   Audio faders are calibrated in dBFS but every gain node wants a linear
 *   multiplier. Levels at or below the silence floor collapse to exactly
 *   zero so that a muted channel costs nothing downstream.
 *
 * Arguments:
 *   level_db_float (number): Level in dBFS. May be -Infinity.
 *
 * Returns:
 *   (number): Linear amplitude in [0, ...), where 0 dBFS returns 1.0.
 *
 * Warning:
 *   Values above 0 dBFS return a multiplier greater than one and will clip
 *   unless the master limiter is engaged.
 */
```

Required sections:

- **Title** — one line, imperative, comprehensive.
- **Brief** — why this exists, not what the code obviously does.
- **Arguments** — name, type, meaning. `(none)` if there are none.
- **Returns** — type and meaning. `(none)` if it returns nothing.
- **Warning** — failure modes, side effects, precision limits, ordering
  requirements. Omit the section only when there is genuinely nothing to warn
  about.

---

## 4. Formatting

- Two-space indentation.
- Lines wrap at 79 characters, broken at operators or argument boundaries,
  with the continuation indented one level.
- Multi-argument calls that exceed the limit put one argument per line.
- Braces are mandatory on every `if`/`for`/`while`, even single-statement.
- No nested ternaries.

### 4.1 Where the column limit does not apply

The limit governs **code**. In three places a line break is not neutral
formatting — it changes the thing itself — and the limit is therefore
suspended. Each is a deliberate exemption, not an oversight.

**Multi-line template literals.** A template literal spanning several lines
holds embedded content: a GLSL shader, a script in SonicForge's own
language, a block of author copy. Rewrapping those lines edits the data.
A single-line template literal is an ordinary expression and stays checked.
`lint_style.py` implements this in `find_embedded_content_lines`.

**Data URIs, and CSS values that cannot be split.** A newline inside
`url("data:…")` changes the value. There is exactly one such declaration in
the stylesheet, and it carries a comment saying so.

**HTML metadata, and one inline break.** A `<meta>` description or an Open
Graph string is content: rewrapping it changes what search engines and link
unfurlers read. The favicon is a data URI, unbreakable for the same reason as
the CSS one. And exactly one line — the status bar's dot immediately followed
by its label — cannot break, because there is no space between those two
inline elements and a newline would render as one.

Everything else in the markup **is** wrapped: attributes one per line, SVG
path data at its command separators, flowing text at existing spaces, and
adjacent inline elements wherever their container is flex (where whitespace
text nodes are ignored). `index.html` has nine long lines and `tests.html`
has none.

That was settled empirically rather than by argument. A probe boots the page,
records the bounding box of all 111 elements carrying an id plus the total
element count, and diffs it against the same page before the change. Wrapping
is correct only when that comparison is identical — and it caught the status
bar shifting six pixels, which is why that one line still carries a comment
saying it must stay long. Screenshots cannot do this job: the meters and the
frame counter differ between runs of the same file.

The rule behind all of it: **wrap code, never data.** When a break would
change behaviour or content rather than presentation, leave the line long
and say why in a comment beside it.

---

## 5. Enforcement

```bash
python tools/lint_style.py          # whole repo
python tools/lint_style.py js/core  # one directory
python tools/lint_style.py --fix-report  # group violations by rule
```

The linter checks: line length, function length, entry-point length,
module length, constant casing, single-character identifiers, dtype
suffixes, docstring presence and section completeness. A `const` bound
to an arrow or function expression is treated as a function: exempt from
the dtype suffix, subject to the length budget.

`tools/check_wiring.py` covers what the linter cannot: that every named
import resolves to a real export, that every element id referenced in
code exists in `index.html`, and that every style token used is defined.
It reads the inline module scripts in `index.html` and `tests.html` as
well as the `.js` files — an export moved between modules once broke the
unit suite silently, because a page that fails to load reports nothing.

**(review)** items not machine-checkable: whether a name is genuinely
*meaningful*, and whether a Brief explains the *why*.
