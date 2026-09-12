import assert from 'node:assert/strict';
import { mkdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import test from 'node:test';
import { chromium } from 'playwright-core';
import { createCommerceDatabases, commerceEnvironment } from './commerce-test-helpers.mjs';
import { saveAutomationRule, deleteAutomationRule, listAutomationRules, dryRunAutomation, ingestAutomationEvents } from '../functions/_shared/automation-core.js';
import { automationsStatus } from '../functions/_shared/polls-core.js';
import { applyMigration } from './auth-test-helpers.mjs';
import { listRosterRules, previewRosterSync, saveRosterRule, syncRosterRule } from '../functions/_shared/subscriber-roster.js';

const ORIGIN = 'http://127.0.0.1:44206';
const OUTPUT = fileURLToPath(new URL('../.artifacts/event-automations-v11/', import.meta.url));
const kinds = ['rumble.chat.exact', 'rumble.rant', 'rumble.follow', 'subscriber_self_paid', 'rumble.gift_purchase'];
test('operational Trigger Studio and Wheel panel: real local D1 CRUD and dry run at four viewports', async t => {
  const h = await createCommerceDatabases(); t.after(h.dispose); const env = commerceEnvironment(h);
  for (const file of ['0045_rumble_intelligence.sql', '0048_subscriber_roster_automation.sql']) await applyMigration(h.commerceDb, await readFile(new URL(`../commerce-migrations/${file}`, import.meta.url), 'utf8'));
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
  const server = spawn(process.execPath, ['node_modules/vite/bin/vite.js', '--host', '127.0.0.1', '--port', '44206'], { stdio: 'ignore' }); t.after(() => server.kill());
  for (let i = 0; i < 80; i++) { try { if ((await fetch(ORIGIN)).ok) break; } catch { /* startup */ } await new Promise(r => setTimeout(r, 100)); }
  const browser = await chromium.launch({ executablePath: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe', headless: true }); t.after(() => browser.close());
  let fault = false, schemaError = false;
  for (const width of (process.env.AUTOMATION_BROWSER_WIDTHS ? process.env.AUTOMATION_BROWSER_WIDTHS.split(',').map(Number) : [1920, 1440, 768, 390])) {
    discoveryRuntime.rumbleDiscovery.observedAt = new Date().toISOString();
    await h.commerceDb.prepare('UPDATE bot_runtime_heartbeat SET runtime_json=?,heartbeat_at=?').bind(JSON.stringify(discoveryRuntime), new Date().toISOString()).run();
    const context = await browser.newContext({ viewport: { width, height: width < 800 ? 1000 : 1080 }, reducedMotion: 'reduce' }); const page = await context.newPage();
    if (width === 1440) await page.clock.install();
    const errors = []; page.on('pageerror', e => errors.push(e.stack || e.message));
    await page.route('**/api/**', async route => {
      const url = new URL(route.request().url()), path = url.pathname; const body = route.request().postDataJSON();
      const json = (value, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(value) });
      try {
        if (path === '/api/auth/config') return json({ configured: true, emailSignupConfigured: false, turnstileSiteKey: null, oauthProviders: [], oauthProviderStates: [], publicOrigin: ORIGIN, adminOrigin: ORIGIN, environment: 'test', cookieMode: 'host-only' });
        if (path === '/api/auth/session') return json({ ok: true, authenticated: true, csrfToken: 'fixture-csrf', access: { isAdmin: true, isMasterAdmin: true }, account: { id: 'master', email: 'master@example.test', displayName: 'Master Admin', avatarUrl: null, providers: ['email'], role: 'admin', adminLevel: 'master', status: 'active', emailVerified: true, createdAt: now, source: 'env_master' } });
        if (path === '/api/admin/inbox/summary') return json({ ok: true, unread: 0, actionable: { goats: { total: 0 } } });
        if (path === '/api/admin/polls') return json({ ok: true, items: [] });
        if (path === '/api/admin/automations') { const state = await automationsStatus(env); state.runtime = { state: fault ? 'stale' : 'online', ageSeconds: fault ? 90 : 2, desiredRevision: 1, appliedRevision: 1, discordConnected: true, rumbleConfigured: true, providerState: 'live', heartbeatAt: now, rumbleDiscovery: { source: { scope: 'user:1sl8zm' } }, eventAutomation: { activeRules: 4, pending: fault ? 3 : 0, transitions: 2, lastTransition: 'rumble.livestream.stopped', lastSnapshotAt: now, lastFault: fault ? 'event_submission_failed' : '' } }; return json(state); }
        if (path === '/api/admin/automations/poll-voting') return json({ ok: true, policies: [], polls: [], lots: [] });
        if (path === '/api/admin/automations/rules' && schemaError) return json({ message: 'The service database schema is not compatible with this deployment.' }, 503);
        if (path === '/api/admin/automations/rules') return json(route.request().method() === 'POST' ? await saveAutomationRule(env, 'admin', body) : await listAutomationRules(env, url.searchParams.get('wheelId') || ''));
        if (path === '/api/admin/automations/rules/delete') return json(await deleteAutomationRule(env, 'admin', body));
        if (path === '/api/admin/automations/test') return json(dryRunAutomation(body));
        if (path === '/api/admin/automations/rosters') return json(route.request().method() === 'POST' ? await saveRosterRule(env, 'admin', body) : await listRosterRules(env, url.searchParams.get('wheelId') || ''));
        if (path === '/api/admin/automations/rosters/preview') return json(await previewRosterSync(env, body.ruleId));
        if (path === '/api/admin/automations/rosters/sync') return json(await syncRosterRule(env, 'admin', body));
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
    await page.goto(`${ORIGIN}/automations`, { waitUntil: 'domcontentloaded' });
    try { await page.getByRole('heading', { name: 'Chat entrants', exact: true }).waitFor(); }
    catch (error) { console.error('Trigger Studio browser diagnostics:', errors, await page.locator('body').innerText()); throw error; }
    await page.getByRole('heading', { name: 'Current Self-Paid Subscriber Roster', exact: true }).waitFor();
    await page.screenshot({ path: `${OUTPUT}/00-full-page-${width}.png`, fullPage: true });
    await capture('01-overview-active-disabled');
    await page.getByRole('button', { name: 'Create automation', exact: true }).click();
    const editor = page.getByRole('form', { name: 'Automation rule editor' });
    await editor.getByText('Select a Rumble source.', { exact: true }).waitFor({ state: 'hidden' });
    assert.equal(await editor.locator('.event-source__choice strong').innerText(), 'ThirdRailify');
    await capture('18-inline-required-fields', editor);
    await editor.getByRole('button', { name: 'Rumble source', exact: true }).click(); await capture('19-detected-source-open', editor);
    await editor.locator('.event-source__options button').click();
    await editor.getByText('Advanced / Custom source', { exact: true }).click(); await capture('20-advanced-source', editor);
    await editor.getByLabel('Custom Rumble source', { exact: true }).fill('bad source');
    assert.equal(await editor.getByRole('button', { name: 'Save paused rule', exact: true }).isDisabled(), true);
    await capture('21-invalid-custom-source', editor);
    await editor.getByLabel('Custom Rumble source', { exact: true }).fill('channel:example');
    await editor.getByLabel('Custom Rumble source', { exact: true }).fill('user:1sl8zm');
    await editor.getByText('Advanced / Custom source', { exact: true }).click();
    await editor.getByLabel('Rule name', { exact: true }).fill(`Browser rule ${width}`);
    await editor.getByLabel('Target Wheel', { exact: true }).selectOption('wheel-fixture');
    await editor.getByLabel('Exact message (required)', { exact: true }).fill('ENTER');
    await editor.getByLabel('Livestream', { exact: true }).selectOption('detected');
    await editor.getByLabel('Detected livestream', { exact: true }).selectOption('sample-live');
    await capture('02-chat-editor', editor);
    await editor.getByLabel('Sample livestream', { exact: true }).selectOption('sample-live');
    await editor.getByLabel('Sample message', { exact: true }).fill(' enter ');
    await editor.getByRole('button', { name: 'Test rule', exact: true }).click();
    await editor.getByText('Matched', { exact: true }).waitFor(); await capture('11-dry-run-match', editor);
    await editor.getByLabel('Sample message', { exact: true }).fill('enter please');
    await editor.getByRole('button', { name: 'Test rule', exact: true }).click();
    await editor.getByText('No match', { exact: true }).waitFor(); await capture('12-dry-run-no-match', editor);
    const before = (await h.commerceDb.prepare('SELECT COUNT(*) AS n FROM wheel_entries').first()).n;
    assert.equal(before, 4, 'dry run must not mutate entries');
    for (const [kind, name] of [['rumble.rant', '03-rant-editor'], ['rumble.follow', '05-follower-editor'], ['subscriber_self_paid', '06-subscriber-editor'], ['rumble.gift_purchase', '08-gift-editor'], ['rumble.livestream.started', '10-livestream-incompatible']]) {
      await editor.getByLabel('Event family', { exact: true }).selectOption(kind); await capture(name, editor);
      if (kind === 'rumble.rant') { await editor.getByLabel('Minimum amount in cents (optional)', { exact: true }).fill('500'); await capture('04-rant-amount', editor); }
      if (kind === 'subscriber_self_paid') { await editor.getByText(/Exactly 500 reported cents is required/).waitFor(); await capture('07-subscriber-policy', editor); }
      if (kind === 'rumble.gift_purchase') {
        assert.equal(await editor.getByLabel('Livestream', { exact: true }).count(), 0);
        await editor.getByLabel('Entries per purchase', { exact: true }).fill('5'); await capture('22-gift-fixed', editor);
        await editor.getByLabel('Award based on', { exact: true }).selectOption('per_gift');
        await editor.getByLabel('Entries per gift', { exact: true }).fill('0');
        assert.equal(await editor.getByRole('button', { name: 'Save paused rule', exact: true }).isDisabled(), true); await capture('33-invalid-award', editor);
        await editor.getByLabel('Entries per gift', { exact: true }).fill('5'); await capture('23-gift-per-unit', editor);
        await editor.getByLabel('Repeat actor behavior', { exact: true }).selectOption('accumulate'); await capture('24-gift-accumulation', editor);
        await editor.getByLabel('Minimum gifts (optional)', { exact: true }).fill('5'); await capture('09-gift-count', editor);
        await editor.getByRole('button', { name: 'Test rule', exact: true }).click();
        await editor.getByText(/Would add 25 entries to purchaser/).waitFor(); await capture('25-gift-dry-run', editor);
      }
      if (kind === 'rumble.rant') {
        await editor.getByLabel('Sample message', { exact: true }).fill('ENTER');
        await editor.getByLabel('Entries per Rant', { exact: true }).fill('5'); await capture('26-rant-fixed', editor);
        await editor.getByLabel('Award based on', { exact: true }).selectOption('per_amount');
        await editor.getByLabel('Entries per unit', { exact: true }).fill('1'); await capture('27-rant-per-cents', editor);
        await editor.getByLabel('Repeat actor behavior', { exact: true }).selectOption('accumulate'); await capture('28-rant-accumulation', editor);
        await editor.getByRole('button', { name: 'Test rule', exact: true }).click();
        await editor.getByText(/Would add 5 entries/).waitFor(); await capture('29-rant-dry-run', editor);
      }
      if (kind.startsWith('rumble.livestream')) assert.equal(await editor.getByRole('button', { name: /Save/ }).count(), 0);
    }
    for (const [kind, mode, awardLabel] of [['rumble.gift_purchase', 'per_gift', 'Entries per gift'], ['rumble.rant', 'per_amount', 'Entries per unit']]) {
      await editor.getByLabel('Event family', { exact: true }).selectOption(kind);
      await editor.getByLabel('Award based on', { exact: true }).selectOption(mode);
      await editor.getByLabel(awardLabel, { exact: true }).fill('3');
      await editor.getByLabel('Repeat actor behavior', { exact: true }).selectOption('accumulate');
      await editor.getByLabel('Rule name', { exact: true }).fill(`${kind} valid ${width}`);
      await capture(kind === 'rumble.rant' ? '30-valid-rant-save' : '31-valid-gift-save', editor);
      await editor.getByRole('button', { name: 'Save paused rule', exact: true }).click();
      const saved = page.locator('.automation-card').filter({ has: page.getByRole('heading', { name: `${kind} valid ${width}`, exact: true }) });
      await saved.waitFor(); await saved.getByRole('button', { name: 'Edit', exact: true }).click();
      assert.equal(await editor.getByLabel(awardLabel, { exact: true }).inputValue(), '3');
      assert.equal(await editor.getByLabel('Repeat actor behavior', { exact: true }).inputValue(), 'accumulate');
    }
    await editor.getByLabel('Rule name', { exact: true }).fill(`Browser rule ${width}`);
    await editor.getByLabel('Event family', { exact: true }).selectOption('rumble.follow');
    await editor.getByRole('button', { name: 'Save paused rule', exact: true }).click();
    await page.getByRole('heading', { name: `Browser rule ${width}`, exact: true }).waitFor();
    const card = page.locator('.automation-card').filter({ has: page.getByRole('heading', { name: `Browser rule ${width}`, exact: true }) });
    const toggle = card.getByRole('switch', { name: `Enable automation Browser rule ${width}`, exact: true });
    await toggle.click(); await card.locator('button[role="switch"][aria-checked="true"]').waitFor();
    await page.reload({ waitUntil: 'domcontentloaded' }); await card.locator('button[role="switch"][aria-checked="true"]').waitFor();
    await toggle.click(); await card.locator('button[role="switch"][aria-checked="false"]').waitFor(); await capture('15-disabled-rule', card);
    page.once('dialog', dialog => dialog.accept()); await card.getByRole('button', { name: 'Delete', exact: true }).click(); await card.waitFor({ state: 'detached' });
    fault = true; await page.reload({ waitUntil: 'domcontentloaded' }); await page.locator('.event-runtime').getByText('Needs attention', { exact: true }).waitFor(); await capture('16-stale-event-engine'); fault = false;
    schemaError = true; await page.reload({ waitUntil: 'domcontentloaded' });
    await page.getByText('Rules unavailable', { exact: true }).waitFor();
    assert.equal(await page.getByText('Loading rules\u2026', { exact: true }).count(), 0);
    assert.equal(await page.getByRole('button', { name: 'Create automation', exact: true }).isDisabled(), true);
    assert.equal(await page.locator('.event-studio').evaluate(el => getComputedStyle(el).backgroundColor), 'rgb(11, 11, 9)');
    await capture('17-schema-error');
    schemaError = false; await page.getByRole('button', { name: 'Refresh rules', exact: true }).click();
    await page.getByRole('heading', { name: 'Chat entrants', exact: true }).waitFor();
    await page.goto(`${ORIGIN}/wheels/wheel-fixture`, { waitUntil: 'domcontentloaded' }); await page.getByRole('heading', { name: 'Wheel automation', exact: true }).waitFor(); await page.getByRole('heading', { name: 'Chat entrants', exact: true }).waitFor();
    await capture('13-wheel-panel'); await capture('14-wheel-activity', page.locator('.event-activity'));
    await page.getByRole('button', { name: 'Create automation', exact: true }).click(); assert.equal(await editor.getByLabel('Target Wheel', { exact: true }).inputValue(), 'wheel-fixture');
    await editor.getByLabel('Event family', { exact: true }).selectOption('rumble.gift_purchase');
    await editor.getByLabel('Award based on', { exact: true }).selectOption('per_gift');
    await editor.getByLabel('Entries per gift', { exact: true }).fill('5');
    await editor.getByLabel('Repeat actor behavior', { exact: true }).selectOption('accumulate');
    await capture('32-wheel-shared-editor', editor);
    if (width === 1440) {
      await editor.getByLabel('Rule name', { exact: true }).fill('Saved source offline');
      await editor.getByRole('button', { name: 'Save paused rule', exact: true }).click();
      const offlineCard = page.locator('.automation-card').filter({ has: page.getByRole('heading', { name: 'Saved source offline', exact: true }) });
      await offlineCard.waitFor(); await offlineCard.getByRole('button', { name: 'Edit', exact: true }).click();
      await h.commerceDb.prepare('UPDATE bot_runtime_heartbeat SET heartbeat_at=?').bind(new Date(Date.now() - 100000).toISOString()).run();
      await page.clock.fastForward(31000);
      await editor.getByText('Delayed \u00b7 cached discovery', { exact: true }).waitFor(); await capture('34-stale-discovery', editor);
      await h.commerceDb.prepare('UPDATE bot_runtime_heartbeat SET heartbeat_at=?').bind(new Date(Date.now() - 300000).toISOString()).run();
      await page.clock.fastForward(31000);
      await editor.getByText('Offline \u00b7 cached discovery', { exact: true }).waitFor(); await capture('35-offline-cached-source', editor);
      await h.commerceDb.prepare('DELETE FROM bot_runtime_heartbeat').run(); await page.clock.fastForward(31000);
      await editor.getByText('Discovery unavailable. Use Advanced to configure a source.', { exact: true }).waitFor();
      assert.equal(await editor.locator('.event-source__choice strong').innerText(), 'ThirdRailify'); await capture('36-saved-source-without-discovery', editor);
      await editor.getByRole('button', { name: 'Close editor', exact: true }).click();
      await page.getByRole('button', { name: 'Create automation', exact: true }).click();
      await editor.getByText('Select a Rumble source.', { exact: true }).waitFor(); await capture('37-new-rule-offline', editor);
      await editor.getByText('Advanced / Custom source', { exact: true }).click();
      await editor.getByLabel('Custom Rumble source', { exact: true }).fill('channel:custom');
      await editor.getByLabel('Rule name', { exact: true }).fill('Custom offline rule');
      await editor.getByLabel('Exact message (required)', { exact: true }).fill('ENTER');
      await editor.getByRole('button', { name: 'Save paused rule', exact: true }).click();
      await page.getByRole('heading', { name: 'Custom offline rule', exact: true }).waitFor();
      const freshNow = new Date().toISOString(); discoveryRuntime.rumbleDiscovery.observedAt = freshNow;
      await h.commerceDb.prepare(`INSERT INTO bot_runtime_heartbeat(singleton_id,startup_instance_id,bot_version,desired_revision,applied_revision,runtime_json,heartbeat_at,updated_at) VALUES (1,'test','test',1,1,?,?,?)`).bind(JSON.stringify(discoveryRuntime), freshNow, freshNow).run();
    }
    assert.deepEqual(errors, []); await context.close();
  }
});
