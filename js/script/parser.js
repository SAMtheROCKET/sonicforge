/**
 * Parser for the SonicForge command language.
 *
 * Brief:
 *   Produces a small tree of call and loop nodes, which the virtual machine
 *   flattens into a linear instruction list. Two surface syntaxes are
 *   accepted and produce identical trees:
 *
 *     native: loop(3, [ play(440hz, 200ms), wait(100ms) ])
 *     JSON:   [{"loop":3,"body":[["play",440,200],["wait",100]]}]
 *
 *   The JSON form exists because presets, Concert Mode broadcasts, and
 *   anything generated programmatically are far safer to build as data than
 *   by string concatenation.
 */

import { tokenize, TOKEN_KINDS_DICT, ScriptError } from './lexer.js';

/* ---------------------------------------------------------------------------
 * Constants
 * ------------------------------------------------------------------------ */

/** Command names that introduce a repeated block. */
export const LOOP_COMMAND_NAMES_LIST = Object.freeze(['loop', 'repeat']);

/** Node kinds the virtual machine understands. */
export const NODE_KINDS_DICT = Object.freeze({
  PROGRAM: 'program',
  CALL: 'call',
  LOOP: 'loop',
  NUMBER: 'number',
  STRING: 'string',
  WORD: 'word',
  BLOCK: 'block',
});

/** Keys a JSON entry may use to name its command. */
const JSON_COMMAND_KEYS_LIST = Object.freeze([
  'cmd', 'command', 'op', 'name',
]);

/** Keys a JSON loop entry may use to hold its body. */
const JSON_BODY_KEYS_LIST = Object.freeze(['body', 'commands', 'do']);

/** Matches a bare numeric string, with or without a unit suffix. */
const NUMERIC_STRING_PATTERN =
  /^\s*([-+]?\d*\.?\d+(?:[eE][-+]?\d+)?)\s*([A-Za-z%]*)\s*$/;

/* ------------------------------------------------------------------------ */

/**
 * Parse a script in either surface syntax into a program tree.
 *
 * Brief:
 *   The single entry point for every script the application runs, whether
 *   typed by a user, stored in a preset, or received from a peer.
 *
 * Arguments:
 *   source_any (string|Array|Object): Script text, or a JSON structure.
 *
 * Returns:
 *   (Object): A program node with a body_list of call and loop nodes.
 *
 * Warning:
 *   Throws ScriptError, carrying a line and column for the native syntax.
 *   Text beginning with a bracket is tried as JSON first and falls through
 *   to the native parser, which reports a far more useful position.
 */
export function parse(source_any) {
  const is_structured_bool =
    Array.isArray(source_any) ||
    (source_any && typeof source_any === 'object');

  if (is_structured_bool) {
    return {
      kind_str: NODE_KINDS_DICT.PROGRAM,
      body_list: parseJsonStatements(source_any),
    };
  }

  const text_str = String(source_any ?? '').trim();
  if (!text_str) {
    return { kind_str: NODE_KINDS_DICT.PROGRAM, body_list: [] };
  }

  if (text_str.startsWith('[') || text_str.startsWith('{')) {
    const parsed_obj = tryParseJson(text_str);
    if (parsed_obj) {
      return parsed_obj;
    }
  }

  return new StatementParser(tokenize(text_str), text_str).parseProgram();
}

/**
 * Attempt to read the text as JSON, returning null if it is not.
 *
 * Arguments:
 *   text_str (string): Candidate JSON text.
 *
 * Returns:
 *   (Object): A program node, or null when the text is not valid JSON.
 */
function tryParseJson(text_str) {
  try {
    return {
      kind_str: NODE_KINDS_DICT.PROGRAM,
      body_list: parseJsonStatements(JSON.parse(text_str)),
    };
  } catch (error_obj) {
    if (error_obj instanceof ScriptError) {
      throw error_obj;
    }
    return null;
  }
}

/* ------------------------------------------------------------------------ */

/**
 * Build call and loop nodes from a token stream.
 *
 * Arguments:
 *   tokens_list (Object[]): Tokens from the lexer.
 *   source_str (string): Original text, for error rendering.
 *
 * Returns:
 *   (StatementParser): A parser positioned at the first token.
 */
