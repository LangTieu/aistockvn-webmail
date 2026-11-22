#!/usr/bin/env python3
"""Daily Cloudflare billing guard (20/11/2026, Henrry 18:58 + 19:08).

Checks every Cloudflare service on account Skillshare01br against its FREE
limit and alerts via Telegram (same bot as the stock watchdog) at WARN >= 60%
and HARD >= 100% of the limit, deduped to once per day per level, silent on OK.

KEY FACTS (verified 20/11, see the audit report):
- R2 free allowance is 10 GB-month / 1M Class A / 10M Class B. The HARD
  guardrail lives in code (worker/r2-guard.ts): at 8 GB (80%) or 800K
  Class A/month, R2 writes stop (mail still saves to D1, only the raw
  file is missing). This monitor watches the same numbers and alerts
  before the guardrail trips.
- Workers / D1 / Workers AI / Observability on the FREE plan HARD-CAP:
  overage = fail/pause (Error 1027, D1 queries fail, Workers AI 429,
  Observability ingestion pauses). So for those the monitor is the
  guardrail (availability), and the HARD guardrails live in code:
  - R2: worker/r2-guard.ts + migration 0019 -- stops R2 writes at 8 GB
    (80% free) or 800K Class A/month; mail still lands in D1.
  - Workers AI: worker/ai.ts -- 60 calls/day cap + 8000-char input cap.
  - Observability: Worker sampling 0.1 (see observability_guard.py).

What this script measures (webmail token ~/.cf_webmail_token):
- Workers requests (GraphQL, all 3 scripts: aistockvn-mail, telnyx-sms-relay,
  vn-stock-ai-gateway) vs 100,000/day (account-wide, UTC day; rolling 24h used).
- R2 storage: D1 table r2_usage (the Worker's own counter, seeded with the
  real 571,746 bytes measured 20/11) vs 10 GB. The R2 storage GraphQL
  dataset is not readable with this token, so the D1 counter is the source
  of truth -- it is also what the hard guard in the Worker reads. If the
  table is missing (migration 0019 not applied yet), R2 storage is UNKNOWN.
  Also reads the blocked flag: blocked=1 means the hard guard has fired.
- R2 Class A ops: estimated from D1 messages created this month (each
  inbound mail = 1 R2 PUT) vs 1,000,000/month. Labelled as an estimate.
- D1 size (list API, file_size per DB) vs 5 GB/account and 500 MB/DB.
- D1 rows read/written: ESTIMATE from Workers requests x per-request profile
  (500 rows read, 5 rows written -- conservative upper bound) vs 5M read/day
  and 100K written/day. Labelled as an estimate (no API exposes the counters).
- Workers AI neurons: D1 table ai_rate_limits SUM(calls) today x ~90 neurons
  vs 10,000/day. If the table is missing (migration 0018 not applied yet),
  AI usage is UNKNOWN.
- Observability: latest line of observability_guard.log (est_gb) vs 0.5 GB/day.
- Inventory: Workers scripts + R2 buckets + D1 DBs vs the baseline in the
  state file; a NEW billable resource (new Worker / R2 bucket / D1 DB)
  triggers a HARD alert. Pages / KV / Logpush / Stream cannot be listed
  with this token (auth error) -- reported as UNVERIFIED, not an error.

Exit codes: 0 = OK, 2 = WARN/ALERT, 1 = could not measure (core check failed).
Prints one summary line to stdout and appends it to billing_guard.log.
"""

import json
import os
import re
import sys
import urllib.request
from datetime import datetime, timedelta, timezone

ACCOUNT_ID = "e6e3dca05591f48f9bc8a58767c3ee01"
CF_TOKEN_PATH = os.path.expanduser("~/.cf_webmail_token")
TG_ENV_PATH = os.path.expanduser("~/workspace/shopee-deal-hunter/.env")
HERE = os.path.dirname(os.path.abspath(__file__))
STATE_PATH = os.path.join(HERE, "billing_guard_state.json")
LOG_PATH = os.path.join(HERE, "billing_guard.log")
OBS_LOG_PATH = os.path.join(HERE, "observability_guard.log")

