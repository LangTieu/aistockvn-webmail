#!/usr/bin/env python3
"""Daily guardrail: webmail (aistockvn-mail) Cloudflare Observability ingestion.

Measures the last 24h Workers invocations via the Cloudflare GraphQL API
(the only usage read the available API token can do -- the billable-usage,
subscriptions and Logpush endpoints all reject it with auth error) and
estimates the ingested GB/day from the Worker's (audited) log behaviour:
  - Workers Traces: ~5 KB per invocation (generous upper bound; real ~1-2 KB),
    multiplied by the head_sampling_rate in wrangler.jsonc (0.1 after the
    guardrail, 1.0 before).
  - Workers Logs: the Worker emits NO per-request console output -- only
    error/event lines via logEvent (sanitized, <= ~500 B each). Estimated as
    errors x 500 B + 5 KB/day allowance for event lines (backup, client errors).
  - R2 Data Access Logs: NOT enabled (opt-in dashboard toggle, never turned
    on) -> 0. If it is ever enabled, add its volume here.

Thresholds (Free plan: 0.5 GB/day, ingestion pauses at the limit, no charge):
  - WARN  >= 0.30 GB/day (60%): Telegram warning.
  - HARD  >= 0.50 GB/day (100%): Telegram hard alert.
Alerts are deduped to once per day per level (state file next to this script).
The Telegram bot token/chat id are read from
~/workspace/shopee-deal-hunter/.env (the same shared alerting channel the
stock watchdog uses) and are never printed.

Exit codes: 0 = OK, 2 = WARN/ALERT, 1 = could not measure.
Prints one summary line to stdout and appends it to observability_guard.log.
"""

import json
import os
import re
import sys
import urllib.request
from datetime import datetime, timedelta, timezone

ACCOUNT_ID = "e6e3dca05591f48f9bc8a58767c3ee01"
SCRIPT_NAME = "aistockvn-mail"
CF_TOKEN_PATH = os.path.expanduser("~/.cf_webmail_token")
TG_ENV_PATH = os.path.expanduser("~/workspace/shopee-deal-hunter/.env")
HERE = os.path.dirname(os.path.abspath(__file__))
WRANGLER_PATH = os.path.join(HERE, "..", "wrangler.jsonc")
STATE_PATH = os.path.join(HERE, "observability_guard_state.json")
LOG_PATH = os.path.join(HERE, "observability_guard.log")

WARN_GB = 0.30
HARD_GB = 0.50
# Generous upper bound for one invocation's trace (real ~1-2 KB).
TRACE_BYTES_PER_REQUEST = 5120
LOG_BYTES_PER_ERROR = 500
EVENT_LOG_ALLOWANCE_BYTES = 5000


def read_cf_token() -> str:
    with open(CF_TOKEN_PATH, encoding="utf-8") as f:
        return f.read().strip()


def head_sampling_rate() -> float:
    """Read head_sampling_rate from wrangler.jsonc; 1.0 if absent/unreadable."""
    try:
        with open(WRANGLER_PATH, encoding="utf-8") as f:
            text = f.read()
        m = re.search(r'"head_sampling_rate"\s*:\s*([0-9]*\.?[0-9]+)', text)
        if m:
            v = float(m.group(1))
            if 0.0 <= v <= 1.0:
                return v
    except Exception:
        pass
    return 1.0


def fetch_invocations(token: str, start: datetime, end: datetime) -> tuple[int, int]:
    """Return (requests, errors) for the Worker in [start, end) via GraphQL."""
    query = (
        "query { viewer { accounts(filter: {accountTag: \"%s\"}) { "
        "workersInvocationsAdaptive(limit: 5, filter: {datetime_geq: \"%s\", "
        "datetime_lt: \"%s\", scriptName: \"%s\"}) { sum { requests errors } } } } }"
        % (
            ACCOUNT_ID,
            start.strftime("%Y-%m-%dT%H:%M:%SZ"),
            end.strftime("%Y-%m-%dT%H:%M:%SZ"),
            SCRIPT_NAME,
        )
    )
    body = json.dumps({"query": query}).encode()
    req = urllib.request.Request(
        "https://api.cloudflare.com/client/v4/graphql",
        data=body,
        method="POST",
        headers={
            "Authorization": "Bearer " + token,
            "Content-Type": "application/json",
            "User-Agent": "observability-guard/1.0",
        },
    )
    with urllib.request.urlopen(req, timeout=30) as r:
        data = json.load(r)
    rows = data["data"]["viewer"]["accounts"][0]["workersInvocationsAdaptive"]
    if not rows:
        return 0, 0
    total = rows[0]["sum"]
    return int(total.get("requests") or 0), int(total.get("errors") or 0)