class StatementParser {
  constructor(tokens_list, source_str) {
    this.tokens_list = tokens_list;
    this.source_str = source_str;
    this.cursor_int = 0;
  }

  /** Look ahead without consuming. */
  #peek(offset_int = 0) {
    const index_int = Math.min(
      this.cursor_int + offset_int,
      this.tokens_list.length - 1
    );
    return this.tokens_list[index_int];
  }

  /** Consume and return the current token. */
  #next() {
    const token_obj = this.tokens_list[this.cursor_int];
    this.cursor_int += 1;
    return token_obj;
  }

  /** Report whether the current token is of a kind. */
  #isAt(kind_str) {
    return this.#peek().kind_str === kind_str;
  }

  /** Consume a token of the expected kind, or fail with a message. */
  #expect(kind_str, description_str) {
    const token_obj = this.#peek();
    if (token_obj.kind_str !== kind_str) {
      this.#fail(
        `Expected ${description_str ?? kind_str}, ` +
          `found ${describeToken(token_obj)}`,
        token_obj
      );
    }
    return this.#next();
  }

  /** Raise a located ScriptError. */
  #fail(message_str, token_obj = this.#peek()) {
    throw new ScriptError(message_str, {
      line_int: token_obj.line_int,
      column_int: token_obj.column_int,
      source_str: this.source_str,
    });
  }

  /** Consume any run of statement separators. */
  #skipSeparators() {
    while (this.#isAt(TOKEN_KINDS_DICT.SEPARATOR)) {
      this.#next();
    }
  }

  /**
   * Parse the whole token stream into a program node.
   *
   * Arguments:
   *   (none)
   *
   * Returns:
   *   (Object): A program node.
   */
  parseProgram() {
    const body_list = [];
    this.#skipSeparators();

    while (!this.#isAt(TOKEN_KINDS_DICT.END_OF_INPUT)) {
      body_list.push(this.#parseStatement());
      while (
        this.#isAt(TOKEN_KINDS_DICT.SEPARATOR) ||
        this.#isAt(TOKEN_KINDS_DICT.COMMA)
      ) {
        this.#next();
      }
    }
    return { kind_str: NODE_KINDS_DICT.PROGRAM, body_list };
  }

  /** Parse one command call, or a loop. */
  #parseStatement() {
    const name_token_obj = this.#peek();
    if (name_token_obj.kind_str !== TOKEN_KINDS_DICT.IDENTIFIER) {
      this.#fail(
        `Expected a command name, found ${describeToken(name_token_obj)}`,
        name_token_obj
      );
    }
    this.#next();

    const name_str = name_token_obj.value_any.toLowerCase();
    let arguments_list = [];

    if (this.#isAt(TOKEN_KINDS_DICT.OPEN_PAREN)) {
      this.#next();
      arguments_list = this.#parseArguments(TOKEN_KINDS_DICT.CLOSE_PAREN);
      this.#expect(TOKEN_KINDS_DICT.CLOSE_PAREN, "')'");
    }

    if (LOOP_COMMAND_NAMES_LIST.includes(name_str)) {
      return this.#buildLoopNode(name_str, arguments_list, name_token_obj);
    }

    return {
      kind_str: NODE_KINDS_DICT.CALL,
      name_str,
      arguments_list,
      line_int: name_token_obj.line_int,
      column_int: name_token_obj.column_int,
    };
  }

  /** Parse a comma-separated argument list up to a closing token. */
  #parseArguments(closing_kind_str) {
    const arguments_list = [];
    this.#skipSeparators();

    while (
      !this.#isAt(closing_kind_str) &&
      !this.#isAt(TOKEN_KINDS_DICT.END_OF_INPUT)
    ) {
      arguments_list.push(this.#parseArgument());
      this.#skipSeparators();

      if (!this.#isAt(TOKEN_KINDS_DICT.COMMA)) {
        break;
      }
      this.#next();
      this.#skipSeparators();
    }

    this.#skipSeparators();
    return arguments_list;
  }

  /** Parse one argument: a literal, a bare word, or a bracketed block. */
  #parseArgument() {
    const token_obj = this.#peek();

    if (token_obj.kind_str === TOKEN_KINDS_DICT.NUMBER) {
      this.#next();
      return {
        kind_str: NODE_KINDS_DICT.NUMBER,
        value_any: token_obj.value_any,
        raw_float: token_obj.raw_float,
        unit_str: token_obj.unit_str,
        unit_kind_str: token_obj.unit_kind_str,
      };
    }

    if (token_obj.kind_str === TOKEN_KINDS_DICT.STRING) {
      this.#next();
      return {
        kind_str: NODE_KINDS_DICT.STRING,
        value_any: token_obj.value_any,
      };
    }

    if (token_obj.kind_str === TOKEN_KINDS_DICT.OPEN_BRACKET) {
      return this.#parseBlock();
    }

    if (token_obj.kind_str === TOKEN_KINDS_DICT.IDENTIFIER) {
      return this.#parseIdentifierArgument(token_obj);
    }

    return this.#fail(
      `Unexpected ${describeToken(token_obj)} in argument list`,
      token_obj
    );
  }

  /** Parse a bracketed list of statements. */
  #parseBlock() {
    this.#next();
    const body_list = [];
    this.#skipSeparators();

    while (
      !this.#isAt(TOKEN_KINDS_DICT.CLOSE_BRACKET) &&
      !this.#isAt(TOKEN_KINDS_DICT.END_OF_INPUT)
    ) {
      body_list.push(this.#parseStatement());
      this.#skipSeparators();
      if (this.#isAt(TOKEN_KINDS_DICT.COMMA)) {
        this.#next();
        this.#skipSeparators();
      }
    }

    this.#expect(TOKEN_KINDS_DICT.CLOSE_BRACKET, "']'");
    return { kind_str: NODE_KINDS_DICT.BLOCK, body_list };
  }

  /** A bare word is either a nested call or a symbolic value. */
  #parseIdentifierArgument(token_obj) {
    const is_nested_call_bool =
      this.#peek(1).kind_str === TOKEN_KINDS_DICT.OPEN_PAREN;

    if (is_nested_call_bool) {
      return {
        kind_str: NODE_KINDS_DICT.BLOCK,
        body_list: [this.#parseStatement()],
      };
    }

    this.#next();
    return {
      kind_str: NODE_KINDS_DICT.WORD,
      value_any: token_obj.value_any.toLowerCase(),
    };
  }

  /**
   * Assemble a loop node from a count and one or more blocks.
   *
   * Arguments:
   *   name_str (string): The loop command used.
   *   arguments_list (Object[]): Parsed arguments.
   *   token_obj (Object): Token to blame in any error.
   *
   * Returns:
   *   (Object): A loop node.
   */
  #buildLoopNode(name_str, arguments_list, token_obj) {
    if (!arguments_list.length) {
      this.#fail(`${name_str}() needs a repeat count`, token_obj);
    }

    const count_argument_obj = arguments_list[0];
    if (count_argument_obj.kind_str !== NODE_KINDS_DICT.NUMBER) {
      this.#fail(`${name_str}() repeat count must be a number`, token_obj);
    }

    const body_list = [];
    for (
      let index_int = 1;
      index_int < arguments_list.length;
      index_int += 1
    ) {
      const argument_obj = arguments_list[index_int];
      if (argument_obj.kind_str !== NODE_KINDS_DICT.BLOCK) {
        this.#fail(
          `${name_str}() expects commands after the count`,
          token_obj
        );
      }
      body_list.push(...argument_obj.body_list);
    }

    if (!body_list.length) {
      this.#fail(`${name_str}() body is empty`, token_obj);
    }

    return {
      kind_str: NODE_KINDS_DICT.LOOP,
      repeat_count_int: Math.max(0, Math.round(count_argument_obj.value_any)),
      body_list,
      line_int: token_obj.line_int,
      column_int: token_obj.column_int,
    };
  }
}

