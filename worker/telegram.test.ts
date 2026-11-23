import { describe, it, expect, vi } from 'vitest';
import { sendTelegramMessage, TelegramError } from './telegram';

const SYNTHETIC_TOKEN = '123456789:ABCDEFGHIJKLMNOPQRSTUVWXYZ123456';

describe('telegram notifications', () => {
  it('sends expected JSON payload with link_preview_options and protect_content', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ ok: true, result: { message_id: 42 } }), { status: 200 })
    );

    const res = await sendTelegramMessage(
      SYNTHETIC_TOKEN,
      '987654321',
      'Bạn có thư mới',
      fetchMock as unknown as typeof fetch
    );

    expect(res.ok).toBe(true);
    expect(res.messageId).toBe(42);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`https://api.telegram.org/bot${SYNTHETIC_TOKEN}/sendMessage`);
    expect(init.method).toBe('POST');
    expect(JSON.parse(String(init.body))).toEqual({
      chat_id: '987654321',
      text: 'Bạn có thư mới',
      link_preview_options: { is_disabled: true },
      protect_content: true,
    });
  });

  it('maps 429 to retryable TelegramError with retryAfter capped at 3600', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ ok: false, parameters: { retry_after: 120 } }), { status: 429 })
    );

    await expect(
      sendTelegramMessage(SYNTHETIC_TOKEN, '987654321', 'Hello', fetchMock as unknown as typeof fetch)
    ).rejects.toMatchObject({
      code: 'telegram_rate_limited',
      retryable: true,
      retryAfter: 120,
    });
  });

  it('maps 403 to non-retryable telegram_forbidden error', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('Forbidden', { status: 403 }));

    await expect(
      sendTelegramMessage(SYNTHETIC_TOKEN, '987654321', 'Hello', fetchMock as unknown as typeof fetch)
    ).rejects.toMatchObject({
      code: 'telegram_forbidden',
      retryable: false,
    });
  });

  it('rejects malformed token before calling fetch', async () => {
    const fetchMock = vi.fn();

    await expect(
      sendTelegramMessage('bad-token', '987654321', 'Hello', fetchMock as unknown as typeof fetch)
    ).rejects.toBeInstanceOf(TelegramError);

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rejects text longer than 4096 characters before calling fetch', async () => {
    const fetchMock = vi.fn();
    const tooLong = 'a'.repeat(4097);

    await expect(
      sendTelegramMessage(SYNTHETIC_TOKEN, '987654321', tooLong, fetchMock as unknown as typeof fetch)
    ).rejects.toMatchObject({
      code: 'telegram_invalid_text',
      retryable: false,
    });

    expect(fetchMock).not.toHaveBeenCalled();
  });
});
