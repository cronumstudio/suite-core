/**
 * The front end's fingerprint and the static files' ETags come from what the
 * files hold, not from their dates: every deploy clones the repository afresh,
 * so every date changes while the code may not.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { frontFingerprint } from '../app.js';
import { fingerprint, shellHashes } from '../host-worker.js';
import { contentHash, serveStatic } from '../http.js';

/** A public folder with a page, a script and a catalog, every file dated `when`. */
function publicFolder(t, { script = 'export const a = 1;\n', when = new Date('2026-01-01T00:00:00Z') } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'suite-core-print-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.mkdirSync(path.join(dir, 'js'));
  fs.mkdirSync(path.join(dir, 'i18n'));
  fs.writeFileSync(path.join(dir, 'index.html'), '<!doctype html><title>x</title>');
  fs.writeFileSync(path.join(dir, 'js', 'app.js'), script);
  fs.writeFileSync(path.join(dir, 'i18n', 'en.json'), '{"hello":"Hello"}');
  touch(dir, when);
  return dir;
}

/** Dates every file of `dir` at `when`, as a fresh checkout does at the build. */
function touch(dir, when) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true, recursive: true })) {
    if (entry.isFile()) fs.utimesSync(path.join(entry.parentPath, entry.name), when, when);
  }
}

/** What serveStatic answers for `url`, a HEAD with `If-None-Match` when given. */
function head(root, url, ifNoneMatch) {
  const answer = { status: null, headers: null };
  const res = {
    req: { method: 'HEAD', headers: ifNoneMatch ? { 'if-none-match': ifNoneMatch } : {} },
    writeHead(status, headers) { answer.status = status; answer.headers = headers; },
    end() {},
  };
  assert.equal(serveStatic(root, url, res), true);
  return answer;
}

test('fingerprint: the same files with other dates are the same version; `built` still moves', (t) => {
  const one = publicFolder(t, { when: new Date('2026-01-01T00:00:00Z') });
  const two = publicFolder(t, { when: new Date('2026-06-01T12:34:56Z') });
  for (const print of [frontFingerprint, fingerprint]) {
    const a = print(one);
    const b = print(two);
    assert.equal(a.version, b.version);
    assert.notEqual(a.built, b.built);
    assert.equal(b.built, '2026-06-01T12:34:56.000Z');
  }
});

test('fingerprint: a file that holds something else is another version, even with the same size and date', (t) => {
  const when = new Date('2026-01-01T00:00:00Z');
  const one = publicFolder(t, { script: 'export const a = 1;\n', when });
  const two = publicFolder(t, { script: 'export const a = 2;\n', when });
  assert.equal(fs.statSync(path.join(one, 'js', 'app.js')).size, fs.statSync(path.join(two, 'js', 'app.js')).size);
  assert.notEqual(frontFingerprint(one).version, frontFingerprint(two).version);
  assert.notEqual(fingerprint(one).version, fingerprint(two).version);
});

test('fingerprint: a change in place is seen at once, and a file moved to another folder too', (t) => {
  const dir = publicFolder(t);
  const before = frontFingerprint(dir).version;
  fs.writeFileSync(path.join(dir, 'js', 'app.js'), 'export const a = 3;\n');
  const edited = frontFingerprint(dir).version;
  assert.notEqual(edited, before);
  assert.equal(fingerprint(dir).version, fingerprint(dir).version);

  fs.mkdirSync(path.join(dir, 'js', 'lib'));
  fs.renameSync(path.join(dir, 'js', 'app.js'), path.join(dir, 'js', 'lib', 'app.js'));
  assert.notEqual(frontFingerprint(dir).version, edited);
});

test('contentHash: what the file holds, read again when it changes', (t) => {
  const dir = publicFolder(t);
  const file = path.join(dir, 'js', 'app.js');
  const first = contentHash(file);
  assert.match(first, /^[0-9a-f]{40}$/);
  fs.utimesSync(file, new Date('2027-01-01T00:00:00Z'), new Date('2027-01-01T00:00:00Z'));
  assert.equal(contentHash(file), first);
  fs.writeFileSync(file, 'export const b = 1;\n');
  assert.notEqual(contentHash(file), first);
});

test('serveStatic: the same file in a new build keeps its ETag and is a 304; another content is a 200', (t) => {
  const one = publicFolder(t, { when: new Date('2026-01-01T00:00:00Z') });
  const two = publicFolder(t, { when: new Date('2026-06-01T00:00:00Z') });
  const first = head(one, '/js/app.js');
  assert.equal(first.status, 200);
  const etag = first.headers.ETag;
  assert.match(etag, /^W\/"\d+-[0-9a-f]{16}"$/);
  assert.equal(head(two, '/js/app.js').headers.ETag, etag);
  assert.equal(head(two, '/js/app.js', etag).status, 304);

  fs.writeFileSync(path.join(two, 'js', 'app.js'), 'export const a = 9;\n');
  const changed = head(two, '/js/app.js', etag);
  assert.equal(changed.status, 200);
  assert.notEqual(changed.headers.ETag, etag);
});

test('a release that changes only the kit changes its fingerprint and that file’s hash, nothing else (shellHashes)', (t) => {
  const kitDir = publicFolder(t);
  const tasks = publicFolder(t, { script: 'export const tasks = 1;\n' });
  const shell = ['/tasks/', '/tasks/index.html', '/tasks/js/app.js', '/tasks/js/app-version.js', '/tasks/i18n/en.json', '/tasks/i18n/de.json'];
  const places = [{ base: '/tasks/', dir: tasks, i18nDir: path.join(tasks, 'i18n') }];
  const before = shellHashes(shell, { kitDir, places, catalogs: 'texts-1' });
  const kitBefore = fingerprint(kitDir).version;
  assert.equal(before['/tasks/'], undefined, 'pages always travel again');
  assert.equal(before['/tasks/index.html'], undefined);
  assert.equal(before['/tasks/js/app-version.js'], undefined, 'written by the server');
  assert.match(before['/tasks/js/app.js'], /^[0-9a-f]{16}$/);
  assert.match(before['/suite/js/app.js'], /^[0-9a-f]{16}$/, 'every file of the kit, at /suite/');
  assert.match(before['/tasks/i18n/de.json'], /^[0-9a-f]{16}$/, 'a catalog the app has no file for still carries the suite’s texts');

  fs.writeFileSync(path.join(kitDir, 'js', 'app.js'), 'export const a = 2;\n');
  const after = shellHashes(shell, { kitDir, places, catalogs: 'texts-1' });
  assert.notEqual(fingerprint(kitDir).version, kitBefore, 'a new version: a new worker');
  assert.deepEqual(Object.keys(after).filter((url) => after[url] !== before[url]), ['/suite/js/app.js']);

  const texts = shellHashes(shell, { kitDir, places, catalogs: 'texts-2' });
  assert.deepEqual(Object.keys(texts).filter((url) => texts[url] !== after[url]).sort(), ['/tasks/i18n/de.json', '/tasks/i18n/en.json'],
    'the suite’s texts change every catalog');
});
