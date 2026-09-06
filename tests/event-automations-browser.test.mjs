import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import test from 'node:test';
import { chromium } from 'playwright-core';
import { createCommerceDatabases, commerceEnvironment } from './commerce-test-helpers.mjs';
import { saveAutomationRule, deleteAutomationRule, listAutomationRules, dryRunAutomation, ingestAutomationEvents } from '../functions/_shared/automation-core.js';
import { automationsStatus } from '../functions/_shared/polls-core.js';

const ORIGIN = 'http://127.0.0.1:44206';
const OUTPUT = fileURLToPath(new URL('../.artifacts/event-automations/', import.meta.url));
const kinds = ['rumble.chat.exact', 'rumble.rant', 'rumble.follow', 'rumble.subscribe', 'rumble.gift_purchase'];
test('operational Trigger Studio and Wheel panel: real local D1 CRUD and dry run at four viewports', async t => {
  const h = await createCommerceDatabases(); t.after(h.dispose); const env = commerceEnvironment(h);
  await mkdir(OUTPUT, { recursive: true });
  const now = new Date().toISOString();
  await h.commerceDb.prepare(`INSERT INTO wheels(id,reference_code,public_slug,title,lifecycle,visibility,owner_account_id,config_json,created_at,updated_at)
    VALUES ('wheel-fixture','W-FIXTURE','fixture','Community Draw','active','public','owner','{}',?,?)`).bind(now, now).run();
  for (const [i, kind] of kinds.entries()) {
    const rule = (await saveAutomationRule(env, 'admin', { name: ['Chat entrants', 'Rant supporters', 'New followers', 'New subscribers', 'Gift purchasers'][i], description: '', enabled: i !== 2,
      sourceScope: 'user:fixture', eventType: kind, conditions: kind === 'rumble.chat.exact' ? { exactText: 'ENTER' } : {}, actionType: 'wheel.add_actor', targetWheelId: 'wheel-fixture', duplicatePolicy: 'skip' })).rule;
    if (rule.enabled) await ingestAutomationEvents(env, { events: [{ ruleId: rule.id, ruleRevision: rule.revision, eventType: kind, sourceScope: rule.sourceScope, eventFingerprint: String(i + 1).repeat(64),
      actorKey: `rumble:user:fixture:sample viewer ${i}`, actorLabel: `Sample Viewer ${i}`, providerEventAt: new Date(Date.now() + 1000).toISOString(), livestreamId: 'sample-live',
      evidence: { normalizedText: 'enter', amountCents: 500, totalGifts: 5, giftType: 'random', videoId: 123 } }] });
  }
  const server = spawn(process.execPath, ['node_modules/vite/bin/vite.js', 'preview', '--host', '127.0.0.1', '--port', '44206'], { stdio: 'ignore' }); t.after(() => server.kill());
  for (let i = 0; i < 80; i++) { try { if ((await fetch(ORIGIN)).ok) break; } catch { /* startup */ } await new Promise(r => setTimeout(r, 100)); }
  const browser = await chromium.launch({ executablePath: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe', headless: true }); t.after(() => browser.close());
  let fault = false;
  for (const width of [1920, 1440, 768, 390]) {
    const context = await browser.newContext({ viewport: { width, height: width < 800 ? 1000 : 1080 }, reducedMotion: 'reduce' }); const page = await context.newPage();
    const errors = []; page.on('pageerror', e => errors.push(e.message));
    await page.route('**/api/**', async route => {
      const url = new URL(route.request().url()), path = url.pathname; const body = route.request().postDataJSON();
      const json = (value, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(value) });
      try {
        if (path === '/api/auth/config') return json({ configured: true, emailSignupConfigured: false, turnstileSiteKey: null, oauthProviders: [], oauthProviderStates: [], publicOrigin: ORIGIN, adminOrigin: ORIGIN, environment: 'test', cookieMode: 'host-only' });
        if (path === '/api/auth/session') return json({ ok: true, authenticated: true, csrfToken: 'fixture-csrf', access: { isAdmin: true, isMasterAdmin: true }, account: { id: 'master', email: 'master@example.test', displayName: 'Master Admin', avatarUrl: null, providers: ['email'], role: 'admin', adminLevel: 'master', status: 'active', emailVerified: true, createdAt: now, source: 'env_master' } });
        if (path === '/api/admin/inbox/summary') return json({ ok: true, unread: 0, actionable: { goats: { total: 0 } } });
        if (path === '/api/admin/automations') { const state = await automationsStatus(env); state.runtime = { state: fault ? 'stale' : 'online', ageSeconds: fault ? 90 : 2, desiredRevision: 1, appliedRevision: 1, discordConnected: true, rumbleConfigured: true, providerState: 'live', heartbeatAt: now, rumbleDiscovery: { source: { scope: 'user:fixture' } }, eventAutomation: { activeRules: 4, pending: fault ? 3 : 0, transitions: 2, lastTransition: 'rumble.livestream.stopped', lastSnapshotAt: now, lastFault: fault ? 'event_submission_failed' : '' } }; return json(state); }
        if (path === '/api/admin/automations/rules') return json(route.request().method() === 'POST' ? await saveAutomationRule(env, 'admin', body) : await listAutomationRules(env, url.searchParams.get('wheelId') || ''));
        if (path === '/api/admin/automations/rules/delete') return json(await deleteAutomationRule(env, 'admin', body));
        if (path === '/api/admin/automations/test') return json(dryRunAutomation(body));
        if (path === '/api/admin/wheels/wheel-fixture') return json({ ok: true, item: { id: 'wheel-fixture', title: 'Community Draw', reference: 'W-FIXTURE', slug: 'fixture', revision: 5, participantCount: 4, entries: [], results: [], access: [], config: {} } });
        return json({ ok: true });
      } catch (e) { return json({ message: e.message }, e.status || 400); }
    });
    const capture = async (name, locator = page.locator('.event-studio')) => {
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth), `${name}/${width} page overflow`);
      assert.equal(await locator.locator('input,select,button').evaluateAll(nodes => nodes.some(n => { const r = n.getBoundingClientRect(); return r.width > 0 && (r.left < -1 || r.right > innerWidth + 1); })), false, `${name}/${width} control overflow`);
      // Element crops taller than the viewport otherwise capture the shell's sticky
      // bar across their middle. Full-page evidence below retains the actual shell.
      await locator.screenshot({ path: `${OUTPUT}/${name}-${width}.png`, style: '.topbar, .skip-link { visibility: hidden !important; }' });
    };
    await page.goto(`${ORIGIN}/automations`, { waitUntil: 'networkidle' });
    await page.getByRole('heading', { name: 'Chat entrants', exact: true }).waitFor();
    await page.screenshot({ path: `${OUTPUT}/00-full-page-${width}.png`, fullPage: true });
    await capture('01-overview-active-disabled');
    await page.getByRole('button', { name: 'Create automation', exact: true }).click();
    const editor = page.getByRole('form', { name: 'Automation rule editor' });
    await editor.getByLabel('Rule name', { exact: true }).fill(`Browser rule ${width}`);
    await editor.getByLabel('Target Wheel', { exact: true }).selectOption('wheel-fixture');
    await editor.getByLabel('Exact message (required)', { exact: true }).fill('ENTER');
    await capture('02-chat-editor', editor);
    await editor.getByLabel('Sample message', { exact: true }).fill(' enter ');
    await editor.getByRole('button', { name: 'Test rule', exact: true }).click();
    await editor.getByText('Matched', { exact: true }).waitFor(); await capture('11-dry-run-match', editor);
    await editor.getByLabel('Sample message', { exact: true }).fill('enter please');
    await editor.getByRole('button', { name: 'Test rule', exact: true }).click();
    await editor.getByText('No match', { exact: true }).waitFor(); await capture('12-dry-run-no-match', editor);
    const before = (await h.commerceDb.prepare('SELECT COUNT(*) AS n FROM wheel_entries').first()).n;
    assert.equal(before, 4, 'dry run must not mutate entries');
    for (const [kind, name] of [['rumble.rant', '03-rant-editor'], ['rumble.follow', '05-follower-editor'], ['rumble.subscribe', '06-subscriber-editor'], ['rumble.gift_purchase', '08-gift-editor'], ['rumble.livestream.started', '10-livestream-incompatible']]) {
      await editor.getByLabel('Event family', { exact: true }).selectOption(kind); await capture(name, editor);
      if (kind === 'rumble.rant' || kind === 'rumble.subscribe') { await editor.getByLabel('Minimum amount in cents (optional)', { exact: true }).fill('500'); await capture(kind === 'rumble.rant' ? '04-rant-amount' : '07-subscriber-amount', editor); }
      if (kind === 'rumble.gift_purchase') { await editor.getByLabel('Minimum gifts (optional)', { exact: true }).fill('5'); await capture('09-gift-count', editor); }
      if (kind.startsWith('rumble.livestream')) assert.equal(await editor.getByRole('button', { name: /Save/ }).count(), 0);
    }
    await editor.getByLabel('Event family', { exact: true }).selectOption('rumble.follow');
    await editor.getByRole('button', { name: 'Save paused rule', exact: true }).click();
    await page.getByRole('heading', { name: `Browser rule ${width}`, exact: true }).waitFor();
    const card = page.locator('.event-rule').filter({ has: page.getByRole('heading', { name: `Browser rule ${width}`, exact: true }) });
    await card.getByRole('button', { name: 'Enable', exact: true }).click(); await card.getByRole('button', { name: 'Disable', exact: true }).waitFor();
    await page.reload({ waitUntil: 'networkidle' }); await card.getByRole('button', { name: 'Disable', exact: true }).waitFor();
    await card.getByRole('button', { name: 'Disable', exact: true }).click(); await card.getByRole('button', { name: 'Enable', exact: true }).waitFor(); await capture('15-disabled-rule', card);
    page.once('dialog', dialog => dialog.accept()); await card.getByRole('button', { name: 'Delete', exact: true }).click(); await card.waitFor({ state: 'detached' });
    fault = true; await page.reload({ waitUntil: 'networkidle' }); await page.getByText(/Event engine: event_submission_failed/).waitFor(); await capture('16-stale-event-engine'); fault = false;
    await page.goto(`${ORIGIN}/wheels/wheel-fixture`, { waitUntil: 'networkidle' }); await page.getByRole('heading', { name: 'Wheel automation', exact: true }).waitFor(); await page.getByRole('heading', { name: 'Chat entrants', exact: true }).waitFor();
    await capture('13-wheel-panel'); await capture('14-wheel-activity', page.locator('.event-activity'));
    await page.getByRole('button', { name: 'Create automation', exact: true }).click(); assert.equal(await editor.getByLabel('Target Wheel', { exact: true }).inputValue(), 'wheel-fixture');
    assert.deepEqual(errors, []); await context.close();
  }
});
