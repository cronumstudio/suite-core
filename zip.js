/**
 * Zip archives with no dependencies: node:zlib deflates, inflates and works
 * out the CRC-32; this file writes and reads the format around them.
 *
 * Why zip: an export is a file people keep, look into and hand over —the
 * GDPR asks for a "commonly used" format— and every system opens one without
 * installing anything.
 *
 * · **Writing** goes to any Writable (a file, an HTTP response) and waits for
 *   it to drain, one entry at a time, so a big export never sits whole in
 *   memory. Photos and PDFs are stored as they are: they are compressed
 *   already, and deflating them again costs time and gains nothing. Past
 *   4 GB, or 65,535 entries, it writes the ZIP64 records.
 * · **Reading** takes a file on disk (an upload is streamed there first) and
 *   reads entries when asked, through the central directory. It refuses what
 *   it doesn't need to understand —encryption, methods other than store and
 *   deflate, archives split in parts— and inflates each entry with a cap: the
 *   size its directory declares, which the caller checks against its own
 *   limits before asking. A zip bomb stops at the first byte past what it
 *   promised, and a CRC that doesn't match is a damaged file, not data.
 */
import fs from 'node:fs';
import zlib from 'node:zlib';
import { once } from 'node:events';
import { promisify } from 'node:util';
import { HttpError, badRequest } from './http.js';

const deflateRaw = promisify(zlib.deflateRaw);
const inflateRaw = promisify(zlib.inflateRaw);

const LOCAL = 0x04034b50;
const CENTRAL = 0x02014b50;
const END = 0x06054b50;
const END64 = 0x06064b50;
const LOCATOR64 = 0x07064b50;
const ZIP64_EXTRA = 0x0001;
const MAX16 = 0xffff;
const MAX32 = 0xffffffff;
/** General purpose flag 11: the name is UTF-8. */
const UTF8 = 0x0800;
/** Made by Unix (3), specification 4.5: what lets `unzip` keep the permissions below. */
const MADE_BY = (3 << 8) | 45;
/** A regular file, rw-r--r--, in the upper half of the external attributes. */
const FILE_MODE = (0o100644 << 16) >>> 0;

