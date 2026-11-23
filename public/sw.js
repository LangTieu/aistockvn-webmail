self.addEventListener("push", (event) => {
  event.waitUntil(
    (async () => {
      let body = "Bạn có thư mới";
      try {
        const res = await fetch("/api/counts", { credentials: "same-origin" });
        if (res.ok) {
          const data = await res.json();
          if (data && typeof data.unread === "number" && data.unread > 0) {
            body = `Bạn có thư mới (${data.unread} chưa đọc)`;
          }
        }
      } catch {
        // Ignore fetch/auth errors and show generic notification body
      }
      await self.registration.showNotification("AI Stock VN Mail", {
        body,
        icon: "/icon.svg",
      });
    })(),
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  event.waitUntil(
    (async () => {
      const allClients = await self.clients.matchAll({
        type: "window",
        includeUncontrolled: true,
      });
      for (const client of allClients) {
        if ("focus" in client) {
          return client.focus();
        }
      }
      return self.clients.openWindow("/");
    })(),
  );
});
