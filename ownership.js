/**
 * Whose something is, the same in every module (Martin, 03/11/2026; audit of
 * 30/10, auditoria-2026-10-30/compartir.md). sharing.js says who may see and
 * edit something; this says what only its owner may do with it:
 *
 *   · What I share stays mine. Whoever edits it may change it, but not destroy
 *     it or take it away: deleting what isn't theirs, purging it, emptying the
 *     owner's trash or moving it into something of their own answers 403
 *     `not_yours`, with the owner's name ("This isn't yours: ask Ana to remove
 *     or delete it"). Moving it away offers a copy instead (`copy: true` in the
 *     answer): the copy is theirs, the original stays where it was.
 *   · Where a module keeps who made something (Tasks' tasks, an attachment's
 *     uploader), whoever made it may delete it as well (`authorId`).
 *   · Putting something of mine into someone else's container gives it to them:
 *     before it goes, the person is told "It will be Ana's" (`givesTo`).
 *   · When the owner deletes a container they shared (a list, a notebook, a
 *     group, a project), whoever used it is told, by push and by email
 *     (`tellGone`), with no copy offered.
 *   · When an owner's account goes, what they shared passes to whoever used it
 *     (`pickHeir`: who they gave it to, else an editor before a viewer, the
 *     longest in it first, an account in use before a disabled one), the same
 *     way in every module (`handOver`: dated from then, its public page off,
 *     the offers by address still waiting, their addresses masked to the heir).
 *     The deletion notices go once a day per sender and person (`brake`).
 *
 * Made once by the suite, in the module's words (the app's `hooks.texts`: its
 * catalogs over the suite's): `suite.ownership` (0.295.0). A module uses that one,
 * on its own and in a host alike: its notices go with the push, the email and
 * the brake its suite has when they go (`suite` below), a test's stand-ins too.
 *
 * The check is always the server's (REST and MCP alike); the web kit's
 * web/ownership.js only explains it.
 *
 *   const ownership = createOwnership({ db: { get }, shareMail: suite.shareMail, push: suite.push, texts });
 *   ownership.requireOwner(me.id, list.owner_id);                        // 403 not_yours
 *   ownership.requireOwnerOrAuthor(me.id, { ownerId, authorId: task.created_by });
 *   ownership.requireOwner(me.id, note.owner_id, { copy: true });        // moving it out
 *   const owner = ownership.givesTo(me.id, notebook.owner_id);           // null, or { id, name }
 *   ownership.tellGone({ kind: 'list', name, icon, actorId: me.id, audience });
 */
import { HttpError } from './http.js';

/** The code of everything this refuses: the web kit and the assistants' sentences know it. */
export const NOT_YOURS = 'not_yours';

/**
 * The refusal itself, for a module that checks in its own way. `owner` is
 * { id, name } (or null when nobody is known); `copy` says a copy may be asked
 * for instead (moving it out): the web kit offers it, an assistant reads how.
 */
export function notYours(owner, { copy = false, action = null } = {}) {
  return new HttpError(403, NOT_YOURS, {
    owner: owner?.name ?? null,
    owner_id: owner?.id ?? null,
    ...(copy ? { copy: true, hint: 'copy' } : {}),
    // What was refused, when "ask them to remove or delete it" isn't it: 'close' (audit ownership-15).
    ...(action ? { action } : {}),
  });
}

/** Whether someone may delete something: its owner, or whoever made it where that is kept. */
export function mayDelete(userId, { ownerId, authorId = null }) {
  if (userId == null) return false;
  return Number(userId) === Number(ownerId) || (authorId != null && Number(userId) === Number(authorId));
}

/**
 * Who something passes to when its owner's account goes: whoever it was given
 * by (`prefer`, Notes' `given_by`) if they still use it, else an editor before
 * a viewer, the longest in it first, then the lowest id. `candidates` are
 * { userId, permission, since } (each person once is best; repeats are folded
 * into their highest permission and earliest date). → a candidate, or null.
 */
