/**
 * AI Usage Tracker — live subscription quota for every AI provider Hermes can
 * route to, across every local profile, in the Hermes desktop.
 *
 * Scope (deliberately narrow): subscription quota windows only — provider,
 * plan, window, % remaining, reset countdown, plus OpenRouter's account
 * balance and per-key spend. No token counting, no cost estimates, no history.
 *
 * All accounts: the page asks each profile's own backend
 * (`/usage?profile=<name>`, routed by Hermes per profile, so its consent and
 * secret scope apply) and merges entries only when the backend reports the
 * same `account.fingerprint` — a confirmed shared account. Unidentified
 * accounts stay one card per profile; numbers are never added up.
 *
 * Backend: ~/.hermes/plugins/ai-usage-tracker/dashboard/plugin_api.py
 * Read-only. No secrets or raw account identifiers ever reach the UI.
 */
import {
  Badge,
  Button,
  Codicon,
  EmptyState,
  ErrorState,
  ROUTES_AREA,
  STATUSBAR_AREAS,
  SIDEBAR_NAV_AREA,
  ScrollArea,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Separator,
  Skeleton,
  atom,
  cn,
  haptic,
  host,
  useQuery,
  useValue
} from '@hermes/plugin-sdk'
import { jsx, jsxs } from 'react/jsx-runtime'
import { useState } from 'react'

const ID = 'ai-usage-tracker'
const ROUTE = '/ai-usage'
const REFRESH_PAGE_MS = 120_000
const REFRESH_CHIP_MS = 300_000
// One slow profile must not hold the others: each profile's request is bounded on its own.
const PROFILE_TIMEOUT_MS = 30_000

let rest = null
let storage = null
let pendingRefresh = false

// Providers the user has hidden — plugin-scoped, shared by page and chip.
const HIDDEN_KEY = 'hidden-providers-v1'
const $hidden = atom([])

// Profile filter over the All accounts view. Empty = every account (the default,
// whichever profile the app itself is on). A new key on purpose: the v1 key held
// a single-profile selection that would otherwise hide every other account.
const FILTER_KEY = 'profile-filter-v2'
const ALL_ACCOUNTS = '__all__'
const $filter = atom('')

// Which provider the status-bar chip watches. Empty = AUTO: the worst remaining
// window across every visible account. A provider id pins the chip to that
// provider's own worst window; the page writes it.
const CHIP_KEY = 'chip-provider-v1'
const AUTO_CHIP = 'auto'
const $chipProvider = atom('')

// Fan-out state: `profiles` from /profiles, `results[name]` as each profile answers,
// so a fast profile renders while a slow one is still pending.
const $fanout = atom({ profiles: null, results: {} })

function remember(key, value) {
  try {
    storage?.set(key, value)
  } catch {
    /* in-memory state still works for this session */
  }
}

function selectChipProvider(id) {
  const value = String(id || '')
  $chipProvider.set(value)
  remember(CHIP_KEY, value)
}

function persistHidden(ids) {
  $hidden.set(ids)
  remember(HIDDEN_KEY, ids)
}

function hideProvider(id) {
  const current = $hidden.get()
  if (!current.includes(id)) persistHidden([...current, id])
}

function unhideProvider(id) {
  persistHidden($hidden.get().filter(value => value !== id))
}

function unhideAll() {
  persistHidden([])
}

function selectFilter(name) {
  const value = name === ALL_ACCOUNTS ? '' : String(name || '')
  $filter.set(value)
  remember(FILTER_KEY, value)
}

/** The active profile filter ('' = All accounts). */
export function currentProfileFilter() {
  return $filter.get()
}

// ---------------------------------------------------------------- formatters

/** An ISO instant in the browser's own time zone, with the zone named. */
export function formatLocalTime(iso) {
  if (!iso) return null
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  return d.toLocaleString(undefined, {
    day: '2-digit',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hour12: true,
    timeZoneName: 'short'
  })
}

