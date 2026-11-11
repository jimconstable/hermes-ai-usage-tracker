#!/usr/bin/env python3
"""FIXTURE stand-in for the ``claude`` CLI, used only by the isolated browser demo.

Answers Claude Code's ``get_usage`` control request (the one the DirectSDK provider plugin's
``fetch_account_usage`` hook sends) with canned plan limits in the real ``limits[]`` shape:
``session``, ``weekly_all`` and a model-scoped ``weekly_scoped`` window. No model, no network.
"""

import json
import sys
from datetime import datetime, timedelta, timezone


def main() -> int:
    if "--version" in sys.argv:
        print("2.1.999 (FIXTURE)")
        return 0
    now = datetime.now(timezone.utc)
    for line in sys.stdin:
        try:
            request = json.loads(line)
        except ValueError:
            continue
        if request.get("type") != "control_request" or request.get("request", {}).get("subtype") != "get_usage":
            continue
        limits = [
            {"kind": "session", "percent": 23, "resets_at": (now + timedelta(hours=2, minutes=10)).isoformat()},
            {"kind": "weekly_all", "percent": 47, "resets_at": (now + timedelta(days=3, hours=4)).isoformat()},
            {"kind": "weekly_scoped", "percent": 81, "scope": {"model": {"display_name": "Fable"}},
             "resets_at": (now + timedelta(days=3, hours=4)).isoformat()},
        ]
        print(json.dumps({"type": "control_response", "response": {
            "subtype": "success", "request_id": request.get("request_id"),
            "response": {"rate_limits_available": True, "rate_limits": {"limits": limits}}}}), flush=True)
        break
    return 0


if __name__ == "__main__":
    sys.exit(main())
