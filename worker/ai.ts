import { type Env } from "./mail";

const RETRY_DELAY_MS = 1000;

// Workers AI guardrail (20/11/2026): the account's free allocation is
// 10,000 neurons/day, shared by the webmail AI and the Qoder/router leg.
// gpt-oss-120b costs 31,818 neurons/M input tokens + 68,182/M output
// tokens, so one call is at most ~90 neurons after input truncation.
// The global cap of 60 calls/day bounds the webmail to ~5,400 neurons/day
// worst case and stops a runaway loop from starving the daily pool.
// Over the cap the caller gets a clear "daily limit reached" error.
// The check FAILS OPEN: any D1/table error must not block AI, because the
// cap is a safety net, not a dependency (over the 10,000-neuron allocation
// the Workers AI API itself returns 429, which withRetry already handles).
const MAX_AI_CALLS_PER_DAY = 60;
const MAX_AI_INPUT_CHARS = 8000;

function todayKey(): string {
  return new Date().toISOString().slice(0, 10); // YYYY-MM-DD (UTC)
}

function truncateInput(text: string): string {
  return text.length > MAX_AI_INPUT_CHARS ? text.slice(0, MAX_AI_INPUT_CHARS) : text;
}

async function checkAiRateLimit(env: Env): Promise<void> {
  if (!env.DB) return; // no DB (tests without one) -> allow
  try {
    const day = todayKey();
    const row = await env.DB.prepare(
      "SELECT calls FROM ai_rate_limits WHERE scope = ? AND day = ?",
    )
      .bind("global", day)
      .first<{ calls: number }>();
    const calls = typeof row?.calls === "number" ? row.calls : 0;
    if (calls >= MAX_AI_CALLS_PER_DAY) {
      throw new Error("AI daily limit reached (60 calls/day), please try again tomorrow");
    }
    if (row) {
      await env.DB.prepare(
        "UPDATE ai_rate_limits SET calls = calls + 1 WHERE scope = ? AND day = ?",
      )
        .bind("global", day)
        .run();
    } else {
      await env.DB.prepare(
        "INSERT INTO ai_rate_limits (scope, day, calls) VALUES (?, ?, 1)",
      )
        .bind("global", day)
        .run();
    }
  } catch (e) {
    if (e instanceof Error && e.message.startsWith("AI daily limit reached")) throw e;
    // Any D1/table error -> fail open (allow the call).
  }
}

async function withRetry<T>(
  fn: () => Promise<T>,
  onRetry?: (error: Error) => void,
): Promise<T> {
  try {
    return await fn();
  } catch (error: any) {
    const msg = error.message || String(error);
    const status = error.status ?? error.statusCode;
    if (status === 429 || status === 503 || msg.includes("429") || msg.includes("503")) {
      if (onRetry) onRetry(error);
      await new Promise((r) => setTimeout(r, RETRY_DELAY_MS));
      try {
        return await fn();
      } catch (secondError: any) {
        if (onRetry) onRetry(secondError);
        throw new Error(
          "AI is temporarily unavailable, please try again later",
        );
      }
    }
    throw error;
  }
}

export async function summarizeText(env: Env, text: string): Promise<string> {
  const ai = env.AI;
  if (!ai) {
    throw new Error("AI is not configured on the server");
  }
  if (!text || text.trim() === "") {
    return "";
  }
  await checkAiRateLimit(env);
  const input = truncateInput(text);
  return withRetry(
    async () => {
      const out = await ai.run("@cf/openai/gpt-oss-120b", {
        messages: [
          {
            role: "system",
            content:
              "You are a helpful assistant. Provide a short English summary (2-3 sentences or 3-5 bullets) of the following email text.",
          },
          { role: "user", content: input },
        ],
      });
      const textOut = typeof out === "string" ? out : (out as { response?: unknown } | null | undefined)?.response;
      return typeof textOut === "string" ? textOut.trim() : "";
    },
    (err) => {
      // silently retry; no logging of message bodies
    },
  );
}

export async function draftReply(
  env: Env,
  opts: { subject: string; from: string; text: string },
): Promise<string> {
  const ai = env.AI;
  if (!ai) {
    throw new Error("AI is not configured on the server");
  }
  await checkAiRateLimit(env);
  const input = truncateInput(opts.text);
  return withRetry(
    async () => {
      const out = await ai.run("@cf/openai/gpt-oss-120b", {
        messages: [
          {
            role: "system",
            content:
              "You are a helpful assistant. Write a polite, professional English reply draft based on the original message below. Keep it concise and business-appropriate.",
          },
          {
            role: "user",
            content: `Subject: ${opts.subject}\nFrom: ${opts.from}\n\n${input}`,
          },
        ],
      });
      const textOut = typeof out === "string" ? out : (out as { response?: unknown } | null | undefined)?.response;
      return typeof textOut === "string" ? textOut.trim() : "";
    },
    (err) => {
      // silently retry; no logging of message bodies
    },
  );
}