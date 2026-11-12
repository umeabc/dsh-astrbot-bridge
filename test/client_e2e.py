"""End-to-end check of dsh_astrbot_client against a live bridge (direct or relay).

Run by test/relay-e2e.mjs, or by hand:

    python test/client_e2e.py --transport relay \
        --relay-url 127.0.0.1:9443 --room <hex> --key <base64url> --token <token>
"""

from __future__ import annotations

import argparse
import asyncio
import json
import os
import sys
from pathlib import Path

PLUGIN_DIR = Path(os.environ.get("DSH_ASTRBOT_PLUGIN_DIR", Path(__file__).resolve().parent.parent.parent / "astrbot-plugin-dsh"))
if not (PLUGIN_DIR / "dsh_astrbot_client.py").is_file():
    print(f"SKIP: AstrBot client not found at {PLUGIN_DIR}")
    print("      clone https://github.com/umeabc/astrbot-plugin-dsh next to this repo, or set DSH_ASTRBOT_PLUGIN_DIR")
    raise SystemExit(2)
sys.path.insert(0, str(PLUGIN_DIR))

from dsh_astrbot_client import BridgeClient, BridgeError  # noqa: E402

failures = 0


def check(label: str, condition: object, detail: object = None) -> None:
    global failures
    if condition:
        print(f"  ok   {label}")
        return
    failures += 1
    print(f"  FAIL {label} :: {detail!r}")


async def run(client: BridgeClient, label: str) -> None:
    health = await client.health()
    check("health", health.get("ok") is True, health)

    chat_key = f"test/chat/{label}"
    first = await client.chat(chat_key, "hello dsh", follow=True)
    check("first chat returns text", first.get("text") == "mock reply to: hello dsh", first)
    check("first chat reports duration", isinstance(first.get("durationMs"), int), first)
    first_id = first.get("sessionId")

    long_prompt = "长" * 9000
    long_reply = await client.chat(chat_key, long_prompt, follow=True)
    check("multi-chunk prompt round-trips", len(long_reply.get("text", "")) > 9000, len(long_reply.get("text", "")))
    check(
        "plain follow starts a new session",
        long_reply.get("sessionId") != first_id,
        {"first": first_id, "second": long_reply.get("sessionId"), "first_keys": sorted(first), "second_keys": sorted(long_reply)},
    )

    listing = await client.sessions(chat_key)
    check("sessions listing has a page", listing.get("page") == 1 and listing.get("total") == 2, listing)
    sessions = [entry for group in listing.get("workspaces", []) for entry in group.get("sessions", [])]
    check("sessions listing returns both", len(sessions) == 2, sessions)

    switched = await client.switch(chat_key, first_id)
    check("switch returns the session", switched.get("sessionId") == first_id, switched)
    continued = await client.chat(chat_key, "continue", follow=True)
    check("follow continues the switched session", continued.get("sessionId") == first_id, continued)

    cancelled = await client.cancel(chat_key)
    check("cancel with nothing running", cancelled.get("cancelled") is False, cancelled)

    ack = await client.ack(chat_key, continued.get("turnId", first_id))
    check("ack is accepted", "acked" in ack, ack)
    pending = await client.notifications(chat_key)
    check("nothing is pending after delivery", pending == [], pending)

    if label == "direct":
        # Unreachable bridge: five silent attempts, then one clear failure.
        dead = BridgeClient({**client.config, "api_url": "http://127.0.0.1:9", "token": client.token})
        try:
            await dead.health()
        except BridgeError as error:
            check("retries five times before failing", "5" in str(error), str(error))
        else:
            check("retries five times before failing", False, "no error raised")

    bad = BridgeClient({**client.config, "token": "wrong"})
    try:
        await bad.health()
    except BridgeError as error:
        check("wrong token is rejected", error.status == 401, error.status)
    else:
        check("wrong token is rejected", False, "no error raised")


async def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--transport", default="direct", choices=["direct", "relay"])
    parser.add_argument("--api-url", default="http://127.0.0.1:8399")
    parser.add_argument("--relay-url", default="")
    parser.add_argument("--room", default="")
    parser.add_argument("--key", default="")
    parser.add_argument("--token", required=True)
    args = parser.parse_args()

    client = BridgeClient(
        {
            "transport": args.transport,
            "api_url": args.api_url,
            "relay_url": args.relay_url,
            "relay_room": args.room,
            "relay_key": args.key,
            "token": args.token,
            "timeout_seconds": 60,
        }
    )
    await run(client, args.transport)
    print(json.dumps({"transport": args.transport, "failures": failures}))
    return 0 if failures == 0 else 1


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))
