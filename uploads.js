/**
 * Files people attach —photos and PDFs— from Tasks, for every app.
 *
 * Three decisions explain the rest:
 *
 * · **No `multipart/form-data`.** The suite has no dependencies, and parsing
 *   multipart by hand is eighty delicate lines of looking for boundaries
 *   between buffers. The app's page and server are both ours, so the file
 *   travels as the raw request body and its name in the query; the server
 *   streams the request to disk and that's it.
 * · **The folder never grants anything.** Files are kept per person, so they
 *   can be looked at from the NAS, but who may see one is decided by the app
 *   (Tasks: the list of its task). A folder protects nothing, so files are
 *   never served as static files: `serve()` answers after the app checked.
 * · **The Content-Type is not trusted.** The first bytes are, and only what
 *   really is an image or a PDF is stored —and sent back—. Serving a stranger's
 *   file from the app's domain is the part with an edge. Never SVG: it is XML
 *   and can carry scripts.
 *
 * The app keeps its own table linking files to its records (Tasks'
 * `task_files`), its limits per record and its trash; the suite stores,
 * serves, removes, and sweeps what nobody owns any more.
 *
 * A file can also come from a link (`fromUrl`), for an assistant that has the
 * address of a photo and not its bytes: an MCP tool can't carry a file, and an
 * assistant writing a photo out as base64 would be most of its answer. The
 * download is a stream like a request, so the app's own save function, with
 * its permission and plan checks, takes it unchanged. The server fetching an
 * address someone else chose is the part with an edge: see `openUrl`.
 */
import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import dns from 'node:dns/promises';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { randomToken } from './crypto.js';
import { HttpError, badRequest, notFound } from './http.js';

/** What is accepted, recognised by its first bytes. */
export const FILE_TYPES = Object.freeze([
  { mime: 'image/jpeg', ext: 'jpg', bytes: [0xff, 0xd8, 0xff] },
  { mime: 'image/png', ext: 'png', bytes: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] },
  { mime: 'image/gif', ext: 'gif', bytes: [0x47, 0x49, 0x46, 0x38] },
  { mime: 'application/pdf', ext: 'pdf', bytes: [0x25, 0x50, 0x44, 0x46, 0x2d] },
]);

/** How many bytes it takes to decide what a file is. */
const HEADER = 16;

/** What a file is, looking at it: { mime, ext }, or null when it's none of the accepted ones. */
export function detectType(buf) {
  for (const type of FILE_TYPES) {
    if (type.bytes.every((b, i) => buf[i] === b)) return { mime: type.mime, ext: type.ext };
  }
  // WebP is "RIFF", four bytes of size, then "WEBP": the gap means two checks.
  if (buf.length >= 12 && buf.subarray(0, 4).toString('latin1') === 'RIFF'
    && buf.subarray(8, 12).toString('latin1') === 'WEBP') {
    return { mime: 'image/webp', ext: 'webp' };
  }
  return null;
}

export const isImage = (mime) => String(mime || '').startsWith('image/');

/**
 * A file name that can be written without fear. It keeps what is readable,
 * so the folder makes sense from the NAS, and drops everything else: slashes,
 * double dots, accents (they travel badly between systems) and anything odd.
 */
export function safeName(name) {
  // The last part of a path, with either kind of slash (a Windows name on a Linux server too).
  const base = path.posix.basename(String(name || '').replace(/\\/g, '/')).normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-zA-Z0-9._-]+/g, '-')
    .replace(/^[.-]+/, '')                 // neither hidden nor starting with a dash
    .replace(/-{2,}/g, '-')
    .slice(0, 60);
  return base || 'file';
}

/**
 * Where a file is kept, relative to the folder: `<folder>/<random>-<name>.<ext>`.
 * Eight random bytes in front: two photos with the same name don't overwrite
 * each other, and a stranger's address can't be guessed. The extension is the
 * one its bytes say, whatever the name claimed.
 */
export function storedName({ folder, name, ext }) {
  const clean = safeName(name);
  const withExtension = clean.toLowerCase().endsWith(`.${ext}`) ? clean : `${clean}.${ext}`;
  return `${folder}/${randomToken(8)}-${withExtension}`;
}