/**
 * Describe a token in prose, for error messages.
 *
 * Arguments:
 *   token_obj (Object): Token to describe.
 *
 * Returns:
 *   (string): A human-readable description.
 */
function describeToken(token_obj) {
  if (token_obj.kind_str === TOKEN_KINDS_DICT.END_OF_INPUT) {
    return 'end of script';
  }
  if (token_obj.kind_str === TOKEN_KINDS_DICT.SEPARATOR) {
    return 'end of line';
  }
  if (token_obj.kind_str === TOKEN_KINDS_DICT.NUMBER) {
    return `number ${token_obj.raw_float ?? token_obj.value_any}`;
  }
  if (token_obj.kind_str === TOKEN_KINDS_DICT.STRING) {
    return `string "${token_obj.value_any}"`;
  }
  return `'${token_obj.value_any}'`;
}

/* ------------------------------------------------------------------------ */

/**
 * Convert one raw JSON value into an argument node.
 *
 * Brief:
 *   Strings that look like unit-suffixed numbers are run through the lexer,
 *   so "1.5khz" in JSON means exactly what 1.5khz means in the native
 *   syntax.
 *
 * Arguments:
 *   value_any (*): Raw value from a JSON structure.
 *
 * Returns:
 *   (Object): An argument node.
 */
