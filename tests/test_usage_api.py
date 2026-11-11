"""Behaviour of ``GET /usage?profile=<name>`` — the per-profile half of the All accounts view.

Every test goes through the mounted FastAPI router (the same route the desktop page calls) with
fake Hermes host seams from ``conftest.py``.
"""

from __future__ import annotations

import json
from types import SimpleNamespace

import httpx
import pytest

from conftest import FakeProfile, Snapshot, Window, utc

CLAUDE = "claude-subscription-directsdk-experimental"
CODEX_IDENTITY = "codex:acct-123:user-abc"


def usage(client, profile):
    response = client.get("/api/plugins/ai-usage-tracker/usage", params={"profile": profile, "refresh": 1})
    assert response.status_code == 200, response.text
    return response.json()


def provider(payload, pid):
    matches = [p for p in payload["providers"] if p["id"] == pid]
    assert matches, f"{pid} missing from {[p['id'] for p in payload['providers']]}"
    return matches[0]


def codex_snapshot(identity=CODEX_IDENTITY, used=40.0):
    return lambda: Snapshot(provider="openai-codex", source="usage_api", fetched_at=utc(2026, 11, 11, 9),
                            plan="Pro", identity=identity,
                            windows=(Window("Session", used, utc(2026, 11, 11, 14)),
                                     Window("Weekly", 10.0, utc(2026, 11, 15))))


# ------------------------------------------------------------------ shared subscription identity


def test_codex_account_fingerprint_is_stable_across_profiles_and_opaque(hermes, client):
    for name in ("default", "sweep"):
        hermes.add(FakeProfile(name, config={"model": {"provider": "openai-codex"}},
                               logged_in={"openai-codex"}, usage={"openai-codex": codex_snapshot()}))

    first, second = provider(usage(client, "default"), "openai-codex"), provider(usage(client, "sweep"), "openai-codex")

    assert first["account"]["fingerprint"] and first["account"]["fingerprint"] == second["account"]["fingerprint"]
    body = json.dumps(first)
    assert "acct-123" not in body and "user-abc" not in body  # identity never reaches the wire
    assert [w["label"] for w in first["quota"]["windows"]] == ["Session", "Weekly"]


def test_distinct_or_unidentified_codex_accounts_get_no_shared_fingerprint(hermes, client):
    hermes.add(FakeProfile("default", logged_in={"openai-codex"}, usage={"openai-codex": codex_snapshot()}))
    hermes.add(FakeProfile("other", logged_in={"openai-codex"},
                           usage={"openai-codex": codex_snapshot(identity="codex:acct-999:user-xyz")}))
    hermes.add(FakeProfile("anon", logged_in={"openai-codex"}, usage={"openai-codex": codex_snapshot(identity=None)}))

    fp = {name: provider(usage(client, name), "openai-codex")["account"]["fingerprint"]
          for name in ("default", "other", "anon")}

    assert fp["default"] != fp["other"]
    assert fp["anon"] is None  # unknown identity: the UI must keep it separate


# ------------------------------------------------------------------ native Claude DirectSDK hook


def test_directsdk_profile_uses_native_usage_hook_in_its_own_home(hermes, client):
    hermes.native_profiles[CLAUDE] = SimpleNamespace(display_name="Claude Subscription DirectSDK (Experimental)")
    seen_homes = []

    def claude_usage():
        seen_homes.append(hermes.bound().name)
        return Snapshot(provider=CLAUDE, source="claude_code_get_usage", fetched_at=utc(2026, 11, 11, 9),
                        title="Claude plan limits",
                        windows=(Window("Current session", 12.0, utc(2026, 11, 11, 13)),
                                 Window("Current week", 30.0, utc(2026, 11, 14)),
                                 Window("Fable week", 55.0, utc(2026, 11, 14))))

    hermes.add(FakeProfile("default", config={"model": {"provider": "openai-codex"}}))
    hermes.add(FakeProfile("sooty", config={"model": {"provider": CLAUDE}}, usage={CLAUDE: claude_usage}))

    claude = provider(usage(client, "sooty"), CLAUDE)

    assert seen_homes == ["sooty"]  # hook ran with the queried profile bound, not the server's
    assert claude["quota"]["available"] is True
    assert [w["label"] for w in claude["quota"]["windows"]] == ["Current session", "Current week", "Fable week"]
    assert claude["quota"]["windows"][2]["remaining_percent"] == 45.0
    assert claude["label"] == "Claude Subscription DirectSDK (Experimental)"
    assert claude["account"]["fingerprint"] is None  # no confirmable identity -> never merged


