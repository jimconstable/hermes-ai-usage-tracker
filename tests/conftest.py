"""Test harness: the plugin backend against fake Hermes host modules.

The backend imports Hermes lazily (``hermes_constants``, ``hermes_cli.*``, ``agent.*``,
``providers``), so each test installs small in-memory stand-ins for exactly those seams and
drives the real FastAPI router over HTTP. Nothing here touches a real Hermes home, credential
or provider endpoint.
"""

from __future__ import annotations

import contextvars
import importlib.util
import sys
import types
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable, Optional

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

REPO = Path(__file__).resolve().parents[1]


@dataclass(frozen=True)
class Window:
    label: str
    used_percent: Optional[float] = None
    reset_at: Optional[datetime] = None
    detail: Optional[str] = None


@dataclass(frozen=True)
class Snapshot:
    provider: str
    source: str
    fetched_at: datetime
    title: str = "Account limits"
    plan: Optional[str] = None
    windows: tuple = ()
    details: tuple = ()
    unavailable_reason: Optional[str] = None
    identity: Optional[str] = None
    raw: Optional[dict] = None

    @property
    def available(self) -> bool:
        return bool(self.windows or self.details) and not self.unavailable_reason


@dataclass
class FakeProfile:
    """One Hermes profile: its config, env-style credentials and per-provider usage behaviour."""

    name: str
    config: dict = field(default_factory=dict)
    # provider/named-provider -> api key (what ``resolve_runtime_provider`` would return)
    keys: dict = field(default_factory=dict)
    # provider -> callable() -> Snapshot | None | raise  (``fetch_account_usage`` behaviour)
    usage: dict = field(default_factory=dict)
    # providers with an auth-store login
    logged_in: set = field(default_factory=set)


class FakeHermes:
    """The host seams the backend reaches, keyed by the bound Hermes home."""

    def __init__(self, root: Path):
        self.root = root
        self.profiles: dict[str, FakeProfile] = {}
        self.home_var: contextvars.ContextVar = contextvars.ContextVar("fake_home", default=None)
        self.usage_calls: list[tuple[str, str]] = []  # (bound profile name, provider)
        self.native_profiles: dict[str, Any] = {}  # provider id -> object with display_name
        self.openrouter_http: Callable | None = None

    # -- profiles -----------------------------------------------------------------------
    def add(self, profile: FakeProfile) -> FakeProfile:
        home = self.home_of(profile.name)
        home.mkdir(parents=True, exist_ok=True)
        self.profiles[profile.name] = profile
        return profile

    def home_of(self, name: str) -> Path:
        return self.root if name == "default" else self.root / "profiles" / name

    def bound(self) -> FakeProfile:
        home = self.home_var.get() or self.root
        for name, profile in self.profiles.items():
            if self.home_of(name).resolve() == Path(home).resolve():
                return profile
        raise AssertionError(f"no fake profile bound at {home}")

    # -- module installation ------------------------------------------------------------
    def install(self, monkeypatch: pytest.MonkeyPatch) -> None:
        fake = self

        hermes_constants = types.ModuleType("hermes_constants")

        def set_override(home):
            return fake.home_var.set(Path(home))

        hermes_constants.set_hermes_home_override = set_override
        hermes_constants.reset_hermes_home_override = lambda token: fake.home_var.reset(token)
        hermes_constants.get_hermes_home = lambda: fake.home_var.get() or fake.root
        hermes_constants.get_process_hermes_home = lambda: fake.root

        @dataclass
        class Info:
            name: str
            path: Path
            is_default: bool = False
            gateway_running: bool = False

        hermes_cli = types.ModuleType("hermes_cli")
        hermes_cli.__path__ = []  # package
        profiles_mod = types.ModuleType("hermes_cli.profiles")
        profiles_mod.list_profiles = lambda: [
            Info(name=n, path=fake.home_of(n), is_default=(n == "default")) for n in fake.profiles
        ]
        config_mod = types.ModuleType("hermes_cli.config")
        config_mod.load_config_readonly = lambda: dict(fake.bound().config)
        runtime_mod = types.ModuleType("hermes_cli.runtime_provider")

        def resolve_runtime_provider(requested=None, **_kw):
            profile = fake.bound()
            key = profile.keys.get(requested)
            if key is None:
                raise RuntimeError(f"no credentials for {requested}")
            base = "https://openrouter.ai/api/v1"
            named = (profile.config.get("providers") or {}).get(requested) or {}
            return {"api_key": key, "base_url": named.get("base_url") or base}

        runtime_mod.resolve_runtime_provider = resolve_runtime_provider
        auth_mod = types.ModuleType("hermes_cli.auth")
        auth_mod.get_provider_auth_state = lambda provider: (
            {"logged_in": True} if provider in fake.bound().logged_in else None)
        auth_mod.read_credential_pool = lambda provider: []
        catalog_mod = types.ModuleType("hermes_cli.models_catalog_static")
        catalog_mod._PROVIDER_LABELS = {
            "openai-codex": "OpenAI Codex", "openrouter": "OpenRouter", "anthropic": "Anthropic",
        }

        agent = types.ModuleType("agent")
        agent.__path__ = []
        account_usage = types.ModuleType("agent.account_usage")

        def fetch_account_usage(provider, **_kw):
            profile = fake.bound()
            fake.usage_calls.append((profile.name, provider))
            behaviour = profile.usage.get(provider)
            if behaviour is None:
                return None
            return behaviour()

        account_usage.fetch_account_usage = fetch_account_usage

        providers_mod = types.ModuleType("providers")
        providers_mod.get_provider_profile = lambda name: fake.native_profiles.get(name)

        for name, module in {
            "hermes_constants": hermes_constants, "hermes_cli": hermes_cli,
            "hermes_cli.profiles": profiles_mod, "hermes_cli.config": config_mod,
            "hermes_cli.runtime_provider": runtime_mod, "hermes_cli.auth": auth_mod,
            "hermes_cli.models_catalog_static": catalog_mod, "agent": agent,
            "agent.account_usage": account_usage, "providers": providers_mod,
        }.items():
            monkeypatch.setitem(sys.modules, name, module)


def load_backend():
    spec = importlib.util.spec_from_file_location("ai_usage_plugin_api_under_test",
                                                  REPO / "dashboard" / "plugin_api.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


@pytest.fixture
def hermes(tmp_path, monkeypatch):
    fake = FakeHermes(tmp_path / "hermes")
    fake.install(monkeypatch)
    return fake


@pytest.fixture
def backend(hermes, monkeypatch):
    module = load_backend()
    # No state.db activity in the fakes: inclusion comes from config/credentials only.
    monkeypatch.setattr(module, "_active_providers", lambda days=30: (set(), {}))
    return module


@pytest.fixture
def client(backend):
    app = FastAPI()
    app.include_router(backend.router, prefix="/api/plugins/ai-usage-tracker")
    return TestClient(app)


def utc(*args) -> datetime:
    return datetime(*args, tzinfo=timezone.utc)
