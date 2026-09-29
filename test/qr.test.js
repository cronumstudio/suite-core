/**
 * The QR codes of the web kit (web/qr.js), checked against the standard's
 * published values and read back by a small decoder written here: the format
 * information, the zigzag, the blocks, their error correction and the text.
 *
 *   npm test
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  qrMatrix, reedSolomon, formatBits, versionBits, functionModules, penalty,
} from '../web/qr.js';

// ISO/IEC 18004, level M: total codewords, and the blocks as [count, data codewords].
const STANDARD_M = {
  1: [26, 10, [[1, 16]]], 2: [44, 16, [[1, 28]]], 3: [70, 26, [[1, 44]]], 4: [100, 18, [[2, 32]]],
  5: [134, 24, [[2, 43]]], 6: [172, 16, [[4, 27]]], 7: [196, 18, [[4, 31]]], 8: [242, 22, [[2, 38], [2, 39]]],
  9: [292, 22, [[3, 36], [2, 37]]], 10: [346, 26, [[4, 43], [1, 44]]],
};
const REMAINDER_BITS = { 1: 0, 2: 7, 3: 7, 4: 7, 5: 7, 6: 7, 7: 0, 8: 0, 9: 0, 10: 0 };

const MASKS = [
  (x, y) => (x + y) % 2 === 0, (x, y) => y % 2 === 0, (x) => x % 3 === 0, (x, y) => (x + y) % 3 === 0,
  (x, y) => (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0, (x, y) => ((x * y) % 2) + ((x * y) % 3) === 0,
  (x, y) => (((x * y) % 2) + ((x * y) % 3)) % 2 === 0, (x, y) => (((x + y) % 2) + ((x * y) % 3)) % 2 === 0,
];

/** A decoder for what qrMatrix() draws: returns the text, or throws saying what doesn't add up. */
function read({ size, modules }) {
  const bit = (x, y) => (modules[y][x] ? 1 : 0);
  const version = (size - 17) / 4;

  // The format information, twice.
  let first = 0;
  const at = [[8, 0], [8, 1], [8, 2], [8, 3], [8, 4], [8, 5], [8, 7], [8, 8], [7, 8], [5, 8], [4, 8], [3, 8], [2, 8], [1, 8], [0, 8]];
  at.forEach(([x, y], i) => { first |= bit(x, y) << i; });
  let second = 0;
  for (let i = 0; i < 8; i++) second |= bit(size - 1 - i, 8) << i;
  for (let i = 8; i < 15; i++) second |= bit(8, size - 15 + i) << i;
  assert.equal(first, second, 'both copies of the format information agree');
  const mask = [0, 1, 2, 3, 4, 5, 6, 7].find((m) => formatBits(m) === first);
  assert.notEqual(mask, undefined, 'the format information is level M with a known mask');
  assert.equal(bit(8, size - 8), 1, 'the dark module');

  // The zigzag, unmasked.
  const reserved = functionModules(version);
  const bits = [];
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5;
    const upward = ((right + 1) & 2) === 0;
    for (let step = 0; step < size; step++) {
      const y = upward ? size - 1 - step : step;
      for (const x of [right, right - 1]) {
        if (!reserved[y][x]) bits.push(bit(x, y) ^ (MASKS[mask](x, y) ? 1 : 0));
      }
    }
  }
  const [total, ecLength, groups] = STANDARD_M[version];
  const codewords = [];
  for (let i = 0; i + 8 <= total * 8; i += 8) codewords.push(bits.slice(i, i + 8).reduce((a, b) => (a << 1) | b, 0));

  // The blocks back from the interleaving; each block's error correction must hold.
  const sizes = groups.flatMap(([count, length]) => new Array(count).fill(length));
  const blocks = sizes.map((length) => ({ data: [], ec: [], length }));
  let k = 0;
  for (let i = 0; i < Math.max(...sizes); i++) for (const b of blocks) if (i < b.length) b.data.push(codewords[k++]);
  for (let i = 0; i < ecLength; i++) for (const b of blocks) b.ec.push(codewords[k++]);
  for (const b of blocks) assert.deepEqual(reedSolomon(b.data, ecLength), b.ec, 'error correction of a block');

  // Byte mode, the length and the bytes.
  const data = blocks.flatMap((b) => b.data);
  const stream = data.flatMap((byte) => [7, 6, 5, 4, 3, 2, 1, 0].map((i) => (byte >>> i) & 1));
  let pos = 0;
  const take = (n) => { let v = 0; for (let i = 0; i < n; i++) v = (v << 1) | stream[pos++]; return v; };
  assert.equal(take(4), 0b0100, 'byte mode');
  const length = take(version < 10 ? 8 : 16);
  const bytes = Array.from({ length }, () => take(8));
  return new TextDecoder().decode(new Uint8Array(bytes));
}

