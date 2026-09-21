/**
 * The one DOM lookup helper the application layer shares.
 *
 * Brief:
 *   Every panel needs it, and each defining its own copy is how two of them
 *   end up subtly different.
 */

/**
 * Find an element by id.
 *
 * Brief:
 *   check_wiring.py reads these call sites to prove every id referenced in
 *   code exists in index.html, so the argument must stay a literal. Passing
 *   a variable here makes that check unprovable.
 *
 * Arguments:
 *   element_id_str (string): The id, written as a literal at the call site.
 *
 * Returns:
 *   (HTMLElement|null): The element, or null when it is absent.
 */
export function findElement(element_id_str) {
  return document.getElementById(element_id_str);
}
