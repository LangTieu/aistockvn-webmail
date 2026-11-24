import { afterEach, describe, expect, it, vi } from "vitest";
import { uploadAttachments, validateAttachmentName } from "./attachments";
import type { Env } from "./mail";

const env = {
  B2_KEY_ID: "test-key-id", B2_APPLICATION_KEY: "test-application-key",
  B2_BUCKET_NAME: "private-test", B2_S3_ENDPOINT: "https://s3.eu-central-003.backblazeb2.com",
} as Env;

describe("B2 outgoing attachments", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("uploads one file and multiple files with original names", async () => {
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init: RequestInit) =>
      init.method === "GET" ? new Response("<ListBucketResult><Size>10</Size></ListBucketResult>") : new Response(null, { status: 200 })));
    const one = await uploadAttachments(env, [new File(["a"], "report.pdf", { type: "application/pdf" })]);
    expect(one).toHaveLength(1);
    expect(one[0].filename).toBe("report.pdf");
    const many = await uploadAttachments(env, [new File(["b"], "one.txt"), new File(["cd"], "two.txt")]);
    expect(many.map((file) => file.filename)).toEqual(["one.txt", "two.txt"]);
    expect(fetch).toHaveBeenCalledTimes(5);
  });

  it("rejects total size over 25 MB before upload", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    await expect(uploadAttachments(env, [new File([new Uint8Array(25 * 1024 * 1024)], "large.pdf"), new File(["x"], "extra.txt")]))
      .rejects.toThrow("25 MB per email limit");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects executable files and unsafe paths", () => {
    expect(validateAttachmentName("payload.exe")).toContain("not allowed");
    expect(validateAttachmentName("../secret.txt")).toContain("unsafe");
    expect(validateAttachmentName("safe.pdf")).toBeNull();
  });
});

describe("attachment storage error mapping (audit fix 3)", () => {
  // The mapping lives in the worker's attachmentStorageError helper; exercise it
  // through loadAttachment's real error messages via the worker route logic.
  it("loadAttachment throws the upstream status that the worker maps to 404/502", async () => {
    const { loadAttachment } = await import("./attachments");
    const fetchMock = vi.fn(async () => new Response("gone", { status: 404 }));
    vi.stubGlobal("fetch", fetchMock);
    const validKey = "0123456789abcdef0123456789abcdef0123/obj";
    await expect(loadAttachment(env, validKey)).rejects.toThrow("B2 download failed (404).");

    const fetchMock5xx = vi.fn(async () => new Response("boom", { status: 503 }));
    vi.stubGlobal("fetch", fetchMock5xx);
    await expect(loadAttachment(env, validKey)).rejects.toThrow("B2 download failed (503).");
  });
});
