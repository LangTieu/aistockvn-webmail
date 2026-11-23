#!/usr/bin/env python3
"""Small standard-library CLI for the AI Stock VN webmail API."""

import argparse
import json
import os
import sys
import time
import urllib.parse
from datetime import datetime, timezone

try:
    import requests
except ImportError:
    requests = None


DEFAULT_BASE_URL = "https://mail.aistockvn.com"
MAX_RETRIES = 3


class CliError(Exception):
    pass


def request_api(base_url, key, path, method="GET", payload=None):
    if requests is None:
        raise CliError("Thiếu thư viện requests — chạy: pip install requests")
    # Cloudflare Browser Integrity Check chặn User-Agent mặc định của Python
    # (Python-urllib -> 403 error 1010), nên phải đặt User-Agent riêng.
    # requests ổn định hơn urllib qua proxy egress MITM của sandbox (urllib hay
    # bị cắt kết nối giữa chừng — IncompleteRead/RemoteDisconnected).
    headers = {"X-Api-Key": key, "Accept": "application/json", "User-Agent": "mailcli/1.0"}
    if payload is not None:
        headers["Content-Type"] = "application/json"
        headers["X-Mail-Client"] = "1"
    url = base_url.rstrip("/") + path
    last_error = None
    for attempt in range(MAX_RETRIES):
        try:
            resp = requests.request(method, url, headers=headers, json=payload, timeout=30)
            if resp.status_code == 401:
                raise CliError("API key không đúng hoặc chưa nạp, kiểm tra file key và secret MAIL_API_KEY")
            if resp.status_code >= 400:
                try:
                    body = resp.json()
                    message = body.get("error") or body.get("message") or resp.text
                except ValueError:
                    message = resp.text or f"HTTP {resp.status_code}"
                raise CliError(f"Lỗi từ server ({resp.status_code}): {message}")
            return resp.json()
        except CliError:
            raise
        except requests.RequestException as exc:
            last_error = exc
        if attempt < MAX_RETRIES - 1:
            time.sleep(1 + attempt)
    raise CliError(f"Lỗi mạng: {last_error}")


def load_key(path):
    try:
        with open(path, "r", encoding="utf-8") as key_file:
            key = key_file.read().strip()
    except FileNotFoundError:
        raise CliError(f"Không tìm thấy file API key: {path}")
    except OSError as exc:
        raise CliError(f"Không đọc được file API key {path}: {exc}")
    if not key:
        raise CliError(f"File API key rỗng: {path}")
    return key


def short_id(message):
    return str(message.get("id", ""))[:8]


def date_text(value):
    try:
        stamp = float(value)
        if stamp > 10_000_000_000:
            stamp /= 1000
        return datetime.fromtimestamp(stamp, timezone.utc).astimezone().strftime("%Y-%m-%d %H:%M")
    except (TypeError, ValueError, OSError, OverflowError):
        return str(value or "-")


def one_line(message):
    sender = message.get("from") or {}
    if isinstance(sender, dict):
        sender = sender.get("name") or sender.get("address") or ""
    status = "đã đọc" if message.get("isRead") else "chưa đọc"
    subject = str(message.get("subject") or "(không có tiêu đề)").replace("\n", " ")
    return f"{short_id(message):8}  {date_text(message.get('date'))}  {sender}  {subject}  [{status}]"


def list_messages(base_url, key, folder, limit):
    query = urllib.parse.urlencode({"folder": folder, "limit": limit})
    result = request_api(base_url, key, "/api/messages?" + query)
    return result.get("items", [])


def resolve_id(base_url, key, supplied):
    if len(supplied) > 8:
        return supplied
    matches = []
    for folder in ("inbox", "sent"):
        for message in list_messages(base_url, key, folder, 100):
            if str(message.get("id", "")).startswith(supplied):
                matches.append(str(message["id"]))
    matches = sorted(set(matches))
    if not matches:
        raise CliError(f"Mail không tìm thấy với id: {supplied}")
    if len(matches) > 1:
        raise CliError(f"Id {supplied} không duy nhất; hãy dùng id đầy đủ")
    return matches[0]


def run(args, key):
    if args.command in ("inbox", "sent"):
        folder = args.command
        for message in list_messages(args.base_url, key, folder, args.limit):
            print(one_line(message))
        return
    if args.command == "read":
        message_id = resolve_id(args.base_url, key, args.id)
        message = request_api(args.base_url, key, "/api/messages/" + urllib.parse.quote(message_id, safe=""))
        sender = message.get("from") or {}
        sender = sender.get("address", "") if isinstance(sender, dict) else sender
        recipients = message.get("to") or []
        recipients = ", ".join(r.get("address", "") if isinstance(r, dict) else str(r) for r in recipients)
        print(f"From: {sender}\nTo: {recipients}\nSubject: {message.get('subject', '')}\nDate: {date_text(message.get('date'))}\n\n{message.get('text') or ''}")
        return
    if args.command == "send":
        payload = {"to": args.to, "subject": args.subject, "text": args.text}
        if args.cc:
            payload["cc"] = args.cc
        if args.from_alias:
            payload["from"] = args.from_alias
        result = request_api(args.base_url, key, "/api/send", method="POST", payload=payload)
        sent_id = result.get("id") or (result.get("message") or {}).get("id") or result.get("messageId")
        print(f"Đã gửi mail: {sent_id or 'OK'}")
        return
    if args.command == "search":
        query = urllib.parse.urlencode({"q": args.query, "limit": args.limit})
        result = request_api(args.base_url, key, "/api/search?" + query)
        for message in result.get("items", []):
            print(one_line(message))
        return
    if args.command == "unread":
        before = None
        unread = []
        while True:
            params = {"folder": "inbox", "limit": 100}
            if before is not None:
                params["before"] = before
            result = request_api(args.base_url, key, "/api/messages?" + urllib.parse.urlencode(params))
            items = result.get("items", [])
            unread.extend(item for item in items if not item.get("isRead"))
            before = result.get("nextBefore")
            if not before or not items:
                break
        print(f"Chưa đọc: {len(unread)}")
        for message in unread[:20]:
            print(one_line(message))
        return
    if args.command == "status":
        request_api(args.base_url, key, "/api/messages?limit=1")
        print("OK: API key hoạt động")


def make_parser():
    parser = argparse.ArgumentParser(description="CLI điều khiển webmail qua API")
    parser.add_argument("--key-file", default=os.path.expanduser("~/.webmail_api_key"), help="file chứa API key")
    parser.add_argument("--base-url", default=DEFAULT_BASE_URL, help="địa chỉ webmail API")
    sub = parser.add_subparsers(dest="command", required=True)
    for name in ("inbox", "sent"):
        cmd = sub.add_parser(name)
        cmd.add_argument("--limit", type=int, default=30)
    cmd = sub.add_parser("read")
    cmd.add_argument("id")
    cmd = sub.add_parser("send")
    cmd.add_argument("--to", required=True)
    cmd.add_argument("--subject", required=True)
    cmd.add_argument("--text", required=True)
    cmd.add_argument("--cc")
    cmd.add_argument("--from", dest="from_alias")
    cmd = sub.add_parser("search")
    cmd.add_argument("query")
    cmd.add_argument("--limit", type=int, default=30)
    sub.add_parser("unread")
    sub.add_parser("status")
    return parser


def main():
    args = make_parser().parse_args()
    try:
        run(args, load_key(args.key_file))
    except CliError as exc:
        print(str(exc), file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
