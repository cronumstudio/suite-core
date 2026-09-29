/**
 * QR codes with no library, for what an app shows to be scanned: the
 * otpauth:// address of a second step, a link to open on the phone.
 *
 * Byte mode (UTF-8), error correction level M (15 % of the code can be lost),
 * versions 1 to 10: up to 213 bytes, plenty for an address. The mask is the
 * one with the lowest penalty, as the standard (ISO/IEC 18004) says.
 *
 *   qrMatrix(text) → { version, size, modules }   modules[row][column], true = dark
 *   qrSvg(text, { label }) → an <svg> element, black on white whatever the theme
 *     (scanners read dark on light), with the quiet zone around it
 *
 * qrMatrix() touches no DOM, so it runs in Node too (the tests).
 */

/* ------------------------------ the tables ------------------------------- */

// Level M, versions 1–10: error correction codewords per block, and the
// blocks as [count, data codewords] (the second group has one more).
const BLOCKS_M = [
  null,
  [10, [[1, 16]]],
  [16, [[1, 28]]],
  [26, [[1, 44]]],
  [18, [[2, 32]]],
  [24, [[2, 43]]],
  [16, [[4, 27]]],
  [18, [[4, 31]]],
  [22, [[2, 38], [2, 39]]],
  [22, [[3, 36], [2, 37]]],
  [26, [[4, 43], [1, 44]]],
];

// Where the centres of the alignment patterns go, on both axes.
const ALIGNMENT = [null, [], [6, 18], [6, 22], [6, 26], [6, 30], [6, 34],
  [6, 22, 38], [6, 24, 42], [6, 26, 46], [6, 28, 50]];

const MAX_VERSION = 10;
const LEVEL_M = 0b00;   // the two bits of level M in the format information

/* --------------------------- Reed-Solomon, GF(256) --------------------------- */

/** Product in GF(2^8) with the QR polynomial x^8 + x^4 + x^3 + x^2 + 1. */
function gfMultiply(x, y) {
  let z = 0;
  for (let i = 7; i >= 0; i--) {
    z = (z << 1) ^ ((z >>> 7) * 0x11d);
    z ^= ((y >>> i) & 1) * x;
  }
  return z;
}

/** The generator polynomial of `degree`, highest coefficient first and the leading 1 left out. */
function generator(degree) {
  const poly = new Array(degree).fill(0);
  poly[degree - 1] = 1;
  let root = 1;
  for (let i = 0; i < degree; i++) {
    // Multiply by (x - α^i).
    for (let j = 0; j < degree; j++) {
      poly[j] = gfMultiply(poly[j], root);
      if (j + 1 < degree) poly[j] ^= poly[j + 1];
    }
    root = gfMultiply(root, 0x02);
  }
  return poly;
}

/** The error correction codewords of a block: the remainder of its division by the generator. */
export function reedSolomon(data, degree) {
  const poly = generator(degree);
  const rest = new Array(degree).fill(0);
  for (const byte of data) {
    const factor = byte ^ rest.shift();
    rest.push(0);
    for (let i = 0; i < degree; i++) rest[i] ^= gfMultiply(poly[i], factor);
  }
  return rest;
}

/* ------------------------------ the codewords ------------------------------- */

const dataCapacity = (version) => BLOCKS_M[version][1].reduce((sum, [count, size]) => sum + count * size, 0);
const countBits = (version) => (version < 10 ? 8 : 16);

/** The smallest version that holds `length` bytes, or an error. */
function versionFor(length) {
  for (let version = 1; version <= MAX_VERSION; version++) {
    if (4 + countBits(version) + length * 8 <= dataCapacity(version) * 8) return version;
  }
  throw new Error(`QR: ${length} bytes don't fit (at most 213)`);
}

/** Mode, length, the bytes, the terminator and the padding: the data codewords. */
function dataCodewords(bytes, version) {
  const bits = [];
  const put = (value, length) => { for (let i = length - 1; i >= 0; i--) bits.push((value >>> i) & 1); };
  put(0b0100, 4);                       // byte mode
  put(bytes.length, countBits(version));
  for (const byte of bytes) put(byte, 8);
  const capacity = dataCapacity(version) * 8;
  put(0, Math.min(4, capacity - bits.length));
  put(0, (8 - (bits.length % 8)) % 8);
  const words = [];
  for (let i = 0; i < bits.length; i += 8) words.push(bits.slice(i, i + 8).reduce((acc, bit) => (acc << 1) | bit, 0));
  for (let pad = 0xec; words.length < capacity / 8; pad ^= 0xec ^ 0x11) words.push(pad);
  return words;
}

