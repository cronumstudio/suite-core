/**
 * Hot reload by polling (HOT_RELOAD=true), for installs that run the code
 * mounted from the project folder, like the NAS.
 *
 * `node --watch` doesn't work there: the code is edited from another machine
 * over SMB, and the "file changed" notice travels through inotify, which never
 * reaches the container from the desktop. So instead of waiting for the bell
 * this looks at the clock: every two seconds the size and date of the server's
 * files are checked, and if anything changed an orderly shutdown is requested.
 * Docker brings the container back up (`restart: unless-stopped`) with the new
 * code.
 *
 * The folder is walked whole, the suite's submodule and its texts included: a
 * deploy that only moves suite-core must restart too. Tests, docs and .git
 * never hold code the server runs.
 */
import fs from 'node:fs';
import path from 'node:path';

const SKIP = new Set(['.git', 'test', 'docs', 'node_modules']);

/** Size and date of every .js and .json under `root`, as one comparable string. */
export function fingerprint(root) {
  const parts = [];
  const walk = (dir, prefix) => {
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.isDirectory()) {
        if (!SKIP.has(entry.name)) walk(path.join(dir, entry.name), `${prefix}${entry.name}/`);
        continue;
      }
      if (!/\.(js|mjs|json)$/.test(entry.name)) continue;
      try {
        const s = fs.statSync(path.join(dir, entry.name));
        parts.push(`${prefix}${entry.name}:${s.size}:${Math.floor(s.mtimeMs)}`);
      } catch { /* file just moved: it shows up on the next round */ }
    }
  };
  walk(root, '');
  return parts.join('|');
}

/**
 * Starts watching `root`; on a change, `onChange` (by default SIGTERM to this
 * process, through the orderly shutdown that already exists). Returns the timer.
 */
export function watchCode({
  root, interval = 2000, log = console.log,
  onChange = () => process.kill(process.pid, 'SIGTERM'),
}) {
  const initial = fingerprint(root);
  log(`[watcher] hot reload on (polling every ${interval / 1000} s)`);
  const timer = setInterval(() => {
    if (fingerprint(root) === initial) return;
    log('[watcher] code changed; restarting…');
    clearInterval(timer);
    onChange();
  }, interval);
  // No unref: this timer keeps the process alive just like the server.
  return timer;
}