export function pickHeir(candidates, { prefer = null } = {}) {
  const people = new Map();
  const rows = (candidates || []).filter((row) => row?.userId != null);
  // An account nobody can use —disabled by the admin, or waiting to be deleted, which disables it—
  // could never use it, share it or delete it: one in use first, a disabled one only when there is
  // no other (audit portable-17; `disabled` on a candidate, as heirOf() sets it).
  const usable = rows.filter((row) => !row.disabled);
  for (const row of usable.length ? usable : rows) {
    const seen = people.get(row.userId);
    const edit = Boolean(seen?.edit) || row.permission === 'edit';
    const since = seen && String(seen.since ?? '') <= String(row.since ?? '') ? seen.since : row.since;
    people.set(row.userId, { ...row, permission: edit ? 'edit' : row.permission, edit, since });
  }
  if (prefer != null && people.has(prefer)) return strip(people.get(prefer));
  const [first] = [...people.values()].sort((a, b) => Number(b.edit) - Number(a.edit)
    || String(a.since ?? '').localeCompare(String(b.since ?? '')) || a.userId - b.userId);
  return first ? strip(first) : null;
}
const strip = ({ edit, disabled, ...row }) => row;

/** One notice of a deletion per sender, recipient and day, whatever was deleted (A3; audit sc-data-10). */
const GONE_DAY_MS = 24 * 60 * 60 * 1000;
export function createGoneBrake({ clock = () => Date.now() } = {}) {
  const sent = new Map();
  return {
    notice(actorId, targetId) {
      const now = clock();
      const key = `${actorId}:${targetId}`;
      if (sent.size > 50_000) for (const [k, at] of sent) if (now - at >= GONE_DAY_MS) sent.delete(k);
      const last = sent.get(key);
      if (last != null && now - last < GONE_DAY_MS) return false;
      sent.set(key, now);
      return true;
    },
  };
}

/**
 * @param {object} options
 * @param {{ get }} options.db  the module's database (its `users` table).
 * @param {Function} [options.shareMail]  suite.shareMail: its `gone` email, when the owner deletes something shared.
 * @param {object} [options.push]  suite.push (subscriptionsOf, deliver): the push of the same.
 * @param {Function} [options.texts]  (user) → t, in that person's language: the push's words
 *   (the module's translator over the suite's, e.g. `(u) => translator(userLanguage(u))`).
 * @param {object} [options.brake]  { notice(actorId, targetId) → boolean }: whether a notice of a
 *   deletion may go to that person now. Default: once per sender, recipient and day, in memory (a
 *   restart forgets it), for every module that shares the same ownership (the host's suite.ownership).
 * @param {Function} [options.suite]  () → the suite whose `push`, `shareMail` and `goneBrake` a notice
 *   goes with, asked each time one goes, in place of the three above (`brake` stays for a suite
 *   without a brake): what `suite.ownership` is made with, so a module's suite in a host, or a test
 *   that puts its own push or email on the suite, is what it uses.
 * @param {Function} [options.log]
 */