/** A date as MS-DOS keeps it: local time in two 16-bit words, from 1980, in two-second steps. */
function dosDateTime(value) {
  const d = value instanceof Date && !Number.isNaN(value.getTime()) ? value : new Date();
  const year = Math.min(Math.max(d.getFullYear(), 1980), 2107);
  return {
    time: (d.getHours() << 11) | (d.getMinutes() << 5) | Math.floor(d.getSeconds() / 2),
    date: ((year - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate(),
  };
}

/* --------------------------------- writing --------------------------------- */

/**
 * A zip written into `output` as entries are added:
 *
 *   const zip = createZipWriter(fs.createWriteStream(file));
 *   await zip.add('data/lists.json', JSON.stringify(rows));
 *   await zip.add('files/7/photo.jpg', buffer, { compress: false });
 *   await zip.finish();          // the directory, then output.end()
 *
 * An entry is held in memory while it is written, never the archive.
 */
export function createZipWriter(output, { now = () => new Date() } = {}) {
  let offset = 0;
  let finished = false;
  let failure = null;
  const directory = [];
  const names = new Set();
  output.on('error', (err) => { failure ||= err; });
  output.on('close', () => { if (!finished) failure ||= new Error('zip: the output closed before the end'); });

  /** Writes, waiting when the output asks to: a slow client never piles the export up in memory. */
  async function put(buffer) {
    if (failure) throw failure;
    offset += buffer.length;
    if (output.write(buffer)) return;
    const stop = new AbortController();
    try {
      const winner = await Promise.race([
        once(output, 'drain', { signal: stop.signal }).then(() => 'drain'),
        once(output, 'close', { signal: stop.signal }).then(() => 'close'),
      ]);
      if (winner === 'close') throw failure || new Error('zip: the output closed before the end');
    } finally {
      stop.abort();
    }
  }

  /**
   * Adds an entry. `content` is a Buffer or a string (UTF-8). Text is
   * deflated when that makes it smaller; `compress: false` stores it as it is.
   */
  async function add(name, content, { compress = true, date = now() } = {}) {
    if (finished) throw new Error('zip: already finished');
    const clean = String(name);
    if (!clean || clean.startsWith('/') || clean.split('/').includes('..')) throw new Error(`zip: "${clean}" is not a name for an entry`);
    if (names.has(clean)) throw new Error(`zip: "${clean}" twice`);
    names.add(clean);
    const data = Buffer.isBuffer(content) ? content : Buffer.from(String(content), 'utf8');
    if (data.length >= MAX32) throw new Error(`zip: "${clean}" is too big for one entry`);
    const crc = zlib.crc32(data);
    let body = data;
    let method = 0;
    if (compress && data.length > 64) {
      const deflated = await deflateRaw(data);
      if (deflated.length < data.length) {
        body = deflated;
        method = 8;
      }
    }
    const nameBytes = Buffer.from(clean, 'utf8');
    const { time, date: day } = dosDateTime(date);
    const start = offset;

    const header = Buffer.alloc(30);
    header.writeUInt32LE(LOCAL, 0);
    header.writeUInt16LE(20, 4);               // version needed: 2.0 (deflate)
    header.writeUInt16LE(UTF8, 6);
    header.writeUInt16LE(method, 8);
    header.writeUInt16LE(time, 10);
    header.writeUInt16LE(day, 12);
    header.writeUInt32LE(crc, 14);
    header.writeUInt32LE(body.length, 18);
    header.writeUInt32LE(data.length, 22);
    header.writeUInt16LE(nameBytes.length, 26);
    header.writeUInt16LE(0, 28);
    await put(Buffer.concat([header, nameBytes]));
    await put(body);
    directory.push({ nameBytes, method, time, day, crc, compressed: body.length, size: data.length, offset: start });
  }

  /** Writes the central directory and ends the output. Resolves when everything is out. */
  async function finish() {
    if (finished) return;
    const start = offset;
    for (const entry of directory) {
      // Only the offset can pass 4 GB here (an entry never does): it then goes in a ZIP64 extra field.
      const far = entry.offset >= MAX32;
      const extra = far ? Buffer.alloc(12) : Buffer.alloc(0);
      if (far) {
        extra.writeUInt16LE(ZIP64_EXTRA, 0);
        extra.writeUInt16LE(8, 2);
        extra.writeBigUInt64LE(BigInt(entry.offset), 4);
      }
      const record = Buffer.alloc(46);
      record.writeUInt32LE(CENTRAL, 0);
      record.writeUInt16LE(MADE_BY, 4);
      record.writeUInt16LE(far ? 45 : 20, 6);
      record.writeUInt16LE(UTF8, 8);
      record.writeUInt16LE(entry.method, 10);
      record.writeUInt16LE(entry.time, 12);
      record.writeUInt16LE(entry.day, 14);
      record.writeUInt32LE(entry.crc, 16);
      record.writeUInt32LE(entry.compressed, 20);
      record.writeUInt32LE(entry.size, 24);
      record.writeUInt16LE(entry.nameBytes.length, 28);
      record.writeUInt16LE(extra.length, 30);
      record.writeUInt16LE(0, 32);             // comment
      record.writeUInt16LE(0, 34);             // disk
      record.writeUInt16LE(0, 36);             // internal attributes
      record.writeUInt32LE(FILE_MODE, 38);
      record.writeUInt32LE(far ? MAX32 : entry.offset, 42);
      await put(Buffer.concat([record, entry.nameBytes, extra]));
    }
    const size = offset - start;
    const count = directory.length;
    if (count >= MAX16 || size >= MAX32 || start >= MAX32) {
      const end64At = offset;
      const end64 = Buffer.alloc(56);
      end64.writeUInt32LE(END64, 0);
      end64.writeBigUInt64LE(44n, 4);          // what follows this field
      end64.writeUInt16LE(MADE_BY, 12);
      end64.writeUInt16LE(45, 14);
      end64.writeUInt32LE(0, 16);
      end64.writeUInt32LE(0, 20);
      end64.writeBigUInt64LE(BigInt(count), 24);
      end64.writeBigUInt64LE(BigInt(count), 32);
      end64.writeBigUInt64LE(BigInt(size), 40);
      end64.writeBigUInt64LE(BigInt(start), 48);
      const locator = Buffer.alloc(20);
      locator.writeUInt32LE(LOCATOR64, 0);
      locator.writeUInt32LE(0, 4);
      locator.writeBigUInt64LE(BigInt(end64At), 8);
      locator.writeUInt32LE(1, 16);
      await put(Buffer.concat([end64, locator]));
    }
    const end = Buffer.alloc(22);
    end.writeUInt32LE(END, 0);
    end.writeUInt16LE(Math.min(count, MAX16), 8);
    end.writeUInt16LE(Math.min(count, MAX16), 10);
    end.writeUInt32LE(Math.min(size, MAX32), 12);
    end.writeUInt32LE(Math.min(start, MAX32), 16);
    await put(end);
    finished = true;
    const closed = once(output, 'finish');
    output.end();
    await closed;
  }

  return { add, finish, get size() { return offset; }, get count() { return directory.length; } };
}

/* --------------------------------- reading --------------------------------- */

const invalid = (reason) => badRequest('zip_invalid', { reason });
const unsupported = (reason) => badRequest('zip_unsupported', { reason });

/** Reads exactly `length` bytes at `position`, or fails: a short read is a truncated file. */
async function readAt(handle, length, position) {
  const buffer = Buffer.alloc(length);
  let done = 0;
  while (done < length) {
    const { bytesRead } = await handle.read(buffer, done, length - done, position + done);
    if (!bytesRead) throw invalid('truncated');
    done += bytesRead;
  }
  return buffer;
}

/**
 * Opens a zip on disk and reads its directory. `entries` lists what it holds
 * ({ name, size, compressed }); `read(name, { maxBytes })` gives an entry's
 * bytes, checked against its CRC; `close()` lets the file go.
 *
 * Errors are HttpErrors the screens can say: `zip_invalid` (not a zip, or
 * damaged), `zip_unsupported` (encrypted, split, an unknown method) and
 * `zip_too_large` (more than the caller allows).
 */
export async function openZip(file, { maxEntries = 200000, maxDirectoryBytes = 64 * 1024 * 1024 } = {}) {
  const handle = await fs.promises.open(file, 'r');
  try {
    const { size: fileSize } = await handle.stat();
    if (fileSize < 22) throw invalid('too_short');
    // The end record is the last thing in the file, before a comment of up to 64 kB.
    const tailLength = Math.min(fileSize, 22 + MAX16);
    const tailStart = fileSize - tailLength;
    const tail = await readAt(handle, tailLength, tailStart);
    let at = -1;
    for (let i = tailLength - 22; i >= 0; i--) {
      if (tail.readUInt32LE(i) === END && i + 22 + tail.readUInt16LE(i + 20) <= tailLength) { at = i; break; }
    }
    if (at < 0) throw invalid('no_directory');
    const disk = tail.readUInt16LE(at + 4);
    const directoryDisk = tail.readUInt16LE(at + 6);
    let count = tail.readUInt16LE(at + 10);
    let directorySize = tail.readUInt32LE(at + 12);
    let directoryStart = tail.readUInt32LE(at + 16);
    // The ZIP64 records sit just before the end record. A plain zip with
    // exactly 65,535 entries has none, and that count is then the real one.
    const locatorAt = tailStart + at - 20;
    const locator = locatorAt >= 0 && (count === MAX16 || directorySize === MAX32 || directoryStart === MAX32)
      ? await readAt(handle, 20, locatorAt) : null;
    if (locator?.readUInt32LE(0) === LOCATOR64) {
      const end64At = Number(locator.readBigUInt64LE(8));
      if (end64At + 56 > fileSize) throw invalid('zip64_record');
      const end64 = await readAt(handle, 56, end64At);
      if (end64.readUInt32LE(0) !== END64) throw invalid('zip64_record');
      if (end64.readUInt32LE(16) !== 0 || end64.readUInt32LE(20) !== 0) throw unsupported('split');
      count = Number(end64.readBigUInt64LE(32));
      directorySize = Number(end64.readBigUInt64LE(40));
      directoryStart = Number(end64.readBigUInt64LE(48));
    } else if (directorySize === MAX32 || directoryStart === MAX32) {
      throw invalid('no_zip64_locator');
    } else if (disk !== 0 || directoryDisk !== 0) {
      throw unsupported('split');
    }
    if (count > maxEntries || directorySize > maxDirectoryBytes) throw new HttpError(413, 'zip_too_large');
    if (directoryStart + directorySize > fileSize) throw invalid('directory_outside');
    const directory = await readAt(handle, directorySize, directoryStart);

    const entries = new Map();
    let p = 0;
    for (let i = 0; i < count; i++) {
      if (p + 46 > directory.length || directory.readUInt32LE(p) !== CENTRAL) throw invalid('directory');
      const flags = directory.readUInt16LE(p + 8);
      const method = directory.readUInt16LE(p + 10);
      const crc = directory.readUInt32LE(p + 16);
      let compressed = directory.readUInt32LE(p + 20);
      let size = directory.readUInt32LE(p + 24);
      const nameLength = directory.readUInt16LE(p + 28);
      const extraLength = directory.readUInt16LE(p + 30);
      const commentLength = directory.readUInt16LE(p + 32);
      let localOffset = directory.readUInt32LE(p + 42);
      const nameEnd = p + 46 + nameLength;
      if (nameEnd + extraLength + commentLength > directory.length) throw invalid('directory');
      // Without the UTF-8 flag a name is CP437; ours are ASCII, where both agree.
      const name = directory.subarray(p + 46, nameEnd).toString(flags & UTF8 ? 'utf8' : 'latin1');
      if (size === MAX32 || compressed === MAX32 || localOffset === MAX32) {
        const extra = directory.subarray(nameEnd, nameEnd + extraLength);
        let q = 0;
        let found = false;
        while (q + 4 <= extra.length) {
          const id = extra.readUInt16LE(q);
          const length = extra.readUInt16LE(q + 2);
          if (id === ZIP64_EXTRA) {
            let r = q + 4;
            const next = () => {
              if (r + 8 > q + 4 + length) throw invalid('zip64_extra');
              const value = Number(extra.readBigUInt64LE(r));
              r += 8;
              return value;
            };
            if (size === MAX32) size = next();
            if (compressed === MAX32) compressed = next();
            if (localOffset === MAX32) localOffset = next();
            found = true;
            break;
          }
          q += 4 + length;
        }
        if (!found) throw invalid('zip64_extra');
      }
      p = nameEnd + extraLength + commentLength;
      if (name.endsWith('/')) continue;       // a folder: nothing to read
      if (entries.has(name)) throw invalid('duplicate_name');
      entries.set(name, { name, flags, method, crc, compressed, size, localOffset });
    }

    /** The bytes of an entry, or null when there is none by that name. */
    async function read(name, { maxBytes = Infinity } = {}) {
      const entry = entries.get(name);
      if (!entry) return null;
      if (entry.flags & 0x1) throw unsupported('encrypted');
      if (entry.method !== 0 && entry.method !== 8) throw unsupported('method');
      if (entry.size > maxBytes) throw new HttpError(413, 'zip_too_large', { entry: name });
      if (entry.localOffset + 30 > fileSize) throw invalid('entry_outside');
      const local = await readAt(handle, 30, entry.localOffset);
      if (local.readUInt32LE(0) !== LOCAL) throw invalid('entry');
      const start = entry.localOffset + 30 + local.readUInt16LE(26) + local.readUInt16LE(28);
      if (start + entry.compressed > fileSize) throw invalid('entry_outside');
      const raw = await readAt(handle, entry.compressed, start);
      let data = raw;
      if (entry.method === 8) {
        try {
          // Never more than it declared: that is what stops a zip bomb.
          data = await inflateRaw(raw, { maxOutputLength: Math.max(entry.size, 1) });
        } catch {
          throw invalid('inflate');
        }
      }
      if (data.length !== entry.size) throw invalid('size');
      if (zlib.crc32(data) !== entry.crc) throw invalid('crc');
      return data;
    }

    return {
      entries: [...entries.values()].map(({ name, size, compressed }) => ({ name, size, compressed })),
      has: (name) => entries.has(name),
      sizeOf: (name) => entries.get(name)?.size ?? null,
      read,
      close: () => handle.close(),
    };
  } catch (err) {
    await handle.close();
    throw err;
  }
}
