#!/usr/bin/env node
/**
 * The same code in two modules: what a function the modules share looks like when each one writes
 * it again instead of taking it from here. Every run of 8 significant lines (comments, blank lines,
 * imports and lone brackets left out, spaces collapsed) that two or more modules both have counts
 * once. A host's CI keeps that count from growing: a new copy fails it, and the fix is the shared
 * piece in suite-core, or, when the copy is meant, a baseline raised on purpose.
 *
 *   node tools/dup-check.mjs tasks=../tasks projects=../projects … [--max N] [--list N] [--window 8]
 *
 * Prints the count and the first --list shared runs with where they are; exits 1 when the count is
 * over --max. What is read of each module: server/**.js and public/js/**.js, never its own
 * server/suite, tests, vendored files or migrations (a migration's copy stays frozen with it).
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { pathToFileURL } from 'node:url';

const SKIP_DIRS = new Set(['suite', 'node_modules', 'vendor', 'test', 'tests', '.git']);
const SKIP_FILES = /(^|\/)(migrations\.js|.*\.min\.js|.*\.test\.js)$/;

/** The .js files of a module that count: server/ and public/js/, without what SKIP_* leave out. */
export function filesOf(dir) {
  const out = [];
  const walk = (d, rel) => {
    let entries = [];
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (e.isDirectory()) {
        if (!SKIP_DIRS.has(e.name)) walk(path.join(d, e.name), `${rel}${e.name}/`);
      } else if (e.name.endsWith('.js') && !SKIP_FILES.test(`${rel}${e.name}`)) {
        out.push(`${rel}${e.name}`);
      }
    }
  };
  walk(path.join(dir, 'server'), 'server/');
  walk(path.join(dir, 'public', 'js'), 'public/js/');
  return out.sort();
}

/** A file's significant lines: [{ text, line }], comments and noise out, spaces collapsed. */
export function significantLines(source) {
  const out = [];
  let inBlock = false;
  source.split(/\r?\n/).forEach((raw, i) => {
    let text = raw;
    if (inBlock) {
      const end = text.indexOf('*/');
      if (end < 0) return;
      text = text.slice(end + 2);
      inBlock = false;
    }
    // Block comments that start here (the rest of the line after one that ends is kept).
    for (;;) {
      const start = text.indexOf('/*');
      if (start < 0) break;
      const end = text.indexOf('*/', start + 2);
      if (end < 0) { text = text.slice(0, start); inBlock = true; break; }
      text = text.slice(0, start) + text.slice(end + 2);
    }
    text = text.replace(/(^|[^:'"`\\])\/\/.*$/, '$1').replace(/\s+/g, ' ').trim();
    if (!text) return;
    if (/^(import |export \{|export \* from|\} from )/.test(text)) return;
    if (/^[\]})(;,]*$/.test(text)) return;
    out.push({ text, line: i + 1 });
  });
  return out;
}

/**
 * The runs of `window` significant lines that two or more modules have.
 * @param {Record<string, string>} roots  { module: its folder }
 * @returns {{ count: number, shared: Array<{ hash, sample, places: Array<{ module, file, line }> }> }}
 */
export function duplicates(roots, { window = 8 } = {}) {
  const seen = new Map(); // hash → { sample, places: Map(module → { file, line }) }
  for (const [name, dir] of Object.entries(roots)) {
    for (const file of filesOf(dir)) {
      let source;
      try { source = fs.readFileSync(path.join(dir, file), 'utf8'); } catch { continue; }
      const lines = significantLines(source);
      for (let i = 0; i + window <= lines.length; i++) {
        const text = lines.slice(i, i + window).map((l) => l.text).join('\n');
        const hash = crypto.createHash('sha1').update(text).digest('hex').slice(0, 16);
        let entry = seen.get(hash);
        if (!entry) { entry = { sample: text, places: new Map() }; seen.set(hash, entry); }
        if (!entry.places.has(name)) entry.places.set(name, { module: name, file, line: lines[i].line, end: lines[i + window - 1].line, at: i });
      }
    }
  }
  const shared = [...seen.entries()]
    .filter(([, e]) => e.places.size >= 2)
    .map(([hash, e]) => ({ hash, sample: e.sample, places: [...e.places.values()] }))
    .sort((a, b) => a.places[0].module.localeCompare(b.places[0].module)
      || a.places[0].file.localeCompare(b.places[0].file) || a.places[0].at - b.places[0].at);
  return { count: shared.length, shared, blocks: blocksOf(shared, window) };
}

/**
 * The shared runs joined into the pieces a person would name: runs in the same files whose starts
 * are within a window of each other in every one of them are one copied block.
 * → [{ places: [{ module, file, from, to }], runs }], the biggest first.
 */
export function blocksOf(shared, window = 8) {
  const blocks = [];
  const open = new Map(); // the same modules and files → the block still growing
  for (const run of shared) {
    const key = run.places.map((p) => `${p.module}/${p.file}`).join(' ');
    const last = open.get(key);
    const near = last && run.places.every((p, k) => p.at - last.ats[k] > 0 && p.at - last.ats[k] <= window);
    if (near) {
      last.runs += 1;
      last.ats = run.places.map((p) => p.at);
      run.places.forEach((p, k) => { last.places[k].to = p.end; });
    } else {
      const block = { runs: 1, ats: run.places.map((p) => p.at),
        places: run.places.map((p) => ({ module: p.module, file: p.file, from: p.line, to: p.end })) };
      blocks.push(block);
      open.set(key, block);
    }
  }
  return blocks
    .map(({ places, runs }) => ({ places, runs }))
    .sort((a, b) => b.runs - a.runs || b.places.length - a.places.length);
}

function main(argv) {
  const roots = {};
  let max = null;
  let list = 10;
  let window = 8;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--max') max = Number(argv[++i]);
    else if (a === '--list') list = Number(argv[++i]);
    else if (a === '--window') window = Number(argv[++i]);
    else if (a.includes('=')) roots[a.slice(0, a.indexOf('='))] = a.slice(a.indexOf('=') + 1);
    else throw new Error(`dup-check: "${a}" is neither name=folder nor an option`);
  }
  if (Object.keys(roots).length < 2) throw new Error('dup-check: give two modules or more, as name=folder');
  const { count, blocks } = duplicates(roots, { window });
  console.log(`dup-check: ${count} runs of ${window} lines are in two modules or more, in ${blocks.length} blocks`);
  for (const b of blocks.slice(0, list)) {
    console.log(`  ${b.places.map((p) => `${p.module}/${p.file}:${p.from}-${p.to}`).join('  ')}  (${b.runs})`);
  }
  if (max != null && count > max) {
    console.log(`dup-check: ${count} is over the ${max} allowed: write the shared piece once, in suite-core`);
    process.exitCode = 1;
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) main(process.argv.slice(2));