/** Split in blocks, each with its error correction, and interleaved as the reader expects. */
function finalCodewords(data, version) {
  const [ecLength, groups] = BLOCKS_M[version];
  const blocks = [];
  let offset = 0;
  for (const [count, size] of groups) {
    for (let i = 0; i < count; i++) {
      const block = data.slice(offset, offset + size);
      offset += size;
      blocks.push({ data: block, ec: reedSolomon(block, ecLength) });
    }
  }
  const out = [];
  const longest = Math.max(...blocks.map((b) => b.data.length));
  for (let i = 0; i < longest; i++) for (const b of blocks) if (i < b.data.length) out.push(b.data[i]);
  for (let i = 0; i < ecLength; i++) for (const b of blocks) out.push(b.ec[i]);
  return out;
}

/* ------------------------------- the matrix --------------------------------- */

/** The 15 bits of the format information: level and mask, BCH-protected and masked. */
export function formatBits(mask, level = LEVEL_M) {
  const data = (level << 3) | mask;
  let rem = data;
  for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
  return ((data << 10) | rem) ^ 0x5412;
}

/** The 18 bits of the version information (versions 7 and up). */
export function versionBits(version) {
  let rem = version;
  for (let i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >>> 11) * 0x1f25);
  return (version << 12) | rem;
}

