# v0 design prompt — Webmail aistockvn.com (v2: macOS native, English, desktop-first)

Paste verbatim into v0 (or run `node design/v0_generate.mjs` on a machine with the v0 key file).

---

Design a webmail app that looks and feels like a **native macOS app (Apple Mail style)**. **Desktop web first** — primary use is Chrome on desktop (wide layout, 1280px and up, three-pane like Apple Mail); it must still work on phones, but desktop is the priority, not the other way around. **All UI text in English.** Use React + Tailwind CSS (no Next.js routing; navigate with hash `#/inbox`, `#/sent`, `#/m/:id`, `#/compose`). No fake data in the final build: every screen receives data via props/API functions, with loading, empty, and error states.

Mailbox: admin@aistockvn.com (single user).

Style — macOS native:
- System font stack (-apple-system, "SF Pro", Segoe UI, sans-serif); system blue accent (#007AFF) for links, active states, and primary buttons.
- Three-pane desktop layout: slim left sidebar (mailboxes: Inbox with unread badge, Sent, plus search field at top), middle message list, right reading pane. Sidebar in light neutral gray (#F5F5F7) with subtle translucency feel; thin 1px separators (#E5E5EA); 8px corner radii; soft shadows only on floating elements (compose window, menus).
- Native-feeling controls: segmented toolbar buttons, quiet hover states, restrained color — mostly grays with blue as the single accent. Unread messages bold with a blue dot. Compact rows (sender, subject, snippet, time) like Apple Mail.
- On narrow screens the panes collapse to one column with a back button (inbox list → message → back), bottom tab bar with Inbox / Sent.

Screens:
1. **Sign in** — clean centered card on a soft gray gradient, envelope logo, title "AI Stock VN Mail", the mailbox address, a "Sign in with Google" button (placeholder slot for the Google Identity Services button), error message line.
2. **Inbox / Sent** — top toolbar: title, search (expands to a full-width search field with back button), refresh, sign out. Message list: letter avatar tinted by sender name, sender name (Sent: "To: …"), short time/date ("2:05 PM", "Nov 17"), subject, one-line snippet, paperclip icon when there are attachments; unread in bold with blue dot. "Load more" at the end of the list. Empty state with icon and explanation. Floating "Compose" button bottom-right on mobile; on desktop a "Compose" button in the toolbar.
3. **Read message** — toolbar: back, mark as unread. Large subject, sender block (avatar, name, address, "to …", "cc …", full date/time), HTML body inside a sandboxed iframe, banner "Images from external sources are hidden… Show images", attachment cards (name, size, download button). Fixed action bar at the bottom: "Reply", "Forward".
4. **Compose / Reply / Forward** — top bar: close (X), screen title, blue "Send" button (states "Sending…", "Sent"). Fields: From (fixed admin@aistockvn.com), To (email keyboard, "Cc" button to reveal Cc field), Subject, Body (tall textarea). Light red error box and light green success box.

Requirements: click targets ≥ 44px on touch, iOS safe-area support, no horizontal scrolling, system font, AA contrast.