D1_MAIL_ID = "1accd00a-78dc-445b-ada2-52941f14bdbc"
D1_SMS_ID = "a0af3f0e-bcf5-4098-9905-e86efc3a0ba1"

WORKERS_LIMIT_DAY = 100_000
R2_STORAGE_LIMIT_BYTES = 10 * 1024 * 1024 * 1024  # 10 GB-month
R2_CLASS_A_LIMIT_MONTH = 1_000_000
R2_CLASS_B_LIMIT_MONTH = 10_000_000
D1_STORAGE_LIMIT_BYTES = 5 * 1024 * 1024 * 1024  # 5 GB/account
D1_PER_DB_LIMIT_BYTES = 500 * 1024 * 1024  # 500 MB/DB
D1_READ_LIMIT_DAY = 5_000_000
D1_WRITE_LIMIT_DAY = 100_000
AI_NEURON_LIMIT_DAY = 10_000
OBS_LIMIT_GB = 0.5

# Conservative per-request D1 profile (upper bound, from code audit).
D1_ROWS_READ_PER_REQUEST = 500
D1_ROWS_WRITTEN_PER_REQUEST = 5
# Upper bound neurons per webmail AI call after input truncation (8000 chars).
AI_NEURONS_PER_CALL = 90

WARN_PCT = 60.0
HARD_PCT = 100.0


def read_cf_token() -> str:
    with open(CF_TOKEN_PATH, encoding="utf-8") as f:
        return f.read().strip()


def cf_get(token: str, path: str):
    req = urllib.request.Request(
        "https://api.cloudflare.com/client/v4" + path,
        headers={"Authorization": "Bearer " + token, "User-Agent": "billing-guard/1.0"},
    )
    with urllib.request.urlopen(req, timeout=30) as r:
        return json.load(r)


def cf_graphql(token: str, query: str):
    body = json.dumps({"query": query}).encode()
    req = urllib.request.Request(
        "https://api.cloudflare.com/client/v4/graphql",
        data=body,
        method="POST",
        headers={
            "Authorization": "Bearer " + token,
            "Content-Type": "application/json",
            "User-Agent": "billing-guard/1.0",
        },
    )
    with urllib.request.urlopen(req, timeout=30) as r:
        return json.load(r)


def d1_query(token: str, db_id: str, sql: str):
    """D1 REST query. Returns the parsed JSON even on HTTP 400 (e.g. table
    missing) so the caller can see the real error instead of 'Bad Request'."""
    import urllib.error

    body = json.dumps({"sql": sql}).encode()
    req = urllib.request.Request(
        "https://api.cloudflare.com/client/v4/accounts/%s/d1/database/%s/query"
        % (ACCOUNT_ID, db_id),
        data=body,
        method="POST",
        headers={
            "Authorization": "Bearer " + token,
            "Content-Type": "application/json",
            "User-Agent": "billing-guard/1.0",
        },
    )
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            return json.load(r)
    except urllib.error.HTTPError as e:
        try:
            return json.load(e)
        except Exception:
            return {"success": False, "errors": [{"message": "HTTP %d" % e.code}]}


def tg_config():
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
    body = json.dumps({"chat_id": chat, "text": text, "parse_mode": "HTML"}).encode()
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


def _append_log(line: str) -> None:
    try:
        ts = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
        with open(LOG_PATH, "a", encoding="utf-8") as f:
            f.write("%s %s\n" % (ts, line))
    except Exception:
        pass


def pct(value: float, limit: float) -> float:
    return (value / limit * 100.0) if limit else 0.0


def level_for(p: float) -> str:
    if p >= HARD_PCT:
        return "HARD"
    if p >= WARN_PCT:
        return "WARN"
    return "OK"


