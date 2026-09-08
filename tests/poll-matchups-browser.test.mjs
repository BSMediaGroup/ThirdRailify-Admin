import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createHash, createHmac, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import test from 'node:test';
import sharp from 'sharp';
import { chromium } from 'playwright-core';
import { createCommerceDatabases, commerceEnvironment } from './commerce-test-helpers.mjs';
import { createSession, resolveSession, sessionEnvelope } from '../functions/_shared/auth-core.js';
import { createPoll, changePollLifecycle, botActivePoll, getPublicPoll } from '../functions/_shared/polls-core.js';
import { savePollPolicy } from '../functions/_shared/poll-credits.js';
import { onRequest as botHandler } from '../functions/api/internal/bot/[[path]].js';
import { onRequest as pollHandler } from '../functions/api/polls/[[path]].js';
import { onRequest as adminPollHandler } from '../functions/api/admin/polls/[[path]].js';
import { onRequest as automationHandler } from '../functions/api/admin/automations/[[path]].js';
import { onRequest as publicHandler } from '../../ThirdRailify/functions/api/polls/[[path]].js';

const PUBLIC = 'http://127.0.0.1:44931', ADMIN = 'http://127.0.0.1:44932';
const artifacts = process.env.POLL_BROWSER_ARTIFACTS || '.artifacts/poll-credits/acceptance';
const secret = 'offline-browser-poll-secret';
test('local Bot evidence, real D1, Public relay and Admin controls across responsive matchup surfaces', { timeout: 180000 }, async t => {
  await mkdir(artifacts, { recursive: true });
  const h = await createCommerceDatabases({ withMedia: true }); t.after(h.dispose);
  const env = commerceEnvironment(h, { THIRDRAILIFY_PUBLIC_ORIGIN: PUBLIC, THIRDRAILIFY_ADMIN_ORIGIN: ADMIN, THIRDRAILIFY_COMMUNITY_API_SECRET: secret, THIRDRAILIFY_POLL_ANONYMOUS_SECRET: secret, THIRDRAILIFY_BOT_ADMIN_SECRET: secret, THIRDRAILIFY_POLL_VOTER_SECRET: secret, THIRDRAILIFY_PROFILE_MEDIA: h.media, THIRDRAILIFY_MEDIA_PUBLIC_ORIGIN: '' });
  const timestamp = new Date().toISOString();
  await h.authDb.prepare("INSERT INTO accounts(id,email_normalized,display_name,role,admin_level,status,email_verified_at,created_at,updated_at,source) VALUES ('matchup-admin','fixture@example.test','Matchup Editor','admin','full','active',?,?,?,'test')").bind(timestamp, timestamp, timestamp).run();
  const account = await h.authDb.prepare("SELECT * FROM accounts WHERE id='matchup-admin'").first();
  const session = await createSession(env, new Request(ADMIN), account, ADMIN);
  const cookie = session.cookie.split(';')[0];
  const created = await createPoll(env, account.id, { title: 'The moon or the deep?', description: 'One giant leap. One unexplored world. Where would you go?', presentationType: 'abootnothing', presentation: { colors: ['#efc65c', '#6cc9d9'], context: 'Aboot Nothing · The next frontier', featuredOrder: 1 }, rumbleEnabled: true, rumbleSourceScope: 'user:synthetic', options: [{ label: 'THE MOON', description: 'Look up. Go further.', trigger: 'moon' }, { label: 'THE DEEP', description: 'Dive into the unknown.', trigger: 'deep' }] });
  const regular = await createPoll(env, account.id, { title: 'Editable ordinary Poll', options: [{ label: 'Coffee', trigger: 'coffee' }, { label: 'Tea', trigger: 'tea' }] });
  await changePollLifecycle(env, account.id, created.poll.slug, { revision: created.poll.revision, action: 'open' });
  await savePollPolicy(env, account.id, { pollId: created.poll.id, revision: 0, policy: { rantEnabled: true, giftEnabled: true, maxMessages: 3, timeoutSeconds: 300 } });
  const bot = (await botActivePoll(env)).activePoll;
  const at = new Date(Date.parse(bot.paidContext.activatedAt) + 1).toISOString();
  const snapshot = { user_id: 'synthetic', max_num_results: 50, gifted_subs: { recent_gifted_subs: [{ total_gifts: 5, purchased_by: 'Synthetic Viewer', gifted_on: at, video_id: 123, gift_type: 'subscription', remaining_gifts: 0 }] }, livestreams: [{ id: 'synthetic-stream', title: 'Offline fixture', is_live: true, chat: { recent_messages: [], recent_rants: [{ username: 'Synthetic Viewer', text: 'I choose moon!', amount_cents: 1000, created_on: at }] } }] };
  const adapted = spawnSync('X:/GIT/THIRD-RAIL-BOT/.venv/Scripts/python.exe', ['-m', 'tests.poll_credit_bridge'], { cwd: 'X:/GIT/THIRD-RAIL-BOT', encoding: 'utf8', input: JSON.stringify({ snapshot, poll: bot }) }); assert.equal(adapted.status, 0, adapted.stderr);
  const body = JSON.stringify(JSON.parse(adapted.stdout).paid), servicePath = '/api/internal/bot/poll-credits', ts = String(Math.floor(Date.now() / 1000)), id = randomUUID();
  const signature = createHmac('sha256', secret).update(['POST', servicePath, ts, id, createHash('sha256').update(body).digest('hex')].join('\n')).digest('base64url');
  const ingested = await botHandler({ env, request: new Request(ADMIN + servicePath, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-ThirdRailify-Timestamp': ts, 'X-ThirdRailify-Request-Id': id, 'X-ThirdRailify-Signature': signature }, body }) }); assert.equal(ingested.status, 200, await ingested.text());
  const adminProbe = await adminPollHandler({ env, request: new Request(ADMIN + '/api/admin/polls', { headers: { Cookie: cookie } }) });
  assert.equal(adminProbe.status, 200, await adminProbe.text());
  for (const [cwd, port] of [[new URL('../../ThirdRailify/',import.meta.url).pathname.replace(/^\/([A-Z]:)/,'$1'), '44931'], [process.cwd(), '44932']]) {
    const server = spawn(process.execPath, ['node_modules/vite/bin/vite.js', 'preview', '--host', '127.0.0.1', '--port', port], { cwd, stdio: 'ignore' }); t.after(() => server.kill());
  }
  for (const origin of [PUBLIC, ADMIN]) { let ready = false; for (let i = 0; i < 60; i++) { try { if ((await fetch(origin)).ok) { ready = true; break; } } catch { /* local startup */ } await new Promise(r => setTimeout(r, 100)); } assert.ok(ready); }
  const browser = await chromium.launch({ executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true }); t.after(() => browser.close());
  const errors = [], geometry = [];
  let failNextArtwork = false;
  let publicAuthorized = false;
  async function routes(context) {
    await context.route('**/*', async route => {
      const request = route.request(), url = new URL(request.url());
      if (url.origin === 'http://127.0.0.1:5174' && url.pathname === '/api/auth/config') return route.fulfill({ headers: { 'Access-Control-Allow-Origin': PUBLIC }, json: { configured: true, emailSignupConfigured: false, oauthProviders: [], oauthProviderStates: [], publicOrigin: PUBLIC, adminOrigin: ADMIN } });
      if (![PUBLIC, ADMIN].includes(url.origin)) return route.abort();
      if (!url.pathname.startsWith('/api/')) return route.continue();
      const isAdmin = url.origin === ADMIN;
      const headers = { ...request.headers(), ...(isAdmin || publicAuthorized ? { Cookie: cookie } : {}) };
      const req = new Request(request.url(), { method: request.method(), headers, ...(request.postDataBuffer() ? { body: request.postDataBuffer() } : {}) });
      let response;
      if (failNextArtwork && request.method() === 'POST' && url.pathname.includes('/media/')) { failNextArtwork = false; response = Response.json({ message: 'Test upload interruption' }, { status: 503 }); }
      else if (url.pathname === '/api/auth/config') response = Response.json({ configured: true, emailSignupConfigured: false, turnstileSiteKey: null, oauthProviders: [], oauthProviderStates: [], publicOrigin: PUBLIC, adminOrigin: ADMIN, environment: 'test', cookieMode: 'host-only' });
      else if (url.pathname === '/api/auth/session') response = Response.json(isAdmin || publicAuthorized ? await sessionEnvelope(env, await resolveSession(env, req), session.csrfToken) : { ok: true, authenticated: false, account: null });
      else if (url.pathname === '/api/admin/inbox/summary') response = Response.json({ ok: true, unread: 0, actionable: { goats: { total: 0, submissions: 0, comments: 0, emailFailures: 0 } } });
      else if (url.pathname.startsWith('/api/admin/polls')) response = await adminPollHandler({ request: req, env });
      else if (url.pathname.startsWith('/api/admin/automations')) response = await automationHandler({ request: req, env });
      else if (url.pathname.startsWith('/api/polls')) response = await publicHandler({ request: req, env, data: { pollsFetch: (url, init) => pollHandler({ request: new Request(url, init), env }) } });
      else response = Response.json({ ok: true, items: [], count: 0 });
      await route.fulfill({ status: response.status, headers: Object.fromEntries(response.headers), body: Buffer.from(await response.arrayBuffer()) });
    });
  }
  for (const width of [1920, 768, 390, 1440]) {
    const context = await browser.newContext({ viewport: { width, height: width < 500 ? 844 : 1000 }, reducedMotion: 'reduce', ...(width === 1440 ? { recordVideo: { dir: artifacts, size: { width: 1440, height: 1000 } } } : {}) }); await routes(context);
    const page = await context.newPage(); page.on('pageerror', e => errors.push(e.message));
    await page.goto(PUBLIC + '/polls/abootnothing'); await page.getByRole('heading', { name: 'Current Matchups', exact: true }).waitFor(); await page.locator('.poll-card').first().waitFor();
    const reject = page.getByRole('button', { name: 'Reject non-essential', exact: true }); if (await reject.count()) await reject.click();
    assert.equal(await page.locator('.aboot-gallery-hero__mark').evaluate(n => getComputedStyle(n).animationName), 'none');
    await page.screenshot({ path: `${artifacts}/gallery-${width}.png`, fullPage: true });
    await page.getByRole('button', { name: `Quick view ${created.poll.title}`, exact: true }).click(); await page.getByRole('dialog').waitFor();
    assert.equal(await page.locator('.aboot-vote-cards>article').count(), 2); await page.keyboard.press('Escape'); assert.equal(await page.getByRole('dialog').count(), 0);
    await page.goto(PUBLIC + `/polls/${created.poll.slug}`); await page.locator('.aboot-vote-cards').waitFor();
    assert.equal(await page.locator('.poll-increment').count(), 0);
    assert.ok((await page.locator('.poll-credit-status').textContent()).includes('25 votes awaiting allocation'));
    geometry.push({ width, route: 'detail', fits: await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth) });
    await page.screenshot({ path: `${artifacts}/detail-${width}.png`, fullPage: true });
    await page.goto(PUBLIC + `/polls/${created.poll.slug}/popout`); await page.locator('.aboot-vote-cards').waitFor(); assert.equal(await page.getByRole('button', { name: 'Vote', exact: true }).count(), 0);
    await page.setViewportSize({ width, height: width < 500 ? 844 : 1000 });
    if (width === 1440 || width === 390) {
      await page.goto(ADMIN + '/polls');
      await page.getByRole('row').filter({ hasText: 'Editable ordinary Poll' }).getByRole('button', { name: 'Edit Poll', exact: true }).click();
      const editor = page.getByRole('dialog', { name: 'Edit Poll', exact: true });
      await editor.getByLabel('Trigger for Coffee', { exact: true }).fill('java');
      await editor.getByLabel('Rumble stream link (optional)',{exact:true}).fill('https://rumble.com/v12345-regular.html');
      await page.screenshot({ path: `${artifacts}/ordinary-poll-editor-${width}.png` });
      assert.ok(await editor.evaluate(n => { const r = n.getBoundingClientRect(); return r.left >= 0 && r.right <= innerWidth && r.bottom <= innerHeight; }));
      await editor.getByRole('button', { name: 'Save Poll', exact: true }).click();
      await editor.waitFor({ state: 'detached' });
      const saved = (await getPublicPoll(env, regular.poll.slug, account.id, true)).poll;
      assert.equal(saved.options[0].trigger, 'java');
      assert.equal(saved.streamUrl,'https://rumble.com/v12345-regular.html');
      assert.equal(saved.presentationType, 'regular');
      assert.equal(saved.options[0].id, regular.poll.options[0].id);
      await page.getByRole('row').filter({ hasText: created.poll.title }).getByRole('button', { name: 'Edit Poll', exact: true }).click();
      await page.getByLabel('Poll title', { exact: true }).waitFor();
      assert.ok(page.url().includes('?edit='));
      assert.equal(await page.getByLabel('Poll title', { exact: true }).inputValue(), created.poll.title);
    }
    await page.goto(ADMIN + '/polls/abootnothing'); await page.getByRole('heading', { name: 'Aboot Nothing', exact: true }).waitFor(); await page.getByRole('button', { name: 'Edit Poll' }).click({ timeout: 5000 }).catch(e => { throw new Error(`${e.message}: ${errors.join(' | ')}`); }); await page.getByRole('button', { name: 'Save matchup' }).waitFor();
    assert.ok(await page.getByLabel('Poll title', { exact: true }).evaluate(n => { const r = n.getBoundingClientRect(); return document.activeElement === n && r.top >= 0 && r.top < innerHeight; }));
    const matchupDialog=page.getByRole('dialog',{name:'Edit matchup',exact:true});
    assert.equal(await matchupDialog.evaluate(n=>n.matches(':modal')),true);
    assert.equal(await page.evaluate(()=>document.body.style.overflow),'hidden');
    assert.ok(await matchupDialog.evaluate(n=>{const r=n.getBoundingClientRect();return r.top>=0&&r.bottom<=innerHeight&&r.left>=0&&r.right<=innerWidth;}));
    await page.locator('.aboot-editor-dialog .poll-workspace-body').evaluate(n=>n.scrollTop=n.scrollHeight);
    assert.ok(await page.getByRole('button',{name:'Save matchup',exact:true}).evaluate(n=>{const r=n.getBoundingClientRect();return r.top>=0&&r.bottom<=innerHeight;}));
    await page.screenshot({path:`${artifacts}/matchup-modal-${width}.png`});
    await page.keyboard.press('Escape');
    await matchupDialog.waitFor({state:'detached'});
    assert.equal(await page.getByRole('button',{name:'Edit Poll',exact:true}).evaluate(n=>n===document.activeElement),true);
    const publicDetail=page.getByRole('link',{name:'Public detail',exact:true});
    assert.equal(await publicDetail.getAttribute('target'),'_blank');
    assert.ok((await publicDetail.getAttribute('rel')).includes('noopener'));
    await page.getByRole('button',{name:'Edit Poll',exact:true}).click();
    geometry.push({ width, route: 'admin', fits: await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth) });
    if (width === 1440) {
      await page.getByLabel('Rumble stream link (optional)',{exact:true}).fill('https://rumble.com/v67890-matchup.html');
      await page.screenshot({ path: `${artifacts}/admin-editor.png`, fullPage: true });
      await page.getByRole('button', { name: 'Save matchup' }).click(); await page.waitForTimeout(500);
      await page.locator('.admin-toast').filter({ hasText: 'Matchup saved' }).waitFor();
      for (const toastWidth of [1440, 390]) {
        await page.setViewportSize({ width: toastWidth, height: 1000 });
        const toastFit = await page.waitForFunction(() => { const n = document.querySelector('.admin-toast-region'); if (!n) return false; return ((n) => { const r = n.getBoundingClientRect(); return getComputedStyle(n).position === 'fixed' && r.left >= 0 && r.right <= innerWidth && r.top >= 0 && r.bottom <= innerHeight; })(n); });
        assert.ok(toastFit, JSON.stringify(await page.locator(".admin-toast-region").evaluate(n => ({rect:n.getBoundingClientRect().toJSON(),position:getComputedStyle(n).position,width:innerWidth,height:innerHeight}))));
        await page.screenshot({ path: `${artifacts}/save-toast-${toastWidth}.png` });
      }
      await page.locator('.admin-toast').filter({ hasText: 'Matchup saved' }).waitFor({ state: 'detached', timeout: 7000 });
      await page.setViewportSize({ width: 1440, height: 1000 });

      const png = await sharp({ create: { width: 256, height: 256, channels: 4, background: '#efc65c' } }).png().toBuffer();
      await page.getByLabel('Square artwork').first().setInputFiles({ name: 'synthetic-square.png', mimeType: 'image/png', buffer: png });
      await page.locator('.aboot-admin-preview').first().waitFor();
      await page.waitForFunction(() => !document.querySelector('input[type=file]').disabled);
      const beforeImage = (await getPublicPoll(env, created.poll.slug)).poll.options[0].image.id;
      await page.getByLabel('Square artwork').first().setInputFiles({ name: 'replacement-square.png', mimeType: 'image/png', buffer: png });
      await page.waitForTimeout(500);
      const afterImage = (await getPublicPoll(env, created.poll.slug)).poll.options[0].image.id; assert.notEqual(beforeImage, afterImage);
      await page.getByRole('button', { name: 'Save matchup' }).click(); await page.waitForTimeout(300); await page.reload();
      assert.equal((await getPublicPoll(env, created.poll.slug)).poll.options[0].image.id, afterImage);
      const poll = (await getPublicPoll(env, created.poll.slug)).poll;
      await changePollLifecycle(env, account.id, poll.slug, { revision: poll.revision, action: 'close' });
      await page.goto(PUBLIC + `/polls/${created.poll.slug}`);
      const watch=page.getByRole('link',{name:'Watch stream',exact:true});
      await watch.waitFor(); assert.equal(await watch.getAttribute('href'),'https://rumble.com/v67890-matchup.html');assert.equal(await watch.getAttribute('target'),'_blank');assert.equal(await watch.locator('img').count(),1);
      await watch.screenshot({path:`${artifacts}/watch-stream-button.png`});
      await page.locator('.poll-credit-status').waitFor(); await page.waitForTimeout(1200);
      await page.goto(ADMIN + '/automations#poll-reconciliation'); await page.getByRole('heading', { name: 'Credit reconciliation' }).waitFor();
      const lot = page.locator('.poll-credit-queue>article').filter({ hasText: '25 earned' }); await lot.scrollIntoViewIfNeeded(); await page.waitForTimeout(1200); await lot.getByLabel('Audit reason').fill('Local browser acceptance'); await lot.getByRole('button', { name: 'Allocate credits' }).click();
      await page.waitForFunction(() => [...document.querySelectorAll('.poll-credit-queue>article')].some(e => e.textContent.includes('25 committed')));
      await page.waitForTimeout(1200);
      await page.screenshot({ path: `${artifacts}/admin-reconciled.png`, fullPage: true });
      for (const panelWidth of [1920, 768, 390, 1440]) {
        await page.setViewportSize({ width: panelWidth, height: 1000 });
        await page.waitForFunction(() => document.documentElement.scrollWidth <= innerWidth);
        const panel = page.locator('#poll-voting');
        const fit = await panel.evaluate(n => { const body = n.querySelector('.poll-workspace-body'); return { fits: document.documentElement.scrollWidth <= innerWidth, padding: parseFloat(getComputedStyle(body).paddingLeft) }; });
        assert.ok(fit.fits && fit.padding >= 18, JSON.stringify(fit));
        await panel.screenshot({ path: `${artifacts}/voting-panel-${panelWidth}.png` });
      }

      await page.goto(PUBLIC + `/polls/${created.poll.slug}`); await page.locator('.aboot-vote-cards').waitFor(); assert.equal(await page.getByRole('button', { name: 'Vote', exact: true }).count(), 0); assert.equal(await page.locator('.poll-credit-status').count(), 0);
      assert.equal((await getPublicPoll(env, poll.slug)).poll.totalVotes, 35); assert.equal((await getPublicPoll(env, poll.slug)).poll.options[0].image.id, afterImage); await page.screenshot({ path: `${artifacts}/closed-settled.png`, fullPage: true });
      await page.waitForTimeout(1200);
      await page.goto(PUBLIC + '/polls/abootnothing'); await page.getByRole('heading', { name: 'Past Matchups', exact: true }).waitFor(); await page.getByRole('region', { name: 'Past Matchups', exact: true }).locator('.poll-card').first().waitFor(); assert.equal(await page.getByRole('region', { name: 'Past Matchups', exact: true }).locator('.poll-card').count(), 1);
    }
    if (width === 1440) {
      await page.goto(PUBLIC + '/abootnothing'); await page.waitForURL('**/polls/abootnothing');
      await page.goto(PUBLIC + '/polls'); await page.locator('.aboot-feature .poll-card').first().waitFor();
      await page.goto(PUBLIC + '/polls/new'); await page.getByRole('heading', { name: 'Sign in required' }).waitFor();
    }
    if (width === 1440) {
      await page.goto(ADMIN + '/polls/abootnothing');
      await page.getByRole('button', { name: 'Create matchup', exact: true }).click();
      await page.getByLabel('Poll title', { exact: true }).fill('Artwork before first save');
      const png = await sharp({ create: { width: 256, height: 256, channels: 4, background: '#6cc9d9' } }).png().toBuffer();
      const file = { name: 'new-artwork.png', mimeType: 'image/png', buffer: png };
      const count = async () => (await h.commerceDb.prepare('SELECT COUNT(*) AS n FROM polls').first()).n;
      const beforeCount = await count();
      for (const input of await page.locator('input[type=file]').all()) { assert.equal(await input.isEnabled(), true); await input.setInputFiles(file); }
      await page.waitForFunction(() => document.querySelectorAll('.aboot-admin-preview').length === 3);
      assert.equal(await count(), beforeCount);
      await page.locator('.aboot-matchup-editor').screenshot({ path: `${artifacts}/new-artwork-preview.png` });
      failNextArtwork = true;
      await page.getByRole('button', { name: 'Save matchup', exact: true }).click();
      await page.getByText('Test upload interruption', { exact: true }).waitFor();
      assert.equal(await count(), beforeCount + 1);
      await page.getByRole('button', { name: 'Save matchup', exact: true }).click();
      await page.waitForFunction(() => document.querySelectorAll('.aboot-admin-preview').length === 3 && !document.querySelector('input[type=file]').disabled && !document.querySelector('[role=alert]'));
      assert.equal(await count(), beforeCount + 1);
      await page.getByLabel('Poll title', { exact: true }).fill('Unsaved title survives artwork replacement');
      await page.getByLabel('Square artwork').first().setInputFiles(file);
      await page.waitForFunction(() => !document.querySelector('input[type=file]').disabled);
      assert.equal(await page.getByLabel('Poll title', { exact: true }).inputValue(), 'Unsaved title survives artwork replacement');
      await h.commerceDb.prepare("UPDATE polls SET is_public=1 WHERE title='Artwork before first save'").run();
      await page.reload();
      await page.locator('.aboot-admin-grid article').filter({ hasText: 'Artwork before first save' }).getByRole('button', { name: 'Edit Poll' }).click();
      assert.equal(await page.locator('.aboot-admin-preview').count(), 3);
      const draftRow = await h.commerceDb.prepare("SELECT public_slug FROM polls WHERE title='Artwork before first save'").first();
      const draftPayload = await adminPollHandler({env,request:new Request(ADMIN+'/api/admin/polls/'+draftRow.public_slug,{headers:{Cookie:cookie}})});
      const savedDraft = (await draftPayload.json()).poll;
      assert.equal(savedDraft.state, 'draft');
      assert.equal(savedDraft.public, true);
      const draftImages = page.locator('.aboot-admin-grid article').filter({ hasText: 'Artwork before first save' }).locator('img');
      assert.equal(await draftImages.count(), 2);
      await page.waitForFunction(() => [...document.querySelectorAll('.aboot-admin-grid img')].every(n => n.complete && n.naturalWidth > 0));
      for (const img of await draftImages.all()) assert.ok((await img.getAttribute('src')).startsWith('/api/admin/polls/media/'));
      const upcomingImage = savedDraft.options[0].image.id;
      assert.equal((await pollHandler({ env, request: new Request(ADMIN + '/api/polls/media/' + upcomingImage) })).status, 200);
      await page.getByRole('button', { name: 'Close editor', exact: true }).click();
      await page.locator('.aboot-admin-grid').screenshot({ path: `${artifacts}/draft-library-artwork.png` });

      await changePollLifecycle(env,account.id,savedDraft.slug,{revision:savedDraft.revision,action:'open'});
      publicAuthorized = true;
      await page.goto(PUBLIC+'/polls/'+savedDraft.slug);
      await page.locator('.poll-increment').first().waitFor({ timeout: 10000 }).catch(async error => { await page.screenshot({ path: `${artifacts}/increment-debug.png` }); throw new Error(error.message + ' ' + await page.evaluate(async () => JSON.stringify(await (await fetch('/api/polls/access')).json()))); });
      await page.mouse.move(0,0);
      assert.equal(await page.locator('.poll-increment').first().evaluate(n=>getComputedStyle(n).opacity),'0');
      await page.locator('.poll-options>article').first().hover();
      await page.getByLabel('Votes to add to Side one',{exact:true}).fill('7');
      await page.getByRole('button',{name:'Add 7',exact:true}).click();
      await page.waitForFunction(()=>document.querySelector('.poll-options>article em')?.textContent==='7 votes');
      assert.equal((await getPublicPoll(env,savedDraft.slug)).poll.totalVotes,7);
      for (const incrementWidth of [1440,390]) {
        await page.setViewportSize({width:incrementWidth,height:1000});
        await page.locator('.poll-options>article').first().hover();
        const row = page.locator('.poll-increment').first();
        assert.equal(await row.evaluate(n=>getComputedStyle(n).display), incrementWidth < 700 ? 'grid' : 'flex');
        assert.ok(await row.evaluate(n=>n.scrollWidth<=n.clientWidth));
        assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
        await page.locator('.poll-options>article').first().screenshot({path:`${artifacts}/authorized-increment-${incrementWidth}.png`});
      }

      const regular = await createPoll(env, account.id, { title: 'Regular increment acceptance', options: [{ label: 'Regular A', trigger: 'a' }, { label: 'Regular B', trigger: 'b' }] });
      await changePollLifecycle(env, account.id, regular.poll.slug, { revision: regular.poll.revision, action: 'open' });
      await page.setViewportSize({ width: 1440, height: 1000 });
      await page.goto(PUBLIC + '/polls/' + regular.poll.slug);
      await page.locator('.poll-increment').first().waitFor();
      await page.locator('.poll-options>article').first().hover();
      await page.getByLabel('Votes to add to Regular A', { exact: true }).fill('3');
      await page.getByRole('button', { name: 'Add 3', exact: true }).click();
      await page.waitForFunction(() => document.querySelector('.poll-options>article em')?.textContent === '3 votes');
      assert.equal((await getPublicPoll(env, regular.poll.slug)).poll.totalVotes, 3);
      await page.locator('.poll-options').screenshot({ path: `${artifacts}/regular-increment.png` });
      await page.goto(PUBLIC + '/polls');
      await page.getByRole('button', { name: 'Quick view Regular increment acceptance', exact: true }).click();
      await page.getByRole('dialog').locator('.poll-options>article').last().hover();
      await page.getByRole('dialog').getByLabel('Votes to add to Regular B', { exact: true }).fill('2');
      await page.getByRole('dialog').getByRole('button', { name: 'Add 2', exact: true }).click();
      await page.waitForFunction(() => [...document.querySelectorAll('[role=dialog] .poll-options>article em')].some(n => n.textContent === '2 votes'));
      assert.equal((await getPublicPoll(env, regular.poll.slug)).poll.totalVotes, 5);
      for (const [target,type,total] of [[created.poll,'abootnothing',35],[regular.poll,'regular',5]]) {
        await page.goto(ADMIN + (type === 'abootnothing' ? '/polls/abootnothing' : '/polls'));
        const item = type === 'abootnothing' ? page.locator('.aboot-admin-grid>article').filter({hasText:target.title}) : page.locator('tbody tr').filter({hasText:target.title});
        page.once('dialog',dialog=>dialog.accept());
        await item.getByRole('button',{name:'Reset to Upcoming',exact:true}).click();
        await page.waitForTimeout(400);
        const reset=(await getPublicPoll(env,target.slug)).poll; assert.equal(reset.totalVotes,0);assert.equal(reset.upcoming,true);assert.equal(reset.history[0].totalVotes,total);
        const route=type==='abootnothing'?'/polls/abootnothing':'/polls';
        await page.goto(PUBLIC+route);
        const upcoming=page.getByRole('region',{name:type==='abootnothing'?'Upcoming Matchups':'Upcoming Polls',exact:true});
        await upcoming.getByRole('button',{name:`Quick view ${target.title}`,exact:true}).click();
        assert.equal(await page.getByRole('dialog').getByRole('button',{name:'Voting opens soon',exact:true}).count(),2);
        assert.equal(await page.getByRole('dialog').getByRole('button',{name:'Voting opens soon',exact:true}).first().isDisabled(),true);
        await page.keyboard.press('Escape');
        await page.goto(PUBLIC+'/polls/'+target.slug);await page.getByRole('heading',{name:'Previous results',exact:true}).waitFor();
        await page.locator('.poll-result-history summary').first().click();
        await page.screenshot({path:`${artifacts}/upcoming-history-${type}.png`,fullPage:true});
        await page.getByRole('button',{name:'Open Poll',exact:true}).click();
        await page.getByRole('button',{name:'Vote',exact:true}).first().waitFor({timeout:12000});
        const fresh=await createPoll(env,account.id,{title:`Upcoming preview ${type}`,presentationType:type,options:[{label:'First choice',trigger:'1'},{label:'Second choice',trigger:'2'}]});
        await page.goto(PUBLIC+route);await upcoming.getByRole('button',{name:`Quick view ${fresh.poll.title}`,exact:true}).waitFor();
        await upcoming.screenshot({path:`${artifacts}/upcoming-gallery-${type}.png`});
        const freshCard=upcoming.locator('.poll-card').filter({hasText:fresh.poll.title});
        await freshCard.getByRole('button',{name:'Open Poll',exact:true}).click();
        const openRegion=page.getByRole('region',{name:type==='abootnothing'?'Current Matchups':'Open Polls',exact:true});
        const openCard=openRegion.locator('.poll-card').filter({hasText:fresh.poll.title});
        await openCard.getByRole('button',{name:'Close Poll',exact:true}).waitFor();
        assert.equal(await page.getByRole('dialog').count(),0);
        assert.equal((await getPublicPoll(env,fresh.poll.slug)).poll.state,'open');
        page.once('dialog',dialog=>dialog.accept());
        await openCard.getByRole('button',{name:'Close Poll',exact:true}).click();
        const pastRegion=page.getByRole('region',{name:type==='abootnothing'?'Past Matchups':'Past Polls',exact:true});
        await pastRegion.getByRole('button',{name:`Quick view ${fresh.poll.title}`,exact:true}).click();
        await page.getByRole('dialog').getByRole('button',{name:'Open Poll',exact:true}).click();
        await page.getByRole('dialog').getByRole('button',{name:'Close Poll',exact:true}).waitFor();
        assert.equal((await getPublicPoll(env,fresh.poll.slug)).poll.state,'open');
        await page.screenshot({path:`${artifacts}/public-admin-open-${type}.png`,fullPage:true});
      }
      for (const type of ['abootnothing','regular']) {
        const {poll:upcomingPoll}=await createPoll(env,account.id,{title:`Publish upcoming ${type}`,presentationType:type,options:[{label:'First',trigger:'1'},{label:'Second',trigger:'2'}]});
        assert.equal(upcomingPoll.public,true);
        await h.commerceDb.prepare('UPDATE polls SET is_public=0 WHERE id=?').bind(upcomingPoll.id).run();
        await page.goto(ADMIN+(type==='abootnothing'?'/polls/abootnothing':'/polls'));
        const item=type==='abootnothing'?page.locator('.aboot-library article').filter({hasText:upcomingPoll.title}):page.locator('tbody tr').filter({hasText:upcomingPoll.title});
        await item.getByRole('button',{name:'Publish Upcoming',exact:true}).click();
        await item.getByRole('button',{name:'Hide from gallery',exact:true}).waitFor();
        await item.screenshot({path:`${artifacts}/published-admin-${type}.png`});
        const published=(await getPublicPoll(env,upcomingPoll.slug)).poll;
        assert.equal(published.upcoming,true);assert.equal(published.totalVotes,0);assert.equal(published.openedAt,null);
        await page.goto(PUBLIC+(type==='abootnothing'?'/polls/abootnothing':'/polls'));
        const region=page.getByRole('region',{name:type==='abootnothing'?'Upcoming Matchups':'Upcoming Polls',exact:true});
        await region.getByRole('button',{name:`Quick view ${upcomingPoll.title}`,exact:true}).click();
        assert.equal(await page.getByRole('dialog').getByRole('button',{name:'Voting opens soon',exact:true}).first().isDisabled(),true);
      }
      publicAuthorized = false;
      await page.goto(PUBLIC + '/polls/' + regular.poll.slug); await page.locator('.poll-options').waitFor();
      assert.equal(await page.locator('.poll-increment').count(),0);
      assert.equal(await page.locator('.poll-admin-lifecycle').count(),0);

    }
    const video = page.video(); await context.close();
    if (video) await video.saveAs(`${artifacts}/matchup-state-change.webm`);
  }
  assert.deepEqual(errors, []); assert.ok(geometry.every(g => g.fits), JSON.stringify(geometry));
  await writeFile(`${artifacts}/geometry.json`, JSON.stringify(geometry, null, 2));
  const routesAdmin = JSON.parse(await readFile('public/_routes.json', 'utf8')); assert.ok(routesAdmin.include.includes('/api/admin/*') && routesAdmin.include.includes('/api/internal/*'));
});
