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

---

## 5. Enforcement

```bash
python tools/lint_style.py          # whole repo
python tools/lint_style.py js/core  # one directory
python tools/lint_style.py --fix-report  # group violations by rule
```

The linter checks: line length, function length, entry-point length, constant
casing, single-character identifiers, dtype suffixes, docstring presence and
section completeness, and module ordering.

**(review)** items not machine-checkable: whether a name is genuinely
*meaningful*, and whether a Brief explains the *why*.
