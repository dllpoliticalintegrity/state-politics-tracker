// Pure helpers for the feedback edge function (index.ts): input checks and
// the Discord message. No Deno APIs, so src/test/feedback.test.ts runs them
// under vitest.

export const MAX_MESSAGE = 2000;
export const MAX_EMAIL = 200;
export const MAX_URL = 500;
export const MAX_SITE = 80;

export type FeedbackInput = {
  message: string;
  email: string | null;
  pageUrl: string | null;
  site: string;
};

/** The submitted body as clean FeedbackInput, or an error message. `website`
 *  is a honeypot field the form hides from people: anything in it is a bot,
 *  reported as "spam" so the caller can answer 200 and drop it silently. */
export function parseFeedback(body: unknown): FeedbackInput | { error: string } {
  if (!body || typeof body !== "object") return { error: "invalid body" };
  const b = body as Record<string, unknown>;
  if (typeof b.website === "string" && b.website.trim() !== "") return { error: "spam" };
  const message = typeof b.message === "string" ? b.message.trim() : "";
  if (!message) return { error: "message is required" };
  if (message.length > MAX_MESSAGE) return { error: `message is over ${MAX_MESSAGE} characters` };
  let email: string | null = typeof b.email === "string" ? b.email.trim() : "";
  if (!email) email = null;
  else if (email.length > MAX_EMAIL || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return { error: "email doesn't look right" };
  }
  let pageUrl: string | null = typeof b.pageUrl === "string" ? b.pageUrl.trim().slice(0, MAX_URL) : "";
  if (!/^https?:\/\//i.test(pageUrl)) pageUrl = null;
  const site = (typeof b.site === "string" && b.site.trim() ? b.site.trim() : "State Politics Tracker")
    .slice(0, MAX_SITE);
  return { message, email, pageUrl, site };
}

/** Discord webhook body: one embed in the style of integrityindex's
 *  discord-feedback-notify. allowed_mentions is empty so a message containing
 *  "@everyone" or a role mention can never ping the channel. */
export function discordPayload(f: FeedbackInput, now = new Date()) {
  const fields = [
    { name: "Message", value: f.message.slice(0, 1024), inline: false },
    ...(f.message.length > 1024
      ? [{ name: "Message (cont.)", value: f.message.slice(1024, 2048), inline: false }]
      : []),
    { name: "Site", value: f.site, inline: true },
    ...(f.pageUrl ? [{ name: "Page", value: f.pageUrl, inline: true }] : []),
    ...(f.email ? [{ name: "Reply to", value: f.email, inline: true }] : []),
  ];
  return {
    allowed_mentions: { parse: [] as string[] },
    embeds: [{
      title: "New feedback",
      color: 0x3b82f6,
      fields,
      timestamp: now.toISOString(),
      footer: { text: "State Politics Tracker feedback" },
    }],
  };
}

/** Sliding-window limiter keyed by caller: at most `max` hits per `windowMs`.
 *  In memory, so per edge-function instance; enough to blunt a script, and
 *  Discord rate-limits the webhook on top. */
export function makeLimiter(max = 5, windowMs = 10 * 60 * 1000) {
  const hits = new Map<string, number[]>();
  return (key: string, now = Date.now()): boolean => {
    const recent = (hits.get(key) ?? []).filter((t) => now - t < windowMs);
    if (recent.length >= max) {
      hits.set(key, recent);
      return false;
    }
    recent.push(now);
    hits.set(key, recent);
    if (hits.size > 5000) hits.clear();
    return true;
  };
}
