/**
 * Tokeniser for the SonicForge command language.
 *
 * Brief:
 *   The language is deliberately tiny - calls, literals and bracketed lists -
 *   but it is unit-aware, because an audio script that cannot tell two
 *   seconds from two milliseconds is a liability. These are the same tone:
 *
 *     play(1.5khz, 2s, square)
 *     play(1500, 2000, square)
 *
 *   Units are resolved here rather than in the parser, so every consumer
 *   downstream receives a plain number in a known base unit.
 */

/* ---------------------------------------------------------------------------
 * Constants
 * ------------------------------------------------------------------------ */

/** Token kinds the parser distinguishes. */
export const TOKEN_KINDS_DICT = Object.freeze({
  NUMBER: 'number',
  IDENTIFIER: 'identifier',
  STRING: 'string',
  OPEN_PAREN: '(',
  CLOSE_PAREN: ')',
  OPEN_BRACKET: '[',
  CLOSE_BRACKET: ']',
  COMMA: ',',
  SEPARATOR: 'separator',
  END_OF_INPUT: 'end',
});

/**
 * Unit suffixes and how they convert to their base unit.
 *
 * Frequency resolves to hertz, time to milliseconds, gain to decibels,
 * angle to degrees, and percent to a 0-1 ratio.
 */
export const UNIT_SUFFIXES_DICT = Object.freeze({
  hz: { kind_str: 'freq', scale_float: 1 },
  khz: { kind_str: 'freq', scale_float: 1000 },
  k: { kind_str: 'freq', scale_float: 1000 },
  ms: { kind_str: 'time', scale_float: 1 },
  s: { kind_str: 'time', scale_float: 1000 },
  sec: { kind_str: 'time', scale_float: 1000 },
  m: { kind_str: 'time', scale_float: 60000 },
  db: { kind_str: 'gain', scale_float: 1 },
  deg: { kind_str: 'angle', scale_float: 1 },
  '%': { kind_str: 'percent', scale_float: 0.01 },
  ct: { kind_str: 'cents', scale_float: 1 },
  cents: { kind_str: 'cents', scale_float: 1 },
});

/** Maximum characters scanned, guarding against a pathological paste. */
const MAX_SOURCE_LENGTH_INT = 200000;

