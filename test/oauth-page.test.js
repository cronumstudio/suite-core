/**
 * The suite's OAuth screens (oauth-page.js): the product's colour, icon and
 * name, the signature, the person's theme, and nothing unescaped.
 *
 *   npm test
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { brandedPage, textOn } from '../oauth-page.js';

test('the text on the product’s colour: white unless the colour is too light for it', () => {
  // Every product of the suite today keeps white on its buttons.
  for (const color of ['#3A4660', '#EF4B2A', '#2F5BFF', '#0F9D6E', '#0A8FB8', '#E0457B']) {
    assert.equal(textOn(color), '#FFFFFF', color);
  }
  assert.equal(textOn('#FFC21A'), '#16130E', 'yolk takes ink');
  assert.equal(textOn('#FFFFFF'), '#16130E');
});

test('a screen: the app’s colour, icon and name, the signature, and the theme when known', () => {
  const page = brandedPage({ id: 'tasks', name: 'Tasks', color: '#EF4B2A', icon: '/icons/favicon.svg?v=2' });
  const html = page({ lang: 'es', title: 'Conectar con Tasks', body: '<h1>Conectar con Tasks</h1>' });
  assert.match(html, /^<!DOCTYPE html>/);
  assert.match(html, /<html lang="es" data-app="tasks" style="--app: #EF4B2A; --app-on: #FFFFFF">/);
  assert.match(html, /<link rel="icon" href="\/icons\/favicon\.svg\?v=2" type="image\/svg\+xml">/);
  assert.match(html, /<img src="\/icons\/favicon\.svg\?v=2"/);
  assert.match(html, /<title>Conectar con Tasks · Tasks<\/title>/);
  assert.match(html, /<div class="consent__card oauth">[\s\S]*<h1>Conectar con Tasks<\/h1>\n<\/div>\n<a class="cronum-sig"/,
    'the body inside the card, the signature under it');
  assert.match(html, /<meta name="referrer" content="same-origin">/, 'forms keep their Origin (0.24.1)');

  assert.match(page({ lang: 'en', title: 't', body: '', theme: 'dark' }), /data-app="tasks" data-theme="dark"/);
  assert.match(page({ lang: 'en', title: 't', body: '', theme: 'light' }), /data-theme="light"/);
  assert.doesNotMatch(page({ lang: 'en', title: 't', body: '', theme: 'system' }), /data-theme/, 'the browser decides');
  assert.doesNotMatch(page({ lang: 'en', title: 't', body: '', theme: '"><script>' }), /<script>/);

  const plain = brandedPage({ id: 'demo', name: 'A <b>"demo"</b>' })({ lang: 'en', title: '<x>', body: '' });
  assert.doesNotMatch(plain, /style="--app/, 'no colour: the stylesheet’s ink');
  assert.match(plain, /<title>&lt;x&gt; · A &lt;b&gt;&quot;demo&quot;&lt;\/b&gt;<\/title>/);
  assert.match(plain, /src="\/icons\/favicon\.svg"/);
});
