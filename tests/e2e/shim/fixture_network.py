"""FIXTURE network for the isolated browser demo — never installed anywhere else.

``run.sh`` loads it through a ``.pth`` file it drops into the throwaway runtime venv that Hermes
creates for the demo's own data root (the launcher strips ``PYTHONPATH``, so a ``.pth`` is the way
into the gateway AND every plugin host it spawns). It also only arms itself when the process's
``HERMES_HOME`` sits under a demo home carrying the ``.ai-usage-e2e-fixtures`` marker.

Armed, httpx requests to openrouter.ai and chatgpt.com get canned FIXTURE answers keyed by the
fake bearer token, and every other non-loopback request is refused (HTTP 599), so the demo cannot
reach a real provider or spend anything.
"""

from __future__ import annotations

import os
import time
from pathlib import Path


def _armed() -> bool:
    home = Path(os.environ.get("HERMES_HOME") or "/nonexistent")
    return any((p / ".ai-usage-e2e-fixtures").is_file() for p in (home, *home.parents))


if _armed():
    import httpx

    HOUR = 3600

    def _openrouter(token: str, part: str) -> httpx.Response:
        keys = {
            "sk-or-FIXTURE-main": ({"total_credits": 25.0, "total_usage": 11.5},
                                   {"limit": None, "usage": 9.25, "usage_daily": 0.4, "usage_monthly": 3.1}),
            "sk-or-FIXTURE-fallback": ({"total_credits": 25.0, "total_usage": 11.5},
                                       {"limit": 5.0, "limit_remaining": 3.75, "usage": 1.25, "limit_reset": "monthly"}),
            "sk-or-FIXTURE-research": ({"total_credits": 8.0, "total_usage": 7.2},
                                       {"limit": None, "usage": 7.2, "usage_weekly": 1.9}),
            "FIXTURE-or-zero-cap": ({"total_credits": 8.0, "total_usage": 7.2},
                                    {"limit": 0, "limit_remaining": 0, "usage": 0}),
        }
        if token not in keys:
            return httpx.Response(401, json={"error": {"message": "FIXTURE: key revoked"}})
        credits, key = keys[token]
        return httpx.Response(200, json={"data": credits if part == "credits" else key})

    def _codex(token: str) -> httpx.Response:
        now = int(time.time())
        plans = {"A": (62.0, 18.0), "B": (5.0, 41.0)}
        tag = "A" if "acct-A" in _jwt_account(token) else "B"
        session, weekly = plans[tag]
        return httpx.Response(200, json={
            "plan_type": "pro",
            "rate_limit": {
                "primary_window": {"used_percent": session, "limit_window_seconds": 18000, "reset_at": now + 3 * HOUR},
                "secondary_window": {"used_percent": weekly, "limit_window_seconds": 604800, "reset_at": now + 80 * HOUR},
            },
        })

    def _jwt_account(token: str) -> str:
        import base64
        import json

        try:
            payload = token.split(".")[1]
            claims = json.loads(base64.urlsafe_b64decode(payload + "=" * (-len(payload) % 4)))
            return str(claims["https://api.openai.com/auth"]["chatgpt_account_id"])
        except Exception:  # noqa: BLE001
            return ""

    def _answer(request: httpx.Request) -> httpx.Response | None:
        host = request.url.host or ""
        if host in ("127.0.0.1", "localhost", "::1"):
            return None  # the gateway's own loopback traffic
        token = request.headers.get("authorization", "").removeprefix("Bearer ").strip()
        path = request.url.path
        if host == "openrouter.ai" and path.endswith(("/credits", "/key")):
            return _openrouter(token, path.rsplit("/", 1)[-1])
        if host == "chatgpt.com" and path.endswith("/wham/usage"):
            return _codex(token)
        return httpx.Response(599, text=f"FIXTURE network: {host} is blocked in the isolated demo")

    _sync_handle = httpx.HTTPTransport.handle_request
    _async_handle = httpx.AsyncHTTPTransport.handle_async_request

    def handle_request(self, request):
        response = _answer(request)
        return _sync_handle(self, request) if response is None else response

    async def handle_async_request(self, request):
        response = _answer(request)
        return await _async_handle(self, request) if response is None else response

    httpx.HTTPTransport.handle_request = handle_request
    httpx.AsyncHTTPTransport.handle_async_request = handle_async_request
