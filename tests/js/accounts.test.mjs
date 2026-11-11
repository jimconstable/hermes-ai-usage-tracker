// All accounts aggregation, profile filter, default view and browser-local timestamps.
// Run: node --import ./tests/js/register.mjs --test tests/js/
import assert from 'node:assert/strict'
import { test } from 'node:test'

const plugin = await import('../../desktop/plugin.js')
const { aggregateAccounts, filterAccounts, formatLocalTime, loadAllAccounts, openRouterKeyLabel } = plugin
const { host } = await import('@hermes/plugin-sdk')

const codex = (fingerprint, used = 40, fetched = '2026-11-11T09:00:00+00:00') => ({
  id: 'openai-codex',
  family: 'openai-codex',
  label: 'OpenAI Codex',
  account: { fingerprint },
  quota: {
    available: true,
    fetched_at: fetched,
    windows: [{ label: 'Session', used_percent: used, remaining_percent: 100 - used, reset_at: null }]
  }
})
const claude = () => ({
  id: 'claude-subscription-directsdk-experimental',
  family: 'claude-subscription-directsdk-experimental',
  label: 'Claude Subscription DirectSDK',
  account: { fingerprint: null },
  quota: { available: true, windows: [{ label: 'Current week', used_percent: 30, remaining_percent: 70 }] }
})
const openrouter = (id, fingerprint, remaining = 30) => ({
  id,
  family: 'openrouter',
  label: id,
  account: { fingerprint },
  quota: { available: true, windows: [], balance: { remaining_usd: remaining }, key: { usage_usd: 1 } }
})
const ok = (profile, providers) => ({ profile, ok: true, payload: { generated_at: '2026-11-11T09:00:00Z', providers } })

test('a confidently shared subscription appears once, labelled with every profile using it', () => {
  const { accounts } = aggregateAccounts([
    ok('default', [codex('fp-shared', 40, '2026-11-11T09:00:00+00:00')]),
    ok('background', [codex('fp-shared', 41, '2026-11-11T09:05:00+00:00')]),
    ok('sweep', [codex('fp-shared', 40, '2026-11-11T08:59:00+00:00')])
  ])

  assert.equal(accounts.length, 1)
  assert.deepEqual(accounts[0].profiles, ['default', 'background', 'sweep'])
  // never summed: the freshest single snapshot wins
  assert.equal(accounts[0].provider.quota.windows[0].used_percent, 41)
})

test('distinct or unidentified accounts are never merged, even with identical numbers', () => {
  const { accounts } = aggregateAccounts([
    ok('default', [codex('fp-a'), claude()]),
    ok('work', [codex('fp-b'), claude()]),
    ok('anon', [codex(null)])
  ])

  const codexCards = accounts.filter(a => a.provider.family === 'openai-codex')
  const claudeCards = accounts.filter(a => a.provider.family.startsWith('claude'))
  assert.equal(codexCards.length, 3)
  assert.equal(claudeCards.length, 2)
  assert.deepEqual(claudeCards.map(a => a.profiles), [['default'], ['work']])
})

test('OpenRouter keys merge only on the same key, never on an equal account balance', () => {
  const { accounts } = aggregateAccounts([
    ok('default', [openrouter('openrouter', 'k-main'), openrouter('openrouter-limited', 'k-fallback')]),
    ok('research', [openrouter('openrouter', 'k-research')]),
    ok('background', [openrouter('openrouter', 'k-main')])
  ])

  const keys = accounts.filter(a => a.provider.family === 'openrouter')
  assert.equal(keys.length, 3)
  assert.deepEqual(keys.find(a => a.provider.account.fingerprint === 'k-main').profiles, ['default', 'background'])
  // each card keeps its own balance object; nothing is totalled
  assert.ok(keys.every(a => a.provider.quota.balance.remaining_usd === 30))
})

test('a failing profile is reported without hiding the others', () => {
  const { accounts, failures } = aggregateAccounts([
    ok('default', [codex('fp')]),
    { profile: 'sooty', ok: false, error: 'plugin host did not answer within 60s' }
  ])

  assert.equal(accounts.length, 1)
  assert.deepEqual(failures, [{ profile: 'sooty', error: 'plugin host did not answer within 60s' }])
})

test('the profile filter narrows the All accounts view to accounts that profile uses', () => {
  const { accounts } = aggregateAccounts([
    ok('default', [codex('fp-shared'), openrouter('openrouter', 'k1')]),
    ok('sooty', [claude()]),
    ok('sweep', [codex('fp-shared')])
  ])

  assert.equal(filterAccounts(accounts, '').length, 3)
  assert.deepEqual(filterAccounts(accounts, 'sweep').map(a => a.provider.family), ['openai-codex'])
  assert.deepEqual(filterAccounts(accounts, 'sooty').map(a => a.provider.family), [
    'claude-subscription-directsdk-experimental'
  ])
})

test('All accounts is the default view whatever profile the app is on', () => {
  globalThis.__activeProfile = 'sooty'
  plugin.default.register({ rest: async () => ({}), storage: { get: (_k, fallback) => fallback, set: () => {} }, register: () => {} })
  assert.equal(plugin.currentProfileFilter(), '')
})

test('timestamps render in the browser-local time zone, not a hardcoded one', () => {
  const iso = '2026-11-11T09:00:00Z'
  const original = process.env.TZ
  try {
    process.env.TZ = 'Australia/Brisbane'
    const brisbane = formatLocalTime(iso)
    process.env.TZ = 'America/New_York'
    const newYork = formatLocalTime(iso)
    assert.match(brisbane, /07:00\s*pm/i)
    assert.match(newYork, /04:00\s*am/i)
    assert.doesNotMatch(brisbane + newYork, /IST/)
  } finally {
    process.env.TZ = original
  }
})

test('the selected profile refusing /profiles cannot stop the other profiles from refreshing', async () => {
  // App on `legacy`, where this plugin is not enabled: its routed /profiles and /usage 404.
  globalThis.__activeProfile = 'legacy'
  host.profiles = { list: async () => ({ profiles: [{ name: 'default', is_default: true }, { name: 'legacy' }, { name: 'sooty' }] }) }
  const calls = []
  const rest = async path => {
    calls.push(path)
    if (path === '/profiles' || path.includes('profile=legacy')) throw new Error('404: {"detail":"Plugin not found"}')
    return { generated_at: '2026-11-11T09:00:00Z', providers: [codex('fp-shared')] }
  }
  try {
    plugin.default.register({ rest, storage: { get: (_k, fallback) => fallback, set: () => {} }, register: () => {} })
    const { results } = await loadAllAccounts()

    assert.ok(!calls.includes('/profiles'))
    assert.equal(results.default.ok, true)
    assert.equal(results.sooty.ok, true)
    assert.equal(results.legacy.ok, false) // its own plugin gate still applies, reported per profile
    const { accounts } = aggregateAccounts(Object.values(results))
    assert.deepEqual(accounts[0].profiles, ['default', 'sooty'])
  } finally {
    delete host.profiles
    delete globalThis.__activeProfile
  }
})

test('an OpenRouter $0 key cap is shown as a cap, not as an unrestricted key', () => {
  assert.equal(openRouterKeyLabel({ restricted: false, limit_usd: null }), 'unrestricted key (no spend limit)')
  assert.equal(openRouterKeyLabel({ restricted: true, limit_usd: 0, limit_remaining_usd: 0 }), 'restricted key · $0.00 cap, $0.00 left')
  assert.equal(openRouterKeyLabel({ restricted: true, limit_usd: 5, limit_remaining_usd: 4 }), 'restricted key · $5.00 cap, $4.00 left')
})
