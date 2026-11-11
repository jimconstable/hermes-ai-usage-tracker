#!/usr/bin/env python3
"""Build a throwaway Hermes home of FIXTURE profiles for the browser demo.

    python3 tests/e2e/setup_home.py <empty-dir> <directsdk-plugin-dir> <port>

Profiles (every credential is a fake ``FIXTURE`` string; the network shim answers for them):

* default    — Codex account A, OpenRouter main key + ``openrouter-limited`` restricted fallback key
* background — no login of its own: falls back to the root's Codex account A (shared subscription),
               plus an OpenRouter key with a $0 spend cap (a cap, not "unlimited")
* sweep      — Codex account B (a distinct account: must stay a separate card)
* research   — its own OpenRouter key (a distinct key: never merged with default's)
* sooty      — Claude Subscription DirectSDK via the fake ``claude`` CLI, plus a revoked OpenRouter
               key (one provider failing inside a profile)
* legacy     — AI usage tracker NOT enabled (one whole profile refusing; its consent is respected)
"""

from __future__ import annotations

import base64
import json
import os
import sys
import time
from pathlib import Path

HERE = Path(__file__).resolve().parent
REPO = HERE.parents[1]


def jwt(account: str, subject: str) -> str:
    def part(obj: dict) -> str:
        return base64.urlsafe_b64encode(json.dumps(obj).encode()).decode().rstrip("=")

    claims = {"sub": subject, "exp": int(time.time()) + 30 * 86400,
              "https://api.openai.com/auth": {"chatgpt_account_id": account}}
    return f"{part({'alg': 'none', 'typ': 'JWT'})}.{part(claims)}.FIXTURE"


def codex_auth(account: str, subject: str) -> dict:
    return {"version": 1, "providers": {"openai-codex": {
        "tokens": {"access_token": jwt(account, subject), "refresh_token": "FIXTURE-refresh",
                   "account_id": account},
        "last_refresh": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()), "auth_mode": "chatgpt"}}}


def write(path: Path, text: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text)


def yaml(obj, indent: int = 0) -> str:
    """Tiny YAML emitter (dicts/lists/scalars) so the setup needs no third-party package."""
    pad, out = "  " * indent, []
    if isinstance(obj, dict):
        for key, value in obj.items():
            if isinstance(value, (dict, list)) and value:
                out.append(f"{pad}{key}:\n{yaml(value, indent + 1)}")
            else:
                out.append(f"{pad}{key}: {json.dumps(value)}")
    else:
        for value in obj:
            if isinstance(value, dict):
                first, *rest = yaml(value, indent + 1).splitlines()
                out.append(f"{pad}- {first.strip()}" + "".join(f"\n{line}" for line in rest))
            else:
                out.append(f"{pad}- {json.dumps(value)}")
    return "\n".join(out)


def main() -> int:
    root, directsdk, port = Path(sys.argv[1]).resolve(), Path(sys.argv[2]).resolve(), int(sys.argv[3])
    hermes = root / "home" / ".hermes"
    if hermes.exists():
        raise SystemExit(f"{hermes} already exists — use a fresh directory")
    tracker = ["ai-usage-tracker"]
    profiles = {
        "default": {"config": {"model": {"provider": "openai-codex", "default": "gpt-5"},
                               "fallback_model": {"provider": "openrouter-limited", "model": "x/y"},
                               "providers": {"openrouter-limited": {"base_url": "https://openrouter.ai/api/v1",
                                                                    "key_env": "OPENROUTER_FALLBACK_API_KEY",
                                                                    "api_mode": "chat_completions"}},
                               "plugins": {"enabled": tracker},
                               "webapp": {"enabled": True, "host": "127.0.0.1", "port": port},
                               "kanban": {"dispatch_in_gateway": False}},
                    "env": {"OPENROUTER_API_KEY": "sk-or-FIXTURE-main",
                            "OPENROUTER_FALLBACK_API_KEY": "sk-or-FIXTURE-fallback"},
                    "auth": codex_auth("acct-A-FIXTURE", "user-A-FIXTURE")},
        "background": {"config": {"model": {"provider": "openai-codex", "default": "gpt-5"},
                                  "plugins": {"enabled": tracker}},
                       "env": {"OPENROUTER_API_KEY": "FIXTURE-or-zero-cap"}},
        "sweep": {"config": {"model": {"provider": "openai-codex", "default": "gpt-5"},
                             "plugins": {"enabled": tracker}},
                  "auth": codex_auth("acct-B-FIXTURE", "user-B-FIXTURE")},
        "research": {"config": {"model": {"provider": "openrouter", "default": "z/glm"},
                                "plugins": {"enabled": tracker}},
                     "env": {"OPENROUTER_API_KEY": "sk-or-FIXTURE-research"}},
        "sooty": {"config": {"model": {"provider": "claude-subscription-directsdk-experimental",
                                       "default": "claude-opus-5-5"},
                             "plugins": {"enabled": tracker + ["claude-subscription-directsdk-experimental"]}},
                  "env": {"CLAUDE_SUBSCRIPTION_DIRECTSDK_COMMAND": str(HERE / "fake_claude.py"),
                          "OPENROUTER_API_KEY": "sk-or-FIXTURE-revoked"},
                  "plugins": {"claude-subscription-directsdk-experimental": directsdk}},
        "legacy": {"config": {"model": {"provider": "openai-codex", "default": "gpt-5"},
                              "plugins": {"enabled": []}}},
    }
    for name, spec in profiles.items():
        home = hermes if name == "default" else hermes / "profiles" / name
        write(home / "config.yaml", yaml(spec["config"]) + "\n")
        write(home / ".env", "".join(f"{k}={v}\n" for k, v in spec.get("env", {}).items()))
        if "auth" in spec:
            write(home / "auth.json", json.dumps(spec["auth"], indent=2))
        (home / "plugins").mkdir(parents=True, exist_ok=True)
        for plugin, target in spec.get("plugins", {}).items():
            (home / "plugins" / plugin).symlink_to(target, target_is_directory=True)
    # Arms shim/fixture_network.py for processes under this home only.
    write(hermes / ".ai-usage-e2e-fixtures", "FIXTURE demo home — fake credentials only\n")
    # The plugin under test, linked like a dev checkout (`ln -s ~/src/pkg ~/.hermes/plugins/`).
    (hermes / "plugins" / "ai-usage-tracker").symlink_to(REPO, target_is_directory=True)
    os.chmod(HERE / "fake_claude.py", 0o755)
    print(hermes)
    return 0


if __name__ == "__main__":
    sys.exit(main())
