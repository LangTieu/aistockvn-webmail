import { useEffect, useState, type FormEvent } from "react";
import { api, ApiError } from "./api";

const focusRing = "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-teal-600 focus-visible:ring-offset-2";
const inputClass =
  "h-11 w-full rounded-lg border border-slate-300 bg-white px-3 text-base text-slate-900 placeholder:text-slate-400 focus:border-teal-600 focus:outline-none focus:ring-2 focus:ring-teal-600/20";
const primaryButton = `inline-flex h-11 w-full items-center justify-center gap-2 rounded-lg bg-teal-600 px-4 text-base font-medium text-white hover:bg-teal-700 disabled:cursor-not-allowed disabled:bg-teal-400 ${focusRing}`;
const outlineButton = `inline-flex h-9 items-center justify-center gap-2 rounded-lg border border-slate-300 bg-white px-3 text-sm font-medium text-slate-800 hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-50 ${focusRing}`;
const errorText = (e: unknown) => (e instanceof ApiError ? e.message : "Something went wrong. Please try again.");

type NotificationSettings = Awaited<ReturnType<typeof api.getNotificationSettings>>;
type DetailLevel = NotificationSettings["detail_level"];

function urlBase64ToUint8Array(base64String: string) {
  const padding = "=".repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, "+").replace(/_/g, "/");
  const rawData = atob(base64);
  const buffer = new ArrayBuffer(rawData.length);
  const outputArray = new Uint8Array(buffer);
  for (let i = 0; i < rawData.length; i++) {
    outputArray[i] = rawData.charCodeAt(i);
  }
  return outputArray;
}

function isVapidNotConfigured(e: unknown): boolean {
  if (!(e instanceof ApiError)) return false;
  return e.status === 503 || e.message.toLowerCase().includes("vapid_not_configured");
}

