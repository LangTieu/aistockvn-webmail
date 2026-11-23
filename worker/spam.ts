export const SPAM_THRESHOLD = 5;

export function parseAuthResults(headers: { key: string; value: string }[]): { spf: string; dkim: string; dmarc: string } {
  const authResults = headers.find((h) => h.key.toLowerCase() === "authentication-results");
  if (!authResults) return { spf: "none", dkim: "none", dmarc: "none" };

  const content = authResults.value;
  const extract = (keyword: string): string => {
    const regex = new RegExp(`\\b${keyword}=([^;\\s]+)`, "i");
    const match = content.match(regex);
    return match ? match[1].toLowerCase() : "none";
  };

  return {
    spf: extract("spf"),
    dkim: extract("dkim"),
    dmarc: extract("dmarc"),
  };
}

export function scoreSpam(input: {
  from: string;
  subject: string;
  text: string;
  headers: { key: string; value: string }[];
  blocklisted: boolean;
}): { score: number; reasons: string[] } {
  const { spf, dkim, dmarc } = parseAuthResults(input.headers);
  const reasons: string[] = [];

  if (spf === "fail") {
    reasons.push("spf-fail");
  }
  if (dkim === "fail") {
    reasons.push("dkim-fail");
  }
  if (dmarc === "fail") {
    reasons.push("dmarc-fail");
  }
  if (spf === "softfail") {
    reasons.push("spf-softfail");
  }

  if (input.blocklisted) {
    reasons.push("blocklisted");
  }

  if (input.subject.trim() === "" && input.text.length < 20) {
    reasons.push("empty-short");
  }

  const suspiciousSubjects = ["you won", "claim your prize", "urgent action required", "verify your account", "crypto giveaway"];
  const lowerSubject = input.subject.toLowerCase();
  for (const s of suspiciousSubjects) {
    if (lowerSubject.includes(s)) {
      reasons.push("suspicious-subject");
      break;
    }
  }

  const urlRegex = /https?:\/\/[^\s]+/g;
  const urlCount = (input.text.match(urlRegex) || []).length;
  if (urlCount > 10) {
    reasons.push("many-links");
  }

  const score = reasons.reduce((sum, reason) => {
    if (reason === "spf-fail" || reason === "dkim-fail" || reason === "dmarc-fail") return sum + 3;
    if (reason === "spf-softfail") return sum + 1;
    if (reason === "blocklisted") return sum + 5;
    if (reason === "empty-short") return sum + 2;
    if (reason === "suspicious-subject") return sum + 2;
    if (reason === "many-links") return sum + 2;
    return sum;
  }, 0);

  return { score, reasons };
}

export function isSpam(result: { score: number }): boolean {
  return result.score >= 5;
}