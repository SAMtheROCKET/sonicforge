/**
 * Inline SVG icon set.
 *
 * Brief:
 *   Icons are stroke paths on a 24x24 grid, rendered inline rather than
 *   loaded as a font or a sprite sheet. An icon font would be a network
 *   request, and SonicForge must render completely with zero network
 *   access.
 */

/* ---------------------------------------------------------------------------
 * Constants
 * ------------------------------------------------------------------------ */

/** Path data for every icon, keyed by name, on a 24x24 grid. */
export const ICON_PATHS_OBJ = Object.freeze({
  wave: 'M2 12h3c1 0 1.5-7 3-7s2 14 3 14 1.5-7 3-7h2c1 0 1.5-4 3-4s2 8 3 8',
  power: 'M12 3v9M6.3 6.3a8.5 8.5 0 1 0 11.4 0',
  play: 'M6 4l14 8-14 8z',
  stop: 'M6 6h12v12H6z',
  sliders: 'M4 7h10M18 7h2M4 17h4M12 17h8M15 4v6M8 14v6',
  layers: 'M12 3l9 5-9 5-9-5 9-5zM3 14l9 5 9-5',
  mic: 'M12 3a3 3 0 0 1 3 3v6a3 3 0 0 1-6 0V6a3 3 0 0 1 3-3z' +
    'M5 11a7 7 0 0 0 14 0M12 18v3',
  terminal: 'M5 7l4 4-4 4M12 15h7',
  cube: 'M12 2l9 5v10l-9 5-9-5V7l9-5zM12 12l9-5M12 12v10M12 12L3 7',
  droplet: 'M12 3s6 6.5 6 10.5a6 6 0 0 1-12 0C6 9.5 12 3 12 3z',
  headphones: 'M4 15v-3a8 8 0 0 1 16 0v3' +
    'M4 14h3v6H5a1 1 0 0 1-1-1v-5zM20 14h-3v6h2a1 1 0 0 0 1-1v-5z',
  shield: 'M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6l8-3z',
  flask: 'M9 3v6L4 19a1.6 1.6 0 0 0 1.4 2h13.2A1.6 1.6 0 0 0 20 19' +
    'l-5-10V3M8 3h8M7.5 14h9',
  phone: 'M4 5c0-1 1-2 2-2h2l2 4-2 2a12 12 0 0 0 5 5l2-2 4 2v2' +
    'c0 1-1 2-2 2A16 16 0 0 1 4 5z',
  activity: 'M2 12h4l3-8 4 16 3-8h6',
  users: 'M16 19v-1a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v1' +
    'M9 7a3 3 0 1 0 0 6 3 3 0 0 0 0-6zM21 19v-1a4 4 0 0 0-3-3.8' +
    'M16 4.2a4 4 0 0 1 0 7.6',
  link: 'M9.5 14.5a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1.2 1.2' +
    'M14.5 9.5a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1.2-1.2',
  refresh: 'M21 12a9 9 0 1 1-2.6-6.4M21 4v5h-5',
  check: 'M4 12.5l5 5L20 6.5',
  x: 'M6 6l12 12M18 6L6 18',
  alert: 'M12 8v5M12 17h.01M10.3 3.9L2.5 17.4A2 2 0 0 0 4.2 20.4h15.6' +
    'a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z',
  info: 'M12 16v-5M12 8h.01M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18z',
  download: 'M12 3v12M7 11l5 5 5-5M4 20h16',
  upload: 'M12 21V9M7 13l5-5 5 5M4 4h16',
  tune: 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zM12 8v4l3 2',
  ruler: 'M3 9l6-6 12 12-6 6L3 9zM7.5 7.5l2 2M10.5 4.5l2 2M4.5 10.5l2 2',
  bolt: 'M13 2L4 14h6l-1 8 9-12h-6l1-8z',
  eye: 'M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7-10-7-10-7z' +
    'M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z',
  grid: 'M4 4h7v7H4zM13 4h7v7h-7zM4 13h7v7H4zM13 13h7v7h-7z',
  plus: 'M12 5v14M5 12h14',
  chevron: 'M9 6l6 6-6 6',
  menu: 'M4 7h16M4 12h16M4 17h16',
  copy: 'M9 9h10v10H9zM5 15H4V4h11v1',
  trash: 'M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3',
});

/** Rendered size, in pixels, when the caller does not specify one. */
const DEFAULT_ICON_SIZE_PX_INT = 16;

/** Stroke weight, chosen to sit correctly against the interface type. */
const ICON_STROKE_WIDTH_STR = '1.7';

/* ------------------------------------------------------------------------ */

/**
 * Build the markup for one inline SVG icon.
 *
 * Brief:
 *   Returns a string rather than an element because every caller is
 *   assembling a larger innerHTML block, and handing back a node would only
 *   force them to serialise it again.
 *
 * Arguments:
 *   icon_name_str (string): Key into ICON_PATHS_OBJ.
 *   options_obj (Object): { size_px_int, class_name_str, is_filled_bool }.
 *
 * Returns:
 *   (string): SVG markup, or an empty string for an unknown name.
 *
 * Warning:
 *   The output is inserted as HTML. Every value it interpolates is either a
 *   number or author-controlled, never user input.
 */
export function renderIconSvg(icon_name_str, options_obj = {}) {
  const {
    size_px_int = DEFAULT_ICON_SIZE_PX_INT,
    class_name_str = '',
    is_filled_bool = false,
  } = options_obj;

  const path_data_str = ICON_PATHS_OBJ[icon_name_str];
  if (!path_data_str) {
    return '';
  }

  const fill_str = is_filled_bool ? 'currentColor' : 'none';
  const stroke_str = is_filled_bool ? 'none' : 'currentColor';

  return `<svg viewBox="0 0 24 24" width="${size_px_int}" ` +
    `height="${size_px_int}" class="${class_name_str}" aria-hidden="true" ` +
    `fill="${fill_str}" stroke="${stroke_str}" ` +
    `stroke-width="${ICON_STROKE_WIDTH_STR}" stroke-linecap="round" ` +
    `stroke-linejoin="round"><path d="${path_data_str}"/></svg>`;
}
