// Feedback button: the edge function's input checks and Discord message
// (supabase/functions/feedback/lib.ts) and the form that calls it.
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { discordPayload, makeLimiter, parseFeedback } from "../../supabase/functions/feedback/lib";

const invoke = vi.fn();
vi.mock("@/integrations/supabase/client", () => ({ supabase: { functions: { invoke: (...a: unknown[]) => invoke(...a) } } }));

describe("parseFeedback", () => {
  it("cleans a valid submission", () => {
    expect(parseFeedback({ message: "  Typo on the governor page ", email: " a@b.co ",
      pageUrl: "https://texaspoliticstracker.com/governor", site: "Texas Politics Tracker" }))
      .toEqual({ message: "Typo on the governor page", email: "a@b.co",
        pageUrl: "https://texaspoliticstracker.com/governor", site: "Texas Politics Tracker" });
  });

  it("requires a message and a plausible email, and caps lengths", () => {
    expect(parseFeedback({ message: "   " })).toEqual({ error: "message is required" });
    expect(parseFeedback({ message: "x".repeat(2001) })).toHaveProperty("error");
    expect(parseFeedback({ message: "hi", email: "not-an-email" })).toHaveProperty("error");
    expect(parseFeedback(null)).toHaveProperty("error");
  });

  it("flags a filled honeypot as spam and drops non-http page URLs", () => {
    expect(parseFeedback({ message: "buy now", website: "spam.example" })).toEqual({ error: "spam" });
    const ok = parseFeedback({ message: "hi", pageUrl: "javascript:alert(1)" });
    expect(ok).toMatchObject({ pageUrl: null, email: null, site: "State Politics Tracker" });
  });
});

describe("discordPayload", () => {
  it("never lets a message ping the channel and includes the page and reply email", () => {
    const p = discordPayload({ message: "@everyone look", email: "a@b.co",
      pageUrl: "https://statepoliticstracker.com/", site: "State Politics Tracker" }, new Date("2026-10-19T12:00:00Z"));
    expect(p.allowed_mentions).toEqual({ parse: [] });
    const names = p.embeds[0].fields.map((f) => f.name);
    expect(names).toEqual(["Message", "Site", "Page", "Reply to"]);
    expect(p.embeds[0].timestamp).toBe("2026-10-19T12:00:00.000Z");
  });

  it("splits a long message across two fields (Discord's 1024-character field limit)", () => {
    const p = discordPayload({ message: "x".repeat(1500), email: null, pageUrl: null, site: "S" });
    expect(p.embeds[0].fields.map((f) => f.value.length).slice(0, 2)).toEqual([1024, 476]);
  });
});

describe("makeLimiter", () => {
  it("allows max hits per window per caller", () => {
    const allow = makeLimiter(2, 1000);
    expect([allow("ip", 0), allow("ip", 1), allow("ip", 2), allow("other", 2)]).toEqual([true, true, false, true]);
    expect(allow("ip", 1500)).toBe(true);
  });
});

describe("FloatingFeedback", () => {
  beforeEach(() => invoke.mockReset());

  it("sends the message with the page and site, then thanks the visitor", async () => {
    invoke.mockResolvedValue({ data: { ok: true }, error: null });
    const { default: FloatingFeedback } = await import("@/components/FloatingFeedback");
    render(<FloatingFeedback />);
    fireEvent.click(screen.getByRole("button", { name: /feedback/i }));
    fireEvent.change(screen.getByLabelText("Your feedback"), { target: { value: "Love the race cards" } });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() => expect(screen.getByText("Thanks!")).toBeInTheDocument());
    expect(invoke).toHaveBeenCalledWith("feedback", {
      body: expect.objectContaining({ message: "Love the race cards", website: "", pageUrl: window.location.href,
        site: "State Politics Tracker" }),
    });
  });

  it("shows the server's error and keeps the message", async () => {
    invoke.mockResolvedValue({ data: null, error: { context: { json: async () => ({ error: "too many messages" }) } } });
    const { default: FloatingFeedback } = await import("@/components/FloatingFeedback");
    render(<FloatingFeedback />);
    fireEvent.click(screen.getByRole("button", { name: /feedback/i }));
    fireEvent.change(screen.getByLabelText("Your feedback"), { target: { value: "Hello" } });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("too many messages"));
    expect(screen.getByLabelText("Your feedback")).toHaveValue("Hello");
  });
});
