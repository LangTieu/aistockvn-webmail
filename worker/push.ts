import { deletePushSubscriptionByEndpoint } from './notifications';

export interface PushSubscriptionData {
  endpoint: string;
  p256dh: string;
  auth: string;
}

export class PushError extends Error {
  status: number;
  code: string;
  retryable: boolean;

  constructor(status: number, code: string, retryable: boolean, message: string) {
    super(message);
    this.name = 'PushError';
    this.status = status;
    this.code = code;
    this.retryable = retryable;
  }
}

function base64UrlEncode(bytes: Uint8Array): string {
  let bin = '';
  for (let i = 0; i < bytes.length; i++) {
    bin += String.fromCharCode(bytes[i]);
  }
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function encodeJsonBase64Url(obj: Record<string, unknown>): string {
  const bytes = new TextEncoder().encode(JSON.stringify(obj));
  return base64UrlEncode(bytes);
}

export function validatePushSubscriptionInput(
  input: Partial<PushSubscriptionData> | null | undefined
): PushSubscriptionData {
  if (!input || typeof input !== 'object') {
    throw new PushError(400, 'invalid_subscription', false, 'Subscription payload is required');
  }
  const endpoint = typeof input.endpoint === 'string' ? input.endpoint.trim() : '';
  const p256dh = typeof input.p256dh === 'string' ? input.p256dh.trim() : '';
  const auth = typeof input.auth === 'string' ? input.auth.trim() : '';

  if (!endpoint) {
    throw new PushError(400, 'invalid_subscription', false, 'Missing push subscription endpoint');
  }
  let parsedUrl: URL;
  try {
    parsedUrl = new URL(endpoint);
  } catch {
    throw new PushError(400, 'invalid_subscription', false, 'Invalid push subscription endpoint URL');
  }
  if (parsedUrl.protocol !== 'https:') {
    throw new PushError(400, 'invalid_subscription', false, 'Push endpoint must use HTTPS');
  }
  if (!p256dh) {
    throw new PushError(400, 'invalid_subscription', false, 'Missing push subscription p256dh key');
  }
  if (!auth) {
    throw new PushError(400, 'invalid_subscription', false, 'Missing push subscription auth secret');
  }

  return { endpoint, p256dh, auth };
}

function parsePrivateKeyJwk(privateKeyJwk: JsonWebKey | string): JsonWebKey {
  if (typeof privateKeyJwk === 'string') {
    try {
      return JSON.parse(privateKeyJwk) as JsonWebKey;
    } catch {
      throw new PushError(500, 'invalid_vapid_key', false, 'Invalid VAPID private key JWK');
    }
  }
  return privateKeyJwk;
}

export async function vapidHeaders(
  audience: string,
  subject: string,
  privateKeyJwk: JsonWebKey | string,
  publicKeyBase64Url?: string,
  nowSec: number = Math.floor(Date.now() / 1000)
): Promise<{ Authorization: string }> {
  const jwk = parsePrivateKeyJwk(privateKeyJwk);
  const cryptoKey = await crypto.subtle.importKey(
    'jwk',
    jwk,
    { name: 'ECDSA', namedCurve: 'P-256' },
    false,
    ['sign']
  );

  const headerB64 = encodeJsonBase64Url({ typ: 'JWT', alg: 'ES256' });
  const payloadB64 = encodeJsonBase64Url({
    aud: audience,
    exp: nowSec + 12 * 3600,
    sub: subject,
  });

  const signingInput = `${headerB64}.${payloadB64}`;
  const signatureBuf = await crypto.subtle.sign(
    { name: 'ECDSA', hash: 'SHA-256' },
    cryptoKey,
    new TextEncoder().encode(signingInput)
  );
  const sigB64 = base64UrlEncode(new Uint8Array(signatureBuf));
  const jwt = `${signingInput}.${sigB64}`;

  const authValue = publicKeyBase64Url ? `vapid t=${jwt}, k=${publicKeyBase64Url}` : `vapid t=${jwt}`;
  return { Authorization: authValue };
}

export async function sendPush(
  subscription: PushSubscriptionData,
  _payload: unknown,
  vapidPublicKey: string,
  privateKeyJwk: JsonWebKey | string,
  options?: {
    subject?: string;
    fetchImpl?: typeof fetch;
    db?: D1Database;
  }
): Promise<{ ok: boolean; status: number; gone?: boolean }> {
  const validSub = validatePushSubscriptionInput(subscription);
  const audience = new URL(validSub.endpoint).origin;
  const subject = options?.subject ?? 'mailto:admin@aistockvn.com';
  const fetchImpl = options?.fetchImpl ?? fetch;

  const { Authorization } = await vapidHeaders(
    audience,
    subject,
    privateKeyJwk,
    vapidPublicKey
  );

  let resp: Response;
  try {
    resp = await fetchImpl(validSub.endpoint, {
      method: 'POST',
      headers: {
        Authorization,
        TTL: '86400',
        Urgency: 'normal',
      },
    });
  } catch {
    throw new PushError(503, 'push_network', true, 'Push delivery network error');
  }

  if (resp.status >= 200 && resp.status < 300) {
    return { ok: true, status: resp.status };
  }

  if (resp.status === 404 || resp.status === 410) {
    if (options?.db) {
      await deletePushSubscriptionByEndpoint(options.db, validSub.endpoint);
    }
    return { ok: false, status: resp.status, gone: true };
  }

  if (resp.status === 429 || resp.status >= 500) {
    throw new PushError(resp.status, 'push_server', true, `Push service returned ${resp.status}`);
  }

  throw new PushError(resp.status, 'push_rejected', false, `Push service rejected request (${resp.status})`);
}
