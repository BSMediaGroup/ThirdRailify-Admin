import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import test from 'node:test';
import { chromium } from 'playwright-core';
import { createCommerceDatabases, commerceEnvironment } from './commerce-test-helpers.mjs';
import { saveAutomationRule, deleteAutomationRule, listAutomationRules, dryRunAutomation, ingestAutomationEvents } from '../functions/_shared/automation-core.js';
import { automationsStatus } from '../functions/_shared/polls-core.js';

const ORIGIN = 'http://127.0.0.1:44207';
const OUTPUT = fileURLToPath(new URL('../.artifacts/raid-automations/', import.meta.url));
const kinds = ['rumble.chat.exact', 'rumble.rant', 'rumble.follow', 'subscriber_self_paid', 'rumble.gift_purchase'];
test('Raid shared editor, local D1 save/reload, exact dry run and pending runtime at four widths', async t => {
  const h = await createCommerceDatabases(); t.after(h.dispose); const env = commerceEnvironment(h);
  await mkdir(OUTPUT, { recursive: true });
  const now = new Date().toISOString();
  await h.commerceDb.prepare(`INSERT INTO wheels(id,reference_code,public_slug,title,lifecycle,visibility,owner_account_id,config_json,created_at,updated_at)
    VALUES ('wheel-fixture','W-FIXTURE','fixture','Community Draw','active','public','owner','{}',?,?)`).bind(now, now).run();
  const discoveryRuntime = { pollingIntervalSeconds: 60, rumbleDiscovery: { source: { scope: 'user:1sl8zm', id: '1sl8zm', type: 'user', displayName: 'ThirdRailify' }, observedAt: now, providerResponseAt: now, livestreams: [{ id: 'sample-live', title: 'Third Rail Live - Community Night', isLive: true }, { id: 'previous-live', title: 'Previous broadcast', isLive: false }] } };
  await h.commerceDb.prepare(`INSERT INTO bot_runtime_heartbeat(singleton_id,startup_instance_id,bot_version,desired_revision,applied_revision,runtime_json,heartbeat_at,updated_at) VALUES (1,'test','test',1,1,?,?,?)`).bind(JSON.stringify(discoveryRuntime), now, now).run();
  for (const [i, kind] of kinds.entries()) {
    const rule = (await saveAutomationRule(env, 'admin', { name: ['Chat entrants', 'Rant supporters', 'New followers', 'New subscribers', 'Gift purchasers'][i], description: '', enabled: i !== 2,
      sourceScope: 'user:1sl8zm', eventType: kind, conditions: kind === 'rumble.chat.exact' ? { exactText: 'ENTER' } : {}, actionType: 'wheel.add_actor', targetWheelId: 'wheel-fixture', duplicatePolicy: 'skip' })).rule;
    if (rule.enabled) await ingestAutomationEvents(env, { events: [{ ruleId: rule.id, ruleRevision: rule.revision, eventType: kind, sourceScope: rule.sourceScope, eventFingerprint: String(i + 1).repeat(64),
      actorKey: `rumble:user:1sl8zm:sample viewer ${i}`, actorLabel: `Sample Viewer ${i}`, providerEventAt: new Date(Date.now() + 1000).toISOString(), livestreamId: 'sample-live',
      evidence: { normalizedText: 'enter', amountCents: 500, totalGifts: 5, giftType: 'random', videoId: 123 } }] });
  }
  const server = spawn(process.execPath, ['node_modules/vite/bin/vite.js', '--host', '127.0.0.1', '--port', '44207'], { stdio: 'ignore' }); t.after(() => server.kill());
  for (let i = 0; i < 80; i++) { try { if ((await fetch(ORIGIN)).ok) break; } catch { /* startup */ } await new Promise(r => setTimeout(r, 100)); }
  const browser = await chromium.launch({ executablePath: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe', headless: true }); t.after(() => browser.close());
  const fault = false, schemaError = false;
  for (const width of (process.env.AUTOMATION_BROWSER_WIDTHS ? process.env.AUTOMATION_BROWSER_WIDTHS.split(',').map(Number) : [1920, 1440, 768, 390])) {
    discoveryRuntime.rumbleDiscovery.observedAt = new Date().toISOString();
    await h.commerceDb.prepare('UPDATE bot_runtime_heartbeat SET runtime_json=?,heartbeat_at=?').bind(JSON.stringify(discoveryRuntime), new Date().toISOString()).run();
    const context = await browser.newContext({ viewport: { width, height: width < 800 ? 1000 : 1080 }, reducedMotion: 'reduce' }); const page = await context.newPage();
    const errors = []; page.on('pageerror', e => errors.push(e.message));
    await page.route('**/api/**', async route => {
      const url = new URL(route.request().url()), path = url.pathname; const body = route.request().postDataJSON();
      const json = (value, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(value) });
      try {
        if (path === '/api/auth/config') return json({ configured: true, emailSignupConfigured: false, turnstileSiteKey: null, oauthProviders: [], oauthProviderStates: [], publicOrigin: ORIGIN, adminOrigin: ORIGIN, environment: 'test', cookieMode: 'host-only' });
        if (path === '/api/auth/session') return json({ ok: true, authenticated: true, csrfToken: 'fixture-csrf', access: { isAdmin: true, isMasterAdmin: true }, account: { id: 'master', email: 'master@example.test', displayName: 'Master Admin', avatarUrl: null, providers: ['email'], role: 'admin', adminLevel: 'master', status: 'active', emailVerified: true, createdAt: now, source: 'env_master' } });
        if (path === '/api/admin/inbox/summary') return json({ ok: true, unread: 0, actionable: { goats: { total: 0 } } });
        if (path === '/api/admin/automations') { const state = await automationsStatus(env); state.runtime = { state: fault ? 'stale' : 'online', ageSeconds: fault ? 90 : 2, desiredRevision: 1, appliedRevision: 1, discordConnected: true, rumbleConfigured: true, providerState: 'live', heartbeatAt: now, rumbleDiscovery: { source: { scope: 'user:1sl8zm' } }, eventAutomation: { activeRules: 4, pending: fault ? 3 : 0, transitions: 2, lastTransition: 'rumble.livestream.stopped', lastSnapshotAt: now, lastFault: fault ? 'event_submission_failed' : '' } }; return json(state); }
        if (path === '/api/admin/automations/rules' && schemaError) return json({ message: 'The service database schema is not compatible with this deployment.' }, 503);
        if (path === '/api/admin/automations/rules') { if (route.request().method() === 'POST') return json(await saveAutomationRule(env, 'admin', body)); const result = await listAutomationRules(env, url.searchParams.get('wheelId') || ''); if (width === 1920) delete result.readiness; if (width === 390) result.readiness.raidSchema = false; return json(result); };
        if (path === '/api/admin/automations/rules/delete') return json(await deleteAutomationRule(env, 'admin', body));
        if (path === '/api/admin/automations/test') return json(dryRunAutomation(body));
        if (path === '/api/admin/wheels/wheel-fixture') return json({ ok: true, item: { id: 'wheel-fixture', title: 'Community Draw', reference: 'W-FIXTURE', slug: 'fixture', revision: 5, participantCount: 4, entries: [], results: [], access: [], config: {} } });
        return json({ ok: true });
      } catch (e) { return json({ message: e.message, issues: e.issues }, e.status || 400); }
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
    await page.getByRole('button', { name: 'Create automation', exact: true }).click();
    const editor = page.getByRole('form', { name: 'Automation rule editor' });
    await editor.getByLabel('Rule name', { exact: true }).fill(`Raid local ${width}`);
    await editor.getByLabel('Target Wheel', { exact: true }).selectOption('wheel-fixture');
    await editor.getByLabel('Livestream', { exact: true }).selectOption('detected');
    await editor.getByLabel('Detected livestream', { exact: true }).selectOption('sample-live');
    await editor.getByLabel('Event family', { exact: true }).selectOption('rumble.raid.received');
    assert.equal(await editor.locator('.event-source__choice strong').innerText(), 'ThirdRailify');
    assert.equal(await editor.getByLabel('Detected livestream', { exact: true }).inputValue(), 'sample-live');
    assert.equal(await editor.getByLabel('Exact message (required)', { exact: true }).count(), 0);
    assert.equal(await editor.getByLabel('Minimum gifts (optional)', { exact: true }).count(), 0);
    assert.equal(await editor.getByLabel('Minimum amount in cents (optional)', { exact: true }).count(), 0);
    assert.equal(await editor.getByLabel('Award based on').locator('option').count(), 1);
    await editor.getByLabel('Entries per raid notification').fill('10');
    await editor.getByLabel('Repeat actor behavior').selectOption('accumulate');
    await editor.getByText('Chat-derived', { exact: true }).waitFor();
    if (width === 1920 || width === 390) await capture('01-raid-editor', editor);
    await editor.getByRole('button', { name: 'Save paused rule', exact: true }).click();
    await page.getByRole('heading', { name: `Raid local ${width}`, exact: true }).waitFor();
    await page.reload({ waitUntil: 'networkidle' });
    const card = page.locator('.event-rule').filter({ has: page.getByRole('heading', { name: `Raid local ${width}`, exact: true }) });
    await card.waitFor(); await card.getByRole('button', { name: 'Edit', exact: true }).click();
    assert.equal(await editor.getByLabel('Entries per raid notification').inputValue(), '10');
    assert.equal(await editor.getByLabel('Repeat actor behavior').inputValue(), 'accumulate');
    if (width === 1440) await capture('02-saved-reloaded', editor);
    const receiptCount = (await h.commerceDb.prepare('SELECT COUNT(*) AS n FROM automation_receipts').first()).n;
    const weights = (await h.commerceDb.prepare('SELECT id,weight FROM wheel_entries ORDER BY id').all()).results;
    await editor.getByRole('button', { name: 'Load redacted sample', exact: true }).click();
    await editor.getByRole('button', { name: 'Test rule', exact: true }).click();
    await editor.getByText('Matched', { exact: true }).waitFor();
    await editor.locator('.event-test-result').getByText(/not independently verified/).waitFor();
    if (width === 1440) await capture('03-dry-run-match', editor);
    for (const [name, text] of [['commentary', '@ExampleRaider is raiding the channel! BRR BRR BRR BRRRRRRR!!'], ['emotes', ':RAID: :RUMBLERAID:']]) {
      await editor.getByLabel('Sample message', { exact: true }).fill(text);
      await editor.getByRole('button', { name: 'Test rule', exact: true }).click();
      await editor.getByText('No match', { exact: true }).waitFor();
      if (width === 1440) await capture(`04-no-match-${name}`, editor);
    }
    assert.equal((await h.commerceDb.prepare('SELECT COUNT(*) AS n FROM automation_receipts').first()).n, receiptCount);
    assert.deepEqual((await h.commerceDb.prepare('SELECT id,weight FROM wheel_entries ORDER BY id').all()).results, weights);
    await editor.getByLabel('Enable on save').check();
    await editor.getByRole('button', { name: 'Save and enable', exact: true }).click();
    await card.getByText(/Pending capable Bot/).waitFor();
    if (width === 1920) await capture('05-unsupported-runtime', card);
    await page.goto(`${ORIGIN}/wheels/wheel-fixture`, { waitUntil: 'networkidle' });
    await page.getByRole('heading', { name: 'Wheel automation', exact: true }).waitFor();
    await page.getByRole('button', { name: 'Create automation', exact: true }).click();
    await editor.getByLabel('Event family', { exact: true }).selectOption('rumble.raid.received');
    await editor.getByLabel('Entries per raid notification').fill('10');
    await editor.getByLabel('Repeat actor behavior').selectOption('accumulate');
    assert.equal(await editor.getByLabel('Target Wheel', { exact: true }).inputValue(), 'wheel-fixture');
    if (width === 768) await capture('06-wheel-editor', editor);
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    assert.deepEqual(errors, []); await context.close();
  }
});
