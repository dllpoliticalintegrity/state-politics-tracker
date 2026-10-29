// A one-time "support this work" popup: 30 seconds after a visitor arrives
// it offers the donate link (tagged `<site>-popup`, so gifts it brings in
// are counted apart from the floating button's) and the newsletter sign-up. Closing it, or following
// either link, keeps it away for SNOOZE_DAYS; it also shows at most once per
// browser session. Storage can be blocked (private windows), so every read
// and write is guarded, and a visitor without storage simply sees it once
// per page load.
import { useEffect, useRef, useState } from "react";
import { Heart, Mail } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { DONATE_POPUP_URL, NEWSLETTER_SIGNUP_URL } from "@/lib/links";
import { SITE_NAME } from "@/states/site";
import {
  SUPPORT_POPUP_DELAY_MS,
  markSupportPopupShown,
  snoozeSupportPopup,
  supportPopupDue,
} from "@/lib/supportPopup";

export default function SupportPopup({ delayMs = SUPPORT_POPUP_DELAY_MS }: { delayMs?: number }) {
  const [open, setOpen] = useState(false);
  const contentRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!supportPopupDue()) return;
    const timer = window.setTimeout(() => {
      // Re-check: another tab may have snoozed it meanwhile.
      if (!supportPopupDue()) return;
      markSupportPopupShown();
      setOpen(true);
    }, delayMs);
    return () => window.clearTimeout(timer);
  }, [delayMs]);

  const close = () => {
    snoozeSupportPopup();
    setOpen(false);
  };

  return (
    <Dialog open={open} onOpenChange={(o) => (o ? setOpen(true) : close())}>
      <DialogContent
        ref={contentRef}
        // Focus the dialog itself rather than its first button, so nothing
        // looks pre-selected; Tab then reaches Donate first.
        onOpenAutoFocus={(e) => {
          e.preventDefault();
          contentRef.current?.focus();
        }}
        className="w-[calc(100vw-2rem)] max-w-md gap-5 rounded-lg p-6 focus:outline-none sm:p-7"
      >
        <DialogHeader className="space-y-2 text-left">
          <span className="inline-flex h-10 w-10 items-center justify-center rounded-full bg-primary/10 text-primary" aria-hidden="true">
            <Heart className="h-5 w-5" />
          </span>
          <DialogTitle className="font-display text-2xl leading-tight">Keep {SITE_NAME} free</DialogTitle>
          <DialogDescription className="text-sm leading-relaxed">
            We track who is funding every statewide race, straight from the state's own filings, and publish it for
            free with no ads. A gift of any size keeps the data flowing, and our newsletter tells you when the money
            moves.
          </DialogDescription>
        </DialogHeader>
        <DialogFooter className="flex-col gap-2 sm:flex-col sm:space-x-0">
          <a
            href={DONATE_POPUP_URL}
            target="_blank"
            rel="noopener noreferrer"
            onClick={close}
            className="inline-flex h-11 w-full items-center justify-center gap-2 rounded-md bg-primary px-5 text-sm font-semibold text-primary-foreground shadow-sm transition hover:bg-primary/90 focus:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
          >
            <Heart className="h-4 w-4" aria-hidden="true" />
            Donate
          </a>
          <a
            href={NEWSLETTER_SIGNUP_URL}
            target="_blank"
            rel="noopener noreferrer"
            onClick={close}
            className="inline-flex h-11 w-full items-center justify-center gap-2 rounded-md border bg-background px-5 text-sm font-semibold text-foreground transition hover:bg-accent focus:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
          >
            <Mail className="h-4 w-4" aria-hidden="true" />
            Sign up for updates
          </a>
          <button
            type="button"
            onClick={close}
            className="mt-1 h-9 rounded-md text-xs text-muted-foreground underline-offset-2 hover:text-foreground hover:underline focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            Not now
          </button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