/** Taking more than half of the folder at once isn't tidying loose ends. */
const MAX_ORPHAN_SHARE = 0.5;

/**
 * @param {object} options
 * @param {string} options.dir         where files live (DATA_DIR/uploads)
 * @param {number} [options.maxBytes]  per file: photos arrive already reduced by the browser
 *   (~300 kB); this is for PDFs, and so a broken client can't fill the disk
 * @param {Function} [options.storage]  () → the app's storage (storage.js), for `storeChecked`;
 *   asked when a file arrives, as an app on its own learns what it keeps only in createApp
 */
export function createUploads({
  dir, maxBytes = 15 * 1024 * 1024, log = console.log, clock = () => Date.now(), storage = null,
}) {
  const root = path.resolve(dir);

  /** The absolute path of a stored file, or null when the record points outside the folder. */
  function resolve(relative) {
    if (!relative) return null;
    const absolute = path.resolve(root, String(relative));
    // A belt: a stored path must fall inside the folder, whatever happens.
    return absolute.startsWith(root + path.sep) ? absolute : null;
  }

  /**
   * Streams the request body into `<dir>/<folder>/<random>-<name>.<ext>`.
   * → { path (relative, what the app stores), name, mime, size }.
   *
   * It is written as `.partial` and renamed only at the end: a connection cut
   * halfway —a phone leaving the building— never leaves a broken photo
   * passing for a good one. A file that isn't accepted never touches the disk:
   * nothing is written until its first bytes say what it is.
   *
   * Errors: `file_type` and `file_empty` (400), `file_too_large` (413),
   * `upload_cut` (the connection dropped).
   */
  function store(req, { folder, name }) {
    return new Promise((resolvePromise, reject) => {
      // A stream that died before anyone read it (a download from a link, cut
      // while the app was still checking permissions) never ends: answered now,
      // instead of a promise that waits forever.
      if (req.destroyed) {
        reject(req.errored instanceof HttpError ? req.errored : badRequest('upload_cut'));
        return;
      }
      const target = path.join(root, String(folder));
      if (!resolve(`${folder}/x`)) {
        req.resume();
        reject(new Error(`uploads: "${folder}" is not a folder inside ${root}`));
        return;
      }
      fs.mkdirSync(target, { recursive: true });

      let head = Buffer.alloc(0);
      let type = null;
      let written = 0;
      let relative = null;
      let partial = null;
      let out = null;
      let failed = false;
      let reason = null;

      /**
       * The half-written file goes. Windows can't delete a file that is still
       * open, and the stream closes a moment after it is destroyed: there it
       * goes once it has. Elsewhere it goes now.
       */
      const discard = () => {
        if (out) out.destroy();
        if (!partial) return;
        const file = partial;
        const unlink = () => { try { fs.unlinkSync(file); return true; } catch { return false; } };
        if (!unlink() && out) out.once('close', unlink);
      };

      /**
       * Refuses the upload. By default without cutting the connection: the
       * rest is swallowed and the answer comes at the end. Cutting halfway
       * makes the browser see a network error instead of the reason, and the
       * page would say "offline" when the file just wasn't an image. Only a
       * file that is too big is cut: swallowing its megabytes to be polite is
       * exactly what the limit avoids.
       */
      const refuse = (err, { cut = false } = {}) => {
        if (failed) return;
        failed = true;
        reason = err;
        discard();
        if (cut) { req.destroy(); reject(err); return; }
        req.resume();
      };

      // When the disk is slower than the network, reading pauses until it
      // drains: a big PDF never piles up whole in memory.
      const write = (chunk) => {
        if (out.write(chunk)) return;
        req.pause();
        out.once('drain', () => req.resume());
      };

      req.on('data', (chunk) => {
        if (failed) return;
        written += chunk.length;
        if (written > maxBytes) {
          refuse(new HttpError(413, 'file_too_large', { max_mb: Math.round(maxBytes / 1024 / 1024) }), { cut: true });
          return;
        }
        if (!type) {
          head = Buffer.concat([head, chunk]);
          if (head.length < HEADER) return;
          type = detectType(head);
          if (!type) {
            refuse(badRequest('file_type'));
            return;
          }
          relative = storedName({ folder, name, ext: type.ext });
          partial = `${resolve(relative)}.partial`;
          out = fs.createWriteStream(partial);
          out.on('error', (err) => refuse(err, { cut: true }));
          write(head);
          return;
        }
        write(chunk);
      });

      req.on('aborted', () => refuse(badRequest('upload_cut')));
      req.on('error', (err) => refuse(err, { cut: true }));

      req.on('end', () => {
        // Refused on the way, the rest let through: now, with the whole
        // request read, is when the answer with the reason can go.
        if (reason) { reject(reason); return; }
        if (failed) return;
        // `refuse` would wait for an end that just happened: here it is cleaned and answered now.
        const failNow = (err) => {
          failed = true;
          discard();
          reject(err);
        };
        if (!written) { failNow(badRequest('file_empty')); return; }
        // A file so small it didn't even fill the header.
        if (!type) {
          type = detectType(head);
          if (!type) { failNow(badRequest('file_type')); return; }
          relative = storedName({ folder, name, ext: type.ext });
          partial = `${resolve(relative)}.partial`;
          out = fs.createWriteStream(partial);
          out.on('error', failNow);
          out.write(head);
        }
        out.end(() => {
          try {
            fs.renameSync(partial, resolve(relative));
          } catch (err) { failNow(err); return; }
          resolvePromise({
            path: relative,
            name: String(name || '').trim().slice(0, 120) || `file.${type.ext}`,
            mime: type.mime,
            size: written,
          });
        });
      });
    });
  }

  /**
   * `store()` with an app's limits around it, as Tasks, Projects and Notes each
   * did by hand: count, check, store, count again. → what `store` returns.
   *
   * · `count()` and `max`: how many files the record holds now (its trash too,
   *   if the app counts it) and how many it may; `too_many_files` (400, with
   *   `max`) when it is full. Without them, no cap.
   * · `user` and `payer`: who adds the file and whose plan pays for it (by
   *   default the same person), against `storage.mb` (storage.js `check`):
   *   402 `plan_limit` past it. Without either, no storage check.
   *
   * Both are asked before a byte is read, with one byte for the storage (the
   * size isn't known yet), and the body is swallowed so the answer can be sent.
   * Then again once the file is on disk, with its real size: uploads sent
   * together all passed the first count, and the second refuses the ones past
   * the cap, taking their file off the disk. The app records what comes back.
   */
  async function storeChecked(req, { folder, name, user = null, payer = user, count = null, max = null }) {
    let plan = null;
    const room = (adding) => {
      if (max != null && count && count() >= max) throw badRequest('too_many_files', { max });
      if (plan) plan.check(user, adding, { payer });
    };
    try {
      plan = payer ? (typeof storage === 'function' ? storage() : storage) : null;
      if (payer && !plan) throw new Error('uploads.storeChecked: a payer, and no storage to check it against (createApp `storage`)');
      room(1);
    } catch (err) {
      req.resume();
      throw err;
    }
    const stored = await store(req, { folder, name });
    try {
      room(stored.size);
    } catch (err) {
      remove(stored.path);
      throw err;
    }
    return stored;
  }

  /** Deletes a stored file from the disk; false when it wasn't there. */
  function remove(relative) {
    const absolute = resolve(relative);
    if (!absolute) return false;
    try { fs.unlinkSync(absolute); return true; } catch { return false; }
  }

  /**
   * Sends a stored file, once the app has checked who may see it. `file` is
   * the app's record: { path, name, mime } and an `id` for its ETag.
   * With `download`, the browser saves it instead of showing it.
   */
  function serve(req, res, file, { download = false } = {}) {
    const absolute = resolve(file.path);
    let stat;
    try { stat = fs.statSync(absolute); } catch { throw notFound('file_missing'); }
    const etag = `W/"f${file.id ?? ''}-${stat.size}-${Math.floor(stat.mtimeMs)}"`;
    const headers = {
      // The browser keeps to the type we say instead of guessing: it's what
      // stops an uploaded file from running on the app's domain.
      'X-Content-Type-Options': 'nosniff',
      ETag: etag,
      // `no-cache` isn't "don't keep it": it's "keep it, but always ask". The
      // permission can change and the browser's cache belongs to the device,
      // not to the session: with a long max-age, signing out on an iPad and
      // someone else signing in showed them the previous person's photo.
      // Revalidating costs a bodyless 304, and the check always happens.
      'Cache-Control': 'private, no-cache',
    };
    if (req.headers['if-none-match'] === etag) {
      res.writeHead(304, headers);
      res.end();
      return;
    }
    // The name travels in a header: ASCII there, and the real one apart. A
    // stray accent in it breaks the whole response.
    const ascii = String(file.name).replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '');
    res.writeHead(200, {
      ...headers,
      'Content-Type': file.mime,
      'Content-Length': stat.size,
      'Content-Disposition': `${download ? 'attachment' : 'inline'}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(file.name)}`,
    });
    // The stat says the file was there a moment ago, not that it can be read
    // to the end: the purge may take it, the volume unmount, the disk fail
    // halfway. A read stream that fails emits 'error', and an 'error' nobody
    // listens to doesn't fail this request: it takes the whole process down,
    // and everyone's live connections with it. The headers already left, so
    // the honest thing is to cut: the client sees a truncated download.
    const stream = fs.createReadStream(absolute);
    stream.on('error', (err) => {
      log(`[uploads] could not read ${file.path}: ${err.code || err.message}`);
      res.destroy(err);
    });
    // And whoever leaves early doesn't keep the file open.
    res.on('close', () => stream.destroy());
    stream.pipe(res);
  }

  /**
   * Sweeps the files nobody owns any more: a net, not the mechanism (each
   * deletion takes its files with it, but several paths destroy records and
   * one slip is enough to leave garbage nobody will look at again). `live` is
   * every path the app's table(s) still know.
   *
   * Only what has been loose for over a day is touched: an upload halfway
   * exists on disk before it does in the database.
   *
   * And it DOES NOT TRUST THE DATABASE. In Tasks this net once had a hole the
   * size of the folder: a server started against the wrong or a brand-new
   * database —a renamed file, DB_PATH pointing elsewhere, half a restore, a
   * volume that didn't mount— lists no live files, EVERYTHING looks orphaned,
   * and the sweep deletes everyone's photos. A day's age doesn't protect from
   * that: the real files are precisely the old ones. So before deleting it asks
   * whether what it's about to do makes sense, and when in doubt it does
   * nothing and says so. A sweep that doesn't run leaves garbage; one that runs
   * when it shouldn't destroys somebody's photos.
   */
  function sweep(live) {
    if (!fs.existsSync(root)) return 0;
    const known = new Set(live);
    const dayAgo = clock() - 24 * 3600 * 1000;
    // First look, then delete.
    const onDisk = [];
    const candidates = [];
    for (const folder of fs.readdirSync(root, { withFileTypes: true })) {
      if (!folder.isDirectory()) continue;
      const folderPath = path.join(root, folder.name);
      for (const entry of fs.readdirSync(folderPath, { withFileTypes: true })) {
        if (!entry.isFile()) continue;
        const full = path.join(folderPath, entry.name);
        onDisk.push(full);
        if (known.has(`${folder.name}/${entry.name}`)) continue;
        try {
          if (fs.statSync(full).mtimeMs > dayAgo) continue;
        } catch { continue; }
        candidates.push(full);
      }
    }
    if (!candidates.length) return 0;
    // Files on disk and a database that knows none: that isn't spare files,
    // it's a database that doesn't go with this folder.
    if (!known.size) {
      log(`[uploads] SWEEP CANCELLED: ${onDisk.length} file(s) on disk and the database knows none. That points to an`
        + ' empty or wrong database, not to spare files. Check DB_PATH and the data volume. Nothing was deleted.');
      return 0;
    }
    if (candidates.length > onDisk.length * MAX_ORPHAN_SHARE) {
      log(`[uploads] SWEEP CANCELLED: ${candidates.length} of ${onDisk.length} file(s) would go, more than half of the`
        + ' folder. A normal sweep takes loose ends, not half the disk. Check the database is the right one.'
        + ' Nothing was deleted.');
      return 0;
    }
    let deleted = 0;
    for (const full of candidates) {
      try { fs.unlinkSync(full); deleted += 1; } catch { /* someone else took it */ }
    }
    if (deleted) log(`[uploads] ${deleted} file(s) nobody owned were removed`);
    return deleted;
  }

  /**
   * A file from a link, as `openUrl` with this folder's `maxBytes`: → { stream, name },
   * the stream for `store()` (or for the app's save function, which calls it).
   */
  const fromUrl = (url, options = {}) => openUrl(url, { maxBytes, ...options });

  return { dir: root, maxBytes, store, storeChecked, resolve, remove, serve, sweep, fromUrl };
}

