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
 *     longest in it first).
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
export function notYours(owner, { copy = false } = {}) {
  return new HttpError(403, NOT_YOURS, {
    owner: owner?.name ?? null,
    owner_id: owner?.id ?? null,
    ...(copy ? { copy: true, hint: 'copy' } : {}),
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
  for (const row of candidates || []) {
    if (row?.userId == null) continue;
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
const strip = ({ edit, ...row }) => row;

/**
 * @param {object} options
 * @param {{ get }} options.db  the module's database (its `users` table).
 * @param {Function} [options.shareMail]  suite.shareMail: its `gone` email, when the owner deletes something shared.
 * @param {object} [options.push]  suite.push (subscriptionsOf, deliver): the push of the same.
 * @param {Function} [options.texts]  (user) → t, in that person's language: the push's words
 *   (the module's translator over the suite's, e.g. `(u) => translator(userLanguage(u))`).
 * @param {Function} [options.log]
 */
export function createOwnership({ db, shareMail = null, push = null, texts = null, log = console.error } = {}) {
  const { get } = db;

  const userOf = (id) => (id == null ? null : get('SELECT * FROM users WHERE id = ?', id));
  /** Someone as these refusals and notices name them. */
  function personOf(id) {
    const user = userOf(id);
    return user ? { id: user.id, name: user.display_name || user.username || user.email || null } : null;
  }

  /** 403 not_yours unless the person owns it. `copy`: they may take a copy instead. */
  function requireOwner(userId, ownerId, { copy = false } = {}) {
    if (userId != null && Number(userId) === Number(ownerId)) return;
    throw notYours(personOf(ownerId), { copy });
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
   * `kind` is share-mail's ('list', 'notebook', 'group', 'project', 'plan').
   * Never throws: a notice that fails is logged. → a promise of how many were told.
   */
  async function tellGone({ kind, name, icon = null, actorId, audience = [], tag = null }) {
    const actor = userOf(actorId);
    const actorName = actor ? actor.display_name || actor.username || '' : '';
    const ids = [...new Set((audience || []).map(Number))].filter((id) => Number.isInteger(id) && id !== Number(actorId));
    const thing = icon ? `${icon} ${String(name ?? '').trim()}` : String(name ?? '').trim();
    let told = 0;
    await Promise.all(ids.map(async (id) => {
      const to = userOf(id);
      if (!to) return;
      let reached = false;
      if (push && texts) {
        try {
          const subscriptions = push.subscriptionsOf([id]) || [];
          if (subscriptions.length) {
            const t = texts(to);
            await push.deliver(subscriptions, {
              title: t('ownership.gone.title', { name: actorName, thing }),
              body: t('ownership.gone.body', { name: actorName, thing }),
              tag: tag || `gone-${kind}`,
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

  return { personOf, requireOwner, requireOwnerOrAuthor, mayDelete, givesTo, notYours: (ownerId, opts) => notYours(personOf(ownerId), opts), tellGone, pickHeir };
}
