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
 */
import fs from 'node:fs';
import path from 'node:path';
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
 */
export function createUploads({ dir, maxBytes = 15 * 1024 * 1024, log = console.log, clock = () => Date.now() }) {
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
        if (out) out.destroy();
        if (partial) { try { fs.unlinkSync(partial); } catch { /* never existed */ } }
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
          if (out) out.destroy();
          if (partial) { try { fs.unlinkSync(partial); } catch { /* never existed */ } }
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

  return { dir: root, maxBytes, store, resolve, remove, serve, sweep };
}