def tg_config() -> tuple[str | None, str | None]:
    """Read the shared Telegram bot token + chat id (same keys as watchdog)."""
    token = chat = None
    try:
        with open(TG_ENV_PATH, encoding="utf-8") as f:
            for line in f:
                s = line.strip()
                if s.startswith("DEALHUNTER_TELEGRAM_BOT_TOKEN=") or s.startswith(
                    "TELEGRAM_BOT_TOKEN="
                ):
                    token = s.split("=", 1)[1].strip().strip('"').strip("'")
                elif s.startswith("DEALHUNTER_TELEGRAM_CHAT_ID=") or s.startswith(
                    "TELEGRAM_CHAT_ID="
                ):
                    chat = s.split("=", 1)[1].strip().strip('"').strip("'")
    except Exception:
        pass
    return token, chat


def send_telegram(text: str) -> bool:
    token, chat = tg_config()
    if not token or not chat:
        return False
    body = json.dumps(
        {"chat_id": chat, "text": text, "parse_mode": "HTML"}
    ).encode()
    req = urllib.request.Request(
        "https://api.telegram.org/bot%s/sendMessage" % token,
        data=body,
        method="POST",
        headers={"Content-Type": "application/json", "User-Agent": "Mozilla/5.0"},
    )
    for _ in range(3):
        try:
            with urllib.request.urlopen(req, timeout=20) as r:
                r.read()
            return True
        except Exception:
            continue
    return False


def load_state() -> dict:
    try:
        with open(STATE_PATH, encoding="utf-8") as f:
            return json.load(f)
    except Exception:
        return {}


def save_state(state: dict) -> None:
    try:
        with open(STATE_PATH, "w", encoding="utf-8") as f:
            json.dump(state, f)
    except Exception:
        pass


def main() -> int:
    now = datetime.now(timezone.utc)
    start = now - timedelta(hours=24)
    try:
        token = read_cf_token()
        requests, errors = fetch_invocations(token, start, now)
    except Exception as e:
        line = "ERROR could_not_measure %s" % (str(e)[:200],)
        print(line, flush=True)
        _append_log(line)
        return 1

    sampling = head_sampling_rate()
    trace_bytes = requests * TRACE_BYTES_PER_REQUEST * sampling
    log_bytes = errors * LOG_BYTES_PER_ERROR + EVENT_LOG_ALLOWANCE_BYTES
    est_gb = (trace_bytes + log_bytes) / 1e9
    today = now.strftime("%Y-%m-%d")

    level = "OK"
    if est_gb >= HARD_GB:
        level = "HARD"
    elif est_gb >= WARN_GB:
        level = "WARN"

    line = (
        "date=%s requests=%d errors=%d sampling=%.2f est_gb=%.4f "
        "free_limit_gb=0.50 level=%s" % (today, requests, errors, sampling, est_gb, level)
    )
    print(line, flush=True)
    _append_log(line)

    if level == "OK":
        return 0

    state = load_state()
    if state.get("last_alert_date") == today and state.get("last_alert_level") == level:
        print("ALERT already sent today for level %s, skipping duplicate" % level)
        return 2
    msg = (
        "⚠️ Webmail Observability %s: ước tính %.3f GB/ngày (giới hạn free 0,5 GB/ngày). "
        "Requests 24h: %d, errors: %d, sampling: %.0f%%. "
        % (level, est_gb, requests, errors, sampling * 100)
    )
    if level == "HARD":
        msg += "Đã chạm trần free — log sẽ tạm dừng, cần giảm log hoặc xem lại traffic ngay."
    else:
        msg += "Đã qua 60% trần free — theo dõi sát, cân nhắc giảm sampling."
    sent = send_telegram(msg)
    state["last_alert_date"] = today
    state["last_alert_level"] = level
    state["last_est_gb"] = round(est_gb, 4)
    save_state(state)
    print("ALERT level=%s telegram_sent=%s" % (level, sent))
    return 2


def _append_log(line: str) -> None:
    try:
        ts = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
        with open(LOG_PATH, "a", encoding="utf-8") as f:
            f.write("%s %s\n" % (ts, line))
    except Exception:
        pass


if __name__ == "__main__":
    sys.exit(main())