const IDENTIFIER_START_PATTERN = /[A-Za-z_$#]/;
const IDENTIFIER_PART_PATTERN = /[A-Za-z0-9_$#.\-]/;
const LETTER_PATTERN = /[A-Za-z]/;

/* ------------------------------------------------------------------------ */

/**
 * A parse or tokenise failure, located in the source text.
 *
 * Brief:
 *   Carries the line and column so the terminal can point at the offending
 *   character. A script error the user cannot locate is barely better than
 *   no error at all.
 *
 * Arguments:
 *   message_str (string): What went wrong.
 *   location_obj (Object): Optional line_int, column_int and source_str.
 *
 * Returns:
 *   (ScriptError): The error, ready to throw.
 */
export class ScriptError extends Error {
  constructor(message_str, location_obj = {}) {
    super(message_str);
    this.name = 'ScriptError';
    this.line_int = location_obj.line_int ?? 0;
    this.column_int = location_obj.column_int ?? 0;
    this.source_str = location_obj.source_str ?? '';
  }

  /**
   * Render the error with a caret pointing at the offending column.
   *
   * Arguments:
   *   (none)
   *
   * Returns:
   *   (string): A multi-line message, or the bare message when no source
   *   text was captured.
   */
  format() {
    if (!this.source_str) {
      return this.message;
    }

    const lines_list = this.source_str.split('\n');
    const offending_line_str = lines_list[this.line_int - 1] ?? '';
    const caret_padding_str = ' '.repeat(Math.max(0, this.column_int - 1));
    return `${this.message}\n  ${offending_line_str}\n  ${caret_padding_str}^`;
  }
}

/* ------------------------------------------------------------------------ */

/**
 * Scan source text into a flat token list.
 *
 * Brief:
 *   Walks the text once, resolving unit suffixes on numbers as it goes so
 *   the parser never has to think about units at all.
 *
 * Arguments:
 *   source_str (string): Script text to tokenise.
 *
 * Returns:
 *   (Object[]): Tokens, always terminated by an end-of-input token.
 *
 * Warning:
 *   Throws ScriptError with a line and column for any unterminated string,
 *   unterminated block comment, malformed number, or stray character.
 */
export function tokenize(source_str) {
  if (source_str.length > MAX_SOURCE_LENGTH_INT) {
    throw new ScriptError('Script is too long to parse.');
  }

  const scanner_obj = new SourceScanner(source_str);
  return scanner_obj.scanAll();
}

/**
 * Walk source text once, emitting tokens and tracking position.
 *
 * Brief:
 *   A small class rather than a closure so that line and column tracking,
 *   which every error message depends on, lives in one place instead of
 *   being threaded through a dozen helper calls.
 *
 * Arguments:
 *   source_str (string): Text to scan.
 *
 * Returns:
 *   (SourceScanner): A scanner positioned at the start.
 */
class SourceScanner {
  constructor(source_str) {
    this.source_str = source_str;
    this.cursor_int = 0;
    this.line_int = 1;
    this.line_start_int = 0;
    this.tokens_list = [];
  }

  /** Current one-based column. */
  get column_int() {
    return this.cursor_int - this.line_start_int + 1;
  }

  /** Raise a located ScriptError. */
  #fail(message_str) {
    throw new ScriptError(message_str, {
      line_int: this.line_int,
      column_int: this.column_int,
      source_str: this.source_str,
    });
  }

  /** Append a token at the current position. */
  #push(kind_str, value_any, extra_obj = {}) {
    this.tokens_list.push({
      kind_str,
      value_any,
      line_int: this.line_int,
      column_int: this.column_int,
      ...extra_obj,
    });
  }

  /**
   * Scan the entire source into tokens.
   *
   * Arguments:
   *   (none)
   *
   * Returns:
   *   (Object[]): The token list, ending with an end-of-input token.
   */
  scanAll() {
    while (this.cursor_int < this.source_str.length) {
      this.#scanNext();
    }
    this.#push(TOKEN_KINDS_DICT.END_OF_INPUT, null);
    return this.tokens_list;
  }

  /** Dispatch on the next character and consume one token's worth. */
  #scanNext() {
    const character_str = this.source_str[this.cursor_int];

    if (this.#consumeWhitespaceOrSeparator(character_str)) {
      return;
    }
    if (this.#consumeComment(character_str)) {
      return;
    }
    if (this.#consumePunctuation(character_str)) {
      return;
    }
    if (character_str === '"' || character_str === "'") {
      this.#consumeString(character_str);
      return;
    }
    if (this.#looksLikeNumber(character_str)) {
      this.#consumeNumber();
      return;
    }
    if (IDENTIFIER_START_PATTERN.test(character_str)) {
      this.#consumeIdentifier();
      return;
    }

    this.#fail(`Unexpected character '${character_str}'`);
  }

  /** Consume whitespace, newlines and semicolons. */
  #consumeWhitespaceOrSeparator(character_str) {
    if (character_str === '\n') {
      this.#push(TOKEN_KINDS_DICT.SEPARATOR, '\n');
      this.cursor_int += 1;
      this.line_int += 1;
      this.line_start_int = this.cursor_int;
      return true;
    }
    if (character_str === ' ' || character_str === '\t' ||
        character_str === '\r') {
      this.cursor_int += 1;
      return true;
    }
    if (character_str === ';') {
      this.#push(TOKEN_KINDS_DICT.SEPARATOR, ';');
      this.cursor_int += 1;
      return true;
    }
    return false;
  }

  /** Consume a line or block comment. */
  #consumeComment(character_str) {
    const next_str = this.source_str[this.cursor_int + 1] ?? '';

    const is_hash_comment_bool =
      character_str === '#' && !IDENTIFIER_START_PATTERN.test(next_str);
    if (is_hash_comment_bool || (character_str === '/' && next_str === '/')) {
      while (
        this.cursor_int < this.source_str.length &&
        this.source_str[this.cursor_int] !== '\n'
      ) {
        this.cursor_int += 1;
      }
      return true;
    }

    if (character_str === '/' && next_str === '*') {
      this.#consumeBlockComment();
      return true;
    }
    return false;
  }

  /** Consume a block comment, counting any newlines inside it. */
  #consumeBlockComment() {
    this.cursor_int += 2;

    while (this.cursor_int < this.source_str.length) {
      const is_end_bool =
        this.source_str[this.cursor_int] === '*' &&
        this.source_str[this.cursor_int + 1] === '/';
      if (is_end_bool) {
        this.cursor_int += 2;
        return;
      }
      if (this.source_str[this.cursor_int] === '\n') {
        this.line_int += 1;
        this.line_start_int = this.cursor_int + 1;
      }
      this.cursor_int += 1;
    }
    this.#fail('Unterminated block comment');
  }

  /** Consume a single punctuation token. */
  #consumePunctuation(character_str) {
    const kinds_by_character_dict = {
      '(': TOKEN_KINDS_DICT.OPEN_PAREN,
      ')': TOKEN_KINDS_DICT.CLOSE_PAREN,
      '[': TOKEN_KINDS_DICT.OPEN_BRACKET,
      ']': TOKEN_KINDS_DICT.CLOSE_BRACKET,
      ',': TOKEN_KINDS_DICT.COMMA,
    };

    const kind_str = kinds_by_character_dict[character_str];
    if (!kind_str) {
      return false;
    }
    this.#push(kind_str, character_str);
    this.cursor_int += 1;
    return true;
  }

  /** Consume a quoted string, resolving simple escapes. */
  #consumeString(quote_str) {
    const start_column_int = this.column_int;
    this.cursor_int += 1;
    let value_str = '';

    while (
      this.cursor_int < this.source_str.length &&
      this.source_str[this.cursor_int] !== quote_str
    ) {
      if (this.source_str[this.cursor_int] === '\\') {
        value_str += this.#readEscape();
        continue;
      }
      if (this.source_str[this.cursor_int] === '\n') {
        this.#fail('Unterminated string');
      }
      value_str += this.source_str[this.cursor_int];
      this.cursor_int += 1;
    }

    if (this.cursor_int >= this.source_str.length) {
      this.#fail('Unterminated string');
    }
    this.cursor_int += 1;

    this.tokens_list.push({
      kind_str: TOKEN_KINDS_DICT.STRING,
      value_any: value_str,
      line_int: this.line_int,
      column_int: start_column_int,
    });
  }

  /** Read one backslash escape sequence. */
  #readEscape() {
    const escaped_str = this.source_str[this.cursor_int + 1];
    this.cursor_int += 2;

    if (escaped_str === 'n') {
      return '\n';
    }
    if (escaped_str === 't') {
      return '\t';
    }
    return escaped_str ?? '';
  }

  /** Report whether the current position begins a numeric literal. */
  #looksLikeNumber(character_str) {
    const next_str = this.source_str[this.cursor_int + 1] ?? '';
    const is_digit_bool = character_str >= '0' && character_str <= '9';
    const is_leading_dot_bool =
      character_str === '.' && next_str >= '0' && next_str <= '9';
    const is_signed_bool =
      (character_str === '-' || character_str === '+') &&
      ((next_str >= '0' && next_str <= '9') || next_str === '.');

    return is_digit_bool || is_leading_dot_bool || is_signed_bool;
  }

  /** Consume a numeric literal and any unit suffix it carries. */
  #consumeNumber() {
    const start_column_int = this.column_int;
    const start_int = this.cursor_int;
    let scan_int = this.#scanNumericBody(this.cursor_int);

    const raw_number_float = Number(
      this.source_str.slice(start_int, scan_int)
    );
    if (!Number.isFinite(raw_number_float)) {
      this.cursor_int = scan_int;
      this.#fail('Malformed number');
    }

    const { unit_str, next_int } = this.#scanUnitSuffix(scan_int);
    this.cursor_int = next_int;

    const unit_obj = unit_str ? UNIT_SUFFIXES_DICT[unit_str] : null;
    this.tokens_list.push({
      kind_str: TOKEN_KINDS_DICT.NUMBER,
      value_any: unit_obj
        ? raw_number_float * unit_obj.scale_float
        : raw_number_float,
      raw_float: raw_number_float,
      unit_str: unit_str || null,
      unit_kind_str: unit_obj?.kind_str ?? null,
      line_int: this.line_int,
      column_int: start_column_int,
    });
  }

  /** Advance past sign, digits, fraction and exponent. */
  #scanNumericBody(from_int) {
    const source_str = this.source_str;
    let scan_int = from_int;
    const isDigit_fn = (index_int) =>
      source_str[index_int] >= '0' && source_str[index_int] <= '9';

    if (source_str[scan_int] === '-' || source_str[scan_int] === '+') {
      scan_int += 1;
    }
    while (scan_int < source_str.length && isDigit_fn(scan_int)) {
      scan_int += 1;
    }
    if (source_str[scan_int] === '.') {
      scan_int += 1;
      while (scan_int < source_str.length && isDigit_fn(scan_int)) {
        scan_int += 1;
      }
    }

    const is_exponent_bool =
      source_str[scan_int] === 'e' || source_str[scan_int] === 'E';
    if (is_exponent_bool) {
      let exponent_int = scan_int + 1;
      if (
        source_str[exponent_int] === '-' ||
        source_str[exponent_int] === '+'
      ) {
        exponent_int += 1;
      }
      if (isDigit_fn(exponent_int)) {
        scan_int = exponent_int;
        while (scan_int < source_str.length && isDigit_fn(scan_int)) {
          scan_int += 1;
        }
      }
    }
    return scan_int;
  }

  /** Read a recognised unit suffix, if one follows the number. */
  #scanUnitSuffix(from_int) {
    if (this.source_str[from_int] === '%') {
      return { unit_str: '%', next_int: from_int + 1 };
    }

    let scan_int = from_int;
    while (
      scan_int < this.source_str.length &&
      LETTER_PATTERN.test(this.source_str[scan_int])
    ) {
      scan_int += 1;
    }

    const candidate_str = this.source_str
      .slice(from_int, scan_int)
      .toLowerCase();
    if (candidate_str && UNIT_SUFFIXES_DICT[candidate_str]) {
      return { unit_str: candidate_str, next_int: scan_int };
    }
    return { unit_str: '', next_int: from_int };
  }

  /** Consume a bare word or command name. */
  #consumeIdentifier() {
    const start_column_int = this.column_int;
    const start_int = this.cursor_int;

    while (
      this.cursor_int < this.source_str.length &&
      IDENTIFIER_PART_PATTERN.test(this.source_str[this.cursor_int])
    ) {
      this.cursor_int += 1;
    }

    this.tokens_list.push({
      kind_str: TOKEN_KINDS_DICT.IDENTIFIER,
      value_any: this.source_str.slice(start_int, this.cursor_int),
      line_int: this.line_int,
      column_int: start_column_int,
    });
  }
}
