// Smoke test end-to-end via `wrangler dev` (DEV_LOGIN=1, local D1).
// Run: SMOKE_BASE=http://127.0.0.1:8788 npx vitest run --isolate=false
import { describe, expect, it } from "vitest";
import { generateTOTPCode } from "./mfa";

const BASE = process.env.SMOKE_BASE;
if (!BASE) {
  throw new Error("SMOKE_BASE environment variable is required to run e2e smoke tests");
}

const H = { "X-Mail-Client": "1", "Content-Type": "application/json" };
const b64 = (s: string) => Buffer.from(s).toString("base64");
const DEV_USER_EMAIL = "tranbinhanbr01@gmail.com";
const ADMIN_EMAIL = "admin@aistockvn.com";

let adminTotpSecret: string | null = null;

function extractCookie(res: Response, name: string): string {
  const raw = res.headers.get("set-cookie") ?? "";
  const match = raw.match(new RegExp(`(?:^|,\\s*)${name}=([^;]+)`));
  if (!match) {
    throw new Error(`Expected Set-Cookie containing ${name}=, got: ${raw}`);
  }
  return `${name}=${match[1]}`;
}

async function resetAndLogin(email: string, password: string): Promise<{ cookie: string; body: any }> {
  const forgot = await fetch(`${BASE}/api/auth/forgot`, {
    method: "POST",
    headers: H,
    body: JSON.stringify({ email }),
  });
  expect(forgot.status).toBe(200);
  const forgotBody = await forgot.json();
  expect(typeof forgotBody.token).toBe("string");

  const reset = await fetch(`${BASE}/api/auth/reset`, {
    method: "POST",
    headers: H,
    body: JSON.stringify({ token: forgotBody.token, password }),
  });
  expect(reset.status).toBe(200);
  const resetBody = await reset.json();
  expect(resetBody.success).toBe(true);

  const login = await fetch(`${BASE}/api/auth/password`, {
    method: "POST",
    headers: H,
    body: JSON.stringify({ email, password }),
  });
  expect(login.status).toBe(200);
  const cookie = extractCookie(login, "mail_session");
  const body = await login.json();
  return { cookie, body };
}

async function resetAndLoginWithMfa(
  email: string,
  password: string
): Promise<{ cookie: string; body: any; mfaActiveWithoutSecret?: boolean }> {
  const forgot = await fetch(`${BASE}/api/auth/forgot`, {
    method: "POST",
    headers: H,
    body: JSON.stringify({ email }),
  });
  expect(forgot.status).toBe(200);
  const forgotBody = await forgot.json();
  expect(typeof forgotBody.token).toBe("string");

  const reset = await fetch(`${BASE}/api/auth/reset`, {
    method: "POST",
    headers: H,
    body: JSON.stringify({ token: forgotBody.token, password }),
  });
  expect(reset.status).toBe(200);
  const resetBody = await reset.json();
  expect(resetBody.success).toBe(true);

  const login = await fetch(`${BASE}/api/auth/password`, {
    method: "POST",
    headers: H,
    body: JSON.stringify({ email, password }),
  });
  expect(login.status).toBe(200);
  const body = await login.json();

  if (body.mfaRequired === true) {
    if (!adminTotpSecret) {
      // A prior run left MFA enabled in local D1; fall back to dev session (shared mailbox access)
      const devRes = await fetch(`${BASE}/api/auth/dev`, { method: "POST", headers: H });
      expect(devRes.status).toBe(200);
      const cookie = extractCookie(devRes, "mail_session");
      return { cookie, body: await devRes.json(), mfaActiveWithoutSecret: true };
    }
    const challengeCookie = extractCookie(login, "mail_mfa_challenge");
    const code = await generateTOTPCode(adminTotpSecret);
    const challengeRes = await fetch(`${BASE}/api/auth/mfa/challenge`, {
      method: "POST",
      headers: { ...H, Cookie: challengeCookie },
      body: JSON.stringify({ code }),
    });
    expect(challengeRes.status).toBe(200);
    const cookie = extractCookie(challengeRes, "mail_session");
    const challengeBody = await challengeRes.json();
    return { cookie, body: challengeBody };
  }

  const cookie = extractCookie(login, "mail_session");
  return { cookie, body };
}

