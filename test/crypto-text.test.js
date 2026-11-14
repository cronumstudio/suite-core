/**
 * encryptText and decryptText (crypto.js): what one writes the other reads with the same key, and
 * nothing else; a tag cut short is refused (audit sc-auth-13).
 *
 *   npm test
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { encryptText, decryptText } from '../crypto.js';

test('decryptText reads encryptText with its key, and refuses another key, a change and a short tag', () => {
  const key = crypto.randomBytes(32);
  const sealed = encryptText(key, 'secret of the device');
  assert.equal(decryptText(key, sealed), 'secret of the device');
  assert.equal(decryptText(crypto.randomBytes(32), sealed), null, 'another key');
  const [version, iv, tag, data] = sealed.split(':');
  const flipped = Buffer.from(data, 'base64url');
  flipped[0] ^= 1;
  assert.equal(decryptText(key, [version, iv, tag, flipped.toString('base64url')].join(':')), null, 'a change');
  // GCM would take the first bytes of the right tag as a tag: only the whole one counts.
  const short = Buffer.from(tag, 'base64url').subarray(0, 4).toString('base64url');
  assert.equal(decryptText(key, [version, iv, short, data].join(':')), null, 'a tag cut short');
  assert.equal(decryptText(key, 'v0:x:y:z'), null);
  assert.equal(decryptText(key, null), null);
});