def test_native_hook_unavailable_reason_is_reported_not_hidden(hermes, client):
    hermes.native_profiles[CLAUDE] = SimpleNamespace(display_name="Claude DirectSDK")
    hermes.add(FakeProfile("default"))
    hermes.add(FakeProfile("sooty", config={"model": {"provider": CLAUDE}}, usage={CLAUDE: lambda: Snapshot(
        provider=CLAUDE, source="claude_code_get_usage", fetched_at=utc(2026, 11, 11, 9),
        unavailable_reason="Claude Code did not answer in time")}))

    claude = provider(usage(client, "sooty"), CLAUDE)

    assert claude["quota"]["available"] is False
    assert claude["quota"]["unavailable_reason"] == "Claude Code did not answer in time"


# ------------------------------------------------------------------ OpenRouter balance vs keys


def openrouter_transport(by_key):
    """Fake openrouter.ai: ``by_key[token] = {"credits": {...}, "key": {...}}``."""

    def handler(request: httpx.Request) -> httpx.Response:
        token = request.headers["authorization"].removeprefix("Bearer ")
        data = by_key[token]
        part = request.url.path.rsplit("/", 1)[-1]
        if isinstance(data.get(part), Exception):
            raise data[part]
        return httpx.Response(200, json={"data": data[part]})

    return httpx.MockTransport(handler)


@pytest.fixture
def fake_openrouter(backend, monkeypatch):
    real_client = httpx.Client

    def install(by_key):
        transport = openrouter_transport(by_key)
        monkeypatch.setattr(backend.httpx, "Client", lambda **kw: real_client(transport=transport, **kw))

    return install


def test_openrouter_keys_stay_separate_from_each_other_and_from_account_balance(hermes, client, fake_openrouter):
    research_key, fallback_key = "sk-or-research-SECRET", "sk-or-fallback-SECRET"
    fake_openrouter({
        research_key: {"credits": {"total_credits": 50.0, "total_usage": 20.0},
                       "key": {"limit": None, "usage": 7.5, "usage_daily": 1.25}},
        fallback_key: {"credits": {"total_credits": 50.0, "total_usage": 20.0},
                       "key": {"limit": 5.0, "limit_remaining": 4.0, "usage": 1.0, "limit_reset": "monthly"}},
    })
    hermes.add(FakeProfile("default", keys={"openrouter": research_key, "openrouter-limited": fallback_key},
                           config={"providers": {"openrouter-limited": {"base_url": "https://openrouter.ai/api/v1"}},
                                   "fallback_model": {"provider": "openrouter-limited"}},
                           logged_in={"openrouter"}))

    payload = usage(client, "default")
    unrestricted, restricted = provider(payload, "openrouter"), provider(payload, "openrouter-limited")

    assert unrestricted["family"] == restricted["family"] == "openrouter"
    assert unrestricted["account"]["fingerprint"] != restricted["account"]["fingerprint"]
    # Account balance is its own field, never folded into the key's spend/limit numbers.
    assert unrestricted["quota"]["balance"]["remaining_usd"] == 30.0
    assert restricted["quota"]["balance"]["remaining_usd"] == 30.0
    assert unrestricted["quota"]["key"] == (
        {"restricted": False, "limit_usd": None, "limit_remaining_usd": None, "limit_reset": None,
         "usage_usd": 7.5, "usage_daily_usd": 1.25, "usage_weekly_usd": None, "usage_monthly_usd": None})
    assert restricted["quota"]["key"]["restricted"] is True
    assert restricted["quota"]["key"]["limit_remaining_usd"] == 4.0
    assert [w["label"] for w in restricted["quota"]["windows"]] == ["Key spend limit"]
    assert unrestricted["quota"]["windows"] == []
    assert "SECRET" not in json.dumps(payload)


