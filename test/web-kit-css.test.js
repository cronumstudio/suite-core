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

const read = (file) => fs.readFileSync(new URL(`../web/${file}`, import.meta.url), 'utf8');
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

test('the shared block names only the kit\'s and the brand\'s variables, never an app\'s', () => {
  const names = [...shared.replace(/\/\*[\s\S]*?\*\//g, '').matchAll(/var\(--([\w-]+)/g)].map((m) => m[1]);
  assert.ok(names.length > 20);
  for (const name of names) assert.match(name, /^(kit|look|cr)-/, `--${name}`);
});

test('the apps\' names for the kit\'s variables are the kit\'s now, and the radius is 10 px', () => {
  assert.match(rules, /--kit-faint: color-mix\(in oklab, var\(--kit-muted\) 78%, var\(--kit-bg\)\);/);
  assert.match(rules, /--kit-border-strong: color-mix\(in oklab, var\(--kit-border\) 82%, var\(--kit-text\)\);/);
  assert.match(rules, /--kit-radius-small: 8px;/);
  assert.match(rules, /:root\[data-look="clean"\] \{ --kit-radius-small: var\(--look-r-sm, 10px\); \}/);
  // The suite's one radius, which the modules take (Tasks' was 12 px).
  assert.match(/:root \{([^}]*)\}/.exec(rules)[1], /--kit-radius: 10px;/);
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
  assert.match(rules, /:root\[data-look="clean"\] \.kit-nav__item \{ min-height: 40px; padding-block: 8px; font-size: var\(--look-callout, 15px\); \}/);
  assert.match(rules, /:root\[data-look="clean"\] \.kit-nav__item\[aria-current="page"\] \{ font-weight: 500; \}/);
  assert.doesNotMatch(rules, /\.kit-nav__item \{ min-height: 44px; \}/, 'the 44 px of before is gone');
});

test('the widths where layouts change are the brand\'s tokens: 640 and 860', () => {
  assert.match(tokens, /--cr-bp-phone: 640px;/);
  assert.match(tokens, /--cr-bp-tablet: 860px;/);
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
