/**
 * The suite's icons: a short set drawn on a 24-unit grid with a thick stroke
 * and round ends, like the glyphs of the product icons. They take the colour
 * of the text around them (`currentColor`) and its size from the CSS
 * (`.kit-icon`). Built node by node like everything else: no markup strings.
 */
const SVG = 'http://www.w3.org/2000/svg';

export const PATHS = Object.freeze({
  archive: 'M3 4h18v4H3zM5 8v12h14V8M10 12h4',
  back: 'M15 18l-6-6 6-6',
  bell: 'M6 16v-5a6 6 0 1 1 12 0v5l2 2H4zM10 21h4',
  bold: 'M6 12h9a4 4 0 0 1 0 8H7a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1h7a4 4 0 0 1 0 8',
  book: 'M4 19.5A2.5 2.5 0 0 1 6.5 17H20V3H6.5A2.5 2.5 0 0 0 4 5.5zM4 19.5A2.5 2.5 0 0 0 6.5 22H20v-5',
  box: 'M3 7l9-4 9 4v10l-9 4-9-4zM3 7l9 4 9-4M12 11v10',
  calendar: 'M4 5h16v16H4zM4 10h16M9 3v4M15 3v4',
  // Lucide's camera, its circle drawn as two arcs.
  camera: 'M14.5 4h-5L7 7H4a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2h-3zM9 13a3 3 0 1 0 6 0 3 3 0 1 0-6 0',
  card: 'M3 6h18v12H3zM3 10h18M7 15h3',
  check: 'M5 12.5l4.5 4.5L19 7',
  chevron: 'M9 18l6-6-6-6',
  'chevron-down': 'M6 9l6 6 6-6',
  clip: 'M20.5 11.5l-8.2 8.2a5 5 0 0 1-7-7l8.5-8.5a3.3 3.3 0 0 1 4.7 4.7l-8.4 8.4a1.7 1.7 0 0 1-2.4-2.4l7.6-7.6',
  clock: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM12 7v5l3 2',
  'code-xml': 'M18 16l4-4-4-4M6 8l-4 4 4 4M14.5 4l-5 16',
  copy: 'M9 9h11v11H9zM5 15H4V4h11v1',
  device: 'M3 5h18v11H3zM8 20h8M12 16v4',
  download: 'M12 4v11M7 10l5 5 5-5M5 20h14',
  edit: 'M4 20h4L19 9l-4-4L4 16zM13.5 6.5l4 4',
  external: 'M14 4h6v6M20 4l-9 9M18 14v6H4V6h6',
  filter: 'M4 5h16l-6 7.5V19l-4 2v-8.5z',
  folder: 'M3 6a1 1 0 0 1 1-1h5l2 2h9a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1z',
  globe: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18',
  grid: 'M4 4h6v6H4zM14 4h6v6h-6zM4 14h6v6H4zM14 14h6v6h-6z',
  heading: 'M6 12h12M6 20V4M18 20V4',
  'heading-1': 'M4 12h8M4 18V6M12 18V6M17 12l3-2v8',
  'heading-2': 'M4 12h8M4 18V6M12 18V6M21 18h-4c0-4 4-3 4-6 0-1.5-2-2.5-4-1',
  'heading-3': 'M4 12h8M4 18V6M12 18V6M17.5 10.5c1.7-1 3.5 0 3.5 1.5a2 2 0 0 1-2 2M17 17.5c2 1.5 4 .3 4-1.5a2 2 0 0 0-2-2',
  home: 'M4 11l8-7 8 7v9h-5v-6H9v6H4z',
  // Lucide's image: the frame (a rounded rect), the sun and the hill, in one path.
  image: 'M5 3h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2zM7 9a2 2 0 1 0 4 0 2 2 0 1 0-4 0M21 15l-3.1-3.1a2 2 0 0 0-2.8 0L6 21',
  inbox: 'M3 13h5l1 3h6l1-3h5M5 5h14l2 8v6H3v-6z',
  info: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM12 11v5M12 8h.01',
  italic: 'M19 4h-9M14 20H5M15 4L9 20',
  key: 'M14.5 13a5 5 0 1 0-4.6-3L3 17v4h4v-2h2v-2h2l2.1-2.1a5 5 0 0 0 1.4.1zM16.5 7.5h.01',
  link: 'M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71',
  list: 'M3 5h.01M3 12h.01M3 19h.01M8 5h13M8 12h13M8 19h13',
  'list-indent-decrease': 'M21 5H11M21 12H11M21 19H11M7 8l-4 4 4 4',
  'list-indent-increase': 'M21 5H11M21 12H11M21 19H11M3 8l4 4-4 4',
  'list-ordered': 'M11 5h10M11 12h10M11 19h10M4 4h1v5M4 9h2M6.5 20H3.4c0-1 2.6-1.925 2.6-3.5a1.5 1.5 0 0 0-2.6-1.02',
  'list-todo': 'M4 4h4a1 1 0 0 1 1 1v4a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1zM3 17l2 2 4-4M13 5h8M13 12h8M13 19h8',
  lock: 'M5 11h14v10H5zM8 11V7a4 4 0 0 1 8 0v4',
  logout: 'M15 4h4v16h-4M10 17l5-5-5-5M15 12H3',
  mail: 'M3 5h18v14H3zM3 6l9 7 9-7',
  menu: 'M4 6h16M4 12h16M4 18h16',
  minus: 'M5 12h14',
  moon: 'M20 14.5A8.5 8.5 0 1 1 9.5 4a7 7 0 0 0 10.5 10.5z',
  more: 'M5 12h.01M12 12h.01M19 12h.01',
  notes: 'M7 3h10a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2zM9 8h6M9 12h6M9 16h3',
  phone: 'M7 2h10v20H7zM11 18h2',
  pin: 'M12 16v6M8 3h8l-1.5 6L18 12.5V15H6v-2.5L9.5 9z',
  plus: 'M12 5v14M5 12h14',
  'redo-2': 'M15 14l5-5-5-5M20 9H9.5A5.5 5.5 0 0 0 4 14.5A5.5 5.5 0 0 0 9.5 20H13',
  refresh: 'M20 11a8 8 0 1 0-2.3 5.7M20 4v7h-7',
  search: 'M11 18a7 7 0 1 1 0-14 7 7 0 0 1 0 14zM20 20l-3.5-3.5',
  shield: 'M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6z',
  sliders: 'M4 6h9M17 6h3M4 12h3M11 12h9M4 18h11M19 18h1M15 4v4M9 10v4M17 16v4',
  sort: 'M7 4v16M3 16l4 4 4-4M17 20V4M13 8l4-4 4 4',
  spark: 'M12 3l2 5.5 5.5 2-5.5 2L12 18l-2-5.5-5.5-2 5.5-2z',
  star: 'M12 3l2.8 5.7 6.2.9-4.5 4.4 1.1 6.2L12 17.3 6.4 20.2l1.1-6.2L3 9.6l6.2-.9z',
  strikethrough: 'M16 4H9a3 3 0 0 0-2.83 4M14 12a4 4 0 0 1 0 8H6M4 12h16',
  sun: 'M12 16a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4',
  table: 'M5 3h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2zM12 3v18M3 9h18M3 15h18',
  tag: 'M3 12V4a1 1 0 0 1 1-1h8l9 9-9 9zM7.5 7.5h.01',
  trash: 'M3 6h18M8 6V4h8v2M6 6l1 14h10l1-14M10 11v5M14 11v5',
  'undo-2': 'M9 14L4 9l5-5M4 9h10.5a5.5 5.5 0 0 1 5.5 5.5a5.5 5.5 0 0 1-5.5 5.5H11',
  upload: 'M12 20V9M7 14l5-5 5 5M5 4h14',
  user: 'M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM4 21a8 8 0 0 1 16 0',
  users: 'M16 20v-1a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v1M9 11a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7zM22 20v-1a4 4 0 0 0-3-3.9M16 4.1a3.5 3.5 0 0 1 0 6.8',
  'wifi-off': 'M3 3l18 18M8.5 16.5a5 5 0 0 1 7 0M5 12.9a10 10 0 0 1 5.2-2.8M19 12.9a10 10 0 0 0-2.4-1.7M2 8.8a15 15 0 0 1 4.2-2.6M22 8.8A15 15 0 0 0 11 5M12 20h.01',
  x: 'M6 6l12 12M18 6L6 18',
});

