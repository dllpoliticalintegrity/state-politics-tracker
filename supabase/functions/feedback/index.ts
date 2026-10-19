// Edge function: the site's floating Feedback button
// (src/components/FloatingFeedback.tsx) posts here; the message goes to the
// team's Discord channel through a webhook. Ported from integrityindex's
// discord-feedback-notify (same secret name and embed style), but called
// directly by the form instead of a feedback_posts database webhook, since
// visitors here are anonymous and nothing needs storing.
//
// Secret: DISCORD_FEEDBACK_WEBHOOK_URL (Supabase dashboard -> Edge Functions
// -> Secrets). Deploy with verify_jwt off: the site calls it with the
// publishable key, which is not a JWT.
//   supabase functions deploy feedback --no-verify-jwt --project-ref lohxdfrxnxuxjdvvyfjc
//
// Abuse guards: a honeypot field, length limits, a per-IP limit of 5 messages
// per 10 minutes, and no @mentions in what reaches Discord (lib.ts).

import { discordPayload, makeLimiter, parseFeedback } from "./lib.ts";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const allow = makeLimiter();

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, "Content-Type": "application/json" },
  });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS });
  if (req.method !== "POST") return json({ error: "method not allowed" }, 405);

  const discordUrl = Deno.env.get("DISCORD_FEEDBACK_WEBHOOK_URL");
  if (!discordUrl) {
    console.error("DISCORD_FEEDBACK_WEBHOOK_URL not set");
    return json({ error: "feedback is not configured" }, 500);
  }

  const parsed = parseFeedback(await req.json().catch(() => null));
  if ("error" in parsed) {
    // A filled honeypot gets a normal "ok" so the bot learns nothing.
    return parsed.error === "spam" ? json({ ok: true }) : json({ error: parsed.error }, 400);
  }

  const ip = (req.headers.get("cf-connecting-ip") ??
    req.headers.get("x-forwarded-for")?.split(",")[0] ?? "unknown").trim();
  if (!allow(ip)) return json({ error: "too many messages, try again in a few minutes" }, 429);

  const res = await fetch(discordUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(discordPayload(parsed)),
  });
  if (!res.ok) {
    console.error(`Discord webhook failed: ${res.status} ${await res.text()}`);
    return json({ error: "couldn't deliver, please try again" }, 502);
  }
  return json({ ok: true });
});