def main() -> int:
    now = datetime.now(timezone.utc)
    start = now - timedelta(hours=24)
    today = now.strftime("%Y-%m-%d")
    month_start_ms = int(
        datetime(now.year, now.month, 1, tzinfo=timezone.utc).timestamp() * 1000
    )

    checks = []  # (name, value_str, pct_or_None, level, note)
    errors = []
    token = None
    try:
        token = read_cf_token()
    except Exception as e:
        line = "ERROR could_not_measure token_read_failed %s" % (str(e)[:200],)
        print(line, flush=True)
        _append_log(line)
        return 1

    # --- 1. Workers requests (GraphQL, account-wide, rolling 24h) ---
    try:
        q = (
            "query { viewer { accounts(filter: {accountTag: \"%s\"}) { "
            "workersInvocationsAdaptive(limit: 10, filter: {datetime_geq: \"%s\", "
            "datetime_lt: \"%s\"}) { sum { requests errors } dimensions { scriptName } } } } }"
            % (
                ACCOUNT_ID,
                start.strftime("%Y-%m-%dT%H:%M:%SZ"),
                now.strftime("%Y-%m-%dT%H:%M:%SZ"),
            )
        )
        data = cf_graphql(token, q)
        rows = data["data"]["viewer"]["accounts"][0]["workersInvocationsAdaptive"]
        total_req = sum(int(r["sum"].get("requests") or 0) for r in rows)
        total_err = sum(int(r["sum"].get("errors") or 0) for r in rows)
        per_script = {
            r["dimensions"]["scriptName"]: int(r["sum"].get("requests") or 0)
            for r in rows
        }
        p = pct(total_req, WORKERS_LIMIT_DAY)
        checks.append(
            ("workers_requests", "%d/24h err=%d %s" % (total_req, total_err, per_script), p, level_for(p), "limit 100K/day")
        )
    except Exception as e:
        errors.append("workers_requests: %s" % (str(e)[:150],))

    # --- 2. R2 storage + guard state (D1 r2_usage table) ---
    r2_blocked = False
    try:
        d = d1_query(
            token,
            D1_MAIL_ID,
            "SELECT bytes_total, objects_total, class_a_month, class_a_count, blocked FROM r2_usage WHERE id = 1",
        )
        if not d.get("success"):
            raise RuntimeError(str(d.get("errors"))[:150])
        rows = d["result"][0]["results"]
        if not rows:
            checks.append(("r2_storage", "UNKNOWN (r2_usage empty)", None, "UNKNOWN", "migration 0019 seed missing"))
        else:
            r = rows[0]
            r2_blocked = bool(r.get("blocked"))
            p = pct(float(r["bytes_total"]), R2_STORAGE_LIMIT_BYTES)
            lvl = "HARD" if r2_blocked else level_for(p)
            checks.append(
                ("r2_storage", "%.3f GB (%d objects, blocked=%d)" % (r["bytes_total"] / 1e9, r["objects_total"], r["blocked"]), p, lvl, "limit 10 GB; hard guard fires at 8 GB")
            )
            # Class A ops this month (from the same counter).
            ca = int(r.get("class_a_count") or 0)
            ca_month = str(r.get("class_a_month") or "")
            if ca_month == now.strftime("%Y-%m"):
                p2 = pct(ca, R2_CLASS_A_LIMIT_MONTH)
                checks.append(("r2_class_a", "%d this month" % ca, p2, level_for(p2), "limit 1M/month"))
            else:
                checks.append(("r2_class_a", "UNKNOWN (counter month %s != %s)" % (ca_month, now.strftime("%Y-%m")), None, "UNKNOWN", "limit 1M/month"))
    except Exception as e:
        checks.append(("r2_storage", "UNKNOWN (%s)" % (str(e)[:120],), None, "UNKNOWN", "r2_usage table missing? migration 0019 not applied yet"))

    # --- 3. R2 Class A cross-check: messages created this month (1 PUT each) ---
    try:
        d = d1_query(
            token,
            D1_MAIL_ID,
            "SELECT COUNT(*) AS n FROM messages WHERE date >= %d" % month_start_ms,
        )
        if d.get("success"):
            n = int(d["result"][0]["results"][0]["n"])
            p = pct(n, R2_CLASS_A_LIMIT_MONTH)
            checks.append(("r2_class_a_xcheck", "%d msgs this month (est PUTs)" % n, p, level_for(p), "estimate: 1 R2 PUT per inbound mail"))
    except Exception as e:
        errors.append("r2_class_a_xcheck: %s" % (str(e)[:120],))

    # --- 4. D1 size (list API) ---
    try:
        d = cf_get(token, "/accounts/%s/d1/database" % ACCOUNT_ID)
        if not d.get("success"):
            raise RuntimeError(str(d.get("errors"))[:150])
        total = 0
        worst_p = 0.0
        detail = []
        for b in d.get("result", []):
            size = int(b.get("file_size") or 0)
            total += size
            worst_p = max(worst_p, pct(size, D1_PER_DB_LIMIT_BYTES))
            detail.append("%s=%.2fMB" % (b["name"], size / 1e6))
        p = max(pct(total, D1_STORAGE_LIMIT_BYTES), worst_p)
        checks.append(
            ("d1_storage", "%.2f MB total (%s)" % (total / 1e6, ", ".join(detail)), p, level_for(p), "limit 5 GB/account, 500 MB/DB")
        )
    except Exception as e:
        errors.append("d1_storage: %s" % (str(e)[:150],))

    # --- 5. D1 rows read/written (ESTIMATE from Workers requests) ---
    wr = next((c for c in checks if c[0] == "workers_requests"), None)
    if wr is not None:
        m = re.search(r"^(\d+)/24h", wr[1])
        if m:
            req = int(m.group(1))
            est_read = req * D1_ROWS_READ_PER_REQUEST
            est_write = req * D1_ROWS_WRITTEN_PER_REQUEST
            p = max(pct(est_read, D1_READ_LIMIT_DAY), pct(est_write, D1_WRITE_LIMIT_DAY))
            checks.append(
                ("d1_rows_est", "read~%d write~%d (est)" % (est_read, est_write), p, level_for(p), "ESTIMATE: 500 read + 5 write per request; no API exposes the counters")
            )
    else:
        checks.append(("d1_rows_est", "UNKNOWN (no workers_requests)", None, "UNKNOWN", "needs Workers request count"))

    # --- 6. Workers AI neurons (D1 ai_rate_limits) ---
    try:
        d = d1_query(
            token,
            D1_MAIL_ID,
            "SELECT COALESCE(SUM(calls),0) AS total FROM ai_rate_limits WHERE day = '%s'" % today,
        )
        if not d.get("success"):
            raise RuntimeError(str(d.get("errors"))[:150])
        calls = int(d["result"][0]["results"][0]["total"])
        est_neurons = calls * AI_NEURONS_PER_CALL
        p = pct(est_neurons, AI_NEURON_LIMIT_DAY)
        checks.append(
            ("workers_ai", "%d calls today, ~%d neurons (est)" % (calls, est_neurons), p, level_for(p), "limit 10K neurons/day; code cap 60 calls/day")
        )
    except Exception as e:
        checks.append(("workers_ai", "UNKNOWN (%s)" % (str(e)[:120],), None, "UNKNOWN", "ai_rate_limits table missing? migration 0018 not applied yet"))

    # --- 7. Observability (latest observability_guard.log line) ---
    try:
        est_gb = None
        with open(OBS_LOG_PATH, encoding="utf-8") as f:
            for line in f:
                m = re.search(r"est_gb=([0-9.]+)", line)
                if m:
                    est_gb = float(m.group(1))
        if est_gb is None:
            checks.append(("observability", "UNKNOWN (no est_gb in log)", None, "UNKNOWN", "limit 0.5 GB/day"))
        else:
            p = pct(est_gb, OBS_LIMIT_GB)
            checks.append(("observability", "%.4f GB/day (est)" % est_gb, p, level_for(p), "limit 0.5 GB/day; ingestion pauses at limit"))
    except Exception as e:
        checks.append(("observability", "UNKNOWN (%s)" % (str(e)[:120],), None, "UNKNOWN", "limit 0.5 GB/day"))

    # --- 8. Inventory: new billable resource? ---
    try:
        d = cf_get(token, "/accounts/%s/workers/scripts" % ACCOUNT_ID)
        scripts = sorted(s.get("id") for s in d.get("result", [])) if d.get("success") else []
        d2 = cf_get(token, "/accounts/%s/r2/buckets" % ACCOUNT_ID)
        buckets = sorted(b.get("name") for b in d2.get("result", {}).get("buckets", [])) if d2.get("success") else []
        d3 = cf_get(token, "/accounts/%s/d1/database" % ACCOUNT_ID)
        dbs = sorted(b.get("name") for b in d3.get("result", [])) if d3.get("success") else []
        inventory = {"workers": scripts, "r2_buckets": buckets, "d1_dbs": dbs}
        state = load_state()
        baseline = state.get("inventory")
        if baseline is None:
            state["inventory"] = inventory
            save_state(state)
            checks.append(("inventory", "baseline recorded: %s" % inventory, None, "OK", "first run"))
        elif baseline != inventory:
            checks.append(("inventory", "CHANGED baseline=%s now=%s" % (baseline, inventory), None, "HARD", "new billable resource? review immediately"))
            state["inventory"] = inventory
            save_state(state)
        else:
            checks.append(("inventory", "unchanged: %d workers, %d buckets, %d dbs" % (len(scripts), len(buckets), len(dbs)), None, "OK", "Pages/KV/Logpush/Stream unverifiable with this token"))
    except Exception as e:
        errors.append("inventory: %s" % (str(e)[:150],))

    # --- Summarize ---
    worst = "OK"
    for _name, _val, _p, lvl, _note in checks:
        if lvl == "HARD":
            worst = "HARD"
            break
        if lvl == "WARN":
            worst = "WARN"
    if errors:
        worst = "HARD" if worst == "OK" else worst
        # Core measurement failure is an error, but UNKNOWNs alone are not.
    parts = []
    for name, val, p, lvl, _note in checks:
        pstr = ("%.1f%%" % p) if p is not None else "?"
        parts.append("%s=%s[%s %s]" % (name, val, pstr, lvl))
    line = "date=%s level=%s %s" % (today, worst, " ".join(parts))
    if errors:
        line += " ERRORS: " + "; ".join(errors)
    print(line, flush=True)
    _append_log(line)

    if worst == "OK" and not errors:
        return 0

    # Dedup: once per day per level (HARD beats WARN for the same day).
    state = load_state()
    if state.get("last_alert_date") == today and state.get("last_alert_level") == worst:
        print("ALERT already sent today for level %s, skipping duplicate" % worst)
        return 2
    if worst == "WARN" and state.get("last_alert_date") == today and state.get("last_alert_level") == "HARD":
        print("HARD alert already sent today, skipping WARN duplicate")
        return 2

    msg = "⚠️ Cloudflare billing guard %s (%s):\n" % (worst, today)
    for name, val, p, lvl, note in checks:
        if lvl in ("WARN", "HARD", "UNKNOWN"):
            pstr = ("%.1f%%" % p) if p is not None else "?"
            msg += "- %s: %s (%s) — %s\n" % (name, val, pstr, note)
    if r2_blocked:
        msg += "⛔ RÀO CỨNG R2 ĐÃ KÍCH HOẠT: ghi R2 đang dừng (mail vẫn lưu D1, thiếu file raw). Kiểm tra ngay.\n"
    if errors:
        msg += "Lỗi đo: " + "; ".join(errors) + "\n"
    sent = send_telegram(msg)
    state["last_alert_date"] = today
    state["last_alert_level"] = worst
    save_state(state)
    print("ALERT level=%s telegram_sent=%s" % (worst, sent))
    return 2


if __name__ == "__main__":
    sys.exit(main())
