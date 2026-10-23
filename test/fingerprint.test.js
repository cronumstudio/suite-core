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
import { fingerprint } from '../host-worker.js';
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
  const a = fingerprint(one);
  const b = fingerprint(two);
  assert.equal(a.version, b.version);
  assert.notEqual(a.built, b.built);
  assert.equal(b.built, '2026-06-01T12:34:56.000Z');
});

test('fingerprint: a file that holds something else is another version, even with the same size and date', (t) => {
  const when = new Date('2026-01-01T00:00:00Z');
  const one = publicFolder(t, { script: 'export const a = 1;\n', when });
  const two = publicFolder(t, { script: 'export const a = 2;\n', when });
  assert.equal(fs.statSync(path.join(one, 'js', 'app.js')).size, fs.statSync(path.join(two, 'js', 'app.js')).size);
  assert.notEqual(fingerprint(one).version, fingerprint(two).version);
});

test('fingerprint: a change in place is seen at once, and a file moved to another folder too', (t) => {
  const dir = publicFolder(t);
  const before = fingerprint(dir).version;
  fs.writeFileSync(path.join(dir, 'js', 'app.js'), 'export const a = 3;\n');
  const edited = fingerprint(dir).version;
  assert.notEqual(edited, before);

  fs.mkdirSync(path.join(dir, 'js', 'lib'));
  fs.renameSync(path.join(dir, 'js', 'app.js'), path.join(dir, 'js', 'lib', 'app.js'));
  assert.notEqual(fingerprint(dir).version, edited);
});

test('fingerprint: only what the browser loads counts, by its real extension', (t) => {
  const dir = publicFolder(t);
  const before = fingerprint(dir).version;
  // Not a script, a style or a page: names that merely end in those letters.
  fs.writeFileSync(path.join(dir, 'js', 'notesjs'), 'x');
  fs.writeFileSync(path.join(dir, 'foocss'), 'x');
  fs.writeFileSync(path.join(dir, 'logo.png'), 'x');
  assert.equal(fingerprint(dir).version, before);
  fs.writeFileSync(path.join(dir, 'js', 'more.js'), 'export {};');
  assert.notEqual(fingerprint(dir).version, before);
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