function resetLabel(iso) {
  if (!iso) return null
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return null
  const seconds = Math.round((d.getTime() - Date.now()) / 1000)
  if (seconds <= 0) return 'resets now'
  const days = Math.floor(seconds / 86_400)
  const hours = Math.floor((seconds % 86_400) / 3600)
  const minutes = Math.floor((seconds % 3600) / 60)
  const rel = days ? `in ${days}d ${hours}h` : hours ? `in ${hours}h ${minutes}m` : `in ${minutes}m`
  return `resets ${rel} · ${formatLocalTime(iso)}`
}

function pct(value) {
  if (value === null || value === undefined) return '—'
  return `${Math.round(Number(value))}%`
}

function usd(value) {
  if (value === null || value === undefined) return null
  return `$${Number(value).toFixed(2)}`
}

function toneFor(remaining) {
  if (remaining === null || remaining === undefined) return 'muted'
  if (remaining <= 5) return 'bad'
  if (remaining <= 25) return 'warn'
  return 'good'
}

function statusOf(provider) {
  if (provider.quota?.available) return { variant: 'success', label: 'live quota' }
  if (provider.quota?.unavailable_reason) return { variant: 'muted', label: 'no quota' }
  return { variant: 'muted', label: 'unavailable' }
}

function errorText(error) {
  const text = String(error?.message || error || 'request failed')
  if (/plugin not found|not enabled in this profile/i.test(text)) {
    return `${text} — AI usage tracker is not enabled for this profile (hermes --profile <name> plugins enable ai-usage-tracker).`
  }
  return text
}

// ---------------------------------------------------------------- aggregation

function fetchedAt(provider) {
  const t = Date.parse(provider?.quota?.fetched_at || '')
  return Number.isNaN(t) ? 0 : t
}

/**
 * Merge per-profile `/usage` answers into account cards.
 *
 * `results`: `[{ profile, ok: true, payload } | { profile, ok: false, error }]`.
 * Entries merge only on the same provider family AND the same backend
 * `account.fingerprint` (a provider-confirmed identity); a missing fingerprint
 * keeps one card per profile. A merged card shows the freshest single snapshot
 * and lists every profile using it — percentages and balances are never summed.
 */
export function aggregateAccounts(results) {
  const accounts = []
  const byKey = new Map()
  const failures = []
  for (const result of results || []) {
    if (!result?.ok) {
      failures.push({ profile: result?.profile, error: result?.error })
      continue
    }
    for (const provider of result.payload?.providers || []) {
      const fingerprint = provider.account?.fingerprint || null
      const family = provider.family || provider.id
      const key = fingerprint ? `${family}#${fingerprint}` : `${provider.id}@${result.profile}`
      const existing = byKey.get(key)
      if (!existing) {
        const account = { key, provider, profiles: [result.profile], cacheAge: result.payload?.cache_age_seconds ?? null }
        byKey.set(key, account)
        accounts.push(account)
        continue
      }
      if (!existing.profiles.includes(result.profile)) existing.profiles.push(result.profile)
      if (fetchedAt(provider) > fetchedAt(existing.provider)) {
        existing.provider = provider
        existing.cacheAge = result.payload?.cache_age_seconds ?? null
      }
    }
  }
  // Live quota first; within that, stable by label so cards don't jump between refreshes.
  accounts.sort((a, b) => {
    const live = Number(Boolean(b.provider.quota?.available)) - Number(Boolean(a.provider.quota?.available))
    return live || String(a.provider.label).localeCompare(String(b.provider.label))
  })
  return { accounts, failures }
}

/** Accounts a profile uses; '' = all of them. */
export function filterAccounts(accounts, profile) {
  if (!profile) return accounts
  return accounts.filter(account => account.profiles.includes(profile))
}

/** One provider's tightest numeric window, or null when it reports none. */
function worstWindowOf(provider) {
  let worst = null
  for (const window of provider?.quota?.windows || []) {
    const remaining = window.remaining_percent
    if (remaining === null || remaining === undefined) continue
    if (worst === null || remaining < worst.remaining) {
      worst = { remaining, provider: provider.label, window: window.label, reset_at: window.reset_at || null }
    }
  }
  return worst
}

