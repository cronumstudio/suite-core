/**
 * The agents of Settings › Your AI and of a host's first start (web/agents.js): the same ones,
 * in the same order, as cronumstudio.com/work/ under Connect, each with its steps in words of
 * the five catalogs (audit 2026-11-06, claims-ai-4).
 *
 *   npm test
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { installFakeDom } from './fake-dom.js';

installFakeDom();
const catalog = (lang) => JSON.parse(fs.readFileSync(new URL(`../i18n/${lang}.json`, import.meta.url), 'utf8'));
const english = catalog('en');
const realFetch = globalThis.fetch;
globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => english });
const { loadLanguage } = await import('../web/i18n.js');
await loadLanguage('en', { remember: false });
globalThis.fetch = realFetch;
const { AGENTS, agentGuide } = await import('../web/agents.js');

test('the agents are the web’s: Grok and Perplexity in, Gemini out', () => {
  assert.deepEqual(AGENTS.map((a) => a.id),
    ['claude', 'chatgpt', 'grok', 'perplexity', 'claude-code', 'codex', 'gemini-cli', 'cursor', 'vscode']);
});

test('each agent has its steps, the connector’s address among them, in words every catalog has', () => {
  const endpoint = 'https://work.example/mcp';
  for (const { id } of AGENTS) {
    const steps = agentGuide(id, { endpoint, app: 'Cronum Work' });
    assert.ok(steps.length >= 2, id);
    const parts = steps.flat();
    assert.ok(parts.some((part) => part.code?.includes(endpoint)), `${id}: the address to paste`);
    for (const part of parts) {
      const words = part.text ?? part.link;
      if (words !== undefined) assert.doesNotMatch(words, /^kit\.agents\./, `${id}: ${words} has words`);
    }
  }
  const keys = Object.keys(english).filter((key) => key.startsWith('kit.agents.'));
  for (const lang of ['es', 'fr', 'de', 'it']) {
    const other = catalog(lang);
    assert.deepEqual(keys.filter((key) => !other[key]), [], `${lang} has every step`);
  }
  assert.ok(!keys.some((key) => key.startsWith('kit.agents.gemini.')), 'nothing left of Gemini');
});

test('Claude and ChatGPT as the web gives them today, and the last words of ChatGPT the same', () => {
  const steps = (id) => agentGuide(id, { endpoint: 'https://work.example/mcp', app: 'Cronum Work' }).flat();
  assert.ok(steps('claude').some((part) => part.href === 'https://claude.ai/customize/connectors'));
  assert.ok(steps('chatgpt').some((part) => part.href === 'https://chatgpt.com/plugins'));
  assert.equal(steps('chatgpt').at(-1).text, 'Leave Authentication on OAuth, accept the warning, choose Create as a plugin and sign in '
    + 'with your Cronum Work account. Then install it, and in a new chat type @ and choose Cronum Work.');
  assert.ok(steps('grok').some((part) => part.href === 'https://grok.com/connectors'));
  assert.equal(steps('perplexity').at(-1).text, 'Add it and sign in with your Cronum Work account.');
});
