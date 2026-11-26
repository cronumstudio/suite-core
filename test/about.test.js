/**
 * What Settings › About says of the code and of whoever runs it (about.js): the install's settings
 * read and checked, the source of the version that runs, and what /api/auth/config says of them.
 *
 *   node --test test/about.test.js
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { aboutFromEnv, aboutAnswer, CLOSED_PARTS, COPYRIGHT, LICENSE_URL, TRADEMARKS_URL } from '../about.js';
import { createSuite, createApp } from '../app.js';
import { resolveConfig } from '../config.js';

const PRODUCT = { app: { id: 'demo', name: 'Demo', languages: ['en'] } };

test('nothing set: the product’s repository at its version, the licence, and no closed part, legal link or sign-up', () => {
  const warnings = [];
  const about = aboutFromEnv({}, warnings);
  assert.deepEqual(warnings, []);
  assert.deepEqual(about, { sourceUrl: null, revision: null, modified: null, closed: [], links: {}, signupUrl: null });
  assert.deepEqual(aboutAnswer(about, { id: 'work', version: '1.2.3' }), {
    source: 'https://github.com/cronumstudio/work/tree/v1.2.3',
    revision: null,
    modified: null,
    closed: [],
    links: {},
    copyright: COPYRIGHT,
    license: LICENSE_URL,
    trademarks: TRADEMARKS_URL,
    third_party: 'https://github.com/cronumstudio/work/blob/v1.2.3/THIRD_PARTY_NOTICES.md',
  });
  assert.equal(aboutAnswer(undefined, { id: 'work', version: '1.2.3' }).source, 'https://github.com/cronumstudio/work/tree/v1.2.3',
    'a config without it: the same');
});

test('the build’s commit names the exact code that runs, in the product’s repository or the install’s own', () => {
  const sha = 'a'.repeat(40);
  const built = aboutAnswer(aboutFromEnv({ SOURCE_REVISION: sha }), { id: 'work', version: '1.2.3' });
  assert.equal(built.source, `https://github.com/cronumstudio/work/tree/${sha}`);
  assert.equal(built.third_party, `https://github.com/cronumstudio/work/blob/${sha}/THIRD_PARTY_NOTICES.md`);
  assert.equal(built.revision, sha);

  // A changed copy points it at its own code: `{ref}` is the commit, or the version without one.
  const fork = aboutFromEnv({ SOURCE_URL: 'https://git.example.org/acme/work/src/commit/{ref}', SOURCE_REVISION: 'v2.0.0-acme.1' });
  assert.equal(aboutAnswer(fork, { id: 'work', version: '1.2.3' }).source, 'https://git.example.org/acme/work/src/commit/v2.0.0-acme.1');
  const noRef = aboutFromEnv({ SOURCE_URL: 'https://git.example.org/acme/work/src/tag/{ref}' });
  assert.equal(aboutAnswer(noRef, { id: 'work', version: '1.2.3' }).source, 'https://git.example.org/acme/work/src/tag/v1.2.3');
  const plain = aboutAnswer(aboutFromEnv({ SOURCE_URL: 'https://git.example.org/acme/work' }), { id: 'work', version: '1.2.3' });
  assert.equal(plain.source, 'https://git.example.org/acme/work', 'without {ref}, as written');
  assert.equal(plain.trademarks, null, 'a copy whose code is someone else’s: no link to the products’ trademark policy');
  assert.equal(plain.third_party, null, 'its notices are in its own source');
  assert.equal(aboutAnswer(aboutFromEnv({ SOURCE_URL: 'https://github.com/cronumstudio/work/tree/{ref}' }), { id: 'work', version: '1' }).trademarks,
    TRADEMARKS_URL, 'the products’ own repository written out: still theirs');
});

test('who changed it, the closed parts, the legal links and the sign-up, each checked; a mistake is said and left out', () => {
  const warnings = [];
  const about = aboutFromEnv({
    SOURCE_MODIFIED: '  Acme Ltd,\n March 2027 ',
    SOURCE_CLOSED: 'payments, croc,croc, games',
    TERMS_URL: 'https://example.com/terms/',
    PRIVACY_URL: 'https://example.com/privacy/',
    COOKIES_URL: 'not a link',
    LEGAL_URL: 'javascript:alert(1)',
    SUPPORT_URL: 'http://example.com/support',
    SIGNUP_URL: 'https://example.com/join',
    SOURCE_URL: 'ftp://example.com/code',
    SOURCE_REVISION: 'no spaces allowed',
  }, warnings);
  assert.equal(about.modified, 'Acme Ltd, March 2027', 'one line');
  assert.deepEqual(about.closed, ['payments', 'croc'], 'each once, from the suite’s list');
  assert.deepEqual(CLOSED_PARTS, ['croc', 'payments']);
  assert.deepEqual(about.links, { terms: 'https://example.com/terms/', privacy: 'https://example.com/privacy/', support: 'http://example.com/support' });
  assert.equal(about.signupUrl, 'https://example.com/join');
  assert.equal(about.sourceUrl, null);
  assert.equal(about.revision, null);
  assert.deepEqual(warnings.map((w) => w.split(' ')[0]).sort(), ['COOKIES_URL', 'LEGAL_URL', 'SOURCE_CLOSED:', 'SOURCE_REVISION', 'SOURCE_URL']);
  const long = [];
  assert.equal(aboutFromEnv({ SOURCE_MODIFIED: 'x'.repeat(300) }, long).modified.length, 200);
  assert.equal(long.length, 1);
  const config = resolveConfig(PRODUCT, { DATA_DIR: os.tmpdir(), SOURCE_CLOSED: 'croc', SIGNUP_URL: 'nope' });
  assert.deepEqual(config.install.about.closed, ['croc'], 'read with the install');
  assert.ok(config.warnings.some((w) => w.startsWith('SIGNUP_URL')), 'and its mistakes said at the start');
  assert.deepEqual(config.errors, [], 'never one that stops it');
});

test('/api/auth/config says it, for Settings › About and the public pages', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'suite-core-about-'));
  const suite = createSuite({
    config: PRODUCT,
    env: {
      DATA_DIR: dir, PORT: '0', BASE_URL: 'http://127.0.0.1', SOURCE_REVISION: 'b'.repeat(40), SOURCE_CLOSED: 'payments',
      TERMS_URL: 'https://example.com/terms/', SIGNUP_URL: 'https://example.com/join',
    },
    log: () => {}, exitOnError: false,
  });
  const app = createApp({ suite, version: '3.4.5', handleSignals: false, log: () => {} });
  const server = await app.listen();
  t.after(async () => { await app.close(); suite.database.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  const config = await (await fetch(`http://127.0.0.1:${server.address().port}/api/auth/config`)).json();
  assert.equal(config.about.source, `https://github.com/cronumstudio/demo/tree/${'b'.repeat(40)}`);
  assert.deepEqual(config.about.closed, ['payments']);
  assert.deepEqual(config.about.links, { terms: 'https://example.com/terms/' });
  assert.deepEqual(config.about.copyright, COPYRIGHT);
  assert.equal(config.signup_url, 'https://example.com/join');
});
