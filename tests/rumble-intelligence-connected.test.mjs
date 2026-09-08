import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { readFile, mkdir } from 'node:fs/promises';
import { resolve, extname } from 'node:path';
import { chromium } from 'playwright-core';
import { createCommerceDatabases, commerceEnvironment } from './commerce-test-helpers.mjs';
import { applyMigration, cookiePair } from './auth-test-helpers.mjs';
import { createSession } from '../functions/_shared/auth-core.js';
import { onRequest as ingest } from '../functions/api/internal/bot/[[path]].js';
import { onRequest as report } from '../functions/api/admin/rumble-intelligence/[[path]].js';
import { onRequest as auth } from '../functions/api/auth/[[path]].js';

test('actual Python serializer/HMAC HTTP client -> Admin handler -> local D1 -> authenticated reporting -> real browser', async t => {
  const h = await createCommerceDatabases(); t.after(() => h.dispose());
  await applyMigration(h.commerceDb, await readFile(new URL('../commerce-migrations/0045_rumble_intelligence.sql', import.meta.url), 'utf8'));
  const server = createServer(async (req, res) => {
    try {
      const chunks = []; for await (const c of req) chunks.push(c);
      const request = new Request(origin + req.url, { method: req.method, headers: req.headers, ...(!['GET', 'HEAD'].includes(req.method) ? { body: Buffer.concat(chunks) } : {}) });
      let response;
      if (req.url.startsWith('/api/internal/bot/')) response = await ingest({ request, env });
      else if (req.url.startsWith('/api/admin/rumble-intelligence')) response = await report({ request, env });
      else if (req.url.startsWith('/api/auth/')) response = await auth({ request, env });
      else if (req.url.startsWith('/api/')) response = Response.json({ ok: false, error: 'unrelated_harness_route' }, { status: 404 });
      else {
        const file = req.url.startsWith('/assets/') ? resolve('dist', '.' + req.url) : resolve('dist/index.html');
        if (!file.startsWith(resolve('dist'))) throw new Error('invalid path');
        response = new Response(await readFile(file), { headers: { 'Content-Type': ({ '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.woff2': 'font/woff2' })[extname(file)] || 'text/html' } });
      }
      res.writeHead(response.status, Object.fromEntries(response.headers)); res.end(Buffer.from(await response.arrayBuffer()));
    } catch { res.writeHead(500); res.end('Local connected harness failure'); }
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r)); t.after(() => new Promise(r => server.close(r)));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const env = commerceEnvironment(h, { THIRDRAILIFY_ADMIN_ORIGIN: origin, THIRDRAILIFY_PUBLIC_ORIGIN: origin, THIRDRAILIFY_BOT_ADMIN_SECRET: 'local-intelligence-test-secret-never-deployed' });
  const now = new Date().toISOString();
  await h.authDb.prepare("INSERT INTO accounts(id,email_normalized,display_name,role,admin_level,status,email_verified_at,created_at,updated_at,source) VALUES('intelligence-local','intelligence@example.test','Local Operator','admin','full','active',?,?,?,'test')").bind(now, now, now).run();
  const account = await h.authDb.prepare("SELECT * FROM accounts WHERE id='intelligence-local'").first();
  const session = await createSession(env, new Request(origin), account, origin);
  const cookie = cookiePair(session.cookie);
  const sample = JSON.parse(await readFile(new URL('../migrations/RUMBLE_OUTPUT_WITH_RAID.json', import.meta.url), 'utf8'));
  const runPython = snapshot => new Promise((resolveRun, reject) => {
    const child = spawn('X:/GIT/THIRD-RAIL-BOT/.venv/Scripts/python.exe', ['-m', 'tests.emit_subscriber_observation'], { cwd: 'X:/GIT/THIRD-RAIL-BOT', stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '', stderr = ''; child.stdout.on('data', c => stdout += c); child.stderr.on('data', c => stderr += c);
    child.on('exit', code => code ? reject(new Error(stderr)) : resolveRun(JSON.parse(stdout)));
    child.stdin.end(JSON.stringify({ snapshot, observedAt: now, origin, secret: env.THIRDRAILIFY_BOT_ADMIN_SECRET }));
  });
  const receipt = await runPython(sample); assert.equal(receipt.qualified, true);
  const response = await fetch(origin + '/api/admin/rumble-intelligence', { headers: { Cookie: cookie } });
  assert.equal(response.status, 200); assert.match(response.headers.get('content-type'), /json/);
  const body = await response.json(); assert.equal(body.current.id, receipt.observationId); assert.equal(body.current.rawCount, 122); assert.equal(body.distinctCount, 116); assert.deepEqual(body.counts, { 'Self-paid': 9, 'Gifted': 105, 'Self-paid + gifted': 2, 'Needs review': 0 });
  const details = await (await fetch(origin + '/api/admin/rumble-intelligence/person?name=csireferee', { headers: { Cookie: cookie } })).json(); assert.equal(details.records.length, 2); assert.ok(details.records.every(r => r.firstBotObservedAt === now));
  const importRequest = (path, value, csrf = session.csrfToken) => fetch(origin + '/api/admin/rumble-intelligence/import/' + path, { method: 'POST', headers: { Cookie: cookie, Origin: origin, 'Content-Type': 'application/json', 'X-CSRF-Token': csrf }, body: JSON.stringify(value) });
  assert.equal((await importRequest('preview', { snapshot: sample }, '')).status, 403);
  const preview = await (await importRequest('preview', { snapshot: sample })).json(); assert.equal(preview.qualified, true);
  assert.equal((await importRequest('commit', { snapshot: { ...sample, subscribers: { num_subscribers: 0, recent_subscribers: [] } }, observationId: preview.observationId, previewFingerprint: preview.previewFingerprint })).status, 409);
  assert.equal((await importRequest('preview', { snapshot: { ...sample, user_id: 'vmzw3' } })).status, 400);
  assert.equal((await fetch(origin + '/api/admin/rumble-intelligence')).status, 401);
  await runPython(sample); await runPython({ ...sample, now: sample.now + 60 });
  const next = await (await fetch(origin + '/api/admin/rumble-intelligence', { headers: { Cookie: cookie } })).json(); assert.equal(next.history.length, 2); assert.equal(next.history[1].arrivals, 0);
  const imported = await importRequest('commit', { snapshot: sample, observationId: preview.observationId, previewFingerprint: preview.previewFingerprint }); assert.equal(imported.status, 200);
  assert.equal((await importRequest('commit', { snapshot: sample, observationId: preview.observationId, previewFingerprint: preview.previewFingerprint })).status, 200);
  const afterImport = await (await fetch(origin + '/api/admin/rumble-intelligence', { headers: { Cookie: cookie } })).json(); assert.equal(afterImport.current.id, next.current.id);
  const browser = await chromium.launch({ executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true }); t.after(() => browser.close());
  await mkdir('.artifacts/rumble-intelligence', { recursive: true });
  for (const width of [1920, 1440, 768, 390]) {
    const context = await browser.newContext({ viewport: { width, height: 1000 }, reducedMotion: 'reduce' });
    const split = cookie.indexOf('='); await context.addCookies([{ name: cookie.slice(0, split), value: cookie.slice(split + 1), url: origin }]);
    const page = await context.newPage(); const errors = []; page.on('pageerror', e => errors.push(e.message));
    await page.goto(origin + '/rumble-intelligence'); await page.getByRole('heading', { name: 'Subscriber Registry', exact: true }).waitFor();
    try { await page.getByText('116 accounts', { exact: false }).waitFor(); } catch (e) { await page.screenshot({ path: '.artifacts/rumble-intelligence/connected-failure.png', fullPage: true }); t.diagnostic(await page.locator('body').innerText()); throw e; }
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true, `overflow at ${width}`);
    await page.screenshot({ path: `.artifacts/rumble-intelligence/registry-${width}.png`, fullPage: width > 900 });
    if (width <= 900) { await page.locator('.ri-person').first().scrollIntoViewIfNeeded(); await page.screenshot({ path: `.artifacts/rumble-intelligence/registry-cards-${width}.png` }); }
    if (width === 1440) {
      for (const [value, count, file] of [['Self-paid', 9, 'self-paid'], ['Gifted', 105, 'gifted'], ['Self-paid + gifted', 2, 'mixed']]) {
        await page.getByRole('combobox', { name: /^Classification/ }).selectOption(value); await page.getByText(`${count} accounts`, { exact: false }).waitFor(); await page.screenshot({ path: `.artifacts/rumble-intelligence/${file}.png`, fullPage: true });
      }
      await page.locator('.ri-person').first().focus(); await page.keyboard.press('Enter'); await page.locator('dialog[open]').waitFor(); await page.screenshot({ path: '.artifacts/rumble-intelligence/mixed-detail.png', fullPage: true }); await page.keyboard.press('Escape'); assert.equal(await page.locator('dialog[open]').count(), 0);
      await page.getByRole('button', { name: 'history', exact: true }).click(); await page.screenshot({ path: '.artifacts/rumble-intelligence/history.png', fullPage: true });
      await page.reload(); await page.getByText('116 accounts', { exact: false }).waitFor();
    }
    assert.deepEqual(errors, []); await context.close();
  }
  for (const table of ['automation_receipts', 'poll_votes']) assert.equal((await h.commerceDb.prepare(`SELECT COUNT(*) n FROM ${table}`).first()).n, 0);
  t.diagnostic('Real provider fixture; actual Python HMAC transport, real Admin auth and report handlers, local D1, real responsive browser. This is local acceptance, not production evidence.');
});
