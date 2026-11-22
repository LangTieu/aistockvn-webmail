import { describe, it, expect, vi } from 'vitest';
import { vapidHeaders, sendPush, validatePushSubscriptionInput, PushError } from './push';

function base64UrlDecodeToString(b64u: string): string {
  const pad = '='.repeat((4 - (b64u.length % 4)) % 4);
  const b64 = (b64u + pad).replace(/-/g, '+').replace(/_/g, '/');
  return atob(b64);
}

describe('web push & VAPID', () => {
  it('generates a 3-part VAPID JWT with ES256 header', async () => {
    const keyPair = (await crypto.subtle.generateKey(
      { name: 'ECDSA', namedCurve: 'P-256' },
      true,
      ['sign', 'verify']
    )) as CryptoKeyPair;
    const privateJwk = (await crypto.subtle.exportKey('jwk', keyPair.privateKey)) as JsonWebKey;
    const samplePub =
      'BE7gLUIIkv8mAu3p2eG2DfpffV7EPcQZGr2fA-l5B3BRhcaUn6rCGV80be21mNxKnqnT9B76TijKNn4kApmxQ64';

    const { Authorization } = await vapidHeaders(
      'https://fcm.googleapis.com',
      'mailto:admin@aistockvn.com',
      privateJwk,
      samplePub,
      1_700_000_000
    );

    expect(Authorization.startsWith('vapid t=')).toBe(true);
    const tokenPart = Authorization.split('vapid t=')[1].split(',')[0];
    const parts = tokenPart.split('.');
    expect(parts).toHaveLength(3);

    const header = JSON.parse(base64UrlDecodeToString(parts[0])) as { alg: string; typ: string };
    expect(header.alg).toBe('ES256');
    expect(header.typ).toBe('JWT');
  });

  it('deletes subscription when push endpoint returns 404', async () => {
    const keyPair = (await crypto.subtle.generateKey(
      { name: 'ECDSA', namedCurve: 'P-256' },
      true,
      ['sign', 'verify']
    )) as CryptoKeyPair;
    const privateJwk = (await crypto.subtle.exportKey('jwk', keyPair.privateKey)) as JsonWebKey;

    const deletedEndpoints: string[] = [];
    const mockDb = {
      prepare(sql: string) {
        let bound: unknown[] = [];
        return {
          bind(...args: unknown[]) {
            bound = args;
            return this;
          },
          async run() {
            if (sql.includes('DELETE FROM push_subscriptions')) {
              deletedEndpoints.push(String(bound[0]));
              return { meta: { changes: 1 } };
            }
            return { meta: { changes: 0 } };
          },
        };
      },
    } as unknown as D1Database;

    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 404 }));
    const endpoint = 'https://push.example.com/sub/expired-1';

    const res = await sendPush(
      { endpoint, p256dh: 'test-p256dh', auth: 'test-auth' },
      null,
      'BE7gLUIIkv8mAu3p2eG2DfpffV7EPcQZGr2fA-l5B3BRhcaUn6rCGV80be21mNxKnqnT9B76TijKNn4kApmxQ64',
      privateJwk,
      { fetchImpl: fetchMock as unknown as typeof fetch, db: mockDb }
    );

    expect(res.ok).toBe(false);
    expect(res.status).toBe(404);
    expect(res.gone).toBe(true);
    expect(deletedEndpoints).toEqual([endpoint]);
  });

  it('rejects subscription missing auth with 400 PushError', () => {
    expect(() =>
      validatePushSubscriptionInput({
        endpoint: 'https://push.example.com/sub/1',
        p256dh: 'valid-key',
        auth: '',
      })
    ).toThrow(PushError);

    try {
      validatePushSubscriptionInput({
        endpoint: 'https://push.example.com/sub/1',
        p256dh: 'valid-key',
      });
    } catch (err) {
      expect(err).toBeInstanceOf(PushError);
      expect((err as PushError).status).toBe(400);
    }
  });
});