/** The tightest window across the given accounts (AUTO chip). */
function worstRemaining(accounts) {
  let worst = null
  for (const account of accounts) {
    const candidate = worstWindowOf(account.provider)
    if (candidate && (worst === null || candidate.remaining < worst.remaining)) worst = candidate
  }
  return worst
}

// ---------------------------------------------------------------- data

function usagePath(profile, refresh) {
  const params = [`profile=${encodeURIComponent(profile)}`]
  if (refresh) params.push('refresh=1')
  return `/usage?${params.join('&')}`
}

async function loadAllAccounts() {
  const refresh = pendingRefresh
  pendingRefresh = false
  const listing = await rest('/profiles')
  const profiles = Array.isArray(listing?.profiles) ? listing.profiles : []
  const names = profiles.map(row => row.name)
  // Keep the last answer of every still-listed profile until its new one lands.
  const previous = $fanout.get().results
  $fanout.set({ profiles, results: Object.fromEntries(names.filter(n => previous[n]).map(n => [n, previous[n]])) })
  await Promise.all(
    names.map(async name => {
      let result
      try {
        result = { profile: name, ok: true, payload: await rest(usagePath(name, refresh), { timeoutMs: PROFILE_TIMEOUT_MS }) }
      } catch (error) {
        result = { profile: name, ok: false, error: errorText(error) }
      }
      const current = $fanout.get()
      $fanout.set({ ...current, results: { ...current.results, [name]: result } })
    })
  )
  return { at: new Date().toISOString(), profiles: names.length }
}

function useAllAccounts(intervalMs) {
  const query = useQuery({
    queryKey: ['ai-usage-tracker', 'all-accounts'],
    queryFn: loadAllAccounts,
    refetchInterval: intervalMs,
    refetchOnMount: 'always',
    refetchOnWindowFocus: true,
    staleTime: 30_000,
    retry: 1,
    placeholderData: previous => previous
  })
  const fanout = useValue($fanout)
  const profiles = fanout.profiles || []
  const ordered = profiles.map(row => fanout.results[row.name]).filter(Boolean)
  const pending = profiles.filter(row => !fanout.results[row.name]).map(row => row.name)
  return { ...query, profiles, pending, ...aggregateAccounts(ordered) }
}

// ---------------------------------------------------------------- components

const MUTED = 'text-[0.6875rem] text-(--ui-text-quaternary)'

function QuotaBar({ window }) {
  const remaining = window.remaining_percent
  if (remaining === null || remaining === undefined) {
    return jsxs('div', {
      className: 'flex items-baseline gap-2 text-xs',
      children: [
        jsx('span', { className: 'w-28 shrink-0 text-(--ui-text-tertiary)', children: window.label }),
        jsx('span', { className: 'text-(--ui-text-quaternary)', children: window.detail || 'unlimited' })
      ]
    })
  }
  const tone = toneFor(remaining)
  return jsxs('div', {
    className: 'flex flex-col gap-1',
    children: [
      jsxs('div', {
        className: 'flex flex-wrap items-baseline gap-2 text-xs',
        children: [
          jsx('span', { className: 'w-28 shrink-0 text-(--ui-text-tertiary)', children: window.label }),
          jsx('span', {
            className: cn('font-medium tabular-nums', remaining <= 25 ? 'text-(--ui-text-primary)' : 'text-(--ui-text-secondary)'),
            children: `${pct(remaining)} left`
          }),
          window.detail ? jsx('span', { className: 'text-(--ui-text-quaternary)', children: window.detail }) : null,
          resetLabel(window.reset_at)
            ? jsx('span', { className: 'text-(--ui-text-quaternary)', children: resetLabel(window.reset_at) })
            : null,
          tone === 'bad' || tone === 'warn'
            ? jsx(Badge, { variant: tone === 'bad' ? 'destructive' : 'warn', size: 'xs', children: tone === 'bad' ? 'low' : 'watch' })
            : null
        ]
      }),
      jsx('div', {
        className: 'h-1.5 w-full overflow-hidden rounded-[2px]',
        style: { background: 'var(--ui-stroke-secondary)' },
        children: jsx('div', {
          className: 'h-full rounded-[2px]',
          style: { width: `${Math.max(1, Math.min(100, remaining))}%`, background: 'var(--ui-accent)' }
        })
      })
    ]
  })
}

