/**
 * The self-test harness.
 *
 * Brief:
 *   A deliberately small assertion library. The return contract is explicit
 *   because the loose version of check() treated every returned string as a
 *   pass, which silently marked a real layout violation green while printing
 *   its own failure message.
 */

/* ------------------------------------------------------------------------ */

/** Every check recorded so far, in the order they ran. */
export const CHECKS_LIST = [];

/** Anything the application logged as an error while we drove it. */
export const CONSOLE_ERRORS_LIST = [];

/**
 * Run one check and record the result.
 *
 * Brief:
 *   The accepted return values are exact: true or undefined pass, false or
 *   null fail, a string passes with that string as detail, and an object
 *   with an `ok` field says exactly what it means. Anything else is
 *   coerced, which is why verdict() exists.
 *
 * Arguments:
 *   name_str (string): What is being asserted.
 *   body_fn (Function): The check; may throw.
 *   options_obj (Object): { critical } marking a check as non-fatal.
 *
 * Returns:
 *   (boolean): Whether the check passed.
 */
export function check(name_str, body_fn, options_obj = {}) {
  const { critical = true } = options_obj;
  let is_ok_bool = false;
  let detail_str = '';

  try {
    const result_any = body_fn();
    if (result_any === true || result_any === undefined) {
      is_ok_bool = true;
    } else if (result_any === false || result_any === null) {
      is_ok_bool = false;
    } else if (typeof result_any === 'string') {
      is_ok_bool = true;
      detail_str = result_any;
    } else if (typeof result_any === 'object' && 'ok' in result_any) {
      is_ok_bool = Boolean(result_any.ok);
      detail_str = result_any.detail ?? '';
    } else {
      is_ok_bool = Boolean(result_any);
    }
  } catch (err) {
    is_ok_bool = false;
    detail_str = `${err.name}: ${err.message}`;
  }

  CHECKS_LIST.push({
    name: name_str, ok: is_ok_bool, detail: detail_str, critical,
  });
  return is_ok_bool;
}

/**
 * State a result and its supporting detail explicitly.
 *
 * Brief:
 *   Returning a bare string from a check is a pass, so a failing check must
 *   never report its reason that way. This is the shape to use whenever a
 *   check has something to say either way.
 *
 * Arguments:
 *   is_ok_bool (boolean): Whether the check passed.
 *   detail_str (string): Supporting detail, shown either way.
 *
 * Returns:
 *   (Object): The explicit result shape check() understands.
 */
export function verdict(is_ok_bool, detail_str) {
  return { ok: is_ok_bool, detail: detail_str };
}

/**
 * Record a check that was decided outside check().
 *
 * Brief:
 *   For a check whose result is only known after an await, which
 *   check() cannot express because it takes a synchronous body.
 *
 * Arguments:
 *   name_str (string): What was asserted.
 *   is_ok_bool (boolean): Whether it passed.
 *   detail_str (string): Supporting detail.
 *
 * Returns:
 *   (none)
 */
export function record(name_str, is_ok_bool, detail_str = '') {
  CHECKS_LIST.push({
    name: name_str, ok: is_ok_bool, detail: detail_str, critical: true,
  });
}

/**
 * Capture anything the application logs as an error while we drive it.
 *
 * Brief:
 *   Patches console.error and listens for uncaught errors and rejected
 *   promises, so a throw anywhere in the application lands in one list.
 *
 * Arguments:
 *   (none)
 *
 * Returns:
 *   (none)
 *
 * Warning:
 *   Errors thrown inside a requestAnimationFrame callback never reach a
 *   try/catch here, which is why the window listeners matter as much as the
 *   console patch.
 */
export function captureErrors() {
  const native_error_fn = console.error;

  console.error = (...arguments_list) => {
    CONSOLE_ERRORS_LIST.push(arguments_list
      .map((value_any) =>
        value_any instanceof Error ? value_any.message : String(value_any))
      .join(' '));
    native_error_fn.apply(console, arguments_list);
  };

  window.addEventListener('error', (error_event) =>
    CONSOLE_ERRORS_LIST.push(`uncaught: ${error_event.message}`)
  );
  window.addEventListener('unhandledrejection', (rejection_event) =>
    CONSOLE_ERRORS_LIST.push(
      'unhandled rejection: ' +
      `${rejection_event.reason?.message ?? rejection_event.reason}`
    )
  );
}

/**
 * Wait for a fixed delay.
 *
 * Brief:
 *   Used to let animation frames and deferred work actually happen
 *   before a check reads the result.
 *
 * Arguments:
 *   delay_ms_int (number): How long to wait.
 *
 * Returns:
 *   (Promise<void>)
 */
export function sleep(delay_ms_int) {
  return new Promise((resolve_fn) => setTimeout(resolve_fn, delay_ms_int));
}

/**
 * Build the report the runner posts back.
 *
 * Brief:
 *   The field names here are a contract with the development server
 *   and with CI, so they are written out rather than shorthand.
 *
 * Arguments:
 *   app_obj (Object): The application facade.
 *   elapsed_ms_int (number): How long the suite took.
 *
 * Returns:
 *   (Object): The report.
 */
export function buildReport(app_obj, elapsed_ms_int) {
  const failed_list = CHECKS_LIST.filter((check_obj) => !check_obj.ok);

  return {
    kind: 'app',
    done: true,
    pass: CHECKS_LIST.length - failed_list.length,
    fail: failed_list.length,
    ms: elapsed_ms_int,
    vizMode: app_obj.ui.waterfall?.render_mode_str,
    sampleRate: app_obj.engine.sampleRateHertz,
    // These key names are the report contract the dev server and CI read.
    // They are pinned explicitly rather than written as shorthand, so a
    // rename of the variable cannot silently rename the output field.
    consoleErrors: CONSOLE_ERRORS_LIST,
    checks: CHECKS_LIST.map((check_obj) => ({
      name: check_obj.name, ok: check_obj.ok, detail: check_obj.detail,
    })),
    failures: failed_list.map((check_obj) => ({
      test: check_obj.name,
      error: check_obj.detail || 'returned false',
    })),
  };
}