test('the published values: Reed-Solomon, the format and version information', () => {
  // "HELLO WORLD" at 1-M, the standard's worked example (alphanumeric mode): its error correction.
  assert.deepEqual(reedSolomon([32, 91, 11, 120, 209, 114, 220, 77, 67, 64, 236, 17, 236, 17, 236, 17], 10),
    [196, 35, 39, 119, 235, 215, 231, 226, 93, 23]);
  const levelM = ['101010000010010', '101000100100101', '101111001111100', '101101101001011',
    '100010111111001', '100000011001110', '100111110010111', '100101010100000'];
  levelM.forEach((bits, mask) => assert.equal(formatBits(mask).toString(2).padStart(15, '0'), bits, `M, mask ${mask}`));
  assert.equal(formatBits(0, 0b01).toString(2), '111011111000100', 'L, mask 0');
  assert.deepEqual([7, 8, 9, 10].map(versionBits), [0x07c94, 0x085bc, 0x09a99, 0x0a4d3]);
});

test('each version leaves exactly the standard’s codewords, and remainder bits, for data', () => {
  for (let version = 1; version <= 10; version++) {
    const reserved = functionModules(version);
    const size = version * 4 + 17;
    assert.equal(reserved.length, size);
    const free = reserved.flat().filter((r) => !r).length;
    assert.equal(Math.floor(free / 8), STANDARD_M[version][0], `version ${version}: codewords`);
    assert.equal(free % 8, REMAINDER_BITS[version], `version ${version}: remainder bits`);
  }
});

test('what it draws reads back, with any mask and at every size', () => {
  const texts = [
    'a', 'HELLO WORLD', 'Café, niño y 😀',
    'otpauth://totp/Next%3Amartin?secret=JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP&issuer=Next&algorithm=SHA1&digits=6&period=30',
    'x'.repeat(14), 'x'.repeat(15), 'x'.repeat(122), 'x'.repeat(123), 'x'.repeat(180), 'x'.repeat(181), 'x'.repeat(213),
  ];
  for (const text of texts) {
    for (let mask = 0; mask < 8; mask++) assert.equal(read(qrMatrix(text, { mask })), text, `${text.slice(0, 20)}…, mask ${mask}`);
    assert.equal(read(qrMatrix(text)), text);
  }
  assert.deepEqual(['x'.repeat(14), 'x'.repeat(15), 'x'.repeat(213)].map((t) => qrMatrix(t).version), [1, 2, 10],
    'the smallest version that holds it');
  assert.equal(qrMatrix('x'.repeat(181)).version, 10, '16 length bits from version 10');
  assert.throws(() => qrMatrix('x'.repeat(214)), /don't fit/);
});

test('the mask chosen is the one with the lowest penalty', () => {
  const text = 'otpauth://totp/Demo%3Aada?secret=GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ&issuer=Demo';
  const chosen = qrMatrix(text);
  const scores = [0, 1, 2, 3, 4, 5, 6, 7].map((mask) => penalty(qrMatrix(text, { mask }).modules));
  assert.equal(penalty(chosen.modules), Math.min(...scores));
  assert.equal(chosen.mask, scores.indexOf(Math.min(...scores)));
});
