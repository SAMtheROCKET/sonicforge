/**
 * Pairing-code encoding for the serverless WebRTC tier.
 *
 * Brief:
 *   With no signalling server, the offer and answer have to travel by
 *   whatever channel the two people already share - a message, an email, a
 *   read-aloud string. Raw SDP is multi-line, full of characters that get
 *   mangled in transit, and impossible to tell apart from noise. Packing it
 *   into one prefixed base64 token makes it paste-safe and makes a wrong
 *   paste identifiable rather than merely broken.
 */

/* ---------------------------------------------------------------------------
 * Constants
 * ------------------------------------------------------------------------ */

/** Prefix identifying a SonicForge pairing code, and its format version. */
const SIGNAL_PREFIX_STR = 'SF1:';

/** Base64 pads to a multiple of this many characters. */
const BASE64_BLOCK_INT = 4;

/** Trailing padding, stripped on encode and restored on decode. */
const TRAILING_PADDING_REGEX = /=+$/;

/** Whitespace a pasted code may have picked up in transit. */
const WHITESPACE_REGEX = /\s+/g;

/* ------------------------------------------------------------------------ */

/**
 * Pack a signalling blob into a compact, paste-safe string.
 *
 * Brief:
 *   Padding is stripped so the code survives being pasted into places that
 *   treat a trailing '=' as punctuation; decode restores it.
 *
 * Arguments:
 *   signal_obj (Object): { room_code_str, from_str, sdp }.
 *
 * Returns:
 *   (string): The prefixed, base64-encoded code.
 */
export function encodeSignal(signal_obj) {
  const json_str = JSON.stringify(signal_obj);
  const bytes_uint8array = new TextEncoder().encode(json_str);

  let binary_str = '';
  for (const byte_int of bytes_uint8array) {
    binary_str += String.fromCharCode(byte_int);
  }
  const base64_str = btoa(binary_str).replace(TRAILING_PADDING_REGEX, '');
  return `${SIGNAL_PREFIX_STR}${base64_str}`;
}

/**
 * Unpack a pairing code back into its signalling blob.
 *
 * Brief:
 *   Whitespace is stripped and padding restored, because a code that has
 *   been through a chat client or an email quote rarely arrives byte-exact.
 *
 * Arguments:
 *   code_str (string): A code produced by encodeSignal.
 *
 * Returns:
 *   (Object): The decoded signalling blob.
 *
 * Warning:
 *   Throws when the prefix is missing, which is the common case of someone
 *   pasting the wrong thing. The message says so rather than surfacing a
 *   base64 or JSON error the viewer cannot act on.
 */
export function decodeSignal(code_str) {
  const trimmed_str = String(code_str).trim();
  if (!trimmed_str.startsWith(SIGNAL_PREFIX_STR)) {
    throw new Error('That is not a SonicForge pairing code.');
  }

  const base64_str = trimmed_str
    .slice(SIGNAL_PREFIX_STR.length)
    .replace(WHITESPACE_REGEX, '');
  const padding_length_int =
    (BASE64_BLOCK_INT - (base64_str.length % BASE64_BLOCK_INT)) %
    BASE64_BLOCK_INT;

  const binary_str = atob(base64_str + '='.repeat(padding_length_int));
  const bytes_uint8array = Uint8Array.from(
    binary_str, (character_str) => character_str.charCodeAt(0)
  );
  return JSON.parse(new TextDecoder().decode(bytes_uint8array));
}