/** OpenRouter: the account's balance and this key's own spend, visibly separate. */
function OpenRouterBlock({ quota }) {
  const balance = quota.balance || {}
  const key = quota.key
  const keyParts = []
  if (key) {
    keyParts.push(key.restricted ? 'restricted key' : 'unrestricted key (no spend limit)')
    if (key.usage_usd !== null && key.usage_usd !== undefined) keyParts.push(`spent ${usd(key.usage_usd)} total`)
    for (const [field, label] of [['usage_daily_usd', 'today'], ['usage_weekly_usd', 'this week'], ['usage_monthly_usd', 'this month']]) {
      if (key[field]) keyParts.push(`${usd(key[field])} ${label}`)
    }
  }
  return jsxs('div', {
    className: 'flex flex-col gap-1 text-xs',
    children: [
      jsxs('div', {
        className: 'flex flex-wrap items-baseline gap-2',
        children: [
          jsx('span', { className: 'w-28 shrink-0 text-(--ui-text-tertiary)', children: 'Account balance' }),
          jsx('span', {
            className: 'font-medium tabular-nums text-(--ui-text-secondary)',
            children: balance.remaining_usd === null || balance.remaining_usd === undefined ? '—' : usd(balance.remaining_usd)
          }),
          jsx('span', {
            className: 'text-(--ui-text-quaternary)',
            children: balance.error
              ? `balance unavailable: ${balance.error}`
              : 'whole OpenRouter account — every key on it reports this same balance; never added up'
          })
        ]
      }),
      key
        ? jsxs('div', {
            className: 'flex flex-wrap items-baseline gap-2',
            children: [
              jsx('span', { className: 'w-28 shrink-0 text-(--ui-text-tertiary)', children: 'This API key' }),
              jsx('span', { className: 'text-(--ui-text-secondary)', children: keyParts.join(' · ') })
            ]
          })
        : null
    ]
  })
}

function AccountCard({ account, isHidden }) {
  const provider = account.provider
  const quota = provider.quota || {}
  const status = statusOf(provider)
  const fetched = quota.fetched_at ? formatLocalTime(quota.fetched_at) : null
  const freshness = fetched
    ? `fetched ${fetched}${account.cacheAge ? ` (cached ${Math.round(account.cacheAge)}s)` : ''}`
    : null
  const unconfirmed = quota.available && !provider.account?.fingerprint

  return jsxs('div', {
    'data-account': provider.family || provider.id,
    className: cn('flex flex-col gap-2 rounded-[5px] border border-(--ui-stroke-secondary) p-3', isHidden && 'opacity-60'),
    children: [
      jsxs('div', {
        className: 'flex flex-wrap items-center gap-2',
        children: [
          jsx('span', { className: 'text-sm font-medium', children: provider.label }),
          quota.plan ? jsx(Badge, { variant: 'muted', size: 'xs', children: quota.plan }) : null,
          jsx(Badge, { variant: status.variant, size: 'xs', children: status.label }),
          ...account.profiles.map(name => jsx(Badge, { variant: 'outline', size: 'xs', children: name }, `p-${name}`)),
          jsx('span', { className: 'flex-1' }),
          jsx('button', {
            type: 'button',
            title: isHidden ? 'Show this provider again' : 'Hide this provider',
            'aria-label': isHidden ? `Unhide ${provider.label}` : `Hide ${provider.label}`,
            className: 'shrink-0 px-1 text-(--ui-text-quaternary) hover:text-(--ui-text-secondary)',
            onClick: () => {
              haptic('tap')
              if (isHidden) unhideProvider(provider.id)
              else hideProvider(provider.id)
            },
            children: jsx(Codicon, { name: isHidden ? 'eye' : 'close' })
          })
        ]
      }),
      quota.balance || quota.key ? jsx(OpenRouterBlock, { quota }) : null,
      (quota.windows || []).map((window, index) => jsx(QuotaBar, { window }, index)),
      !quota.available && quota.unavailable_reason ? jsx('div', { className: MUTED, children: quota.unavailable_reason }) : null,
      (quota.details || []).map((detail, index) => jsx('div', { className: MUTED, children: detail }, index)),
      freshness || unconfirmed
        ? jsx('div', {
            className: MUTED,
            children: [freshness, unconfirmed ? 'account identity not confirmable — shown per profile, never merged' : null]
              .filter(Boolean)
              .join(' · ')
          })
        : null
    ]
  })
}

