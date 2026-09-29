/**
 * Copies from the command line (portability.js): what each app's
 * `scripts/data.js` runs, inside its container or next to its data folder.
 * It is the way to move a whole install without a browser, without the
 * upload limits of a proxy in front (Cloudflare cuts at 100 MB), and before
 * anybody has signed in to the new one.
 *
 *   node scripts/data.js export <copy.zip> [--account <user>]
 *   node scripts/data.js import <copy.zip> [--as <user>] [--email <src>=<address>] [--to <src>=<user>]
 *                                          [--new <src>] [--username <src>=<name>] [--skip <src>]
 *                                          [--replace <src>] [--apply]
 *
 * `export` writes the whole install, or one account's data with --account.
 * `import` says what it would do and does it only with --apply. Where each
 * account of the copy goes: by default the account here with the same email,
 * or a new one; --email gives one of the copy's accounts an email (so it links
 * with that account here, or with its WorkOS account when that person signs
 * in), --to sends it into an account here, --new always makes a new one,
 * --skip leaves it out and --replace empties the account it goes into first.
 * <src> is a username (or id) in the copy; <user> one here. With --as the
 * copy of one person goes into that account, as "Import data" does.
 *
 * Messages are for whoever runs the install: in English, like the logs.
 */
import fs from 'node:fs';
import { HttpError } from '../http.js';

const USAGE = `Usage:
  node scripts/data.js export <copy.zip> [--account <user>]
  node scripts/data.js import <copy.zip> [--as <user>] [--email <src>=<address>] [--to <src>=<user>]
                                         [--new <src>] [--username <src>=<name>] [--skip <src>]
                                         [--replace <src>] [--apply]`;

const LISTS = ['email', 'to', 'new', 'username', 'skip', 'replace'];
const SINGLE = ['account', 'as'];

export function parseArgs(argv) {
  const [command, file, ...rest] = argv;
  const flags = { apply: false, ...Object.fromEntries(LISTS.map((k) => [k, []])), ...Object.fromEntries(SINGLE.map((k) => [k, null])) };
  for (let i = 0; i < rest.length; i++) {
    const match = /^--([a-z]+)(?:=(.*))?$/.exec(rest[i]);
    if (!match) throw new Error(`"${rest[i]}" is not an option`);
    const [, name, inline] = match;
    if (name === 'apply') { flags.apply = true; continue; }
    if (!LISTS.includes(name) && !SINGLE.includes(name)) throw new Error(`--${name} is not an option`);
    const value = inline ?? rest[++i];
    if (value == null || value.startsWith('--')) throw new Error(`--${name} needs a value`);
    if (LISTS.includes(name)) flags[name].push(value);
    else flags[name] = value;
  }
  return { command, file, flags };
}

/** "martin=it@example.com" → ['martin', 'it@example.com'] */
function pair(flag, value) {
  const at = value.indexOf('=');
  if (at < 1 || at === value.length - 1) throw new Error(`--${flag} takes <src>=<value>: "${value}"`);
  return [value.slice(0, at), value.slice(at + 1)];
}

const sum = (counts) => Object.values(counts || {}).reduce((a, b) => a + b, 0);
const tables = (counts) => Object.entries(counts || {}).map(([table, n]) => `${table} ${n}`).join(', ') || 'nothing';
const size = (bytes) => (bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : `${Math.ceil((bytes || 0) / 1024)} kB`);

/**
 * @param {object} options
 * @param {object} options.suite         from createSuite()
 * @param {object} options.declaration   what the app's data is (portability.js)
 * @param {string} [options.version]     the app's version, for the copy's manifest
 * @returns {Promise<number>} the exit code
 */
