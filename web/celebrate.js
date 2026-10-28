/**
 * The celebration when something is done: a short burst of confetti and a
 * cheerful "ding". One choice for every module and for Cronum Work's calendar
 * (Settings › Language and theme), kept on the device: the sound and the
 * confetti are a matter of where you are.
 *
 *   import { celebrate, playStep } from '../suite/celebrate.js';
 *   if (!task.done) celebrate(checkbox);                  // a task, a step, a project ticked
 *   celebrate(checkbox, { root: place.root });            // out of a dialog, in the module's own root
 *   celebrate({ x, y });                                  // from a point, when the button is gone
 *
 * Taken from Tasks, where it began (`tasks.celebrate`): until the person
 * chooses here, what they chose there still holds. No images or audio files:
 * the confetti is elements animated with the Web Animations API (no stylesheet
 * needed, so it works the same in every module and in a dialog), and the sound
 * is synthesised with WebAudio. The system's "reduce motion" is respected.
 */

const PREFS_KEY = 'suite.celebrate';
/** Where Tasks kept the same choice before it was the suite's. */
const LEGACY_KEY = 'tasks.celebrate';

const defaults = { sound: true, animation: true };

const read = (key) => {
  try {
    const raw = localStorage.getItem(key);
    const value = raw == null ? null : JSON.parse(raw);
    return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
  } catch {
    return null;
  }
};

/** { animation, sound }: what the person chose on this device, else what they chose in Tasks, else both on. */
export function celebratePrefs() {
  const saved = read(PREFS_KEY) || read(LEGACY_KEY) || {};
  return {
    animation: typeof saved.animation === 'boolean' ? saved.animation : defaults.animation,
    sound: typeof saved.sound === 'boolean' ? saved.sound : defaults.sound,
  };
}

/** Turns `animation` or `sound` on or off on this device; returns the whole choice. */
export function setCelebratePref(key, value) {
  const next = { ...celebratePrefs(), [key]: Boolean(value) };
  try { localStorage.setItem(PREFS_KEY, JSON.stringify(next)); } catch { /* no storage: this page only */ }
  return next;
}

const reducedMotion = () => Boolean(globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches);

/* --------------------------------- sound --------------------------------- */

let audioContext = null;

function ensureAudio() {
  if (audioContext) return audioContext;
  const Ctx = globalThis.AudioContext || globalThis.webkitAudioContext;
  if (!Ctx) return null;
  audioContext = new Ctx();
  return audioContext;
}

/** Two short rising notes: it sounds like "done" without being annoying. */
export function playDing() {
  if (!celebratePrefs().sound) return;
  const ctx = ensureAudio();
  if (!ctx) return;
  if (ctx.state === 'suspended') ctx.resume().catch(() => {});

  const now = ctx.currentTime;
  const master = ctx.createGain();
  master.gain.value = 0.16;
  master.connect(ctx.destination);

  // E5 and B5: a cheerful, brief interval.
  [[659.25, 0], [987.77, 0.085]].forEach(([freq, delay], index) => {
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(freq, now + delay);

    const start = now + delay;
    const end = start + (index ? 0.32 : 0.18);
    gain.gain.setValueAtTime(0.0001, start);
    gain.gain.exponentialRampToValueAtTime(1, start + 0.012);
    gain.gain.exponentialRampToValueAtTime(0.0001, end);

    osc.connect(gain);
    gain.connect(master);
    osc.start(start);
    osc.stop(end + 0.02);
  });
}

/**
 * A part of something ticked (a step of a task): one short, soft note, the
 * first of the ding's two. Five parts in a row with the whole celebration each
 * would tire; the last one gets it.
 */
export function playStep() {
  if (!celebratePrefs().sound) return;
  const ctx = ensureAudio();
  if (!ctx) return;
  if (ctx.state === 'suspended') ctx.resume().catch(() => {});

  const start = ctx.currentTime;
  const end = start + 0.14;
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  osc.type = 'sine';
  osc.frequency.setValueAtTime(783.99, start);     // G5, between the ding's two
  gain.gain.setValueAtTime(0.0001, start);
  gain.gain.exponentialRampToValueAtTime(0.09, start + 0.01);
  gain.gain.exponentialRampToValueAtTime(0.0001, end);
  osc.connect(gain);
  gain.connect(ctx.destination);
  osc.start(start);
  osc.stop(end + 0.02);
}