def test_same_openrouter_key_in_two_profiles_shares_a_fingerprint(hermes, client, fake_openrouter):
    key = "sk-or-shared-SECRET"
    fake_openrouter({key: {"credits": {"total_credits": 10.0, "total_usage": 1.0}, "key": {"usage": 1.0}}})
    for name in ("default", "research"):
        hermes.add(FakeProfile(name, keys={"openrouter": key}, logged_in={"openrouter"}))

    a, b = (provider(usage(client, n), "openrouter")["account"]["fingerprint"] for n in ("default", "research"))

    assert a and a == b


def test_openrouter_balance_failure_keeps_key_usage(hermes, client, fake_openrouter):
    key = "sk-or-x-SECRET"
    fake_openrouter({key: {"credits": httpx.ConnectError("boom"), "key": {"usage": 3.0}}})
    hermes.add(FakeProfile("default", keys={"openrouter": key}, logged_in={"openrouter"}))

    quota = provider(usage(client, "default"), "openrouter")["quota"]

    assert quota["available"] is True
    assert quota["balance"]["remaining_usd"] is None and "ConnectError" in quota["balance"]["error"]
    assert quota["key"]["usage_usd"] == 3.0


def test_zero_dollar_key_cap_is_restricted_not_unlimited(hermes, client, fake_openrouter):
    # OpenRouter: limit=null means unlimited; limit=0 is a real $0 cap.
    caps = {"k-null": None, "k-zero": 0, "k-five": 5.0}
    fake_openrouter({k: {"credits": {"total_credits": 10.0, "total_usage": 1.0},
                         "key": {"limit": cap, "limit_remaining": cap, "usage": 0.0}} for k, cap in caps.items()})
    for name, key in zip(("default", "research", "background"), caps):
        hermes.add(FakeProfile(name, keys={"openrouter": key}, logged_in={"openrouter"}))

    unlimited, zero, five = (provider(usage(client, n), "openrouter")["quota"]
                             for n in ("default", "research", "background"))

    assert unlimited["key"]["restricted"] is False and unlimited["windows"] == []
    assert zero["key"]["restricted"] is True
    assert (zero["key"]["limit_usd"], zero["key"]["limit_remaining_usd"]) == (0.0, 0.0)
    assert [(w["label"], w["remaining_percent"], w["detail"]) for w in zero["windows"]] == [
        ("Key spend limit", 0.0, "$0.00 of $0.00 left")]
    assert zero["balance"]["remaining_usd"] == 9.0  # account balance stays separate from the key cap
    assert five["key"]["restricted"] is True and five["windows"][0]["remaining_percent"] == 100.0


# ------------------------------------------------------------------ request secret scope


def test_probe_workers_keep_the_requests_secret_scope(hermes, client, fake_openrouter):
    """Once Hermes serves several profiles it fails closed on credential reads outside the
    request's bound secret scope; the probe thread pool must carry that scope along."""
    hermes.fail_closed = True
    key = "sk-or-scope-SECRET"
    fake_openrouter({key: {"credits": {"total_credits": 3.0, "total_usage": 1.0}, "key": {"usage": 1.0}}})
    hermes.add(FakeProfile("default", keys={"openrouter": key}, logged_in={"openrouter", "openai-codex"},
                           usage={"openai-codex": codex_snapshot()}))

    payload = usage(client, "default")

    assert provider(payload, "openrouter")["quota"]["available"] is True
    assert provider(payload, "openai-codex")["quota"]["available"] is True


# ------------------------------------------------------------------ partial failure


def test_one_failing_provider_does_not_sink_the_others(hermes, client, backend, fake_openrouter):
    def explode():
        raise RuntimeError("upstream 500")

    key = "sk-or-ok-SECRET"
    fake_openrouter({key: {"credits": {"total_credits": 2.0, "total_usage": 1.0}, "key": {"usage": 1.0}}})
    hermes.add(FakeProfile("default", keys={"openrouter": key}, logged_in={"openrouter", "openai-codex"},
                           usage={"openai-codex": explode}))

    payload = usage(client, "default")

    codex, router = provider(payload, "openai-codex"), provider(payload, "openrouter")
    assert codex["quota"]["available"] is False and "upstream 500" in codex["quota"]["unavailable_reason"]
    assert router["quota"]["available"] is True
