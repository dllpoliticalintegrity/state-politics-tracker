/** Time remaining until November 3, 2026 at midnight in the reader's time zone. */
export function timeUntilMidterms(now = new Date()) {
  const secondsLeft = Math.max(0, Math.floor((new Date(2026, 10, 3).getTime() - now.getTime()) / 1_000));
  return {
    days: Math.floor(secondsLeft / 86_400),
    hours: Math.floor((secondsLeft % 86_400) / 3_600),
    minutes: Math.floor((secondsLeft % 3_600) / 60),
    seconds: secondsLeft % 60,
  };
}

export function midtermsStatus(now = new Date()): "upcoming" | "today" | "past" {
  const today = Date.UTC(now.getFullYear(), now.getMonth(), now.getDate());
  const electionDay = Date.UTC(2026, 10, 3);
  return today < electionDay ? "upcoming" : today === electionDay ? "today" : "past";
}