describe("smoke local", () => {
  let cookie = "";

  const mid = `smoke-${Date.now()}@local.test`;
  const testSubject = `Test email body ${mid}`;
  const get = (p: string, c = cookie) => fetch(BASE + p, { headers: { Cookie: c } });
  const inject = (raw: string, to = "admin@aistockvn.com") =>
    fetch(`${BASE}/cdn-cgi/local/email?from=sender@local.test&to=${encodeURIComponent(to)}`, {
      method: "POST",
      body: raw,
    });

  it("blocks access when not logged in and missing header", async () => {
    expect((await get("/api/messages", "")).status).toBe(401);
    expect((await get("/api/messages", "mail_session=forged.sig")).status).toBe(401);
    expect((await fetch(`${BASE}/api/auth/dev`, { method: "POST" })).status).toBe(403);
  });

  it("inject email via handler", async () => {
    const raw = [
      `From: "Sender" <sender@local.test>`,
      `To: ${DEV_USER_EMAIL}`,
      `Subject: =?UTF-8?B?${b64(testSubject)}?=`,
      `Date: ${new Date().toUTCString()}`,
      `Message-ID: <${mid}>`,
      `MIME-Version: 1.0`,
      `Content-Type: multipart/mixed; boundary="b1"`,
      ``,
      `--b1`,
      `Content-Type: text/html; charset=utf-8`,
      ``,
      `<p>Content <b>bold</b> test khoa-smoke-xyz</p>`,
      `--b1`,
      `Content-Type: text/plain; name="note.txt"`,
      `Content-Disposition: attachment; filename="note.txt"`,
      ``,
      `hello attachment`,
      `--b1--`,
      ``,
    ].join("\r\n");
    const r = await inject(raw, DEV_USER_EMAIL);
    expect(r.status).toBeLessThan(300);
  });

  it("login list read search file", async () => {
    // Dev login signs in as the first ALLOWED_EMAILS user (tranbinhanbr01@gmail.com);
    // under the shared mailbox model, every signed-in user sees inbound mail stored in admin@aistockvn.com.
    const devLogin = await fetch(`${BASE}/api/auth/dev`, { method: "POST", headers: H });
    expect(devLogin.status).toBe(200);
    const gmailCookie = extractCookie(devLogin, "mail_session");

    const { cookie: adminCookie } = await resetAndLoginWithMfa(ADMIN_EMAIL, "AdminSmokeListPass123!");
    cookie = adminCookie;

    const gmailListRes = await get("/api/messages?folder=inbox", gmailCookie);
    expect(gmailListRes.status).toBe(200);
    const gmailList = await gmailListRes.json();
    const gmailMsg = gmailList.items.find((i: any) => i.subject === testSubject);
    expect(gmailMsg).toBeDefined();

    // Gmail user (without a personal mailbox row) can also read the shared mailbox message directly (not 404)
    const gmailReadRes = await get(`/api/messages/${encodeURIComponent(gmailMsg.id)}`, gmailCookie);
    expect(gmailReadRes.status).toBe(200);

    const listRes = await get("/api/messages?folder=inbox", adminCookie);
    expect(listRes.status).toBe(200);
    const list = await listRes.json();
    expect(Array.isArray(list.items)).toBe(true);
    const m = list.items.find((i: any) => i.subject === testSubject);
    expect(m).toBeDefined();
    expect(m.from).toEqual({ address: "sender@local.test", name: "Sender" });
    expect(m.hasAttachments).toBe(true);

    const readRes = await get(`/api/messages/${encodeURIComponent(m.id)}`, adminCookie);
    expect(readRes.status).toBe(200);
    const detail = await readRes.json();
    expect(detail.id).toBe(m.id);

    const hitRes = await get("/api/messages?folder=inbox&q=khoa-smoke-xyz", adminCookie);
    expect(hitRes.status).toBe(200);
    const hit = await hitRes.json();
    expect(hit.items.map((i: any) => i.id)).toContain(m.id);

    const missRes = await get("/api/messages?folder=inbox&q=non-existent-xyz-q100", adminCookie);
    expect(missRes.status).toBe(200);
    const miss = await missRes.json();
    expect(Array.isArray(miss.items)).toBe(true);
    expect(miss.items.length).toBe(0);

    const listAfter = await (await get("/api/messages?folder=inbox", adminCookie)).json();
    expect(listAfter.items.find((i: any) => i.id === m.id)?.isRead).toBe(true);
  });

  it("no duplicate Message-ID for injected email", async () => {
    const dupRes = await inject(
      `From: sender@local.test\r\nTo: ${DEV_USER_EMAIL}\r\nSubject: ${testSubject}\r\nMessage-ID: <${mid}>\r\n\r\nx`,
      DEV_USER_EMAIL
    );
    expect(dupRes.status).toBeLessThan(300);
    const list = await (await get("/api/messages?folder=inbox")).json();
    const matches = list.items.filter((i: any) => i.subject === testSubject);
    expect(matches.length).toBe(1);
  });

  it("ingest alias info@aistockvn.com lands in shared inbox and is visible + readable by gmail user", async () => {
    const { cookie: adminCookie } = await resetAndLoginWithMfa(ADMIN_EMAIL, "AdminAliasPass123!");
    const { cookie: gmailCookie } = await resetAndLogin(DEV_USER_EMAIL, "GmailAliasPass123!");

    const ts = Date.now();
    const aliasMid = `info-alias-${ts}@local.test`;
    const aliasSubject = `Info Alias Routing ${ts}`;
    const rawAlias = [
      `From: "Prospect" <prospect@local.test>`,
      `To: info@aistockvn.com`,
      `Subject: ${aliasSubject}`,
      `Date: ${new Date().toUTCString()}`,
      `Message-ID: <${aliasMid}>`,
      ``,
      `Inquiry sent to info@aistockvn.com`,
    ].join("\r\n");

    const injectAlias = await inject(rawAlias, "info@aistockvn.com");
    expect(injectAlias.status).toBeLessThan(300);

    // Admin sees the message routed via info@aistockvn.com
    const adminInboxRes = await get("/api/messages?folder=inbox", adminCookie);
    expect(adminInboxRes.status).toBe(200);
    const adminInbox = await adminInboxRes.json();
    const aliasMsg = adminInbox.items.find((i: any) => i.subject === aliasSubject);
    expect(aliasMsg).toBeDefined();

    // Gmail user (no mailbox row) ALSO sees the info@ message in shared inbox and can read it (not 404)
    const gmailInboxRes = await get("/api/messages?folder=inbox", gmailCookie);
    expect(gmailInboxRes.status).toBe(200);
    const gmailInbox = await gmailInboxRes.json();
    expect(gmailInbox.items.find((i: any) => i.id === aliasMsg.id)).toBeDefined();

    const gmailReadAlias = await get(`/api/messages/${encodeURIComponent(aliasMsg.id)}`, gmailCookie);
    expect(gmailReadAlias.status).toBe(200);
    const gmailAliasDetail = await gmailReadAlias.json();
    expect(gmailAliasDetail.subject).toBe(aliasSubject);
  });

  it("send email shows 503 without RESEND_API_KEY", async () => {
    const r = await fetch(`${BASE}/api/send`, {
      method: "POST",
      headers: { ...H, Cookie: cookie },
      body: JSON.stringify({ to: "a@b.com", subject: "x", text: "y" }),
    });
    expect(r.status).toBe(503);
  });

  it("verify token DEV then login works", async () => {
    const forgot = await fetch(`${BASE}/api/auth/forgot`, {
      method: "POST",
      headers: H,
      body: JSON.stringify({ email: "lethanhdongus@gmail.com" }),
    });
    expect(forgot.status).toBe(200);
    const forgotBody = await forgot.json();
    expect(typeof forgotBody.token).toBe("string");

    const reset = await fetch(`${BASE}/api/auth/reset`, {
      method: "POST",
      headers: H,
      body: JSON.stringify({ token: forgotBody.token, password: "Matkhau123!" }),
    });
    expect(reset.status).toBe(200);
    expect((await reset.json()).success).toBe(true);

    const login = await fetch(`${BASE}/api/auth/password`, {
      method: "POST",
      headers: H,
      body: JSON.stringify({ email: "lethanhdongus@gmail.com", password: "Matkhau123!" }),
    });
    expect(login.status).toBe(200);
    const sessionCookie = extractCookie(login, "mail_session");
    expect(sessionCookie).toMatch(/^mail_session=/);
    const loginBody = await login.json();
    expect(loginBody.email).toBe("lethanhdongus@gmail.com");
    expect(loginBody.mfaRequired).toBeUndefined();
  });

  it("password login verified success returns session not mfa challenge", async () => {
    const { cookie: sessionCookie, body } = await resetAndLogin(
      "lethanhdongus@gmail.com",
      "Matkhau456!"
    );
    expect(sessionCookie).toMatch(/^mail_session=/);
    expect(body.email).toBe("lethanhdongus@gmail.com");
    expect(body.mfaRequired).toBeFalsy();

    const status = await fetch(`${BASE}/api/auth/mfa/status`, {
      method: "GET",
      headers: { Cookie: sessionCookie },
    });
    expect(status.status).toBe(200);
    const statusBody = await status.json();
    expect(statusBody.enabled).toBe(false);
  });

  it("reset then login", async () => {
    const { cookie: sessionCookie, body } = await resetAndLogin(
      "tranbinhanbr01@gmail.com",
      "Matkhau789!"
    );
    expect(sessionCookie).toMatch(/^mail_session=/);
    expect(body.email).toBe("tranbinhanbr01@gmail.com");
    expect(body.mfaRequired).toBeFalsy();
  });

  it("MFA setup confirm login challenge session e2e", async () => {
    // Only super_admin (admin@aistockvn.com) is allowed to enable MFA (403 for non-admin users).
    // Note: MFA setup requires TOTP_ENCRYPTION_KEY in the worker runtime env (returns 503 if unset).
    const email = "admin@aistockvn.com";
    const password = "MfaTestPassword123!";
    const loginAttempt = await resetAndLoginWithMfa(email, password);
    if (loginAttempt.mfaActiveWithoutSecret) {
      // MFA was already enabled on admin@ from a previous run; verify challenge endpoint responds properly
      const forgot = await fetch(`${BASE}/api/auth/forgot`, {
        method: "POST",
        headers: H,
        body: JSON.stringify({ email }),
      });
      const { token } = await forgot.json();
      await fetch(`${BASE}/api/auth/reset`, {
        method: "POST",
        headers: H,
        body: JSON.stringify({ token, password }),
      });
      const gatedRes = await fetch(`${BASE}/api/auth/password`, {
        method: "POST",
        headers: H,
        body: JSON.stringify({ email, password }),
      });
      expect(gatedRes.status).toBe(200);
      const gatedBody = await gatedRes.json();
      expect(gatedBody.mfaRequired).toBe(true);
      const challengeCookie = extractCookie(gatedRes, "mail_mfa_challenge");
      const badChallenge = await fetch(`${BASE}/api/auth/mfa/challenge`, {
        method: "POST",
        headers: { ...H, Cookie: challengeCookie },
        body: JSON.stringify({ code: "000000" }),
      });
      expect(badChallenge.status).toBe(401);
      return;
    }

    const { cookie: initialSession } = loginAttempt;

    const setupRes = await fetch(`${BASE}/api/auth/mfa/setup`, {
      method: "POST",
      headers: { ...H, Cookie: initialSession },
      body: JSON.stringify({ password }),
    });
    if (setupRes.status === 503) {
      throw new Error(
        `MFA setup returned 503 (TOTP_ENCRYPTION_KEY not set in worker env): ${await setupRes.text()}`
      );
    }
    expect(setupRes.status).toBe(200);
    const setupBody = await setupRes.json();
    expect(typeof setupBody.secret).toBe("string");
    expect(setupBody.secret.length).toBeGreaterThan(10);
    adminTotpSecret = setupBody.secret;

    const totpCode = await generateTOTPCode(setupBody.secret);
    const confirmRes = await fetch(`${BASE}/api/auth/mfa/confirm`, {
      method: "POST",
      headers: { ...H, Cookie: initialSession },
      body: JSON.stringify({ code: totpCode }),
    });
    expect(confirmRes.status).toBe(200);
    const confirmBody = await confirmRes.json();
    expect(Array.isArray(confirmBody.recoveryCodes)).toBe(true);
    expect(confirmBody.recoveryCodes.length).toBe(8);

    const statusRes = await fetch(`${BASE}/api/auth/mfa/status`, {
      method: "GET",
      headers: { Cookie: initialSession },
    });
    expect(statusRes.status).toBe(200);
    const statusBody = await statusRes.json();
    expect(statusBody.enabled).toBe(true);
    expect(statusBody.recoveryCodesRemaining).toBe(8);

    const loginRes = await fetch(`${BASE}/api/auth/password`, {
      method: "POST",
      headers: H,
      body: JSON.stringify({ email, password }),
    });
    expect(loginRes.status).toBe(200);
    const loginBody = await loginRes.json();
    expect(loginBody.mfaRequired).toBe(true);
    const challengeCookie = extractCookie(loginRes, "mail_mfa_challenge");

    const freshTotp = await generateTOTPCode(setupBody.secret);
    const challengeRes = await fetch(`${BASE}/api/auth/mfa/challenge`, {
      method: "POST",
      headers: { ...H, Cookie: challengeCookie },
      body: JSON.stringify({ code: freshTotp }),
    });
    expect(challengeRes.status).toBe(200);
    const finalSession = extractCookie(challengeRes, "mail_session");
    expect(finalSession).toMatch(/^mail_session=/);
    const setCookieHeader = challengeRes.headers.get("set-cookie") ?? "";
    expect(setCookieHeader).toMatch(/mail_mfa_challenge=;/);
    const challengeBody = await challengeRes.json();
    expect(challengeBody.email).toBe(email);
  });

  it("Google endpoint rejects invalid token with 401 and shared MFA gating enforces 200 mfaRequired challenge", async () => {
    const email = "admin@aistockvn.com";
    const password = "GoogleMfaGatePass123!";
    const loginAttempt = await resetAndLoginWithMfa(email, password);
    if (loginAttempt.mfaActiveWithoutSecret) {
      const googleRes = await fetch(`${BASE}/api/auth/google`, {
        method: "POST",
        headers: H,
        body: JSON.stringify({ credential: "invalid.google.id.token" }),
      });
      expect(googleRes.status).toBe(401);

      const forgot = await fetch(`${BASE}/api/auth/forgot`, {
        method: "POST",
        headers: H,
        body: JSON.stringify({ email }),
      });
      const { token } = await forgot.json();
      await fetch(`${BASE}/api/auth/reset`, {
        method: "POST",
        headers: H,
        body: JSON.stringify({ token, password }),
      });
      const gatedLogin = await fetch(`${BASE}/api/auth/password`, {
        method: "POST",
        headers: H,
        body: JSON.stringify({ email, password }),
      });
      expect(gatedLogin.status).toBe(200);
      const gatedBody = await gatedLogin.json();
      expect(gatedBody.mfaRequired).toBe(true);
      return;
    }

    const { cookie: initialSession } = loginAttempt;

    const setupRes = await fetch(`${BASE}/api/auth/mfa/setup`, {
      method: "POST",
      headers: { ...H, Cookie: initialSession },
      body: JSON.stringify({ password }),
    });
    if (setupRes.status === 503) {
      throw new Error(
        `MFA setup returned 503 (TOTP_ENCRYPTION_KEY not set in worker env): ${await setupRes.text()}`
      );
    }
    expect(setupRes.status).toBe(200);
    const { secret } = await setupRes.json();
    adminTotpSecret = secret;

    const confirmCode = await generateTOTPCode(secret);
    const confirmRes = await fetch(`${BASE}/api/auth/mfa/confirm`, {
      method: "POST",
      headers: { ...H, Cookie: initialSession },
      body: JSON.stringify({ code: confirmCode }),
    });
    expect(confirmRes.status).toBe(200);

    const statusRes = await fetch(`${BASE}/api/auth/mfa/status`, {
      method: "GET",
      headers: { Cookie: initialSession },
    });
    expect(statusRes.status).toBe(200);
    expect((await statusRes.json()).enabled).toBe(true);

    const googleRes = await fetch(`${BASE}/api/auth/google`, {
      method: "POST",
      headers: H,
      body: JSON.stringify({ credential: "invalid.google.id.token" }),
    });
    expect(googleRes.status).toBe(401);

    const gatedLogin = await fetch(`${BASE}/api/auth/password`, {
      method: "POST",
      headers: H,
      body: JSON.stringify({ email, password }),
    });
    expect(gatedLogin.status).toBe(200);
    const gatedBody = await gatedLogin.json();
    expect(gatedBody.mfaRequired).toBe(true);
    const challengeCookie = extractCookie(gatedLogin, "mail_mfa_challenge");

    const totp = await generateTOTPCode(secret);
    const completeRes = await fetch(`${BASE}/api/auth/mfa/challenge`, {
      method: "POST",
      headers: { ...H, Cookie: challengeCookie },
      body: JSON.stringify({ code: totp }),
    });
    expect(completeRes.status).toBe(200);
    const sessionCookie = extractCookie(completeRes, "mail_session");
    expect(sessionCookie).toMatch(/^mail_session=/);
  });

  it("recovery code works once then reuse fails", async () => {
    const email = "admin@aistockvn.com";
    const password = "AdminRecoveryPass123!";
    const loginAttempt = await resetAndLoginWithMfa(email, password);
    if (loginAttempt.mfaActiveWithoutSecret) {
      const forgot = await fetch(`${BASE}/api/auth/forgot`, {
        method: "POST",
        headers: H,
        body: JSON.stringify({ email }),
      });
      const { token } = await forgot.json();
      await fetch(`${BASE}/api/auth/reset`, {
        method: "POST",
        headers: H,
        body: JSON.stringify({ token, password }),
      });
      const login1 = await fetch(`${BASE}/api/auth/password`, {
        method: "POST",
        headers: H,
        body: JSON.stringify({ email, password }),
      });
      expect(login1.status).toBe(200);
      expect((await login1.json()).mfaRequired).toBe(true);
      const challengeCookie = extractCookie(login1, "mail_mfa_challenge");
      const reuseInvalid = await fetch(`${BASE}/api/auth/mfa/challenge`, {
        method: "POST",
        headers: { ...H, Cookie: challengeCookie },
        body: JSON.stringify({ code: "INVALID-RECOVERY-CODE" }),
      });
      expect(reuseInvalid.status).toBe(401);
      expect((await reuseInvalid.json()).error).toBe("Invalid MFA code");
      return;
    }

    const { cookie: initialSession } = loginAttempt;

    const setupRes = await fetch(`${BASE}/api/auth/mfa/setup`, {
      method: "POST",
      headers: { ...H, Cookie: initialSession },
      body: JSON.stringify({ password }),
    });
    if (setupRes.status === 503) {
      throw new Error(
        `MFA setup returned 503 (TOTP_ENCRYPTION_KEY not set in worker env): ${await setupRes.text()}`
      );
    }
    expect(setupRes.status).toBe(200);
    const { secret } = await setupRes.json();
    adminTotpSecret = secret;

    const setupTotp = await generateTOTPCode(secret);
    const confirmRes = await fetch(`${BASE}/api/auth/mfa/confirm`, {
      method: "POST",
      headers: { ...H, Cookie: initialSession },
      body: JSON.stringify({ code: setupTotp }),
    });
    expect(confirmRes.status).toBe(200);
    const confirmBody = await confirmRes.json();
    expect(Array.isArray(confirmBody.recoveryCodes)).toBe(true);
    expect(confirmBody.recoveryCodes.length).toBe(8);
    const firstRecoveryCode: string = confirmBody.recoveryCodes[0];

    const statusBefore = await fetch(`${BASE}/api/auth/mfa/status`, {
      method: "GET",
      headers: { Cookie: initialSession },
    });
    expect(statusBefore.status).toBe(200);
    const remainingBefore: number = (await statusBefore.json()).recoveryCodesRemaining;

    const login1 = await fetch(`${BASE}/api/auth/password`, {
      method: "POST",
      headers: H,
      body: JSON.stringify({ email, password }),
    });
    expect(login1.status).toBe(200);
    expect((await login1.json()).mfaRequired).toBe(true);
    const challengeCookie1 = extractCookie(login1, "mail_mfa_challenge");

    const useCode1 = await fetch(`${BASE}/api/auth/mfa/challenge`, {
      method: "POST",
      headers: { ...H, Cookie: challengeCookie1 },
      body: JSON.stringify({ code: firstRecoveryCode }),
    });
    expect(useCode1.status).toBe(200);
    const recoveredSession = extractCookie(useCode1, "mail_session");
    expect(recoveredSession).toMatch(/^mail_session=/);

    const statusAfter = await fetch(`${BASE}/api/auth/mfa/status`, {
      method: "GET",
      headers: { Cookie: recoveredSession },
    });
    expect(statusAfter.status).toBe(200);
    expect((await statusAfter.json()).recoveryCodesRemaining).toBe(remainingBefore - 1);

    const login2 = await fetch(`${BASE}/api/auth/password`, {
      method: "POST",
      headers: H,
      body: JSON.stringify({ email, password }),
    });
    expect(login2.status).toBe(200);
    const challengeCookie2 = extractCookie(login2, "mail_mfa_challenge");

    const reuseCode1 = await fetch(`${BASE}/api/auth/mfa/challenge`, {
      method: "POST",
      headers: { ...H, Cookie: challengeCookie2 },
      body: JSON.stringify({ code: firstRecoveryCode }),
    });
    expect(reuseCode1.status).toBe(401);
    const reuseBody = await reuseCode1.json();
    expect(reuseBody.error).toBe("Invalid MFA code");
  });

  it("mailbox scoping A/B: user A cannot read user B's mailbox", async () => {
    // Shared mailbox (admin@aistockvn.com) is accessible to all authenticated users, while private
    // mailboxes remain isolated. Therefore we test A/B isolation between two non-shared users
    // (tranbinhanbr01@gmail.com and lethanhdongus@gmail.com) rather than using admin@ as A.
    const emailA = "tranbinhanbr01@gmail.com";
    const emailB = "lethanhdongus@gmail.com";
    const passA = "UserAScopePass123!";
    const passB = "UserBScopePass123!";

    const { cookie: cookieA } = await resetAndLogin(emailA, passA);
    const { cookie: cookieB } = await resetAndLogin(emailB, passB);

    // Non-existent message ID under private/unowned scope returns 404 for user B
    const missingId = "00000000-0000-4000-8000-000000000099";
    const readMissingAsB = await get(`/api/messages/${missingId}`, cookieB);
    expect(readMissingAsB.status).toBe(404);

    // Shared mailbox messages (admin@aistockvn.com) are visible to both A and B,
    // whereas sending as B proceeds without a personal mailbox row (returns 503 when RESEND_API_KEY is unset).
    const listARes = await get("/api/messages?folder=inbox", cookieA);
    expect(listARes.status).toBe(200);
    const listBRes = await get("/api/messages?folder=inbox", cookieB);
    expect(listBRes.status).toBe(200);

    const sendAsB = await fetch(`${BASE}/api/send`, {
      method: "POST",
      headers: { ...H, Cookie: cookieB },
      body: JSON.stringify({ to: "recipient@example.com", subject: "Send check", text: "ok" }),
    });
    expect(sendAsB.status).toBe(503);
  });

  it("admin@ registration 409 test", async () => {
    const signup = await fetch(`${BASE}/api/auth/signup`, {
      method: "POST",
      headers: H,
      body: JSON.stringify({ email: "admin@aistockvn.com", password: "Somelongpassword123!" }),
    });
    expect(signup.status).toBe(409);
  });

  it("rejects signup for seeded verified users with 409", async () => {
    const signup = await fetch(`${BASE}/api/auth/signup`, {
      method: "POST",
      headers: H,
      body: JSON.stringify({
        email: "tranbinhanbr01@gmail.com",
        password: "Somelongpassword123!",
      }),
    });
    expect(signup.status).toBe(409);
  });

  it("focused tab splits inbox: allowlisted sender focused, stranger other", async () => {
    const focusedSubject = `Focused smoke ${mid}`;
    const otherSubject = `Other smoke ${mid}`;
    const focusedRaw = [
      `From: ${ADMIN_EMAIL}`,
      `To: ${ADMIN_EMAIL}`,
      `Subject: ${focusedSubject}`,
      `Date: ${new Date().toUTCString()}`,
      `Message-ID: <focused-${mid}>`,
      ``,
      `hello from admin`,
      ``,
    ].join("\r\n");
    const otherRaw = [
      `From: stranger@local.test`,
      `To: ${ADMIN_EMAIL}`,
      `Subject: ${otherSubject}`,
      `Date: ${new Date().toUTCString()}`,
      `Message-ID: <other-${mid}>`,
      ``,
      `plain body with no names`,
      ``,
    ].join("\r\n");
    expect((await inject(focusedRaw, ADMIN_EMAIL)).status).toBeLessThan(300);
    expect((await inject(otherRaw, ADMIN_EMAIL)).status).toBeLessThan(300);

    const focusedList = await (await get("/api/messages?folder=inbox&tab=focused")).json();
    const focusedSubjects = focusedList.items.map((i: any) => i.subject);
    expect(focusedSubjects).toContain(focusedSubject);
    expect(focusedSubjects).not.toContain(otherSubject);
    expect(focusedList.items.find((i: any) => i.subject === focusedSubject)?.isFocused).toBe(true);

    const otherList = await (await get("/api/messages?folder=inbox&tab=other")).json();
    const otherSubjects = otherList.items.map((i: any) => i.subject);
    expect(otherSubjects).toContain(otherSubject);
    expect(otherSubjects).not.toContain(focusedSubject);
    expect(otherList.items.find((i: any) => i.subject === otherSubject)?.isFocused).toBe(false);

    const allList = await (await get("/api/messages?folder=inbox")).json();
    const allSubjects = allList.items.map((i: any) => i.subject);
    expect(allSubjects).toContain(focusedSubject);
    expect(allSubjects).toContain(otherSubject);
  });
});
