/**
 * Sharing with people one already knows, the same in every app: their names
 * as chips under the share dialog's email field, one or several picked, and
 * every share sent at once. The app says who those people are (each its own
 * rule: whoever one shares something with, in either direction) and how one
 * share is made; the kit draws the chips and says how it went.
 *
 *   import { peopleChips, shareWithEach } from '../suite/people.js';
 *   const chips = peopleChips(people, { onChange: (ids) => {}, selected: [] });   // [{ id, name }]
 *   form.append(email, chips.node);
 *   const { done, failed } = await shareWithEach(
 *     [...chips.selected().map((id) => people.find((p) => p.id === id)), { email: email.value, name: email.value }],
 *     (target) => api.post(`/api/lists/${id}/share`, target.id ? { user_id: target.id } : { email: target.email }));
 *
 * Nobody's email is needed to pick them: the server shares by id, and only with
 * someone the person already knows (an id it doesn't know answers as an unknown
 * email would, so ids can't be tried one after another).
 */
import { el, clear } from './dom.js';
import { t } from './i18n.js';
import { errorMessage } from './api.js';
import { toast } from './ui.js';

/** The chips: none at all (a hidden node) when there is nobody to offer. */
export function peopleChips(people = [], { onChange = null, selected = [], label = t('kit.people.label') } = {}) {
  // `selected`: those picked from the start (a dialog drawn again keeps who was refused picked).
  const picked = new Set(selected);
  // `label`: what is said above the chips; '' says nothing (the dialog says it already).
  const node = el('div', { class: 'kit-people', role: 'group', 'aria-label': label || null });
  const paint = (list) => {
    clear(node);
    picked.forEach((id) => { if (!list.some((p) => p.id === id)) picked.delete(id); });
    node.hidden = !list.length;
    if (!list.length) return;
    if (label) node.append(el('span', { class: 'kit-people__label', text: label }));
    for (const person of list) {
      const chip = el('button', {
        type: 'button', class: 'kit-people__chip', 'aria-pressed': String(picked.has(person.id)), text: person.name,
        onClick: () => {
          if (picked.has(person.id)) picked.delete(person.id);
          else picked.add(person.id);
          chip.setAttribute('aria-pressed', String(picked.has(person.id)));
          onChange?.([...picked]);
        },
      });
      node.append(chip);
    }
  };
  paint(people);
  return {
    node,
    /** The ids picked, in the order of the chips. */
    selected: () => people.filter((p) => picked.has(p.id)).map((p) => p.id),
    clear: () => { picked.clear(); paint(people); onChange?.([]); },
    /** Other people (after a share, without those who now have it); what was picked and is still there stays picked. */
    set: (list) => { people = list; paint(list); },
  };
}

/**
 * One share for each target ({ id?, email?, name }), one after another, and
 * then one notice: how many went, or who was refused and why, keeping the ones
 * that went. → { done: [target], failed: [{ target, error }] }.
 */
export async function shareWithEach(targets, shareOne) {
  const done = [];
  const failed = [];
  for (const target of targets) {
    try {
      await shareOne(target);
      done.push(target);
    } catch (error) {
      failed.push({ target, error });
    }
  }
  const went = !done.length ? null
    : done.length === 1 ? t('kit.people.sharedOne', { name: done[0].name || done[0].email })
      : t('kit.people.sharedMany', { count: done.length });
  if (failed.length) {
    const refused = failed.map(({ target, error }) => t('kit.people.notShared', { name: target.name || target.email, reason: errorMessage(error) }));
    toast([went, ...refused].filter(Boolean).join(' '), { error: true });
  } else if (went) {
    toast(went);
  }
  return { done, failed };
}
