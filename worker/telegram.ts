import { TELEGRAM_CHAT_ID_RE } from './notifications';

export const TELEGRAM_TOKEN_RE = /^\d{5,20}:[A-Za-z0-9_-]{20,200}$/;
export const TELEGRAM_MAX_TEXT_LEN = 4096;
export const TELEGRAM_MAX_RETRY_AFTER_SEC = 3600;

export class TelegramError extends Error {
  code: string;
  retryable: boolean;
  retryAfter?: number;

  constructor(code: string, retryable: boolean, message: string, retryAfter?: number) {
    super(message);
    this.name = 'TelegramError';
    this.code = code;
    this.retryable = retryable;
    if (retryAfter !== undefined) {
      this.retryAfter = retryAfter;
    }
  }
}

export async function sendTelegramMessage(
  token: string,
  chatId: string,
  text: string,
  fetchImpl: typeof fetch = fetch
): Promise<{ ok: true; messageId?: number }> {
  if (typeof token !== 'string' || !TELEGRAM_TOKEN_RE.test(token)) {
    throw new TelegramError('telegram_invalid_token', false, 'Invalid Telegram bot token format');
  }
  if (typeof chatId !== 'string' || !TELEGRAM_CHAT_ID_RE.test(chatId)) {
    throw new TelegramError('telegram_invalid_chat_id', false, 'Invalid Telegram chat ID format');
  }
  if (typeof text !== 'string' || text.length < 1 || text.length > TELEGRAM_MAX_TEXT_LEN) {
    throw new TelegramError(
      'telegram_invalid_text',
      false,
      `Telegram message text must be between 1 and ${TELEGRAM_MAX_TEXT_LEN} characters`
    );
  }

  const url = `https://api.telegram.org/bot${token}/sendMessage`;
  const body = JSON.stringify({
    chat_id: chatId,
    text,
    link_preview_options: { is_disabled: true },
    protect_content: true,
  });

  let resp: Response;
  try {
    resp = await fetchImpl(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
      signal: AbortSignal.timeout(10_000),
    });
  } catch {
    throw new TelegramError('telegram_network', true, 'Telegram API network or timeout error');
  }

  if (resp.ok) {
    let messageId: number | undefined;
    try {
      const data = (await resp.json()) as { result?: { message_id?: number } };
      messageId = data?.result?.message_id;
    } catch {
      // Ignore JSON parse issues on 2xx
    }
    return { ok: true, messageId };
  }

  if (resp.status === 429) {
    let retryAfter = 60;
    try {
      const data = (await resp.json()) as { parameters?: { retry_after?: number } };
      if (typeof data?.parameters?.retry_after === 'number' && data.parameters.retry_after > 0) {
        retryAfter = data.parameters.retry_after;
      }
    } catch {
      const hdr = resp.headers?.get?.('Retry-After');
      if (hdr) {
        const parsed = Number(hdr);
        if (Number.isFinite(parsed) && parsed > 0) retryAfter = parsed;
      }
    }
    const clamped = Math.min(TELEGRAM_MAX_RETRY_AFTER_SEC, Math.max(1, Math.ceil(retryAfter)));
    throw new TelegramError(
      'telegram_rate_limited',
      true,
      'Telegram API rate limited',
      clamped
    );
  }

  if (resp.status === 403) {
    throw new TelegramError(
      'telegram_forbidden',
      false,
      'Telegram bot was blocked or chat is forbidden'
    );
  }

  if (resp.status >= 500) {
    throw new TelegramError(
      'telegram_server',
      true,
      `Telegram API server error (${resp.status})`
    );
  }

  throw new TelegramError(
    'telegram_bad_request',
    false,
    `Telegram API rejected request (${resp.status})`
  );
}