export function createOwnership({
  db, shareMail = null, push = null, texts = null, brake = createGoneBrake(), suite = null, log = console.error,
} = {}) {
  const { get } = db;
  /** The push, the email and the brake a notice goes with now. */
  const services = () => {
    if (!suite) return { push, shareMail, brake };
    const now = suite() || {};
    return { push: now.push ?? null, shareMail: now.shareMail ?? null, brake: now.goneBrake ?? brake };
  };

  const userOf = (id) => (id == null ? null : get('SELECT * FROM users WHERE id = ?', id));
  /** Someone as these refusals and notices name them. */
  function personOf(id) {
    const user = userOf(id);
    return user ? { id: user.id, name: user.display_name || user.username || user.email || null } : null;
  }

  /** 403 not_yours unless the person owns it. `copy`: they may take a copy instead. */
  function requireOwner(userId, ownerId, { copy = false, action = null } = {}) {
    if (userId != null && Number(userId) === Number(ownerId)) return;
    throw notYours(personOf(ownerId), { copy, action });
  }

  /** 403 not_yours unless the person owns it or made it (`authorId`, where the module keeps it). */
  function requireOwnerOrAuthor(userId, { ownerId, authorId = null }) {
    if (mayDelete(userId, { ownerId, authorId })) return;
    throw notYours(personOf(ownerId));
  }

  /**
   * Putting something of the person's into a container owned by `ownerId`
   * gives it to that owner: → { id, name } of who it will belong to, or null
   * when it stays theirs. What a module answers and asks before with it.
   */
  function givesTo(userId, ownerId) {
    if (ownerId == null || Number(userId) === Number(ownerId)) return null;
    return personOf(ownerId);
  }

  /**
   * The owner deleted something they shared: whoever used it (`audience`, user
   * ids; the owner is left out) hears it, by push where a device of theirs
   * takes one and by email, with nothing to answer and no copy offered.
   * `kind` is share-mail's ('list', 'notebook', 'group', 'project', 'plan'); `id`, the thing's,
   * tells one push from another on a device (two lists deleted, two notices; `tag` overrides it).
   * Each person hears once a day from the same sender (`brake`), whatever is deleted: deleting and
   * restoring again and again, or a notebook of fifty notes, is one notice (audit sc-data-10).
   * Never throws: a notice that fails is logged. → a promise of how many were told.
   */
  async function tellGone({ kind, name, icon = null, actorId, audience = [], tag = null, id: thingId = null }) {
    // What this notice goes with: the suite's at this moment, when the suite is given.
    const { push, shareMail, brake } = services();
    const actor = userOf(actorId);
    const actorName = actor ? actor.display_name || actor.username || '' : '';
    const ids = [...new Set((audience || []).map(Number))].filter((id) => Number.isInteger(id) && id !== Number(actorId));
    const title = String(name ?? '').trim();
    let told = 0;
    await Promise.all(ids.map(async (id) => {
      const to = userOf(id);
      if (!to) return;
      if (brake && !brake.notice(actorId, id)) return;
      let reached = false;
      if (push && texts) {
        try {
          const subscriptions = push.subscriptionsOf([id]) || [];
          if (subscriptions.length) {
            const t = texts(to);
            // Something without a name is called so, as its email calls it (share-mail.js), never «“”».
            const named = title || t('mail.share.untitled');
            const thing = icon ? `${icon} ${named}` : named;
            await push.deliver(subscriptions, {
              title: t('ownership.gone.title', { name: actorName, thing }),
              body: t('ownership.gone.body', { name: actorName, thing }),
              tag: tag || (thingId != null ? `gone-${kind}-${thingId}` : `gone-${kind}`),
            });
            reached = true;
          }
        } catch (err) {
          log(`[ownership] the push of a ${kind} deleted was not sent: ${err?.message}`);
        }
      }
      if (shareMail?.gone) {
        try {
          if (await shareMail.gone({ to, actor: actorName, kind, name, icon })) reached = true;
        } catch (err) {
          log(`[ownership] the email of a ${kind} deleted was not sent: ${err?.message}`);
        }
      }
      if (reached) told += 1;
    }));
    return told;
  }

  /**
   * pickHeir over candidates as the module reads them ({ userId, permission, since }), with each
   * one's account looked up: a disabled one only when there is nobody else (portable-17).
   */
  function heirOf(candidates, options = {}) {
    const rows = (candidates || []).map((row) => {
      const user = row?.userId == null ? null : get('SELECT disabled_at FROM users WHERE id = ?', row.userId);
      return { ...row, disabled: Boolean(row?.disabled || user?.disabled_at) };
    });
    return pickHeir(rows, options);
  }

  /**
   * What someone leaving owned and shared passes to whoever used it, the same way in every module
   * (audits of 6/11: dup-srv-1, ownership-20, sc-data-22). Each of their things in `table` that
   * someone accepted goes, with everything in it, to its heir (heirOf: who it was given by, else an
   * editor before a viewer, the longest in it first, an account in use before a disabled one):
   *
   *   · its owner is the heir, from now (`since`: the column the module's sweeps count from, so
   *     what the heir's plan keeps less of is counted from the day it became theirs, not lost at
   *     once: Notes' owner_since, audits ownership-2, next-srv-2, sc-data-16);
   *   · its public page goes off (`unpublish`): the heir never published it, and their name would
   *     be on it for anyone with the link (audits ownership-4, sc-data-11);
   *   · the offers by address its owner made still wait, and the heir sees their addresses masked
   *     (Martin, 14/11/2026; sharing.js addressFor): the module keeps them, with who made them;
   *   · `moved(row, heir, at)` is the module's own part (the heir's share goes, a name made free,
   *     a group left…), and `set(row, heir)` adds columns to the same UPDATE.
   *
   * Needs `db.all` and `db.run`. In one transaction of the module's (erase and accounts.remove
   * run in one). → [{ id, heirId }] of what passed, for the module's live notices.
   *
   * @param {number} userId   who is leaving
   * @param {object} spec
   * @param {string} spec.table                     the containers' table
   * @param {string} [spec.key='id'], [spec.owner='owner_id']
   * @param {string} [spec.where]                   more of the WHERE (e.g. 'deleted_at IS NULL')
   * @param {Function} spec.candidates              (row) → [{ userId, permission, since }], the leaving one's left out
   * @param {Function} [spec.prefer]                (row) → the id to prefer when they still use it
   * @param {string|null} [spec.since='owner_since'] null when the table keeps no such column
   * @param {boolean|{ token, since }} [spec.unpublish=true]  its page's columns (public_token, public_since)
   * @param {Function} [spec.set]                   (row, heir) → { column: value } for the same UPDATE
   * @param {Function} [spec.moved]                 (row, heir, at) → the module's own part
   * @param {Function} [spec.clock]                 → ISO time
   */
  function handOver(userId, {
    table, key = 'id', owner = 'owner_id', where = null, candidates, prefer = null, since = 'owner_since',
    unpublish = true, set = null, moved = null, clock = () => new Date().toISOString(),
  }) {
    const { all, run } = db;
    if (!all || !run) throw new TypeError('ownership.handOver needs db.all and db.run');
    const handed = [];
    const rows = all(`SELECT * FROM ${table} WHERE ${owner} = ?${where ? ` AND (${where})` : ''} ORDER BY ${key}`, userId);
    for (const row of rows) {
      const heir = heirOf((candidates(row) || []).filter((c) => Number(c.userId) !== Number(userId)), { prefer: prefer?.(row) ?? null });
      if (!heir) continue;
      const at = clock();
      const columns = { [owner]: heir.userId };
      if (since) columns[since] = at;
      if (unpublish) {
        const page = unpublish === true ? { token: 'public_token', since: 'public_since' } : unpublish;
        if (page.token) columns[page.token] = null;
        if (page.since) columns[page.since] = null;
      }
      Object.assign(columns, set?.(row, heir) || {});
      const names = Object.keys(columns);
      run(`UPDATE ${table} SET ${names.map((n) => `${n} = ?`).join(', ')} WHERE ${key} = ?`, ...names.map((n) => columns[n]), row[key]);
      moved?.(row, heir, at);
      handed.push({ id: row[key], heirId: heir.userId });
    }
    return handed;
  }

  return {
    personOf, requireOwner, requireOwnerOrAuthor, mayDelete, givesTo,
    notYours: (ownerId, opts) => notYours(personOf(ownerId), opts), tellGone, pickHeir, heirOf, handOver,
  };
}
