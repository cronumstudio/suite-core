/**
 * Whose something is, in the page (the server's ownership.js decides; this
 * only explains it). The same three moments in every app:
 *
 *   · Deleting or moving what isn't yours answers 403 `not_yours`: the kit's
 *     errorMessage already says "This isn't yours: ask Ana to remove it or
 *     delete it", so a toast of it is enough.
 *   · Moving it away answers that with `copy: true`: `moving()` offers a copy
 *     and, with yes, asks again with `{ copy: true }`; the original stays.
 *   · Putting something of yours into someone else's container gives it to
 *     them: `confirmGive()` asks first ("It will be Ana's").
 *
 *   import { moving, confirmGive } from '../suite/ownership.js';
 *   await moving((extra) => api.patch(`api/tasks/${id}`, { list_id: to, ...extra }));
 *   if (list.owner && list.owner.id !== me.id && !(await confirmGive({ owner: list.owner.name, thing: task.title }))) return;
 */
import { t } from './i18n.js';
import { confirmDialog } from './ui.js';

export const NOT_YOURS = 'not_yours';

/** Whether an error is the server saying it isn't the person's. */
export const isNotYours = (err) => err?.code === NOT_YOURS;

/** Whether the refusal lets them take a copy instead (moving it away). */
export const offersCopy = (err) => isNotYours(err) && Boolean(err?.data?.copy);

/** Asks "Take a copy?" for that refusal. Resolves true or false. */
export function askCopy(err, { parent = null } = {}) {
  return confirmDialog(t('kit.ownership.copyText', { owner: err?.data?.owner ?? '' }), {
    title: t('kit.ownership.copyTitle'), confirm: t('kit.ownership.copyConfirm'), danger: false, parent,
  });
}

/**
 * A move that may be refused as not the person's: `send(extra)` makes it, with
 * `{}` first and `{ copy: true }` when they take the copy offered. → what the
 * send answered, or null when they said no; any other error is thrown as it was.
 */
export async function moving(send, { parent = null } = {}) {
  try {
    return await send({});
  } catch (err) {
    if (!offersCopy(err)) throw err;
    if (!(await askCopy(err, { parent }))) return null;
    return send({ copy: true });
  }
}

/**
 * Before putting something of the person's into someone else's container:
 * "It will be Ana's". Resolves true to go on. `owner` is a name.
 */
export function confirmGive({ owner, thing = '' }, { parent = null } = {}) {
  return confirmDialog(t('kit.ownership.giveText', { owner, thing }), {
    title: t('kit.ownership.giveTitle', { owner }), confirm: t('kit.ownership.giveConfirm'), danger: false, parent,
  });
}