const MASKS = [
  (x, y) => (x + y) % 2 === 0,
  (x, y) => y % 2 === 0,
  (x) => x % 3 === 0,
  (x, y) => (x + y) % 3 === 0,
  (x, y) => (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0,
  (x, y) => ((x * y) % 2) + ((x * y) % 3) === 0,
  (x, y) => (((x * y) % 2) + ((x * y) % 3)) % 2 === 0,
  (x, y) => (((x + y) % 2) + ((x * y) % 3)) % 2 === 0,
];

function blankMatrix(version) {
  const size = version * 4 + 17;
  const modules = Array.from({ length: size }, () => new Array(size).fill(false));
  const reserved = Array.from({ length: size }, () => new Array(size).fill(false));
  const set = (x, y, dark) => { modules[y][x] = dark; reserved[y][x] = true; };

  // Timing patterns, then the finders over their ends.
  for (let i = 0; i < size; i++) {
    set(6, i, i % 2 === 0);
    set(i, 6, i % 2 === 0);
  }
  for (const [cx, cy] of [[3, 3], [size - 4, 3], [3, size - 4]]) {
    for (let dy = -4; dy <= 4; dy++) {
      for (let dx = -4; dx <= 4; dx++) {
        const x = cx + dx;
        const y = cy + dy;
        if (x < 0 || y < 0 || x >= size || y >= size) continue;
        const ring = Math.max(Math.abs(dx), Math.abs(dy));
        set(x, y, ring !== 2 && ring !== 4);   // 4 is the light separator
      }
    }
  }
  const centres = ALIGNMENT[version];
  const last = centres.length - 1;
  centres.forEach((cy, i) => centres.forEach((cx, j) => {
    // Not where a finder is.
    if ((i === 0 && j === 0) || (i === 0 && j === last) || (i === last && j === 0)) return;
    for (let dy = -2; dy <= 2; dy++) {
      for (let dx = -2; dx <= 2; dx++) set(cx + dx, cy + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
    }
  }));
  // Room for the format information (drawn once the mask is chosen), and the
  // dark module that is always there.
  drawFormat(set, size, 0);
  if (version >= 7) {
    const bits = versionBits(version);
    for (let i = 0; i < 18; i++) {
      const dark = ((bits >>> i) & 1) === 1;
      const a = size - 11 + (i % 3);
      const b = Math.floor(i / 3);
      set(a, b, dark);
      set(b, a, dark);
    }
  }
  return { size, modules, reserved, set };
}

function drawFormat(set, size, mask) {
  const bits = formatBits(mask);
  const bit = (i) => ((bits >>> i) & 1) === 1;
  // Around the top-left finder…
  for (let i = 0; i <= 5; i++) set(8, i, bit(i));
  set(8, 7, bit(6));
  set(8, 8, bit(7));
  set(7, 8, bit(8));
  for (let i = 9; i < 15; i++) set(14 - i, 8, bit(i));
  // …and split between the other two.
  for (let i = 0; i < 8; i++) set(size - 1 - i, 8, bit(i));
  for (let i = 8; i < 15; i++) set(8, size - 15 + i, bit(i));
  set(8, size - 8, true);
}

/** Which modules are the patterns' and not data's, for a version: for tests and readers. */
export function functionModules(version) {
  return blankMatrix(version).reserved;
}

/** The codewords in the zigzag, two columns at a time from the bottom right, skipping the timing column. */
function placeData(matrix, codewords) {
  const { size, modules, reserved } = matrix;
  let i = 0;
  const total = codewords.length * 8;
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5;
    const upward = ((right + 1) & 2) === 0;
    for (let step = 0; step < size; step++) {
      const y = upward ? size - 1 - step : step;
      for (let j = 0; j < 2; j++) {
        const x = right - j;
        if (reserved[y][x] || i >= total) continue;
        modules[y][x] = ((codewords[i >>> 3] >>> (7 - (i & 7))) & 1) === 1;
        i++;
      }
    }
  }
}

/** How hard a matrix is to read (the four rules of the standard): the lower, the better. */
export function penalty(modules) {
  const size = modules.length;
  let score = 0;
  const lines = [];
  for (let y = 0; y < size; y++) lines.push(modules[y]);
  for (let x = 0; x < size; x++) lines.push(modules.map((row) => row[x]));
  const finderLike = [true, false, true, true, true, false, true];
  for (const line of lines) {
    // 1: five or more of the same colour in a row.
    let run = 1;
    for (let i = 1; i <= size; i++) {
      if (i < size && line[i] === line[i - 1]) run++;
      else {
        if (run >= 5) score += 3 + (run - 5);
        run = 1;
      }
    }
    // 3: something that looks like a finder, with four light modules on a side.
    for (let i = 0; i + 7 <= size; i++) {
      if (!finderLike.every((dark, k) => line[i + k] === dark)) continue;
      const lightBefore = i >= 4 && [1, 2, 3, 4].every((k) => !line[i - k]);
      const lightAfter = i + 11 <= size && [7, 8, 9, 10].every((k) => !line[i + k]);
      if (lightBefore) score += 40;
      if (lightAfter) score += 40;
    }
  }
  // 2: blocks of 2×2 of one colour.
  for (let y = 0; y + 1 < size; y++) {
    for (let x = 0; x + 1 < size; x++) {
      const c = modules[y][x];
      if (modules[y][x + 1] === c && modules[y + 1][x] === c && modules[y + 1][x + 1] === c) score += 3;
    }
  }
  // 4: far from half dark.
  const dark = modules.reduce((sum, row) => sum + row.filter(Boolean).length, 0);
  score += Math.floor(Math.abs((dark * 100) / (size * size) - 50) / 5) * 10;
  return score;
}

/**
 * The matrix of a text. `mask` forces one (0–7) instead of choosing the best:
 * for tests.
 */
export function qrMatrix(text, { mask = null } = {}) {
  const bytes = [...new TextEncoder().encode(String(text))];
  const version = versionFor(bytes.length);
  const codewords = finalCodewords(dataCodewords(bytes, version), version);

  const candidates = (mask == null ? [0, 1, 2, 3, 4, 5, 6, 7] : [mask]).map((m) => {
    const matrix = blankMatrix(version);
    placeData(matrix, codewords);
    const flip = MASKS[m];
    for (let y = 0; y < matrix.size; y++) {
      for (let x = 0; x < matrix.size; x++) {
        if (!matrix.reserved[y][x] && flip(x, y)) matrix.modules[y][x] = !matrix.modules[y][x];
      }
    }
    drawFormat(matrix.set, matrix.size, m);
    return { mask: m, modules: matrix.modules, score: mask == null ? penalty(matrix.modules) : 0 };
  });
  const best = candidates.reduce((a, b) => (b.score < a.score ? b : a));
  return { version, size: version * 4 + 17, mask: best.mask, modules: best.modules };
}

/**
 * The code as an <svg>, built node by node (the kit never assembles HTML).
 * `border` is the quiet zone, in modules: four, as the standard asks.
 */
export function qrSvg(text, { border = 4, label = '' } = {}) {
  const { size, modules } = qrMatrix(text);
  const NS = 'http://www.w3.org/2000/svg';
  const full = size + border * 2;
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('viewBox', `0 0 ${full} ${full}`);
  svg.setAttribute('shape-rendering', 'crispEdges');
  svg.setAttribute('class', 'kit-qr');
  if (label) {
    svg.setAttribute('role', 'img');
    svg.setAttribute('aria-label', label);
  } else {
    svg.setAttribute('aria-hidden', 'true');
  }
  const back = document.createElementNS(NS, 'rect');
  back.setAttribute('width', String(full));
  back.setAttribute('height', String(full));
  back.setAttribute('fill', '#fff');
  const dots = document.createElementNS(NS, 'path');
  let d = '';
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) if (modules[y][x]) d += `M${x + border} ${y + border}h1v1h-1z`;
  }
  dots.setAttribute('d', d);
  dots.setAttribute('fill', '#000');
  svg.append(back, dots);
  return svg;
}
