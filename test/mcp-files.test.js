/**
 * Files an assistant attaches through the MCP (mcp-files.js): one-time upload
 * links (single use, a quarter of an hour, for an account still active, never
 * opened by a cookie), their route in an app and in a module of a host, and
 * `receiveFile`, the whole of an app's tool for a file.
 *
 *   npm test
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { createSuite, createApp } from '../app.js';
import { createHost, MCP_TEXT_MAX } from '../host.js';
import { HttpError } from '../http.js';
import {
  createUploadLinks, receiveFile, uploadLinkText, FILE_PARAMS, UPLOAD_LINK_MINUTES, MAX_UPLOAD_LINKS,
} from '../mcp-files.js';

const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(60, 7)]);
const PDF = Buffer.from('%PDF-1.7\n1 0 obj << >> endobj\n');

const PRODUCT = {
  app: { id: 'demo', name: 'Demo', port: 3999, languages: ['en'] },
  modules: { uploads: true },
  accounts: { minPasswordLength: 8 },
};

test('an upload link: single use, a quarter of an hour, for an account still active; the oldest goes past the limit', () => {
  let now = Date.parse('2026-10-16T10:00:00Z');
  const people = { 1: { id: 1, disabled_at: null }, 2: { id: 2, disabled_at: '2026-10-16T09:00:00Z' } };
  const links = createUploadLinks({
    baseUrl: 'https://app.example/notes/', accounts: { byId: (id) => people[id] ?? null }, clock: () => now,
  });
  const accept = () => 'saved';
  const tokenOf = (link) => link.url.split('/').at(-1);

  const link = links.offer({ userId: 1, name: 'receipt.pdf', accept });
  assert.match(link.url, /^https:\/\/app\.example\/notes\/api\/mcp-uploads\/[\w-]{43}$/, 'at the app’s own address, a module’s path included');
  assert.equal(link.expires_at, '2026-10-16T10:15:00.000Z');
  assert.equal(UPLOAD_LINK_MINUTES, 15);
  const taken = links.take(tokenOf(link));
  assert.deepEqual([taken.userId, taken.name, taken.accept, taken.user.id], [1, 'receipt.pdf', accept, 1]);
  assert.equal(links.take(tokenOf(link)), null, 'used once, it opens nothing again');
  assert.equal(links.take('made-up'), null);
  assert.equal(links.take(''), null);

  const late = links.offer({ userId: 1, accept });
  now += 15 * 60 * 1000;
  assert.equal(links.take(tokenOf(late)), null, 'expired');
  now += 1;
  assert.equal(links.size, 0, 'expired ones are forgotten');

  assert.equal(links.take(tokenOf(links.offer({ userId: 2, accept }))), null, 'a disabled account’s link opens nothing');
  assert.equal(links.take(tokenOf(links.offer({ userId: 3, accept }))), null, 'nor one of an account that is gone');

  const first = links.offer({ userId: 1, accept });
  for (let i = 0; i < MAX_UPLOAD_LINKS; i++) links.offer({ userId: 1, accept });
  assert.equal(links.size, MAX_UPLOAD_LINKS, 'never more than the limit in memory');
  assert.equal(links.take(tokenOf(first)), null, 'the oldest went');

  assert.throws(() => links.offer({ accept }), /userId/);
  assert.throws(() => links.offer({ userId: 1 }), /accept/);
});

test('what the assistant reads: how to send the file, and what to do without a shell, short enough for Claude Code', () => {
  const text = uploadLinkText({ url: 'https://app.example/api/mcp-uploads/abc', expires_at: '2026-10-16T10:15:00.000Z' });
  assert.match(text, /curl -X POST --data-binary @<path> "https:\/\/app\.example\/api\/mcp-uploads\/abc\?name=<file name>"/);
  assert.match(text, /15 minutes/);
  assert.match(text, /ask the person for a public link/);
  assert.ok(text.length < MCP_TEXT_MAX);
  assert.deepEqual(Object.keys(FILE_PARAMS), ['file_url', 'file_name']);
  assert.ok(Object.values(FILE_PARAMS).every((p) => p.type === 'string' && p.description.length < 300));
});

/** An app with uploads, an MCP and a save function of its own, over real HTTP. */
async function startApp(t, { product = PRODUCT } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'suite-core-mcp-files-'));
  const suite = createSuite({
    config: product, env: { DATA_DIR: dir, PORT: '0', ADMIN_PASSWORD: 'root-password', BASE_URL: 'http://127.0.0.1' },
    log: () => {}, exitOnError: false,
  });
  const app = createApp({
    suite, handleSignals: false, log: () => {},
    mcp: { tools: [{ name: 'noop', description: 'x', inputSchema: { type: 'object' }, handler: () => ({ content: [] }) }] },
  });
  const server = await app.listen();
  t.after(async () => { await app.close(); suite.database.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const admin = suite.database.get("SELECT id FROM users WHERE username = 'admin'");
  return { suite, base, admin, dir };
}

/** Sends a file to a link as curl does: the raw body, its name in ?name=. */
const upload = async (base, link, body, { query = '', headers = {} } = {}) => {
  const res = await fetch(`${base}${new URL(link.url).pathname}${query}`, { method: 'POST', body, headers });
  return { status: res.status, data: await res.json().catch(() => null) };
};

test('an app takes the file of an upload link through its own save function, once, and no cookie opens one', async (t) => {
  const { suite, base, admin } = await startApp(t);
  const saved = [];
  const accept = async (stream, { name, user }) => {
    const file = await suite.uploads.store(stream, { folder: String(user.id), name });
    saved.push(file);
    return { attached: file.name, mime: file.mime };
  };
  const link = suite.uploadLinks.offer({ userId: admin.id, name: 'Kitchen.jpg', accept });
  assert.ok(link.url.startsWith('http://127.0.0.1/api/mcp-uploads/'), 'at the app’s public address');

  const first = await upload(base, link, JPEG);
  assert.deepEqual(first, { status: 201, data: { attached: 'Kitchen.jpg', mime: 'image/jpeg' } });
  assert.deepEqual(fs.readFileSync(suite.uploads.resolve(saved[0].path)), JPEG);
  assert.deepEqual(await upload(base, link, JPEG), { status: 404, data: { error: 'upload_link_not_found' } }, 'once');

  const named = suite.uploadLinks.offer({ userId: admin.id, accept });
  assert.equal((await upload(base, named, PDF, { query: '?name=Receipt%20March.pdf' })).data.attached, 'Receipt March.pdf',
    'the name curl sends');
  assert.deepEqual(await upload(base, { url: 'http://x/api/mcp-uploads/made-up' }, JPEG),
    { status: 404, data: { error: 'upload_link_not_found' } });

  // A session is never a link: a signed-in browser with a wrong token gets the same 404.
  const login = await fetch(`${base}/api/auth/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'admin', password: 'root-password' }),
  });
  const cookie = login.headers.getSetCookie().find((c) => c.startsWith('demo_sid=')).split(';')[0];
  assert.deepEqual(await upload(base, { url: 'http://x/api/mcp-uploads/made-up' }, JPEG, { headers: { Cookie: cookie } }),
    { status: 404, data: { error: 'upload_link_not_found' } });

  // What the save function refuses is its answer; the link is spent all the same.
  const refusing = suite.uploadLinks.offer({ userId: admin.id, accept });
  assert.deepEqual(await upload(base, refusing, Buffer.from('<svg/> not an image at all')), { status: 400, data: { error: 'file_type' } });
  assert.equal((await upload(base, refusing, JPEG)).status, 404);
  const forbidden = suite.uploadLinks.offer({
    userId: admin.id, accept: () => { throw new HttpError(403, 'plan_limit', { feature: 'storage.mb' }); },
  });
  assert.deepEqual(await upload(base, forbidden, JPEG), { status: 403, data: { error: 'plan_limit', feature: 'storage.mb' } },
    'refused before reading: the answer still arrives');

  // An account switched off between the offer and the file.
  const later = suite.uploadLinks.offer({ userId: admin.id, accept });
  suite.database.run('UPDATE users SET disabled_at = ? WHERE id = ?', new Date().toISOString(), admin.id);
  assert.equal((await upload(base, later, JPEG)).status, 404);
  assert.equal(saved.length, 2);
  assert.equal((await fetch(`${base}/api/mcp-uploads/abc`)).status, 405, 'only POST');
});

test('without the MCP or without uploads there are no upload links, and their route is not there', async (t) => {
  for (const modules of [{ uploads: true, mcp: false }, { uploads: false }]) {
    const { suite, base } = await startApp(t, { product: { ...PRODUCT, modules } });
    assert.equal(suite.uploadLinks, null, JSON.stringify(modules));
    assert.equal((await upload(base, { url: 'http://x/api/mcp-uploads/abc' }, JPEG)).data.error, 'not_found');
  }
});

test('receiveFile: a file from a link goes straight to the save function; without one, an upload link and how to use it', async (t) => {
  const { suite, base, admin } = await startApp(t);
  const site = http.createServer((req, res) => res.writeHead(200, { 'Content-Length': PDF.length }).end(PDF));
  await new Promise((r) => site.listen(0, '127.0.0.1', r));
  t.after(() => site.close());
  const fetchOptions = { allowPrivate: true };
  const accept = (stream, { name }) => suite.uploads.store(stream, { folder: 'mcp', name });

  const fromLink = await receiveFile({
    suite, userId: admin.id, url: `http://127.0.0.1:${site.address().port}/files/contract.pdf`, accept, fetchOptions,
  });
  assert.deepEqual([fromLink.saved.name, fromLink.saved.mime], ['contract.pdf', 'application/pdf']);
  const renamed = await receiveFile({
    suite, userId: admin.id, url: `http://127.0.0.1:${site.address().port}/x`, name: ' Signed.pdf ', accept, fetchOptions,
  });
  assert.equal(renamed.saved.name, 'Signed.pdf', 'the name the assistant gives wins');
  await assert.rejects(receiveFile({ suite, userId: admin.id, url: `http://127.0.0.1:${site.address().port}/x`, accept }),
    { code: 'file_url_private' }, 'never inside a network without the test’s override');
  // Refused before reading: the download is closed, not left open until its time runs out.
  let opened = null;
  await assert.rejects(receiveFile({
    suite, userId: admin.id, url: `http://127.0.0.1:${site.address().port}/x`, fetchOptions,
    accept: (stream) => { opened = stream; throw Object.assign(new Error('no'), { code: 'forbidden', status: 403 }); },
  }), { code: 'forbidden' });
  assert.equal(opened.destroyed, true);

  const offered = await receiveFile({ suite, userId: admin.id, name: 'Plan.pdf', accept });
  assert.equal(offered.saved, undefined);
  assert.match(offered.link.url, /^http:\/\/127\.0\.0\.1\/api\/mcp-uploads\//);
  assert.equal(offered.instructions, uploadLinkText(offered.link));
  const sent = await upload(base, offered.link, PDF);
  assert.deepEqual([sent.status, sent.data.name], [201, 'Plan.pdf'], 'the name given when it was offered');
});

test('in a host, each module has its own upload links at its own path', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'suite-core-mcp-files-host-'));
  const host = await createHost({
    config: { app: { id: 'work', name: 'Work', languages: ['en', 'es'] }, accounts: { minPasswordLength: 8 } },
    modules: [
      { mount: 'alpha', entry: new URL('./fixtures/host/alpha/module.js?case=mcp-files', import.meta.url) },
      { mount: 'beta', entry: new URL('./fixtures/host/beta/module.js?case=mcp-files', import.meta.url) },
    ],
    env: { DATA_DIR: dir, PORT: '0', ADMIN_PASSWORD: 'root-password', BASE_URL: 'http://127.0.0.1' },
    handleSignals: false, exitOnError: false, log: () => {},
  });
  const server = await host.listen();
  t.after(async () => { await host.close(); host.suite.database.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const [alpha, beta] = host.modules;
  const admin = host.suite.database.get("SELECT id FROM users WHERE username = 'admin'");
  assert.notEqual(alpha.suite.uploadLinks, beta.suite.uploadLinks);

  const link = alpha.suite.uploadLinks.offer({
    userId: admin.id, accept: (stream, { name }) => alpha.suite.uploads.store(stream, { folder: '1', name }),
  });
  assert.match(link.url, /^http:\/\/127\.0\.0\.1\/alpha\/api\/mcp-uploads\/[\w-]+$/, 'the module’s address, its path included');
  const res = await fetch(`${base}${new URL(link.url).pathname}?name=photo.jpg`, { method: 'POST', body: JPEG });
  assert.equal(res.status, 201);
  const stored = await res.json();
  assert.ok(fs.existsSync(path.join(dir, 'uploads', 'alpha', stored.path)), 'in the module’s own folder');
  const elsewhere = alpha.suite.uploadLinks.offer({ userId: admin.id, accept: () => ({}) });
  const wrongModule = await fetch(`${base}${new URL(elsewhere.url).pathname.replace('/alpha/', '/beta/')}`, { method: 'POST', body: JPEG });
  assert.equal(wrongModule.status, 404, 'another module’s link is nothing in this one');
});