function convertJsonArgument(value_any) {
  if (typeof value_any === 'number') {
    return {
      kind_str: NODE_KINDS_DICT.NUMBER,
      value_any,
      raw_float: value_any,
      unit_str: null,
      unit_kind_str: null,
    };
  }

  if (typeof value_any === 'boolean') {
    return {
      kind_str: NODE_KINDS_DICT.WORD,
      value_any: value_any ? 'on' : 'off',
    };
  }

  if (typeof value_any === 'string') {
    return convertJsonString(value_any);
  }

  if (Array.isArray(value_any)) {
    return {
      kind_str: NODE_KINDS_DICT.BLOCK,
      body_list: parseJsonStatements(value_any),
    };
  }

  if (value_any && typeof value_any === 'object') {
    return {
      kind_str: NODE_KINDS_DICT.BLOCK,
      body_list: parseJsonStatements([value_any]),
    };
  }

  return { kind_str: NODE_KINDS_DICT.STRING, value_any: String(value_any) };
}

/** Convert a JSON string, resolving a unit suffix where one is present. */
function convertJsonString(value_str) {
  if (NUMERIC_STRING_PATTERN.test(value_str)) {
    const tokens_list = tokenize(value_str.trim());
    const is_single_number_bool =
      tokens_list.length === 2 &&
      tokens_list[0].kind_str === TOKEN_KINDS_DICT.NUMBER;

    if (is_single_number_bool) {
      const token_obj = tokens_list[0];
      return {
        kind_str: NODE_KINDS_DICT.NUMBER,
        value_any: token_obj.value_any,
        raw_float: token_obj.raw_float,
        unit_str: token_obj.unit_str,
        unit_kind_str: token_obj.unit_kind_str,
      };
    }
  }
  return { kind_str: NODE_KINDS_DICT.STRING, value_any: value_str };
}

/**
 * Convert one JSON entry into a call or loop node.
 *
 * Arguments:
 *   entry_any (*): Array form, object form, or single-key object.
 *   index_int (number): Position in the list, for error messages.
 *
 * Returns:
 *   (Object): A call or loop node.
 *
 * Warning:
 *   Throws ScriptError for an entry that cannot be interpreted, naming its
 *   index so the author can find it.
 */
function convertJsonStatement(entry_any, index_int) {
  if (Array.isArray(entry_any)) {
    return convertJsonArrayStatement(entry_any, index_int);
  }

  if (entry_any && typeof entry_any === 'object') {
    const node_obj = convertJsonObjectStatement(entry_any);
    if (node_obj) {
      return node_obj;
    }
  }

  throw new ScriptError(
    `Entry ${index_int}: cannot interpret ` +
      `${JSON.stringify(entry_any)?.slice(0, 60)}`
  );
}

