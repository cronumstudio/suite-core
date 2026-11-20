import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { duplicates, filesOf, significantLines } from '../tools/dup-check.mjs';

const TOOL = fileURLToPath(new URL('../tools/dup-check.mjs', import.meta.url));

// Twelve lines of a helper the way a module writes it; the other module has it with its own
// comments, spacing and line endings.
const HELPER = [
  'export function rangeOf(rows, field) {',
  '  let low = null;',
  '  let high = null;',
  '  for (const row of rows) {',
  '    const value = row[field];',
  '    if (value == null) continue;',
  '    if (low == null || value < low) low = value;',
  '    if (high == null || value > high) high = value;',
  '  }',
  '  const span = low == null ? 0 : high - low;',
  '  const middle = low == null ? null : low + span / 2;',
  '  return { low, high, span, middle };',
  '}',
];

function modules(t, files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dup-check-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  for (const [file, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    fs.writeFileSync(path.join(root, file), text);
  }
  return root;
}

test('a helper two modules both wrote counts, whatever their comments and spacing', (t) => {
  const root = modules(t, {
    'a/server/range.js': `// A's own words\n${HELPER.join('\n')}\n`,
    'b/public/js/util.js': `import x from './x.js';\n/* B's\n   words */\n${HELPER.map((l) => `\t${l.trim()}   `).join('\r\n')}\r\n`,
    'c/server/other.js': 'export const other = 1;\n',
  });
  const { count, blocks } = duplicates({ a: `${root}/a`, b: `${root}/b`, c: `${root}/c` });
  // 11 significant lines (the lone `}` lines are left out) → 4 runs of 8, one block.
  assert.equal(count, 4);
  assert.equal(blocks.length, 1);
  assert.deepEqual(blocks[0].places.map((p) => `${p.module}/${p.file}:${p.from}-${p.to}`),
    ['a/server/range.js:2-13', 'b/public/js/util.js:4-15']);
});

test('what a module may keep to itself is not read: its suite, tests, migrations and vendored files', (t) => {
  const copy = `${HELPER.join('\n')}\n`;
  const root = modules(t, {
    'a/server/range.js': copy,
    'b/server/suite/range.js': copy,
    'b/server/migrations.js': copy,
    'b/test/range.test.js': copy,
    'b/public/js/vendor/range.js': copy,
    'b/public/js/range.min.js': copy,
    'b/public/css/range.js': copy,
  });
  assert.deepEqual(filesOf(`${root}/b`), []);
  assert.equal(duplicates({ a: `${root}/a`, b: `${root}/b` }).count, 0);
});

test('the same code twice in one module is not a copy between modules', (t) => {
  const root = modules(t, {
    'a/server/one.js': `${HELPER.join('\n')}\n`,
    'a/server/two.js': `${HELPER.join('\n')}\n`,
    'b/server/b.js': 'export const b = 1;\n',
  });
  assert.equal(duplicates({ a: `${root}/a`, b: `${root}/b` }).count, 0);
});

test('significant lines leave out comments, blank lines, imports and lone brackets, and keep URLs', (t) => {
  const lines = significantLines([
    "import { a } from './a.js';",
    '',
    '/** A doc',
    ' * comment */ const kept = 1; // and a note',
    "const url = 'https://example.com/x'; // the URL stays",
    '});',
    '} from \'./b.js\';',
  ].join('\n'));
  assert.deepEqual(lines, [
    { text: 'const kept = 1;', line: 4 },
    { text: "const url = 'https://example.com/x';", line: 5 },
  ]);
});

test('the command fails over --max and names where the copies are', (t) => {
  const root = modules(t, {
    'a/server/range.js': `${HELPER.join('\n')}\n`,
    'b/server/range.js': `${HELPER.join('\n')}\n`,
  });
  const run = (...extra) => spawnSync(process.execPath, [TOOL, `a=${root}/a`, `b=${root}/b`, ...extra], { encoding: 'utf8' });
  const over = run('--max', '3');
  assert.equal(over.status, 1);
  assert.match(over.stdout, /4 runs of 8 lines are in two modules or more, in 1 blocks/);
  assert.match(over.stdout, /a\/server\/range\.js:1-12 {2}b\/server\/range\.js:1-12/);
  assert.match(over.stdout, /over the 3 allowed/);
  assert.equal(run('--max', '4').status, 0);
  assert.equal(run().status, 0);
});
