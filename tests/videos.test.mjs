// The Videos page: films are self-contained pages under assets/videos/, reached from the More menu.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';

const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');

test('videos: every listed film exists as a standalone page', async () => {
  const { VIDEOS } = await import('../assets/js/views/videos.js');
  assert.ok(VIDEOS.length >= 1);
  for (const v of VIDEOS) {
    assert.ok(existsSync(new URL(`../${v.src}`, import.meta.url)), `${v.src} is committed`);
    const html = read(v.src);
    assert.match(html, /^<!doctype html>/i, 'standards mode, not quirks');
    assert.match(html, /<meta charset="utf-8">/i);
    assert.match(html, /<title>[^<]+<\/title>/);
    // nothing loaded from outside the page except the Google Fonts stylesheet
    for (const m of html.matchAll(/<(?:script|link|img|iframe)\b[^>]*\b(?:src|href)="(https?:[^"]+)"/gi)) assert.match(m[1], /^https:\/\/fonts\.(googleapis|gstatic)\.com(\/|$)/, m[1]);
  }
});

test('videos: wired into the app and the More menu, and published by the Pages build', () => {
  assert.match(read('index.html'), /href="#\/videos" data-route="videos"/);
  assert.match(read('index.html'), /class="nav-menu-label"[^>]*>Videos</);
  assert.match(read('assets/js/app.js'), /videos: renderVideos/);
  assert.match(read('.github/workflows/pages.yml'), /\bassets\b/);
});