function FilterPicker({ profiles, value, onSelect }) {
  return jsxs(Select, {
    value: value || ALL_ACCOUNTS,
    onValueChange: next => {
      haptic('tap')
      onSelect(next)
    },
    children: [
      jsx(SelectTrigger, {
        className: 'h-6 w-44 text-[0.6875rem]',
        'aria-label': 'Filter by Hermes profile',
        children: jsx(SelectValue, {})
      }),
      jsx(SelectContent, {
        children: [
          jsx(SelectItem, { value: ALL_ACCOUNTS, children: 'All accounts' }, ALL_ACCOUNTS),
          ...profiles.map(row =>
            jsx(SelectItem, { value: row.name, children: row.is_default && row.name !== 'default' ? `${row.name} (default)` : row.name }, row.name)
          )
        ]
      })
    ]
  })
}

/** Picks which provider the status-bar chip watches. AUTO_CHIP = worst window across visible accounts. */
function ChipPicker({ providers, value, onSelect }) {
  return jsxs(Select, {
    value: value || AUTO_CHIP,
    onValueChange: next => {
      haptic('tap')
      onSelect(next === AUTO_CHIP ? '' : next)
    },
    children: [
      jsx(SelectTrigger, {
        className: 'h-6 w-56 text-[0.6875rem]',
        title: 'Which provider the status-bar chip shows',
        'aria-label': 'Status bar chip provider',
        children: jsx(SelectValue, {})
      }),
      jsx(SelectContent, {
        children: [
          jsx(SelectItem, { value: AUTO_CHIP, children: 'Auto (Lowest %)' }, AUTO_CHIP),
          ...providers.map(provider => jsx(SelectItem, { value: provider.id, children: provider.label }, provider.id))
        ]
      })
    ]
  })
}

function PageHeader({ profiles, filter, chipProviders, chipProvider, isFetching, refetch, meta, hiddenCount, showHidden, setShowHidden }) {
  return jsxs('div', {
    className: 'flex flex-wrap items-center gap-2',
    children: [
      jsx('span', { className: 'text-sm font-medium', children: filter ? `AI usage · ${filter}` : 'AI usage · All accounts' }),
      jsx('span', { className: MUTED, children: meta || '' }),
      jsx('span', { className: 'flex-1' }),
      hiddenCount > 0
        ? jsxs(Button, {
            variant: 'ghost',
            title: showHidden ? 'Hide the hidden providers again' : `Show ${hiddenCount} hidden provider(s)`,
            onClick: () => {
              haptic('tap')
              setShowHidden(!showHidden)
            },
            children: [jsx(Codicon, { name: 'eye' }), jsx('span', { children: showHidden ? `Showing hidden ${hiddenCount}` : `Hidden ${hiddenCount}` })]
          })
        : null,
      showHidden && hiddenCount > 0
        ? jsx(Button, {
            variant: 'text',
            onClick: () => {
              haptic('tap')
              unhideAll()
            },
            children: 'Unhide all'
          })
        : null,
      jsx('span', { className: MUTED, children: 'Status Bar:' }),
      jsx(ChipPicker, { providers: chipProviders, value: chipProvider, onSelect: selectChipProvider }),
      jsx(FilterPicker, { profiles, value: filter, onSelect: selectFilter }),
      jsxs(Button, {
        variant: 'secondary',
        onClick: () => {
          haptic('tap')
          pendingRefresh = true
          refetch()
        },
        disabled: isFetching,
        children: [jsx(Codicon, { name: 'refresh' }), jsx('span', { children: isFetching ? 'Refreshing…' : 'Refresh' })]
      })
    ]
  })
}

