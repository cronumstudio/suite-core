/**
 * Files an assistant attaches to an app's records through the MCP: a photo
 * for a task, a PDF for a note.
 *
 * An MCP tool carries JSON, not files, and an assistant writing a photo out as
 * base64 spends most of its answer on it and often gets it wrong. So a file
 * comes in one of two ways, and both end in the same place, a stream the
 * app's own save function takes as it takes a request (Notes' `saveFile`,
 * Tasks' `saveAttachment`), with its permission and plan checks unchanged:
 *
 * · **A link** (`file_url`): the server downloads it (uploads.js `fromUrl`,
 *   never from an address inside a network).
 * · **A one-time upload link**, for an assistant that can run a command
 *   (Claude Code): the tool answers an address, and the assistant sends the
 *   file there with curl. The address is the only credential: random, kept as
 *   a hash, good once, for 15 minutes, for one account that must still be
 *   active when the file arrives. No cookie opens it, and none replaces it.
 *
 * Links live in memory: a restart loses the ones open, and the assistant asks
 * for another, which costs nothing. In a host each module has its own, at its
 * own path (`/<mount>/api/mcp-uploads/…`), as its files are its own.
 *
 *   // an app's MCP tool
 *   handler: async (user, args) => {
 *     const out = await receiveFile({
 *       suite, userId: user.id, url: args.file_url, name: args.file_name,
 *       accept: (stream, { name }) => saveFile(user, args.note_id, stream, name),
 *     });
 *     return { content: [{ type: 'text', text: out.saved ? JSON.stringify(out.saved) : out.instructions }] };
 *   }
 */
import { randomToken, sha256 } from './crypto.js';
import { HttpError, notFound, sendJson } from './http.js';
import { answeredOnce } from './idempotency.js';

/** How long an upload link waits for its file. */
export const UPLOAD_LINK_MINUTES = 15;
/** Links open at once per app (or module): past it the oldest goes, so nobody can fill the memory. */
export const MAX_UPLOAD_LINKS = 100;

/**
 * The parameters an app's tool takes for a file, to spread into its
 * `inputSchema.properties`: the same names and words in every app, so an
 * assistant that learned one knows them all.
 */
export const FILE_PARAMS = Object.freeze({
  file_url: {
    type: 'string',
    description: 'A public http(s) link to the image (JPG, PNG, GIF, WebP) or PDF, downloaded by the server. '
      + 'Without it, the answer is a one-time upload link instead.',
  },
  file_name: { type: 'string', description: 'The name the file gets, such as "receipt.pdf". Optional.' },
});

/**
 * What an assistant reads when it gets an upload link: how to send the file,
 * and what to do when it can't run a command. In English, as every tool text.
 */
export function uploadLinkText({ url, expires_at: expiresAt }) {
  return `Upload the file within ${UPLOAD_LINK_MINUTES} minutes (until ${expiresAt}) with: `
    + `curl -X POST --data-binary @<path> "${url}?name=<file name>" (the name URL-encoded). `
    + 'The answer says where it went. The link works once. This works only where you can run a command '
    + '(e.g. Claude Code); in a chat without a shell, ask the person for a public link to the file instead.';
}

/**
 * The open upload links of an app (or of a module of a host).
 *
 * @param {object} options
 * @param {string} options.baseUrl    the app's public address (a module's includes its /<mount>)
 * @param {object} options.accounts   to check that whoever the link is for is still active
 */
