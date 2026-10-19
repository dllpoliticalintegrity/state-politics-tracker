// Feedback button pinned to the bottom-left corner of every page (the
// mirror of FloatingDonate). Opens a short form whose message goes to the
// team's Discord channel through the `feedback` edge function
// (supabase/functions/feedback). The page URL and site name ride along.
import { useState } from "react";
import { MessageSquare } from "lucide-react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { supabase } from "@/integrations/supabase/client";
import { SITE_NAME } from "@/states/site";

const MAX_MESSAGE = 2000;

type Status = "idle" | "sending" | "sent" | "error";

export default function FloatingFeedback() {
  const [open, setOpen] = useState(false);
  const [message, setMessage] = useState("");
  const [email, setEmail] = useState("");
  const [website, setWebsite] = useState(""); // honeypot: hidden from people
  const [status, setStatus] = useState<Status>("idle");
  const [error, setError] = useState("");

  const onOpenChange = (next: boolean) => {
    setOpen(next);
    if (!next && status === "sent") {
      setStatus("idle");
      setMessage("");
      setEmail("");
    }
  };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!message.trim() || status === "sending") return;
    setStatus("sending");
    setError("");
    const { data, error: err } = await supabase.functions.invoke("feedback", {
      body: { message, email, website, pageUrl: window.location.href, site: SITE_NAME },
    });
    if (err || !data?.ok) {
      let msg = "Couldn't send. Please try again.";
      try {
        const body = await (err as { context?: Response })?.context?.json?.();
        if (body?.error) msg = String(body.error);
      } catch { /* keep the generic message */ }
      setError(msg);
      setStatus("error");
      return;
    }
    setStatus("sent");
  };

  return (
    <Popover open={open} onOpenChange={onOpenChange}>
      <PopoverTrigger asChild>
        <button
          type="button"
          className="fixed bottom-20 left-4 z-40 inline-flex items-center gap-2 rounded-full border bg-background px-4 py-3 text-sm font-semibold text-foreground shadow-lg ring-1 ring-black/5 transition hover:-translate-y-0.5 hover:shadow-xl focus:outline-none focus-visible:ring-2 focus-visible:ring-ring md:left-6 xl:bottom-6"
        >
          <MessageSquare className="h-4 w-4" />
          Feedback
        </button>
      </PopoverTrigger>
      <PopoverContent side="top" align="start" className="w-[min(22rem,calc(100vw-2rem))]">
        {status === "sent" ? (
          <div className="space-y-2 py-2 text-center">
            <p className="font-semibold">Thanks!</p>
            <p className="text-sm text-muted-foreground">Your feedback went straight to our team.</p>
            <Button variant="outline" size="sm" onClick={() => onOpenChange(false)}>Close</Button>
          </div>
        ) : (
          <form onSubmit={submit} className="space-y-3">
            <div>
              <p className="font-semibold">Send us feedback</p>
              <p className="text-xs text-muted-foreground">Spotted a mistake or have an idea? Tell us.</p>
            </div>
            <Textarea
              aria-label="Your feedback"
              placeholder="What's on your mind?"
              value={message}
              onChange={(e) => setMessage(e.target.value.slice(0, MAX_MESSAGE))}
              rows={4}
              required
            />
            <Input
              aria-label="Email (optional)"
              type="email"
              placeholder="Email (optional, if you'd like a reply)"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
            />
            {/* Honeypot: off-screen and skipped by keyboard and screen readers. */}
            <input
              type="text"
              name="website"
              tabIndex={-1}
              autoComplete="off"
              aria-hidden="true"
              className="absolute -left-[9999px] h-0 w-0 opacity-0"
              value={website}
              onChange={(e) => setWebsite(e.target.value)}
            />
            {status === "error" && <p role="alert" className="text-sm text-destructive">{error}</p>}
            <div className="flex items-center justify-between gap-2">
              <span className="text-xs text-muted-foreground">{message.length}/{MAX_MESSAGE}</span>
              <Button type="submit" size="sm" disabled={!message.trim() || status === "sending"}>
                {status === "sending" ? "Sending…" : "Send"}
              </Button>
            </div>
          </form>
        )}
      </PopoverContent>
    </Popover>
  );
}