/* ------------------------------ from a link ------------------------------- */

/** Answers that send the download elsewhere: followed by hand, each new address checked again. */
const REDIRECTS = new Set([301, 302, 303, 307, 308]);

const unreachable = () => badRequest('file_url_unreachable');

function publicV4(ip) {
  const [a, b, c] = ip.split('.').map(Number);
  return !(a === 0 || a === 10 || a === 127                 // "this network", private, loopback
    || (a === 100 && b >= 64 && b <= 127)                    // shared by carriers (CGNAT)
    || (a === 169 && b === 254)                              // link-local: cloud metadata lives here
    || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)
    || (a === 192 && b === 0 && (c === 0 || c === 2))        // protocol assignments, documentation
    || (a === 192 && b === 88 && c === 99)                   // the old 6to4 relays
    || (a === 198 && (b === 18 || b === 19))                 // benchmarking
    || (a === 198 && b === 51 && c === 100) || (a === 203 && b === 0 && c === 113)
    || a >= 224);                                            // multicast, reserved, broadcast
}

/** An IPv6 address as its eight 16-bit words: `::` expanded, a dotted tail turned into two words. */
function ipv6Words(ip) {
  let text = ip.toLowerCase().split('%')[0];
  const tail = /(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(text);
  if (tail) {
    const [a, b, c, d] = tail.slice(1).map(Number);
    text = `${text.slice(0, tail.index)}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }
  const [head, rest] = text.split('::');
  const before = head ? head.split(':') : [];
  const after = rest === undefined ? null : (rest ? rest.split(':') : []);
  const words = after === null ? before : [...before, ...Array(8 - before.length - after.length).fill('0'), ...after];
  return words.map((w) => parseInt(w, 16));
}

/** The IPv4 address two words of an IPv6 one carry. */
const v4Of = (high, low) => `${high >> 8}.${high & 255}.${low >> 8}.${low & 255}`;

/**
 * Whether an address is on the public internet, the only place the server
 * fetches a file from. Anything else is somebody's inside: the NAS's admin
 * page, the router, the cloud's metadata service at 169.254.169.254. IPv6 is
 * only public in 2000::/3, and the forms that carry an IPv4 address inside
 * (mapped, NAT64, 6to4) are judged by that address: `::ffff:127.0.0.1` is
 * loopback written another way.
 */
export function isPublicAddress(ip) {
  const text = String(ip || '').trim();
  const family = net.isIP(text.split('%')[0]);
  if (family === 4) return publicV4(text);
  if (family !== 6) return false;
  const w = ipv6Words(text);
  if (w.length !== 8 || w.some((x) => !Number.isInteger(x))) return false;
  const zeros = (from, to) => w.slice(from, to).every((x) => x === 0);
  if (zeros(0, 5) && w[5] === 0xffff) return publicV4(v4Of(w[6], w[7]));                 // ::ffff:a.b.c.d
  if (w[0] === 0x64 && w[1] === 0xff9b && zeros(2, 6)) return publicV4(v4Of(w[6], w[7]));  // NAT64
  if (w[0] === 0x2002) return publicV4(v4Of(w[1], w[2]));                                // 6to4
  if ((w[0] & 0xe000) !== 0x2000) return false;   // ::, ::1, ULA fc00::/7, link-local, multicast…
  if (w[0] === 0x2001 && w[1] < 0x200) return false;   // protocol assignments, Teredo among them
  if (w[0] === 0x2001 && w[1] === 0xdb8) return false;   // documentation
  if (w[0] === 0x3fff && w[1] < 0x1000) return false;   // documentation, the newer block
  return true;
}

/** A link a file may be fetched from: http or https, with a host and no credentials. */
function checkedUrl(text) {
  const raw = String(text ?? '').trim();
  let url;
  try { url = new URL(raw); } catch { throw badRequest('file_url'); }
  if (raw.length > 2048 || !['http:', 'https:'].includes(url.protocol) || !url.hostname
    || url.username || url.password) {
    throw badRequest('file_url');
  }
  return url;
}

/**
 * The address the download will connect to, after checking every address the
 * name has: one private among public ones is enough to refuse, because which
 * one a connection would get is the resolver's choice, not ours.
 */
async function addressOf(url, { lookup, allowPrivate }) {
  const host = url.hostname.replace(/^\[|\]$/g, '');
  let addresses;
  if (net.isIP(host)) addresses = [{ address: host, family: net.isIP(host) }];
  else {
    try { addresses = await lookup(host, { all: true }); } catch { throw unreachable(); }
  }
  if (!Array.isArray(addresses) || !addresses.length) throw unreachable();
  const mayBePrivate = typeof allowPrivate === 'function' ? allowPrivate(host) : allowPrivate === true;
  if (!mayBePrivate && addresses.some((a) => !isPublicAddress(a.address))) throw badRequest('file_url_private');
  return addresses[0];
}

/**
 * One GET, to the address that was checked. The name is never looked up
 * again: a resolver that answered a public address for the check and a private
 * one a moment later (DNS rebinding) would otherwise walk the server inside.
 * The URL keeps its name, so the Host header and the TLS certificate are the site's.
 */
function requestOnce(url, { address, family }, { signal, headersTimeout, userAgent }) {
  const client = url.protocol === 'https:' ? https : http;
  return new Promise((resolve, reject) => {
    const req = client.request(url, {
      method: 'GET',
      // No pool: a socket kept from another request was checked for another name.
      agent: false,
      headers: { 'User-Agent': userAgent, Accept: 'image/*, application/pdf, */*;q=0.1', 'Accept-Encoding': 'identity' },
      // Node asks with `all` when it may try several families (autoSelectFamily): one answer either way.
      lookup: (_host, options, done) => (options?.all ? done(null, [{ address, family }]) : done(null, address, family)),
    }, (res) => {
      clearTimeout(timer);
      resolve(res);
    });
    const timer = setTimeout(() => req.destroy(unreachable()), headersTimeout);
    const abort = () => req.destroy(unreachable());
    signal.addEventListener('abort', abort, { once: true });
    req.on('close', () => signal.removeEventListener('abort', abort));
    req.on('error', (err) => {
      clearTimeout(timer);
      reject(err instanceof HttpError ? err : unreachable());
    });
    req.end();
  });
}

/** The file's name: the one the site gives (Content-Disposition), else the last part of its path, else `file`. */
export function nameFromResponse(disposition, url) {
  const header = String(disposition || '');
  let name = '';
  const encoded = /filename\*\s*=\s*[\w-]*'[^']*'([^;]+)/i.exec(header);
  if (encoded) {
    try { name = decodeURIComponent(encoded[1].trim().replace(/^"|"$/g, '')); } catch { /* malformed: the next one */ }
  }
  if (!name) {
    const plain = /filename\s*=\s*(?:"([^"]*)"|([^;]+))/i.exec(header);
    if (plain) name = (plain[1] ?? plain[2] ?? '').trim();
  }
  if (!name) {
    const last = url.pathname.split('/').filter(Boolean).at(-1) || '';
    try { name = decodeURIComponent(last); } catch { name = last; }
  }
  // A name, not a path, and nothing a header or a page would choke on.
  name = path.posix.basename(name.replace(/\\/g, '/')).replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 120);
  return name || 'file';
}

/**
 * Opens a file at a link someone gave (an assistant, through an MCP tool):
 * → { stream, name }, the stream a Readable that `store()` takes as it takes a
 * request. What is kept is decided by `store`, by the first bytes, as for any
 * upload: a page that says it is a photo is still refused.
 *
 * It is the server fetching an address it was handed, so it never fetches one
 * inside a network (`isPublicAddress`, on every address the name has and on
 * every redirect, at most `maxRedirects`), and it connects to the address it
 * checked. A Content-Length over `maxBytes` is refused before reading; a body
 * that grows past it, by `store`. 10 s to answer, 60 s for everything.
 *
 * Errors (HttpError): `file_url` (not an http(s) link, or one with a user and
 * password), `file_url_private`, `file_url_unreachable` (no such name, no
 * answer, too slow, too many redirects), `file_url_status` with the `status`,
 * `file_too_large` (413). A download cut halfway fails `store` with
 * `upload_cut`, or with `file_url_unreachable` when it ran out of time.
 *
 * `lookup` and `allowPrivate` (true, or a function of the host name) are for
 * tests only: a test server lives on 127.0.0.1.
 */
export async function openUrl(given, {
  maxBytes = 15 * 1024 * 1024, maxRedirects = 3, headersTimeout = 10_000, timeout = 60_000,
  userAgent = 'suite-core (file from a link)', lookup = dns.lookup, allowPrivate = false,
} = {}) {
  let url = checkedUrl(given);
  const deadline = new AbortController();
  const timer = setTimeout(() => deadline.abort(), timeout);
  timer.unref?.();
  try {
    for (let hop = 0; ; hop += 1) {
      const address = await addressOf(url, { lookup, allowPrivate });
      if (deadline.signal.aborted) throw unreachable();
      const res = await requestOnce(url, address, { signal: deadline.signal, headersTimeout, userAgent });
      if (REDIRECTS.has(res.statusCode)) {
        res.destroy();
        if (hop >= maxRedirects || !res.headers.location) throw unreachable();
        let next;
        try { next = new URL(res.headers.location, url).href; } catch { throw unreachable(); }
        url = checkedUrl(next);
        continue;
      }
      if (res.statusCode < 200 || res.statusCode >= 300) {
        res.destroy();
        throw badRequest('file_url_status', { status: res.statusCode });
      }
      const length = Number(res.headers['content-length']);
      if (Number.isFinite(length) && length > maxBytes) {
        res.destroy();
        throw new HttpError(413, 'file_too_large', { max_mb: Math.round(maxBytes / 1024 / 1024) });
      }
      return {
        stream: relay(res, deadline.signal, () => clearTimeout(timer)),
        name: nameFromResponse(res.headers['content-disposition'], url),
      };
    }
  } catch (err) {
    clearTimeout(timer);
    throw err;
  }
}

/**
 * The download as the stream `store()` reads. A stream of its own and not the
 * response: a response that fails says ECONNRESET, and `store` passes on what
 * its stream says, which must be a code the app can answer with. Pausing it
 * pauses the download (pipe); destroying it closes the connection.
 */
function relay(res, signal, done) {
  const out = new PassThrough();
  const fail = () => out.destroy(signal.aborted ? unreachable() : badRequest('upload_cut'));
  res.on('aborted', fail);
  res.on('error', fail);
  const abort = () => {
    out.destroy(unreachable());
    res.destroy();
  };
  signal.addEventListener('abort', abort, { once: true });
  out.on('close', () => {
    signal.removeEventListener('abort', abort);
    done();
    if (!res.complete) res.destroy();
  });
  // Until `store` listens, an error has nobody to hear it, and an 'error' nobody listens to takes
  // the process down. `store` finds the stream already destroyed and answers with its error.
  out.on('error', () => {});
  res.pipe(out);
  return out;
}
