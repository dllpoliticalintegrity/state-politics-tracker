import { useEffect, useState } from "react";
import { CalendarDays } from "lucide-react";
import { timeUntilMidterms, midtermsStatus } from "@/lib/midterms";

export default function MidtermsCountdown() {
  const [now, setNow] = useState(() => new Date());

  useEffect(() => {
    const timer = window.setInterval(() => setNow(new Date()), 1_000);
    return () => window.clearInterval(timer);
  }, []);

  const remaining = timeUntilMidterms(now);
  const status = midtermsStatus(now);

  return (
    <div className="mx-auto flex w-fit max-w-full items-center gap-2 whitespace-nowrap border-y border-primary/25 px-1 py-3 text-xs sm:gap-3 sm:px-3 sm:text-sm">
      <p className="flex shrink-0 items-center gap-1 sm:gap-2 text-foreground">
        <CalendarDays aria-hidden="true" className="h-3.5 w-3.5 shrink-0 text-primary sm:h-4 sm:w-4" />
        <span className="hidden sm:inline">Countdown to the midterms</span>
        <span className="sm:hidden">Midterms</span>
      </p>
      <div className="text-foreground" role="timer" aria-live="off">
        {status === "upcoming" ? (
          <div className="flex items-center gap-1.5 sm:gap-3" aria-label={`${remaining.days} days, ${remaining.hours} hours, ${remaining.minutes} minutes, ${remaining.seconds} seconds`}>
            {Object.entries(remaining).map(([unit, value]) => (
              <div key={unit} className="flex items-baseline gap-0.5 sm:gap-1">
                <strong className="font-mono text-sm sm:text-base font-semibold tabular-nums text-primary">{String(value).padStart(2, "0")}</strong>
                <span className="text-[11px] text-muted-foreground"><span className="hidden sm:inline">{unit}</span><span className="sm:hidden">{unit === "minutes" ? "m" : unit.charAt(0)}</span></span>
              </div>
            ))}
          </div>
        ) : status === "today" ? (
          <strong className="text-primary">Today is Election Day</strong>
        ) : (
          <strong>2026 midterms complete</strong>
        )}
      </div>
      <time dateTime="2026-11-03" className="text-[11px] sm:text-xs text-muted-foreground"><span className="hidden sm:inline">November 3, 2026</span><span className="sm:hidden">Nov 3</span></time>
    </div>
  );
}