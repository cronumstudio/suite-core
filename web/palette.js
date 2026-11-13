/**
 * The colours and the icons that name a collection in every module: a list, a notebook, a
 * project, a group of them (audit of 6/11, ui-dialogos-9). Tasks had 13 colours, Notes 12,
 * Projects 10 and Next 8 by name, in other orders and other blues; a list and a notebook of the
 * same job could hardly match. Now one palette, here, and the pickers that offer it (pickers.js).
 *
 * It imports nothing and touches no DOM, so a module's server can load it too (Tasks proposes the
 * free colour when an assistant makes a list without one).
 *
 * What is already saved is never touched: a colour or an icon that is not offered here any more is
 * still shown, and offered first in the picker, so it doesn't change by accident.
 */

/**
 * Twelve colours, by name, around the wheel. `hex` is what a module that keeps the colour itself
 * stores (Tasks, Notes, Projects): white text reads on each (4.5:1) and each shows on the dark page
 * (3:1). `dark` is its lighter step, for a module that keeps the name (Next) and paints with the
 * kit's token, `--kit-color-<name>` (kit.css): it reads as text on the dark page (4.5:1). They keep
 * away from the yolk (now), the red and amber of the notices and the states, and the products'
 * accents. The test measures them all (web-kit.test.js).
 */
export const KIT_COLORS = Object.freeze([
  { name: 'blue', hex: '#2564cf', dark: '#6f9ff7' },
  { name: 'cyan', hex: '#0a7ea6', dark: '#5cc3e4' },
  { name: 'teal', hex: '#0e7c86', dark: '#4fbcc4' },
  { name: 'green', hex: '#15803d', dark: '#5cc98a' },
  { name: 'olive', hex: '#6e7a2a', dark: '#a8b55a' },
  { name: 'brown', hex: '#8a6a45', dark: '#c49a6c' },
  { name: 'pink', hex: '#c2407c', dark: '#ec85b0' },
  { name: 'plum', hex: '#a03ea3', dark: '#d08be6' },
  { name: 'violet', hex: '#7b61c9', dark: '#a593ea' },
  { name: 'indigo', hex: '#4f5bd5', dark: '#949cf2' },
  { name: 'steel', hex: '#56708a', dark: '#8fb0cf' },
  { name: 'slate', hex: '#606776', dark: '#a5abb6' },
].map((c) => Object.freeze(c)));

/** The names alone, in the palette's order: what a module that keeps names accepts. */
export const KIT_COLOR_NAMES = Object.freeze(KIT_COLORS.map((c) => c.name));

/** The palette's colour for a name or a #rrggbb (any case), or null when it isn't one of them. */
export function kitColor(value) {
  if (typeof value !== 'string' || !value) return null;
  const key = value.trim().toLowerCase();
  return KIT_COLORS.find((c) => c.name === key || c.hex === key) || null;
}

/*
 * The order a new collection's colour is proposed in: five apart around the wheel (5 and 12 share
 * no factor, so the walk visits all twelve), so two lists made in a row never come out in
 * neighbouring shades.
 */
const STRIDE = 5;
const PROPOSED = KIT_COLORS.map((_, i) => KIT_COLORS[(i * STRIDE) % KIT_COLORS.length]);

/**
 * A colour to start with, different from the ones in use (`used`: hexes or names, any case, nulls
 * skipped): the first free one along the proposed order, not a counter, so a gap left by a deleted
 * one is used again. With all twelve in use, it goes on by count. `as: 'name'` gives the name.
 */
export function suggestedColor(used = [], { as = 'hex' } = {}) {
  const inUse = new Set(used.map(kitColor).filter(Boolean).map((c) => c.name));
  const free = PROPOSED.find((c) => !inUse.has(c.name)) || PROPOSED[used.filter(Boolean).length % PROPOSED.length];
  return as === 'name' ? free.name : free.hex;
}

/**
 * The icons in view: the twenty a collection is named with most (work, home, shopping, studies,
 * travel). The rest wait behind «Más…».
 */
export const KIT_ICONS = Object.freeze([
  '📁', '📋', '✅', '📝', '🎯', '📅', '💼', '🏠', '🛒', '💡',
  '📚', '🎨', '🚀', '🛠️', '📦', '💻', '🌐', '🌱', '✈️', '❤️',
]);

/**
 * Behind «Más…»: Tasks' emojis (they were all in view there, 164 of them), by theme: work and the
 * office, computers and tools, home, and the rest. The twenty in view are not repeated.
 */
export const KIT_MORE_ICONS = Object.freeze([
  // Work and the office.
  '📌', '🗓️', '⏰', '⏳', '🔖', '⭐', '🔥', '🏢', '🏭', '🏪',
  '🏦', '🤝', '👥', '📊', '📈', '📉', '🗂️', '📂', '📑', '🧾',
  '📜', '✉️', '📧', '📨', '📮', '📞', '☎️', '💬', '📢', '📣',
  '🔍', '🏷️', '🔑', '🔒', '💳', '💰', '💶', '🧮', '📐', '📏',
  '✏️', '🖊️', '📎', '🖇️', '✂️', '🗃️', '🗄️', '🚚', '⚖️', '🧠',
  '🧩',
  // Computers and tools.
  '🖥️', '⌨️', '🖱️', '🖨️', '📱', '📲', '💾', '💿', '🔌', '🔋',
  '📡', '🛰️', '🤖', '👾', '🎮', '🕹️', '📷', '📹', '🎥', '📺',
  '📻', '🎧', '🎙️', '⌚', '🔦', '🧪', '🔬', '🛡️', '🐛', '⚙️',
  '🔧', '🔨', '🪛', '🔩', '🧰', '⚡', '♻️',
  // Home.
  '🏡', '🏘️', '🛋️', '🛏️', '🚪', '🪟', '🪑', '🚿', '🛁', '🚽',
  '🧻', '🧼', '🧽', '🪣', '🧹', '🧺', '🧴', '🧯', '🍳', '🍽️',
  '☕', '🧊', '🪴', '🌳', '🕯️', '🪜', '🧱', '🏗️', '🖼️', '🧵',
  '👕', '🧸', '👶', '🐶', '🐱', '🐾', '🚗',
  // The rest: studies, health, travel, celebrations.
  '🍎', '🍕', '🎓', '📖', '📰', '💪', '🏃', '🧘', '🩺', '💊',
  '🏥', '🌍', '🧳', '🗺️', '🏖️', '🎁', '🎉', '🎵', '🎸', '🎬',
]);