export function NotificationsPanel({ onBack }: { onBack: () => void }) {
  const pushSupported =
    typeof window !== "undefined" &&
    typeof navigator !== "undefined" &&
    "serviceWorker" in navigator &&
    "PushManager" in window;

  const [settings, setSettings] = useState<NotificationSettings | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  // Browser push state
  const [permission, setPermission] = useState<NotificationPermission>(() =>
    typeof Notification !== "undefined" ? Notification.permission : "default",
  );
  const [pushSubscribed, setPushSubscribed] = useState(false);
  const [vapidUnavailable, setVapidUnavailable] = useState(false);
  const [pushBusy, setPushBusy] = useState(false);
  const [pushError, setPushError] = useState<string | null>(null);
  const [pushMessage, setPushMessage] = useState<string | null>(null);

  // Telegram state
  const [telegramEnabled, setTelegramEnabled] = useState(false);
  const [telegramChatId, setTelegramChatId] = useState("");
  const [telegramSaving, setTelegramSaving] = useState(false);
  const [telegramTesting, setTelegramTesting] = useState(false);
  const [telegramError, setTelegramError] = useState<string | null>(null);
  const [telegramMessage, setTelegramMessage] = useState<string | null>(null);

  // Detail level state
  const [detailLevel, setDetailLevel] = useState<DetailLevel>("basic");
  const [detailSaving, setDetailSaving] = useState(false);
  const [detailError, setDetailError] = useState<string | null>(null);
  const [detailMessage, setDetailMessage] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    const load = async () => {
      setLoading(true);
      setLoadError(null);
      try {
        const res = await api.getNotificationSettings();
        if (!active) return;
        setSettings(res);
        setTelegramEnabled(res.telegram_enabled);
        setTelegramChatId(res.telegram_chat_id);
        setDetailLevel(res.detail_level);
      } catch (e) {
        if (!active) return;
        setLoadError(errorText(e));
      } finally {
        if (active) setLoading(false);
      }

      if (pushSupported) {
        try {
          const reg = await navigator.serviceWorker.getRegistration();
          const sub = reg ? await reg.pushManager.getSubscription() : null;
          if (active) setPushSubscribed(Boolean(sub));
        } catch {
          if (active) setPushSubscribed(false);
        }
      }
    };
    void load();
    return () => {
      active = false;
    };
  }, [pushSupported]);

  const handleEnablePush = async () => {
    if (!pushSupported || pushBusy || vapidUnavailable) return;
    setPushBusy(true);
    setPushError(null);
    setPushMessage(null);
    try {
      const perm = await Notification.requestPermission();
      setPermission(perm);
      if (perm !== "granted") {
        setPushError(
          perm === "denied"
            ? "Notification permission is blocked in the browser."
            : "You have not granted notification permission for the browser.",
        );
        return;
      }

      let publicKey: string;
      try {
        const keyRes = await api.getVapidPublicKey();
        publicKey = keyRes.publicKey;
      } catch (e) {
        if (isVapidNotConfigured(e)) {
          setVapidUnavailable(true);
          setPushError("Push is not configured on the server");
          return;
        }
        throw e;
      }

      let reg = await navigator.serviceWorker.getRegistration();
      if (!reg) {
        reg = await navigator.serviceWorker.register("/sw.js");
      }
      const readyReg = await navigator.serviceWorker.ready;
      const activeReg = readyReg || reg;

      const subscription = await activeReg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(publicKey),
      });

      const subJson = subscription.toJSON();
      const endpoint = subJson.endpoint || subscription.endpoint;
      const p256dh = subJson.keys?.p256dh || "";
      const auth = subJson.keys?.auth || "";
      if (!endpoint || !p256dh || !auth) {
        throw new Error("Could not read the push subscription key from the browser.");
      }

      await api.subscribePush({
        endpoint,
        keys: { p256dh, auth },
      });

      const updated = await api.updateNotificationSettings({
        push_enabled: true,
        telegram_enabled: settings?.telegram_enabled ?? telegramEnabled,
        telegram_chat_id: settings?.telegram_chat_id ?? telegramChatId,
        detail_level: settings?.detail_level ?? detailLevel,
      });
      setSettings(updated);
      setPushSubscribed(true);
      setPushMessage("Browser notifications enabled.");
    } catch (e) {
      if (isVapidNotConfigured(e)) {
        setVapidUnavailable(true);
        setPushError("Push is not configured on the server");
      } else {
        setPushError(errorText(e));
      }
    } finally {
      setPushBusy(false);
    }
  };

  const handleDisablePush = async () => {
    if (!pushSupported || pushBusy) return;
    setPushBusy(true);
    setPushError(null);
    setPushMessage(null);
    try {
      const reg = await navigator.serviceWorker.getRegistration();
      const sub = reg ? await reg.pushManager.getSubscription() : null;
      if (sub) {
        const endpoint = sub.endpoint;
        await sub.unsubscribe();
        await api.unsubscribePush(endpoint);
      }

      const updated = await api.updateNotificationSettings({
        push_enabled: false,
        telegram_enabled: settings?.telegram_enabled ?? telegramEnabled,
        telegram_chat_id: settings?.telegram_chat_id ?? telegramChatId,
        detail_level: settings?.detail_level ?? detailLevel,
      });
      setSettings(updated);
      setPushSubscribed(false);
      setPushMessage("Browser notifications disabled.");
    } catch (e) {
      setPushError(errorText(e));
    } finally {
      setPushBusy(false);
    }
  };

  const handleSaveTelegram = async (e: FormEvent) => {
    e.preventDefault();
    if (telegramSaving) return;
    setTelegramSaving(true);
    setTelegramError(null);
    setTelegramMessage(null);
    try {
      const updated = await api.updateNotificationSettings({
        push_enabled: settings?.push_enabled ?? pushSubscribed,
        telegram_enabled: telegramEnabled,
        telegram_chat_id: telegramChatId.trim(),
        detail_level: settings?.detail_level ?? detailLevel,
      });
      setSettings(updated);
      setTelegramEnabled(updated.telegram_enabled);
      setTelegramChatId(updated.telegram_chat_id);
      setTelegramMessage("Saved Telegram settings.");
    } catch (err) {
      setTelegramError(errorText(err));
    } finally {
      setTelegramSaving(false);
    }
  };

  const handleTestTelegram = async () => {
    if (telegramTesting) return;
    setTelegramTesting(true);
    setTelegramError(null);
    setTelegramMessage(null);
    try {
      await api.sendTestNotification("telegram");
      setTelegramMessage("Sent a test message via Telegram.");
    } catch (err) {
      setTelegramError(errorText(err));
    } finally {
      setTelegramTesting(false);
    }
  };

  const handleDetailChange = async (nextLevel: DetailLevel) => {
    if (detailSaving || nextLevel === detailLevel) return;
    const prevLevel = detailLevel;
    setDetailLevel(nextLevel);
    setDetailSaving(true);
    setDetailError(null);
    setDetailMessage(null);
    try {
      const updated = await api.updateNotificationSettings({
        push_enabled: settings?.push_enabled ?? pushSubscribed,
        telegram_enabled: settings?.telegram_enabled ?? telegramEnabled,
        telegram_chat_id: settings?.telegram_chat_id ?? telegramChatId,
        detail_level: nextLevel,
      });
      setSettings(updated);
      setDetailLevel(updated.detail_level);
      setDetailMessage("Saved notification detail level.");
    } catch (err) {
      setDetailLevel(prevLevel);
      setDetailError(errorText(err));
    } finally {
      setDetailSaving(false);
    }
  };

  const pushStatusLabel = !pushSupported
    ? "Browser not supported"
    : permission === "denied"
      ? "Permission blocked"
      : vapidUnavailable
        ? "Push is not configured on the server"
        : pushSubscribed
          ? "Subscribed"
          : "Not subscribed";

  return (
    <div className="flex min-h-full flex-col bg-white">
      <header className="flex shrink-0 items-center gap-2 border-b border-slate-200 px-4 py-3">
        <button
          type="button"
          onClick={onBack}
          aria-label="Back"
          className={`inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-lg text-slate-700 hover:bg-slate-100 ${focusRing}`}
        >
          <svg
            aria-hidden="true"
            viewBox="0 0 24 24"
            className="h-5 w-5"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d="m15 18-6-6 6-6" />
          </svg>
        </button>
        <h1 className="text-base font-semibold text-slate-900">Notifications</h1>
      </header>

      <div className="mx-auto w-full max-w-3xl px-4 py-6">
        {loading ? (
          <p className="text-sm text-slate-600">Loading…</p>
        ) : loadError ? (
          <p role="alert" className="rounded-lg border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-800">
            {loadError}
          </p>
        ) : (
          <div className="space-y-6 rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
            {/* Browser Push */}
            <section aria-labelledby="push-heading" className="space-y-3">
              <div className="flex items-center justify-between gap-2">
                <h2 id="push-heading" className="text-base font-semibold text-slate-900">
                  Browser notifications (Push)
                </h2>
                <span
                  className={`inline-flex shrink-0 items-center rounded-full px-2 py-0.5 text-xs font-medium ${
                    pushSubscribed ? "bg-emerald-50 text-emerald-700" : "bg-slate-100 text-slate-600"
                  }`}
                >
                  {pushStatusLabel}
                </span>
              </div>

              {!pushSupported ? (
                <p className="text-sm text-slate-600">
                  This browser does not support Service Worker or the Push API.
                </p>
              ) : permission === "denied" ? (
                <p className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">
                  Notification permission is blocked. Open the browser settings for this site to allow notifications.
                </p>
              ) : vapidUnavailable ? (
                <p className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">
                  Push is not configured on the server
                </p>
              ) : null}

              {pushError && (
                <p role="alert" className="rounded-lg border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-800">
                  {pushError}
                </p>
              )}
              {pushMessage && (
                <p role="status" className="text-sm text-teal-700">
                  {pushMessage}
                </p>
              )}

              <div className="flex flex-wrap gap-2">
                {pushSubscribed ? (
                  <button
                    type="button"
                    onClick={() => void handleDisablePush()}
                    disabled={!pushSupported || pushBusy}
                    className={outlineButton}
                  >
                    {pushBusy ? "Turning off…" : "Off"}
                  </button>
                ) : (
                  <button
                    type="button"
                    onClick={() => void handleEnablePush()}
                    disabled={!pushSupported || permission === "denied" || vapidUnavailable || pushBusy}
                    className={`${primaryButton} sm:w-auto`}
                  >
                    {pushBusy ? "Turning on…" : "On"}
                  </button>
                )}
              </div>
            </section>

            {/* Telegram */}
            <section aria-labelledby="telegram-heading" className="space-y-3 border-t border-slate-200 pt-6">
              <h2 id="telegram-heading" className="text-base font-semibold text-slate-900">
                Telegram
              </h2>

              <ol className="list-decimal space-y-1 pl-5 text-sm text-slate-600">
                <li>Open the Telegram bot and press Start.</li>
                <li>Message @userinfobot to get your numeric chat id.</li>
                <li>Paste the chat id here and press Save.</li>
              </ol>

              <form onSubmit={(e) => void handleSaveTelegram(e)} className="space-y-3">
                <label className="flex cursor-pointer items-center gap-2.5 text-sm font-medium text-slate-800">
                  <input
                    type="checkbox"
                    checked={telegramEnabled}
                    onChange={(e) => setTelegramEnabled(e.target.checked)}
                    disabled={telegramSaving}
                    className="h-4 w-4 rounded border-slate-300 text-teal-600 focus:ring-teal-600"
                  />
                  <span>Enable Telegram notifications</span>
                </label>

                <div>
                  <label htmlFor="telegram-chat-id" className="mb-1.5 block text-sm font-medium text-slate-800">
                    Telegram Chat ID
                  </label>
                  <input
                    id="telegram-chat-id"
                    type="text"
                    inputMode="numeric"
                    placeholder="Example: 123456789"
                    value={telegramChatId}
                    onChange={(e) => setTelegramChatId(e.target.value)}
                    disabled={telegramSaving}
                    className={inputClass}
                  />
                </div>

                {telegramError && (
                  <p role="alert" className="rounded-lg border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-800">
                    {telegramError}
                  </p>
                )}
                {telegramMessage && (
                  <p role="status" className="text-sm text-teal-700">
                    {telegramMessage}
                  </p>
                )}

                <div className="flex flex-wrap items-center gap-2">
                  <button type="submit" disabled={telegramSaving} className={`${primaryButton} sm:w-auto`}>
                    {telegramSaving ? "Saving…" : "Save"}
                  </button>
                  <button
                    type="button"
                    onClick={() => void handleTestTelegram()}
                    disabled={telegramTesting || telegramSaving || !telegramChatId.trim()}
                    className={outlineButton}
                  >
                    {telegramTesting ? "Sending…" : "Send test message"}
                  </button>
                </div>
              </form>
            </section>

            {/* Detail level */}
            <section aria-labelledby="detail-heading" className="space-y-3 border-t border-slate-200 pt-6">
              <h2 id="detail-heading" className="text-base font-semibold text-slate-900">
                Notification detail level
              </h2>

              <div role="radiogroup" aria-labelledby="detail-heading" className="space-y-2.5">
                <label className="flex cursor-pointer items-start gap-3 rounded-lg border border-slate-200 p-3 hover:bg-slate-50">
                  <input
                    type="radio"
                    name="detail_level"
                    value="basic"
                    checked={detailLevel === "basic"}
                    onChange={() => void handleDetailChange("basic")}
                    disabled={detailSaving}
                    className="mt-1 h-4 w-4 border-slate-300 text-teal-600 focus:ring-teal-600"
                  />
                  <span className="text-sm">
                    <span className="block font-medium text-slate-900">Basic</span>
                    <span className="text-slate-600">Only shows &quot;You have new mail&quot;, the sender name and a link to open webmail.</span>
                  </span>
                </label>

                <label className="flex cursor-pointer items-start gap-3 rounded-lg border border-slate-200 p-3 hover:bg-slate-50">
                  <input
                    type="radio"
                    name="detail_level"
                    value="full"
                    checked={detailLevel === "full"}
                    onChange={() => void handleDetailChange("full")}
                    disabled={detailSaving}
                    className="mt-1 h-4 w-4 border-slate-300 text-teal-600 focus:ring-teal-600"
                  />
                  <span className="text-sm">
                    <span className="block font-medium text-slate-900">Full</span>
                    <span className="text-slate-600">Also includes the subject and a snippet of up to 160 characters.</span>
                  </span>
                </label>
              </div>

              {detailError && (
                <p role="alert" className="rounded-lg border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-800">
                  {detailError}
                </p>
              )}
              {detailMessage && (
                <p role="status" className="text-sm text-teal-700">
                  {detailMessage}
                </p>
              )}
            </section>
          </div>
        )}
      </div>
    </div>
  );
}
