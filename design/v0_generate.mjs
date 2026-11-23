#!/usr/bin/env node
// Gửi design/v0-prompt.md lên v0 Platform API (POST https://api.v0.dev/v1/chats) và lưu mã sinh ra
// vào design/v0-output/. Key chỉ đọc từ file (mặc định ~/.v0_api_key, 0600) — không bao giờ in ra.
// Dùng: node design/v0_generate.mjs [đường-dẫn-file-key]
// Chế độ async + poll: responseMode "sync" giữ một kết nối mở ~5 phút và bị proxy egress
// cắt giữa chừng (UND_ERR_SOCKET, 2 lần 17/11). Bản này tạo chat rồi poll ngắn từng lần.
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const keyPath = process.argv[2] || join(homedir(), ".v0_api_key");
const key = readFileSync(keyPath, "utf8").trim();
const prompt = readFileSync(join(here, "v0-prompt.md"), "utf8").split("---").slice(1).join("---").trim();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const res = await fetch("https://api.v0.dev/v1/chats", {
  method: "POST",
  headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
  body: JSON.stringify({ message: prompt }),
});
const data = await res.json().catch(() => ({}));
if (!res.ok) {
  console.error(`v0 API lỗi HTTP ${res.status}: ${JSON.stringify(data).slice(0, 500)}`);
  process.exit(1);
}
const chatId = data.id;
console.log(`v0 chat: ${data.webUrl || chatId}`);

// Poll ngắn từng lần cho tới khi xong (tối đa ~12 phút).
let latest = data.latestVersion || {};
for (let i = 0; i < 36; i++) {
  const status = latest.status || "pending";
  console.log(`poll ${i + 1}/36: ${status}`);
  if (status === "completed") break;
  if (status === "failed") {
    console.error(`v0 generation failed: ${JSON.stringify(latest).slice(0, 500)}`);
    process.exit(1);
  }
  await sleep(20000);
  const r = await fetch(`https://api.v0.dev/v1/chats/${chatId}`, {
    headers: { Authorization: `Bearer ${key}` },
  });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) {
    console.error(`v0 poll lỗi HTTP ${r.status}: ${JSON.stringify(d).slice(0, 300)}`);
    process.exit(1);
  }
  latest = d.latestVersion || latest;
  if (d.webUrl) data.webUrl = d.webUrl;
}
if ((latest.status || "") !== "completed") {
  console.error(`v0 chưa xong sau 12 phút (status: ${latest.status}). Chat: ${data.webUrl || chatId}`);
  process.exit(2);
}

const out = join(here, "v0-output");
mkdirSync(out, { recursive: true });
const files = latest.files || [];
for (const f of files) {
  const p = join(out, f.name);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, f.content);
}
writeFileSync(
  join(out, "chat.json"),
  JSON.stringify({ id: chatId, webUrl: data.webUrl, demo: latest.demoUrl, files: files.map((f) => f.name) }, null, 2),
);
console.log(`v0 chat: ${data.webUrl || chatId}`);
console.log(`demo: ${latest.demoUrl || "(chưa có)"}`);
console.log(`${files.length} tệp → ${out}`);