/** Convert the ["play", 440, 1000] array form. */
function convertJsonArrayStatement(entry_list, index_int) {
  const [name_any, ...rest_list] = entry_list;
  if (typeof name_any !== 'string') {
    throw new ScriptError(
      `Entry ${index_int}: first element must be a command name`
    );
  }

  const name_str = name_any.toLowerCase();
  if (LOOP_COMMAND_NAMES_LIST.includes(name_str)) {
    return {
      kind_str: NODE_KINDS_DICT.LOOP,
      repeat_count_int: Math.max(0, Math.round(Number(rest_list[0]) || 0)),
      body_list: parseJsonStatements(rest_list.slice(1).flat()),
      line_int: 0,
      column_int: 0,
    };
  }

  return {
    kind_str: NODE_KINDS_DICT.CALL,
    name_str,
    arguments_list: rest_list.map(convertJsonArgument),
    line_int: 0,
    column_int: 0,
  };
}

/** Convert the {"cmd": …} and {"loop": …} object forms. */
function convertJsonObjectStatement(entry_obj) {
  const loop_node_obj = convertJsonLoopObject(entry_obj);
  if (loop_node_obj) {
    return loop_node_obj;
  }

  const name_any = JSON_COMMAND_KEYS_LIST.map(
    (key_str) => entry_obj[key_str]
  ).find((candidate_any) => typeof candidate_any === 'string');

  if (typeof name_any === 'string') {
    const raw_arguments_any =
      entry_obj.args ?? entry_obj.params ?? entry_obj.arguments ?? [];
    return buildJsonCallNode(name_any, raw_arguments_any);
  }

  const keys_list = Object.keys(entry_obj);
  if (keys_list.length === 1) {
    return buildJsonCallNode(keys_list[0], entry_obj[keys_list[0]]);
  }
  return null;
}

/**
 * Convert a JSON object that names a loop, if it does.
 *
 * Arguments:
 *   entry_obj (Object): Candidate entry.
 *
 * Returns:
 *   (Object): A loop node, or null when the entry is not a loop.
 */
function convertJsonLoopObject(entry_obj) {
  const loop_key_str = LOOP_COMMAND_NAMES_LIST.find(
    (key_str) => key_str in entry_obj
  );
  if (!loop_key_str) {
    return null;
  }

  const body_any =
    JSON_BODY_KEYS_LIST.map((key_str) => entry_obj[key_str]).find(
      (candidate_any) => candidate_any !== undefined
    ) ?? [];

  return {
    kind_str: NODE_KINDS_DICT.LOOP,
    repeat_count_int: Math.max(
      0,
      Math.round(Number(entry_obj[loop_key_str]) || 0)
    ),
    body_list: parseJsonStatements(body_any),
    line_int: 0,
    column_int: 0,
  };
}

/**
 * Assemble a call node from a command name and its raw arguments.
 *
 * Arguments:
 *   name_str (string): Command name, in any case.
 *   raw_arguments_any (*): An argument array, or a single argument.
 *
 * Returns:
 *   (Object): A call node.
 */
function buildJsonCallNode(name_str, raw_arguments_any) {
  const arguments_any_list = Array.isArray(raw_arguments_any)
    ? raw_arguments_any
    : [raw_arguments_any];

  return {
    kind_str: NODE_KINDS_DICT.CALL,
    name_str: name_str.toLowerCase(),
    arguments_list: arguments_any_list.map(convertJsonArgument),
    line_int: 0,
    column_int: 0,
  };
}

/**
 * Convert a list of JSON entries into statement nodes.
 *
 * Brief:
 *   Exported so the same conversion can be reused for nested blocks, which
 *   is what makes loops inside JSON scripts work.
 *
 * Arguments:
 *   entries_any (*): An array of entries, or a single entry.
 *
 * Returns:
 *   (Object[]): Call and loop nodes.
 */
export function parseJsonStatements(entries_any) {
  const entries_list = Array.isArray(entries_any)
    ? entries_any
    : [entries_any];
  return entries_list
    .filter((entry_any) => entry_any != null)
    .map(convertJsonStatement);
}

export { ScriptError };