/** Icons drawn as dots, which need a thicker stroke to be seen. */
const DOTS = new Set(['more']);
/** Icons that point somewhere: mirrored when the page reads right to left. */
const DIRECTIONAL = new Set(['back', 'chevron', 'logout']);

/**
 * An icon as an <svg>. With `label` it is announced (a button with nothing
 * else in it); without, screen readers skip it.
 */
export function icon(name, { label = null, className = '' } = {}) {
  const svg = document.createElementNS(SVG, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('class', `kit-icon${className ? ` ${className}` : ''}`);
  if (DIRECTIONAL.has(name)) svg.setAttribute('data-directional', '');
  if (label) {
    svg.setAttribute('role', 'img');
    svg.setAttribute('aria-label', label);
  } else {
    svg.setAttribute('aria-hidden', 'true');
  }
  const path = document.createElementNS(SVG, 'path');
  path.setAttribute('d', PATHS[name] ?? PATHS.info);
  if (DOTS.has(name)) path.setAttribute('stroke-width', '3.2');
  svg.append(path);
  return svg;
}

/** The ring of Cronum Studio, for the signature: its colours come from the CSS. */
export function cronumRing() {
  const svg = document.createElementNS(SVG, 'svg');
  svg.setAttribute('viewBox', '0 0 100 100');
  svg.setAttribute('aria-hidden', 'true');
  const ring = document.createElementNS(SVG, 'path');
  ring.setAttribute('d', 'M50 14A36 36 0 1 0 86 50');
  const dot = document.createElementNS(SVG, 'circle');
  dot.setAttribute('cx', '76.87');
  dot.setAttribute('cy', '23.13');
  dot.setAttribute('r', '10');
  svg.append(ring, dot);
  return svg;
}
