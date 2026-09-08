import { createHash } from 'node:crypto';
import { createCommerceDatabases, commerceEnvironment } from './commerce-test-helpers.mjs';
import { createWheel, mutateCreatorGrant, getPublicWheel } from '../functions/_shared/wheels-core.js';
import { saveAutomationRule, ingestAutomationEvents } from '../functions/_shared/automation-core.js';
import { FEATURE_PRESETS } from '../src/lib/entrant-appearance.mjs';
export async function featureFixture() {
  const h = await createCommerceDatabases();
  const env = commerceEnvironment(h, { THIRDRAILIFY_AUTH_RATE_LIMIT_SECRET: 'local-feature-rate' });
  const now = new Date().toISOString();
  for (const id of ['master', 'creator']) await h.authDb.prepare("INSERT INTO accounts(id,email_normalized,display_name,role,admin_level,status,email_verified_at,created_at,updated_at,source) VALUES (?,?,?,?,?,'active',?,?,?,?)").bind(id, `${id}@example.test`, id, id === 'master' ? 'admin' : 'user', id === 'master' ? 'master' : 'none', now, now, now, id === 'master' ? 'env_master' : 'test').run();
  await mutateCreatorGrant(env, 'master', { accountId: 'creator', action: 'approve', mayCreate: true, maximumOwnedWheels: 8 });
  const created = await createWheel(env, 'creator', { title: 'Feature Donation Draw', visibility: 'public', lifecycle: 'active', config: { spinDurationMs: 60000, celebrationEnabled: false, tickingSoundEnabled: false, winnerSoundEnabled: false }, entries: [] });
  const slug = created.wheel.slug; const wheelId = (await h.commerceDb.prepare('SELECT id FROM wheels WHERE public_slug=?').bind(slug).first()).id;
  const rules = [];
  for (const [i, [preset, eventType]] of [['subscriber', 'rumble.subscribe'], ['raid', 'rumble.raid.received'], ['gift', 'rumble.gift_purchase'], ['rant', 'rumble.rant']].entries()) {
    rules.push((await saveAutomationRule(env, 'master', { name: `${preset} entrant treatment`, description: '', enabled: true, sourceScope: 'user:fixture', eventType, conditions: {}, actionType: 'wheel.add_actor', targetWheelId: wheelId, duplicatePolicy: 'accumulate', actionConfig: { version: 2, repeatActorPolicy: 'accumulate', award: { mode: 'fixed', entriesPerUnit: i === 0 ? 150 : 20, unitCents: 100 }, appearance: { ...FEATURE_PRESETS[preset].components, effects: { kinds: [['sparkles'], ['shine'], ['dazzle'], ['pulse']][i], intensity: .4, speed: 1, density: 3 } } } } )).rule);
  }
  let sequence = 0;
  const event = (rule, actorLabel, options = {}) => {
    const at = options.at || new Date(Date.now() + 1000 + sequence++).toISOString();
    const evidence = rule.eventType === 'rumble.raid.received' ? { announcement: 'has raided this stream!', detectionMethod: 'chat-announcement-v1' } : rule.eventType === 'rumble.gift_purchase' ? { totalGifts: 5, giftType: 'random', videoId: 123 } : { amountCents: 500, ...(rule.eventType === 'rumble.rant' ? { normalizedText: 'hello' } : {}), ...options.evidence };
    const material = rule.eventType === 'rumble.raid.received' ? JSON.stringify(['rumble-raid-notice-v1', rule.sourceScope, 'fixture-stream', actorLabel.normalize('NFKC').trim().toLowerCase(), at, evidence.announcement]) : `${sequence++}:${actorLabel}:${at}`;
    return { ruleId: rule.id, ruleRevision: rule.revision, sourceScope: rule.sourceScope, eventType: rule.eventType, providerEventAt: at, livestreamId: 'fixture-stream', actorLabel, actorKey: `rumble:${rule.sourceScope}:${actorLabel.toLowerCase()}`, eventFingerprint: createHash('sha256').update(material).digest('hex'), evidence };
  };
  const send = async e => (await ingestAutomationEvents(env, { events: [e] })).results[0].outcome;
  const read = () => getPublicWheel(env, slug, 'creator');
  return { h, env, slug, wheelId, rules, event, send, read };
}
