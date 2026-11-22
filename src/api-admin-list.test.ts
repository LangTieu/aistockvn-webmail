import { api } from './api';
import { afterEach, describe, expect, it, vi } from 'vitest';

afterEach(() => {
  vi.unstubAllGlobals();
});

const cases = [
  { method: () => api.listAdminUsers(), key: 'users' },
  { method: () => api.listAdminDomains(), key: 'domains' },
  { method: () => api.listAdminAliases(), key: 'aliases' },
  { method: () => api.listAuditLogs(), key: 'logs' },
] as const;

describe('admin list API responses', () => {
  it.each(cases)('$key accepts wrapped objects, arrays, and missing keys', async ({ method, key }) => {
    const expected = [{ id: `${key}-item` }];
    const fetchPayload = (payload: unknown) => {
      vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => payload })));
    };

    fetchPayload({ [key]: expected });
    expect(await method()).toEqual(expected);

    fetchPayload(expected);
    expect(await method()).toEqual(expected);

    fetchPayload({});
    expect(await method()).toEqual([]);
  });
});