export function createUploadLinks({
  baseUrl, accounts, minutes = UPLOAD_LINK_MINUTES, max = MAX_UPLOAD_LINKS, clock = () => Date.now(),
}) {
  const base = String(baseUrl).replace(/\/+$/, '');
  /** sha256(token) → { userId, name, accept, expires }, oldest first (a Map keeps the order). */
  const open = new Map();

  const prune = () => {
    const now = clock();
    for (const [key, link] of open) if (link.expires <= now) open.delete(key);
  };

  /**
   * A link for one file: `accept(stream, { name, user })` is called with the
   * request when it arrives, and what it returns is the answer (201, JSON).
   * → { url, expires_at }
   */
  function offer({ userId, name = null, accept }) {
    if (!userId) throw new Error('uploadLinks.offer: a userId is needed');
    if (typeof accept !== 'function') throw new Error('uploadLinks.offer: accept(stream, { name }) is needed');
    prune();
    while (open.size >= max) open.delete(open.keys().next().value);
    const token = randomToken(32);
    const expires = clock() + minutes * 60 * 1000;
    open.set(sha256(token), { userId, name: name ? String(name) : null, accept, expires });
    return { url: `${base}/api/mcp-uploads/${token}`, expires_at: new Date(expires).toISOString() };
  }

  /**
   * The link of a token, used up: → { userId, name, accept, user }, or null
   * when there is none, it expired, or its account is gone or disabled
   * (deleted, waiting to be deleted, or switched off by the admin). Taken out
   * before anything else: whatever happens next, it opens nothing again.
   */
  function take(token) {
    const key = sha256(String(token || ''));
    const link = open.get(key);
    if (!link) return null;
    open.delete(key);
    if (link.expires <= clock()) return null;
    const user = accounts.byId(link.userId);
    if (!user || user.disabled_at) return null;
    return { ...link, user };
  }

  return { offer, take, get size() { prune(); return open.size; } };
}

/**
 * `POST /api/mcp-uploads/:token`: the file of an upload link, as the raw body
 * with its name in `?name=` (as the apps' own upload routes take it). 201 with
 * what the app's `accept` answered; 404 `upload_link_not_found` for a link
 * that doesn't exist, expired or was used.
 *
 * The token is the only credential: the session a request may carry is never
 * looked at (no cookie opens a link someone else was given, and none replaces
 * the link). Never through the idempotency keys either: they belong to a
 * session, and a link answers once anyway.
 */
export function registerUploadLinksApi(api, { uploadLinks, limiter }) {
  api.post('/api/mcp-uploads/:token', answeredOnce(async (ctx) => {
    const { req, res } = ctx;
    const token = String(ctx.params.token || '');
    // Tokens carry 256 random bits: what the brake stops is a client repeating a dead one.
    const brake = limiter.checkToken(req, token);
    if (!brake.allowed) {
      req.resume();
      throw new HttpError(429, 'too_many_attempts', {}, { 'Retry-After': String(brake.retryAfter) });
    }
    const link = uploadLinks.take(token);
    if (!link) {
      limiter.tokenFailed(req, token);
      // Swallowed, not cut: cutting halfway makes curl report a broken pipe instead of the answer.
      req.resume();
      throw notFound('upload_link_not_found');
    }
    const name = ctx.query.get('name') ?? link.name ?? '';
    let saved;
    try {
      saved = await link.accept(req, { name, user: link.user });
    } catch (err) {
      // Refused before reading (a permission, a plan): the body is let through so the answer arrives.
      if (!req.readableEnded && !req.destroyed) req.resume();
      throw err;
    }
    sendJson(res, 201, saved ?? { ok: true });
  }));
}

/**
 * The whole of an app's tool for a file: with `url`, the file is downloaded
 * and handed to `accept(stream, { name })` → { saved: what accept returned };
 * without it, an upload link is offered for `accept` to take the file later →
 * { link: { url, expires_at }, instructions }, the sentence for the assistant.
 *
 * `accept` is the app's save function with its checks, the same for both: for
 * a link it runs when the file arrives, minutes later, so it checks again then
 * (it gets `{ name, user }`, the account as it is now). `fetchOptions` reach
 * `uploads.fromUrl` (tests only). Errors are the save function's, `fromUrl`'s
 * (uploads.js) and `store`'s, as codes.
 */
export async function receiveFile({ suite, userId, url = null, name = null, accept, fetchOptions = {} }) {
  if (typeof accept !== 'function') throw new Error('receiveFile: accept(stream, { name }) is needed');
  const given = typeof name === 'string' ? name.trim() : '';
  if (url) {
    if (!suite.uploads) throw new Error('receiveFile: a file from a link needs modules.uploads');
    const file = await suite.uploads.fromUrl(url, fetchOptions);
    try {
      return { saved: await accept(file.stream, { name: given || file.name }) };
    } finally {
      // Refused before it was read: the download doesn't stay open until its time runs out.
      if (!file.stream.readableEnded) file.stream.destroy();
    }
  }
  if (!suite.uploadLinks) throw new Error('receiveFile: an upload link needs modules.uploads and modules.mcp');
  const link = suite.uploadLinks.offer({ userId, name: given || null, accept });
  return { link, instructions: uploadLinkText(link) };
}