export async function runDataCli({ suite, declaration, version = null, argv = process.argv.slice(2), log = console.log, error = console.error }) {
  let parsed;
  try {
    parsed = parseArgs(argv);
  } catch (err) {
    error(`${err.message}\n\n${USAGE}`);
    return 2;
  }
  const { command, file, flags } = parsed;
  if (!['export', 'import'].includes(command) || !file) {
    error(USAGE);
    return 2;
  }
  const portability = suite.portabilityFor(declaration, { version });
  /** An account here, by username, email or id. */
  const here = (value) => {
    const text = String(value).trim();
    const user = suite.accounts.byUsername(text)
      || (/^\d+$/.test(text) ? suite.accounts.byId(Number(text)) : null)
      || suite.database.get('SELECT * FROM users WHERE email = ? COLLATE NOCASE', text.toLowerCase());
    if (!user) throw new Error(`There is no account "${text}" here`);
    return user;
  };

  try {
    if (command === 'export') {
      const user = flags.account ? here(flags.account) : null;
      const job = portability.prepareExport({ scope: user ? 'account' : 'install', userId: user?.id ?? null });
      const manifest = await job.write(fs.createWriteStream(file));
      log(`Copy written to ${file}: ${user ? `the account "${user.username}"` : `the whole install, ${manifest.users} account(s)`}.`);
      log(`  ${tables(manifest.tables)}`);
      log(`  attachments: ${manifest.files.count} (${size(manifest.files.bytes)})${manifest.files.missing ? `, ${manifest.files.missing} missing on disk` : ''}`);
      if (manifest.left_out && sum(manifest.left_out)) log(`  shared with other people, not in it: ${tables(manifest.left_out)}`);
      return 0;
    }

    // import
    const user = flags.as ? here(flags.as) : null;
    const mode = user ? 'account' : 'install';
    const decisions = new Map();
    const decision = (source) => decisions.get(source) || {};
    for (const source of flags.skip) decisions.set(source, { source, skip: true });
    for (const value of flags.to) {
      const [source, target] = pair('to', value);
      decisions.set(source, { source, user_id: here(target).id });
    }
    for (const source of flags.new) decisions.set(source, { source, create: {} });
    for (const value of flags.username) {
      const [source, name] = pair('username', value);
      decisions.set(source, { source, create: { ...(decision(source).create || {}), username: name } });
    }
    for (const value of flags.email) {
      const [source, address] = pair('email', value);
      const current = decision(source);
      decisions.set(source, current.create ? { source, create: { ...current.create, email: address } } : { source, email: address });
    }
    // What the plan decides, made explicit: --replace applies to where each account really goes.
    let plan = await portability.planFile(file, { mode, user, decisions: [...decisions.values()], replace: false });
    const final = mode === 'install' ? plan.accounts.map(({ source, choice }) => {
      if (choice.action === 'skip') return { source: source.id, skip: true };
      if (choice.action === 'create') return { source: source.id, create: { username: choice.username, email: choice.email } };
      const replace = flags.replace.some((s) => s === source.username || s === String(source.id));
      return { source: source.id, user_id: choice.user_id, replace };
    }) : [];
    for (const wanted of flags.replace) {
      if (mode === 'account') break;
      const account = plan.accounts.find((a) => a.source.username === wanted || String(a.source.id) === wanted);
      if (!account) throw new Error(`There is no account "${wanted}" in the copy`);
      if (account.choice.action !== 'map') throw new Error(`--replace ${wanted}: it doesn't go into an account here`);
    }
    if (mode === 'install') plan = await portability.planFile(file, { mode, decisions: final });

    const { copy } = plan;
    log(`Copy of ${copy.app?.name || '?'} ${copy.app?.version || ''} (${copy.scope === 'install' ? 'a whole install' : 'one account'}), made ${copy.created_at}${copy.source?.base_url ? ` at ${copy.source.base_url}` : ''}.`);
    log(`  ${tables(copy.tables)}`);
    log(`  attachments: ${copy.files?.count ?? 0} (${size(copy.files?.bytes)})`);
    if (copy.applied_at) log(`  ALREADY IMPORTED HERE on ${copy.applied_at}: it can't be applied again.`);
    if (mode === 'account') {
      const replaceAll = flags.replace.length > 0;
      log(`Into the account "${user.username}"${replaceAll ? `, replacing what it has now (${tables(plan.replace)})` : ''}.`);
      if (sum(copy.left_out)) log(`  shared with other people, not in the copy: ${tables(copy.left_out)}`);
      if (!flags.apply) { log('\nNothing done yet: add --apply to import it.'); return 0; }
      const result = await portability.applyFile(file, { mode, user, replace: replaceAll });
      log(`Imported: ${tables(result.imported.tables)}; attachments ${result.imported.files}.`);
      return 0;
    }

    log('Accounts:');
    for (const { source, choice, rows } of plan.accounts) {
      const who = `${source.username} (${source.display_name}${source.role === 'admin' ? ', admin' : ''}, ${source.email || 'no email'}, ${sum(rows)} of their own)`;
      let where;
      if (choice.action === 'skip') where = 'left out';
      else if (choice.action === 'create') {
        where = `a new account "${choice.username}" ${choice.email ? `<${choice.email}>` : 'without an email'}`;
        if (!choice.email && plan.provider !== 'local') where += ' — nobody can sign in to it until it has one';
      } else {
        const target = plan.targets.find((u) => u.id === choice.user_id);
        const replace = final.find((d) => d.source === source.id)?.replace;
        where = `the account "${target?.username}" here${replace ? `, replacing what it has (${tables(target?.owns)})` : ''}`;
      }
      log(`  ${who}\n    → ${where}`);
    }
    if (!flags.apply) { log('\nNothing done yet: add --apply to import it.'); return 0; }
    const result = await portability.applyFile(file, { mode, decisions: final });
    log(`\nImported: ${tables(result.imported.tables)}; attachments ${result.imported.files}; plans given by the admin ${result.imported.grants}.`);
    for (const account of result.accounts) log(`  ${account.created ? 'new' : 'into'} "${account.username}" (id ${account.user_id})`);
    if (sum(result.left_out.tables)) log(`  not imported: ${tables(result.left_out.tables)}`);
    const files = result.left_out.files;
    if (files.missing || files.refused || files.too_large) {
      log(`  attachments left out: ${files.missing} missing, ${files.refused} not images or PDF, ${files.too_large} too big`);
    }
    return 0;
  } catch (err) {
    if (err instanceof HttpError) {
      error(`Refused: ${err.code}${Object.keys(err.extra || {}).length ? ` ${JSON.stringify(err.extra)}` : ''}`);
      return 1;
    }
    error(err.message);
    return 1;
  }
}