function UsagePage() {
  const [showHidden, setShowHidden] = useState(false)
  const hiddenIds = useValue($hidden)
  const filter = useValue($filter)
  const chipProvider = useValue($chipProvider)
  const { data, error, isFetching, refetch, profiles, pending, accounts, failures } = useAllAccounts(REFRESH_PAGE_MS)

  const inView = filterAccounts(accounts, filter)
  const visible = inView.filter(account => !hiddenIds.includes(account.provider.id))
  const hiddenAccounts = inView.filter(account => hiddenIds.includes(account.provider.id))
  const chipProviders = [...new Map(visible.map(a => [a.provider.id, a.provider])).values()]
  const header = jsx(PageHeader, {
    profiles,
    filter,
    chipProviders,
    chipProvider,
    isFetching,
    refetch,
    hiddenCount: hiddenIds.length,
    showHidden,
    setShowHidden,
    meta: data ? `refreshed ${formatLocalTime(data.at)}` : null
  })

  // The header (filter + refresh) renders in EVERY state.
  if (error && !profiles.length) {
    return jsxs('div', {
      className: 'flex flex-col gap-3 p-4',
      children: [
        header,
        jsx(ErrorState, {
          title: 'Could not load usage',
          description: `${errorText(error)}`,
          children: jsx(Button, { variant: 'secondary', onClick: () => refetch(), children: 'Retry' })
        })
      ]
    })
  }
  if (!profiles.length || (!accounts.length && pending.length)) {
    return jsxs('div', {
      className: 'flex flex-col gap-3 p-4',
      children: [header, jsx(Skeleton, { className: 'h-6 w-48' }), jsx(Skeleton, { className: 'h-24 w-full' }), jsx(Skeleton, { className: 'h-24 w-full' })]
    })
  }

  const live = visible.filter(account => account.provider.quota?.available).length
  const answered = profiles.length - pending.length - failures.length
  const shownFailures = failures.filter(f => !filter || f.profile === filter)

  return jsxs(ScrollArea, {
    className: 'h-full',
    children: jsxs('div', {
      className: 'flex flex-col gap-3 p-4',
      children: [
        header,
        error ? jsx('div', { className: MUTED, children: `Showing the last good answers — the refresh failed: ${errorText(error)}` }) : null,
        jsx('div', {
          className: MUTED,
          children: `${visible.length} account(s) · ${live} reporting live quota · ${answered}/${profiles.length} profiles answered` +
            (filter ? ` · filtered to ${filter}` : ' · shared subscriptions are listed once with every profile using them')
        }),
        pending.length
          ? jsx('div', { className: MUTED, children: `Still waiting on: ${pending.join(', ')}` })
          : null,
        ...shownFailures.map(failure =>
          jsx('div', {
            role: 'alert',
            className: 'rounded-[5px] border border-(--ui-stroke-secondary) px-3 py-2 text-xs text-(--ui-text-secondary)',
            children: `Profile ${failure.profile}: ${failure.error} — other profiles are unaffected.`
          }, `fail-${failure.profile}`)
        ),
        jsx(Separator, {}),
        jsxs('div', {
          className: 'flex flex-col gap-2',
          children: [
            visible.map(account => jsx(AccountCard, { account }, account.key)),
            showHidden ? hiddenAccounts.map(account => jsx(AccountCard, { account, isHidden: true }, `hidden-${account.key}`)) : null,
            visible.length === 0
              ? jsx(EmptyState, {
                  title: inView.length ? 'Every provider is hidden' : 'No accounts to show',
                  description: inView.length
                    ? `Use "Hidden ${hiddenIds.length}" above to bring them back.`
                    : 'No profile reported provider credentials or recent usage.'
                })
              : null
          ]
        }),
        jsx('div', {
          className: MUTED,
          children:
            '✕ on a card hides that provider (persisted, and excluded from the status-bar chip) · quota comes from each provider\'s own API using each profile\'s own credentials · times are in this browser\'s time zone.'
        })
      ]
    })
  })
}

