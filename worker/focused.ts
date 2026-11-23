export function classifyFocused(input: {
  from: string; subject: string; text: string;
  inReplyTo: string | null; references: string | null;
  allowedEmails: string[]; sentMessageIds: string[]; userNames: string[];
}): { focused: boolean; reasons: string[] } {
  const { from, subject, text, inReplyTo, references, allowedEmails, sentMessageIds, userNames } = input;
  const reasons: string[] = [];

  // 1. allowlisted-sender: from trimmed + lowercased is in allowedEmails (compare lowercased)
  const fromTrimmedLower = from.trim().toLowerCase();
  if (allowedEmails.some((e) => e.toLowerCase() === fromTrimmedLower)) {
    reasons.push("allowlisted-sender");
  }

  // 2. reply-to-sent: inReplyTo (strip <>, trim) in sentMessageIds,
  //    OR any token in references (split on whitespace/commas, strip <>, trim, drop empties)
  //    is in sentMessageIds. Both sides are normalized (angle brackets stripped)
  //    so a bracketed id matches a bare one and vice versa.
  const sentSet = new Set(sentMessageIds.map((id) => id.replace(/[<>]/g, "").trim()).filter((id) => id.length > 0));
  let replyToSent = false;
  if (inReplyTo) {
    const cleaned = inReplyTo.replace(/[<>]/g, "").trim();
    if (sentSet.has(cleaned)) {
      replyToSent = true;
    }
  }
  if (!replyToSent && references) {
    const refTokens = references.split(/[\s,]+/).map((t) => t.replace(/[<>]/g, "").trim()).filter((t) => t.length > 0);
    for (const token of refTokens) {
      if (sentSet.has(token)) {
        replyToSent = true;
        break;
      }
    }
  }
  if (replyToSent) {
    reasons.push("reply-to-sent");
  }

  // 3. mentions-user: any userNames token with length >= 3 (after trim)
  //    found case-insensitively in subject + "\n" + text.
  //    Match on word boundaries when the token starts/ends with a word character
  //    (escape regex meta-characters); a token of only non-word characters never matches.
  const userSearchText = subject + "\n" + text;
  for (const token of userNames) {
    const trimmed = token.trim();
    if (trimmed.length < 3) continue;
    if (!/\w/.test(trimmed)) continue; // token of only non-word characters never matches
    const escaped = trimmed.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    // Word boundaries only where the token starts/ends with a word character;
    // a token ending in a non-word char (e.g. "C++") would never match with \b there.
    const startBoundary = /^\w/.test(trimmed) ? "\\b" : "";
    const endBoundary = /\w$/.test(trimmed) ? "\\b" : "";
    const regex = new RegExp(`${startBoundary}${escaped}${endBoundary}`, "i");
    if (regex.test(userSearchText)) {
      reasons.push("mentions-user");
      break;
    }
  }

  return {
    focused: reasons.length > 0,
    reasons,
  };
}