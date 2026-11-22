/**
 * The components every module drew for itself until 0.176.0, now the kit's (kit.css): chips,
 * colour swatches, the round check, a group's heading, the avatar's sizes, an empty page, the
 * selection, the Clean look's sidebar; the names the apps had for the kit's variables, and the
 * widths where layouts change (tokens.css). The modules' sheets lean on these names.
 *
 *   npm test
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { scopeCss } from '../scope-css.js';
import { lookFallbacks, physicalSides, layoutWidths } from '../tools/css-rules.mjs';

const read = (file) => fs.readFileSync(new URL(`../web/${file}`, import.meta.url), 'utf8');
/** The kit's style sheets. */
const SHEETS = ['kit.css', 'windows.css', 'oauth.css', 'public-page.css', 'tokens.css'];
const kit = read('kit.css');
const tokens = read('tokens.css');
/** The kit's sheet without its comments, where a rule's text is matched. */
const rules = kit.replace(/\/\*[\s\S]*?\*\//g, '');
/** The block of shared components, from its heading to the end. */
const shared = kit.slice(kit.indexOf('/* --------------------------- shared components'));

test('the shared components are the kit\'s, each with its states', () => {
  for (const selector of [
    '.kit-chip', '.kit-chip--tint', '.kit-chip--large', 'button.kit-chip', '.kit-chip[aria-pressed="true"]',
    '.kit-icon-btn--small', '.kit-icon-btn--small .kit-icon',
    '.kit-swatches', '.kit-swatch', '.kit-swatch:hover',
    '.kit-round-check', '.kit-round-check::before', '.kit-round-check::after', '.kit-round-check[disabled]',
    '.kit-group-title', ':root[data-look="clean"] .kit-group-title',
    '.kit-avatar--small', '.kit-avatar--tiny', '.kit-avatar--large',
    '.kit-blank--page', '.kit-blank h2', '.kit-field > .kit-field__label',
  ]) {
    assert.match(rules, new RegExp(`(^|[\\s,])${selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[\\s,{]`, 'm'), selector);
  }
  // Chosen and done by the same means as the modules had: an attribute or a class.
  assert.match(rules, /\.kit-swatch:is\(\[aria-pressed="true"\], \[aria-checked="true"\], \.kit-swatch--on\) \{/);
  assert.match(rules, /\.kit-round-check:is\(\.kit-round-check--done, \[aria-pressed="true"\]\) \{ background: var\(--kit-accent\);/);
  // The tick in the accent's own ink, and the circle's hit area wider than its drawing.
  assert.match(rules, /border-left: 2\.2px solid var\(--kit-on-accent\)/);
  assert.match(rules, /\.kit-round-check::before \{ content: ""; position: absolute; inset: -10px; \}/);
});

test('a button chip takes a finger’s tap in 24 px at least, as the round check does (ui-movil-12)', () => {
  // «2 completed» measured 23 px tall: under WCAG 2.5.8's 24. The drawing stays as it is.
  const coarse = /@media \(pointer: coarse\) \{\s*button\.kit-chip \{ position: relative; \}\s*button\.kit-chip::before \{ content: ""; position: absolute; inset: -(\d+)px 0; \}\s*\}/.exec(rules);
  assert.ok(coarse, 'an invisible margin above and below, with a finger only');
  assert.ok(23 + 2 * Number(coarse[1]) >= 24 + 8, 'well over 24 with the 23 px drawn');
  assert.doesNotMatch(rules, /^button\.kit-chip::before/m, 'with a mouse the chip is as it was');
});

test('the shared block names only the kit\'s and the brand\'s variables, never an app\'s', () => {
  const names = [...shared.replace(/\/\*[\s\S]*?\*\//g, '').matchAll(/var\(--([\w-]+)/g)].map((m) => m[1]);
  assert.ok(names.length > 20);
  for (const name of names) assert.match(name, /^(kit|look|cr)-/, `--${name}`);
});

test('the apps\' names for the kit\'s variables are the kit\'s now, and the radius is 10 px', () => {
  assert.match(rules, /--kit-faint: color-mix\(in oklab, var\(--kit-muted\) 78%, var\(--kit-bg\)\);/);
  assert.match(rules, /--kit-border-strong: color-mix\(in oklab, var\(--kit-border\) 82%, var\(--kit-text\)\);/);
  // One family of corners, the look's (dup-css-13): the kit's old names are three of them, the
  // suite's one radius 10 px in Cronum (Tasks' was 12) and 12 in Clean.
  const root = /:root \{([^}]*)\}/.exec(rules)[1];
  assert.match(root, /--kit-radius: var\(--look-r-md\);/);
  assert.match(root, /--kit-radius-small: var\(--look-r-sm\);/);
  assert.match(root, /--kit-radius-large: var\(--look-r-xl\);/);
  assert.match(root, /--look-r-md: 10px;/);
  assert.doesNotMatch(rules, /var\(--kit-radius/, 'the kit\'s own rules say --look-r-*');
  // Every variable the kit reads without a fallback is one it declares, or one its scripts set.
  const scripts = fs.readdirSync(new URL('../web/', import.meta.url)).filter((f) => f.endsWith('.js')).map(read).join('\n');
  const css = `${rules}\n${tokens}\n${read('windows.css')}`;
  const declared = new Set([...css.matchAll(/--kit-([\w-]+)\s*:/g)].map((m) => m[1]));
  for (const [, name] of css.matchAll(/var\(--kit-([\w-]+)\)/g)) {
    assert.ok(declared.has(name) || scripts.includes(`'--kit-${name}'`), `--kit-${name} is read but never set`);
  }
});

test('selected text in the accent, light and dark, and the caret too', () => {
  assert.match(rules, /^::selection \{ background: color-mix\(in srgb, var\(--kit-accent\) 30%, transparent\); \}$/m);
  assert.match(rules, /^:root\[data-theme="dark"\] ::selection \{ background: color-mix\(in srgb, var\(--kit-accent\) 48%, transparent\); \}$/m);
  assert.match(rules, /^input, textarea \{ caret-color: var\(--kit-accent\); \}$/m);
});

test('the Clean look\'s quiet sidebar is the kit\'s, once for every module', () => {
  assert.match(rules, /:root\[data-look="clean"\] \.kit-nav__item \{ min-height: 40px; padding-block: 8px; font-size: var\(--look-callout\); \}/);
  assert.match(rules, /:root\[data-look="clean"\] \.kit-nav__item\[aria-current="page"\] \{ font-weight: 500; \}/);
  assert.doesNotMatch(rules, /\.kit-nav__item \{ min-height: 44px; \}/, 'the 44 px of before is gone');
});

test('the widths where layouts change are the brand\'s tokens: 640 and 960, as the frame does (dup-css-16)', () => {
  assert.match(tokens, /--cr-bp-phone: 640px;/);
  assert.match(tokens, /--cr-bp-tablet: 960px;/);
  // Every other @media width of the kit's sheets is one it says why: the sign-in's two halves.
  const others = SHEETS.flatMap((f) => layoutWidths(read(f)).map((w) => `${f}: ${w.text}`));
  assert.deepEqual(others, ['kit.css: @media (min-width: 760px)']);
});

/*
 * The look's scale (rule 24 of web-kit.md, dup-css-13): every --look-* has a value in the Cronum
 * look (:root) and in Clean, and a sheet says the name alone. A number beside it was the Cronum
 * size in a second place, and one for each use: 14, 14.5, 15, 15.5, 16, 17 for the same body.
 */
test('the look\'s sizes are said by name, never with a number beside them', () => {
  for (const file of SHEETS) {
    assert.deepEqual(lookFallbacks(read(file)).map((f) => `${file}:${f.line} ${f.text}`), [], file);
  }
  // The check sees one where there is one, and not in a comment.
  assert.equal(lookFallbacks('.a { font-size: var(--look-body, 14px); }\n/* var(--look-body, 3px) */').length, 1);
});

test('every look variable read has a value in the Cronum look and in Clean, on a short scale', () => {
  const values = (body) => new Map([...body.matchAll(/--(look-[\w-]+):\s*([^;]+);/g)].map((m) => [m[1], m[2].trim()]));
  const cronum = values(/:root \{([^}]*)\}/.exec(rules)[1]);
  const clean = values(/:root\[data-look="clean"\] \{([^}]*)\}/.exec(rules)[1]);
  const names = new Set([...SHEETS.map(read).join('\n').matchAll(/var\(--(look-[\w-]+)\)/g)].map((m) => m[1]));
  assert.ok(names.size >= 20, `${names.size} look variables read`);
  for (const name of names) {
    assert.ok(cronum.has(name), `--${name} has a Cronum value`);
    assert.ok(clean.has(name), `--${name} has a Clean value`);
  }
  // The type: whole pixels, one size each in the Cronum look.
  const type = ['large-title', 'title1', 'title2', 'title3', 'headline', 'body', 'callout', 'subhead', 'footnote', 'caption', 'caption2']
    .map((n) => cronum.get(`look-${n}`));
  assert.deepEqual(type, ['21px', '24px', '22px', '19px', '15px', '15px', '14px', '14px', '13px', '12px', '11px']);
  // Clean's, an iPhone's, as they were.
  assert.equal(clean.get('look-body'), '17px');
  assert.equal(clean.get('look-large-title'), '34px');
  assert.equal(clean.get('look-r-xl'), '18px');
});

test('sides are logical in the kit\'s sheets, physical only where it says why (dup-css-19)', () => {
  // Each of these follows the pointer's coordinates, or is a drawing (the round check's tick).
  const allow = /^\.kit-drag-ghost$|^\.kit-round-check::after$|^\.cw-drop$/;
  for (const file of SHEETS) {
    assert.deepEqual(physicalSides(read(file), { allow }).map((f) => `${file}:${f.line} ${f.text}`), [], file);
  }
  assert.equal(physicalSides('.a { margin-left: 2px; text-align: right; inset-inline-start: 0; transition: left .2s; }').length, 2);
});

test('scoped to a module\'s windows (Cronum Work), the shared components keep their names', () => {
  const out = scopeCss(kit, 'tasks', '/tasks/suite/kit.css');
  const body = out.slice(out.indexOf('@scope ('));
  for (const rule of ['.kit-chip {', '.kit-swatch {', '.kit-round-check {', '.kit-group-title {', '::selection {']) {
    assert.ok(body.includes(rule), rule);
  }
  assert.ok(body.includes(':scope[data-look="clean"] .kit-nav__item {'), 'the Clean sidebar, on the module\'s window');
  assert.ok(body.includes(':scope[data-look="clean"] .kit-group-title {'));
  assert.ok(body.includes(':scope[data-theme="dark"] ::selection {'));
});