function UsageChip() {
  const hiddenIds = useValue($hidden)
  const filter = useValue($filter)
  const pinnedId = useValue($chipProvider)
  const { data, accounts } = useAllAccounts(REFRESH_CHIP_MS)

  // A pin only wins while it resolves to a visible account with a numeric window;
  // otherwise the chip falls back to AUTO instead of blanking.
  const visible = filterAccounts(accounts, filter).filter(account => !(hiddenIds || []).includes(account.provider.id))
  const pinned = pinnedId ? worstRemaining(visible.filter(account => account.provider.id === pinnedId)) : null
  const worst = pinned || worstRemaining(visible)
  const tone = toneFor(worst ? worst.remaining : null)
  const detail = worst
    ? [worst.provider, worst.window ? `${worst.window} window` : null, resetLabel(worst.reset_at)].filter(Boolean).join(' · ')
    : 'AI usage'

  return jsx('button', {
    type: 'button',
    title: `${detail}${pinned ? ' (pinned on the AI usage page)' : ''}`,
    'aria-label': `AI usage: ${detail}`,
    className: 'px-1.5 text-[0.6875rem] text-(--ui-text-tertiary) hover:text-(--ui-text-secondary)',
    onClick: () => {
      haptic('tap')
      host.navigate(ROUTE)
    },
    children: jsxs('span', {
      className: 'inline-flex items-center gap-1.5',
      children: [
        jsx('span', {
          'aria-hidden': true,
          className: 'inline-block size-1.5 rounded-full',
          style: {
            background: tone === 'bad' ? 'var(--ui-accent)' : tone === 'warn' ? 'var(--ui-text-secondary)' : 'var(--ui-text-quaternary)'
          }
        }),
        jsx('span', { children: worst ? `${pct(worst.remaining)} · ${worst.provider}` : data ? 'AI usage' : 'AI usage…' })
      ]
    })
  })
}

export default {
  id: ID,
  name: 'AI Usage Tracker',
  register(ctx) {
    rest = ctx.rest
    storage = ctx.storage
    try {
      const saved = storage?.get(HIDDEN_KEY, [])
      if (Array.isArray(saved)) $hidden.set(saved.filter(value => typeof value === 'string'))
    } catch {
      /* a malformed stored list must not block the plugin from loading */
    }
    try {
      const savedChip = storage?.get(CHIP_KEY, '')
      if (typeof savedChip === 'string') $chipProvider.set(savedChip)
    } catch {
      /* fall through to AUTO */
    }
    try {
      // All accounts unless this browser chose a filter — never the app's active profile.
      const savedFilter = storage?.get(FILTER_KEY, '')
      $filter.set(typeof savedFilter === 'string' ? savedFilter : '')
    } catch {
      $filter.set('')
    }

    ctx.register({
      id: 'page',
      area: ROUTES_AREA,
      data: { path: ROUTE },
      render: () => jsx(UsagePage, {})
    })

    ctx.register({
      id: 'nav',
      area: SIDEBAR_NAV_AREA,
      data: { path: ROUTE, label: 'AI usage', codicon: 'graph' }
    })

    ctx.register({
      id: 'chip',
      area: STATUSBAR_AREAS.right,
      order: 125,
      render: () => jsx(UsageChip, {})
    })
  }
}
