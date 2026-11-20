/**
 * The share dialog (web/share.js) and Settings › Sharing (web/shared.js) say the same thing the
 * same way, in every language (sc-ui-2): what one may do, an invitation with no answer, taking it
 * back, leaving, and who has it (the decisions of 13-14/11: «Propietario», «Salir»).
 *
 *   npm test
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const SAME = [
  ['kit.share.view', 'kit.shared.view'],
  ['kit.share.edit', 'kit.shared.edit'],
  ['kit.share.pending', 'kit.shared.pending'],
  ['kit.share.remove', 'kit.shared.remove'],
  ['kit.share.takeBack', 'kit.shared.stop'],
  ['kit.share.leave', 'kit.shared.leave'],
  ['kit.share.owner', 'kit.share.ownerYou'],
];

test('the share dialog and Settings › Sharing use one vocabulary', () => {
  for (const lang of ['en', 'es', 'fr', 'de', 'it']) {
    const words = JSON.parse(fs.readFileSync(new URL(`../i18n/${lang}.json`, import.meta.url), 'utf8'));
    for (const [dialog, settings] of SAME) assert.equal(words[settings], words[dialog], `${lang}: ${settings} as ${dialog}`);
    // Leaving says what goes the same way: only the names of their slots differ.
    assert.equal(words['kit.shared.leaveConfirm'].replace('{item}', '{name}'), words['kit.share.leaveConfirm'], `${lang}: leaveConfirm`);
  }
  const es = JSON.parse(fs.readFileSync(new URL('../i18n/es.json', import.meta.url), 'utf8'));
  assert.equal(es['kit.share.leave'], 'Salir');
  assert.equal(es['kit.share.owner'], 'Propietario');
});
