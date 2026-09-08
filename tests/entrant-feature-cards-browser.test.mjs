import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdir } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { chromium } from 'playwright-core';
import { featureFixture } from './entrant-features-fixture.mjs';
import { saveAutomationRule, listAutomationRules } from '../functions/_shared/automation-core.js';
import { automationsStatus } from '../functions/_shared/polls-core.js';
import { createWheel, adminWheelLibrary, adminWheelDetail, adminWheelResults, getWheelSettings } from '../functions/_shared/wheels-core.js';
import { adminStageLibrary } from '../functions/_shared/wheel-stages-core.js';
const origin = 'http://127.0.0.1:44228', output = '.artifacts/entrant-features';
test('shared cards group IDs and preserve keyboard focus, pending, rollback and revision reconciliation', async t => {
  const f = await featureFixture(); t.after(f.h.dispose); const { env, h, rules, wheelId } = f;
  const second = await createWheel(env, 'creator', { title: 'Feature Donation Draw', visibility: 'public', lifecycle: 'active', config: {}, entries: [] });
  const secondId = (await h.commerceDb.prepare('SELECT id FROM wheels WHERE public_slug=?').bind(second.wheel.slug).first()).id;
  await saveAutomationRule(env, 'master', { ...rules[2], id: undefined, revision: undefined, targetWheelId: secondId, name: 'Same name different Wheel', enabled: false });
  const orphan = (await saveAutomationRule(env, 'master', { ...rules[2], id: undefined, revision: undefined, name: 'Unavailable target rule', enabled: false })).rule;
  await h.commerceDb.prepare('UPDATE automation_rules SET target_wheel_id=NULL WHERE id=?').bind(orphan.id).run();
  const server = spawn(process.execPath, ['node_modules/vite/bin/vite.js', '--host', '127.0.0.1', '--port', '44228'], { stdio: 'ignore' }); t.after(() => server.kill());
  for (let i = 0; i < 60; i++) { try { if ((await fetch(origin)).ok) break; } catch { /* startup */ } await new Promise(r => setTimeout(r, 100)); }
  await mkdir(output, { recursive: true });
  const browser = await chromium.launch({ executablePath: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe', headless: true }); t.after(() => browser.close());
  for (const width of [1920, 1440, 768, 390]) {
    const context = await browser.newContext({ viewport: { width, height: 1080 }, reducedMotion: 'reduce' }); const page = await context.newPage();
    let failure = 0, delay = 0, writes = 0, reads = 0; const errors = []; page.on('pageerror', e => errors.push(e.message));
    await page.route('**/api/**', async route => {
      const url = new URL(route.request().url()), path = url.pathname, method = route.request().method();
      const json = (body, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
      try {
        if (path === '/api/auth/config') return json({ configured: true, oauthProviders: [], oauthProviderStates: [], publicOrigin: origin, adminOrigin: origin, environment: 'test' });
        if (path === '/api/auth/session') return json({ ok: true, authenticated: true, csrfToken: 'fixture', access: { isAdmin: true, isMasterAdmin: true }, account: { id: 'master', email: 'master@example.test', displayName: 'Master Admin', providers: ['email'], role: 'admin', adminLevel: 'master', status: 'active', emailVerified: true, createdAt: new Date().toISOString(), source: 'env_master' } });
        if (path === '/api/admin/inbox/summary') return json({ ok: true, unread: 0, actionable: { goats: { total: 0 } } });
        if (path === '/api/admin/automations') return json(await automationsStatus(env));
        if (path === '/api/admin/automations/poll-voting') return json({ ok: true, policies: [], lots: [], livestreams: [], botCompatible: false, protocol: 1, heartbeatAt: null });
        if (path === '/api/admin/automations/rules') {
          if (method === 'POST') { writes++; if (delay) await new Promise(r => setTimeout(r, delay)); if (failure) return json({ message: `Local simulated ${failure}; rule was not saved.` }, failure); return json(await saveAutomationRule(env, 'master', route.request().postDataJSON())); }
          reads++; return json(await listAutomationRules(env, url.searchParams.get('wheelId') || '', url.searchParams.get('ruleId') || ''));
        }
        if (path === '/api/admin/wheels') return json(await adminWheelLibrary(env));
        if (path === '/api/admin/wheels/stages') return json(await adminStageLibrary(env));
        if (path === '/api/admin/wheels/results') return json(await adminWheelResults(env));
        if (path === '/api/admin/wheels/settings') return json(await getWheelSettings(env));
        if (path === `/api/admin/wheels/${wheelId}`) return json(await adminWheelDetail(env, wheelId));
        return json({ ok: true, items: [] });
      } catch (e) { return json({ message: e.message, issues: e.issues }, e.status || 400); }
    });
    await page.goto(`${origin}/automations`, { waitUntil: 'networkidle' });
    await page.locator('.automation-card').first().waitFor(); assert.equal(await page.locator('.automation-target').count(), 3); assert.equal(await page.locator('.automation-target > summary strong').filter({ hasText: 'Feature Donation Draw' }).count(), 2);
    assert.equal(await page.getByText('Target unavailable', { exact: true }).count(), 1);
    const card = page.locator('.automation-card').filter({ has: page.getByRole('heading', { name: rules[2].name, exact: true }) });
    const toggle = card.getByRole('switch'); await toggle.scrollIntoViewIfNeeded(); await toggle.focus(); const checked = await toggle.getAttribute('aria-checked'); const before = await page.locator('.automation-card h3').allTextContents(); const startWrites = writes, startReads = reads;
    delay = 800; await page.keyboard.press('Space'); await card.getByText('Saving…', { exact: true }).waitFor();
    assert.equal(await page.locator('.automation-card').filter({ has: page.getByRole('heading', { name: rules[0].name, exact: true }) }).getByRole('switch').isEnabled(), true);
    await page.keyboard.press('Space'); await card.screenshot({ path: `${output}/card-pending-${width}.png` });
    await page.waitForFunction(() => !document.querySelector('.automation-card[aria-busy=true]')); assert.equal(writes, startWrites + 1); assert.equal(reads, startReads); assert.notEqual(await toggle.getAttribute('aria-checked'), checked); assert.equal(await toggle.evaluate(e => e === document.activeElement), true); assert.deepEqual(await page.locator('.automation-card h3').allTextContents(), before);
    delay = 0;
    if (width === 1440) for (const code of [401, 403, 429, 409]) {
      failure = code; const prior = await toggle.getAttribute('aria-checked'); const count = writes; await toggle.click(); await card.getByRole('alert').waitFor(); assert.match(await card.getByRole('alert').textContent(), new RegExp(String(code))); assert.equal(await toggle.getAttribute('aria-checked'), prior); assert.equal(writes, count + 1);
      if (code === 409) assert.match(await card.getByRole('alert').textContent(), /Current rule refreshed/);
    }
    await card.screenshot({ path: `${output}/card-state-${width}.png` }); failure = 0;
    const target = card.locator('..').locator('..'); await target.scrollIntoViewIfNeeded(); await page.screenshot({ path: `${output}/admin-grouped-${width}.png` });
    const firstGroup = page.locator('.automation-target').first(); await firstGroup.locator('summary').click(); await page.getByLabel('Search rules', { exact: true }).fill('gift'); await page.getByLabel('Search rules', { exact: true }).fill(''); assert.equal(await firstGroup.getAttribute('open'), null);
    await page.goto(`${origin}/wheels`, { waitUntil: 'networkidle' }); await page.locator('.automation-card').first().waitFor(); await page.locator('.automation-target-list').scrollIntoViewIfNeeded(); await page.screenshot({ path: `${output}/wheels-dashboard-${width}.png` });
    await page.goto(`${origin}/wheels/${wheelId}`, { waitUntil: 'networkidle' }); await page.locator('.automation-card').first().waitFor(); assert.equal(await page.locator('.automation-target').count(), 0); assert.equal(await page.locator('.automation-card').count(), 4);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true); assert.deepEqual(errors, []); await context.close();
  }
});