/* -------------------------------- confetti ------------------------------- */

// The brand's: the coral, the yolk and their shades.
const COLORS = ['#EF4B2A', '#FF7A5C', '#FFC21A', '#FFB000', '#FFD95C'];

/** The point a burst starts from: an element's middle, a { x, y } on the screen, or the screen's middle. */
function pointOf(origin) {
  if (origin && typeof origin.getBoundingClientRect === 'function') {
    const rect = origin.getBoundingClientRect();
    if (rect.width || rect.height) return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
  } else if (origin && Number.isFinite(origin.x) && Number.isFinite(origin.y)) {
    return { x: origin.x, y: origin.y };
  }
  return { x: (globalThis.innerWidth || 0) / 2, y: (globalThis.innerHeight || 0) / 2 };
}

/**
 * A burst of confetti from `origin` (normally, what was ticked). It hangs in
 * the open dialog the origin is in (a dialog is drawn over everything else, so
 * confetti outside it would fall behind it), else in `root` —a module's own,
 * to keep nothing of its own on the page's body—, else in the page's body.
 */
export function confetti(origin = null, { root = null } = {}) {
  if (!celebratePrefs().animation || reducedMotion()) return null;
  const doc = globalThis.document;
  if (!doc) return null;
  const host = (typeof origin?.closest === 'function' && origin.closest('dialog[open]')) || root || doc.body;
  const { x, y } = pointOf(origin);

  const layer = doc.createElement('div');
  layer.className = 'kit-confetti';
  layer.setAttribute('aria-hidden', 'true');
  Object.assign(layer.style, {
    position: 'fixed', left: '0px', top: '0px', width: '0px', height: '0px',
    zIndex: '2147483000', pointerEvents: 'none', overflow: 'visible',
  });
  host.append(layer);
  // In a transformed parent (a dialog sliding in) "fixed" is that parent's: start from where the layer landed.
  const at = layer.getBoundingClientRect?.() || { left: 0, top: 0 };
  const left = x - (at.left || 0);
  const top = y - (at.top || 0);

  // Fewer where there is little room: a phone, or a narrow window of Cronum Work.
  const width = host.getBoundingClientRect?.().width || globalThis.innerWidth || 1024;
  const pieces = width <= 860 ? 12 : 18;
  for (let i = 0; i < pieces; i++) {
    const piece = doc.createElement('i');
    const angle = (Math.PI * 2 * i) / pieces + Math.random() * 0.4;
    const distance = 46 + Math.random() * 54;
    const dx = Math.cos(angle) * distance;
    const dy = Math.sin(angle) * distance - 18;
    const rot = (Math.random() * 2 - 1) * 320;
    Object.assign(piece.style, {
      position: 'absolute', left: `${left - 3.5}px`, top: `${top - 4.5}px`, width: '7px', height: '9px',
      borderRadius: i % 3 === 0 ? '50%' : '2px', background: COLORS[i % COLORS.length], opacity: '0',
    });
    layer.append(piece);
    piece.animate?.([
      { transform: 'translate(0, 0) rotate(0deg) scale(.4)', opacity: 1 },
      { opacity: 1, offset: 0.7 },
      { transform: `translate(${dx}px, ${dy + 26}px) rotate(${rot}deg) scale(1)`, opacity: 0 },
    ], { duration: 850, delay: Math.random() * 60, easing: 'cubic-bezier(.15, .8, .35, 1)', fill: 'forwards' });
  }

  setTimeout(() => layer.remove(), 1100);
  return layer;
}

/** Celebrates something done: confetti and the ding, each as the person chose. */
export function celebrate(origin = null, options = {}) {
  confetti(origin, options);
  playDing();
}
