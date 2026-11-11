# AI Usage Tracker — Hermes desktop plugin

Live **subscription quota** for every AI provider Hermes can route to, inside the Hermes
desktop: a page (sidebar → *AI usage*), a status-bar chip showing the worst remaining
window, across every local profile (*All accounts*) with a per-profile filter.

Scope is deliberately narrow: **quota windows only** — provider, plan, window name,
% remaining, reset countdown. No token counting, no cost estimates, no period filters.

| Provider | Live quota endpoint |
| --- | --- |
| `openai-codex` | `chatgpt.com/backend-api/wham/usage` (session + weekly windows) |
| `anthropic` | `api.anthropic.com/api/oauth/usage` (OAuth accounts only) |
| `nous` | portal account (subscription credits + renewal) |
| `openrouter` | `api/v1/credits` + `/key` (account balance / per-key spend + limit) |
| `claude-subscription-directsdk-experimental` | the provider plugin's own `fetch_account_usage` hook (Claude Code `get_usage`) |
| `copilot` | `api.github.com/copilot_internal/user` |
| `opencode-go` | `opencode.ai/zen/go/v1/usage` (rolling / weekly / monthly) |
| `opencode-zen` | credits endpoint (pay-as-you-go) |
| `zai` | `api.z.ai/api/monitor/usage/quota/limit` |
| `kimi-coding` | `api.kimi.com/coding/v1/usages` |
| `minimax` | `api.minimax.io/v1/api/openplatform/coding_plan/remains` |
| `deepseek` | `api.deepseek.com/user/balance` |

Providers with no quota API are listed with an explicit reason instead of a fabricated
bar. Absence-path providers (Grok/SuperGrok, Gemini Code Assist OAuth, Cursor, Kiro) need
browser cookies and are deliberately not attempted.

## Install

```bash
# from the curated catalog (once merged):
hermes plugins install ai-usage-tracker --enable

# from this repo directly:
hermes plugins install <owner>/<repo> --enable
```

Or ship an install link in any README/site:

```html
<a href="hermes://plugin/install?repo=<owner>/<repo>&enable=1">Install in Hermes</a>
```

Then enable it **for each profile** you want it in — desktop backends are profile-scoped,
and a plugin enabled only in the default profile 404s on every other:

```bash
for p in forge jewel penny smoke teknium; do
  ln -s ~/.hermes/plugins/ai-usage-tracker ~/.hermes/profiles/$p/plugins/ai-usage-tracker
  hermes --profile $p plugins enable ai-usage-tracker
done
```

Relaunch the desktop app after enabling (backend routes mount at web-server start).

## All accounts

The page opens on **All accounts** — every local profile's accounts at once, whichever
profile the app itself is on. It asks each profile separately (``GET /usage?profile=<name>``),
so Hermes routes every request through that profile's own plugin gate, plugin host and
secret scope; a profile that has not enabled the plugin shows a one-line notice and the
rest of the page still renders. Each probe runs with that profile's `HERMES_HOME`, so
credentials, `auth.json` and `.env` resolve for that profile — not the server's own.

- **Shared subscriptions appear once**, labelled with every profile that uses them — but only
  when the provider confirms the identity: each entry carries `account.fingerprint`, a
  truncated one-way hash of the Codex JWT principal or the OpenRouter API key. Accounts with
  no confirmable identity (e.g. Claude via Claude Code) stay one card per profile. Nothing is
  merged because two cards share a provider or show the same numbers, and nothing is summed.
- **OpenRouter** shows the *account* credit balance separately from *this key's* spend and
  limit. Every key on one OpenRouter account reports the same balance, so it is shown per key
  and never added up; a restricted (spend-limited) key and an unrestricted key stay separate
  cards. Named `providers:` entries pointing at openrouter.ai (e.g. a restricted fallback key)
  are probed as their own keys.
- **Claude Subscription DirectSDK** (and any provider plugin with a `fetch_account_usage` hook)
  is read through the provider's own hook, found by Hermes' provider discovery for that
  profile — the DirectSDK hook asks Claude Code for its plan limits, with no inference and
  without this plugin ever seeing a token.
- The **profile filter** (header) narrows the view to the accounts one profile uses; the choice
  is stored per browser (`profile-filter-v2`). Times are shown in the browser's time zone.

Honest limits:

- **Local machine only.** A profile that lives on a *remote* gateway (another machine
  reached over Tailscale/SSH) cannot be read from this backend — the plugin's REST door
  is profile-scoped to the serving machine, and the SDK exposes no cross-gateway route
  to a plugin's own backend.
- Credential lookup uses the profile's own home first and falls back to the server
  process environment (exactly how Hermes itself resolves them for that profile).

## Hiding providers

Each card has a **✕** control. Hidden providers leave the page and are excluded from the
status-bar chip. The header's **`Hidden N`** toggle reveals them dimmed, with **Unhide all**
to reset. The list persists through `ctx.storage`
(`hermes.plugin.ai-usage-tracker.hidden-providers-v1`).

## Layout (one package, both SDKs)

```
ai-usage-tracker/
├── plugin.yaml              # agent half (no tools/hooks — declares nothing by design)
├── __init__.py              # register(ctx) no-op; exists so plugins.enabled can gate it
├── dashboard/
│   ├── manifest.json        # { "name": "ai-usage-tracker", "api": "plugin_api.py" }
│   └── plugin_api.py        # FastAPI router → /api/plugins/ai-usage-tracker/{usage,profiles,health}
└── desktop/
    └── plugin.js            # desktop half; Electron copies it to desktop-plugins/<id>/
```

Endpoints: `GET /usage?profile=<name>&refresh=0|1`, `GET /profiles`, `GET /health`.
Responses are cached in-process for 60s per profile; `refresh=1` bypasses.

## Privacy

- Read-only. Nothing is written except the plugin's own cache and its browser-side UI prefs.
- Credentials are resolved in-process and **never serialized**; the wire carries
  `configured: true/false` and a source label only. Account identities never leave the
  backend either — only the truncated `account.fingerprint` hash used to recognise a
  shared account.
- The only outbound calls are the provider quota endpoints above.

## Tests

```bash
python -m pip install -r tests/requirements.txt
python -m pytest -q tests                                       # backend, via the FastAPI router
node --import ./tests/js/register.mjs --test tests/js/*.test.mjs  # page logic (Node 22)
```

`tests/e2e/` holds an optional local browser demo: `run.sh` starts a throwaway Hermes gateway
(clean env, its own `HOME`/`HERMES_HOME`) serving the real Webapp with FIXTURE profiles and a
fixture network, so the page can be exercised end to end without touching real accounts.
