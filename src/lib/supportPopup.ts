// The support popup's timing rules (src/components/SupportPopup.tsx): when
// it may open and how a dismissal is remembered. Storage can be blocked
// (private windows), so every read and write is guarded.

/** How long a visitor is on the site before the popup opens. */
export const SUPPORT_POPUP_DELAY_MS = 30_000;
/** How long a dismissal (or a click through) keeps it away. */
export const SNOOZE_DAYS = 14;
export const SNOOZE_KEY = "spt:support-popup:until";
export const SESSION_KEY = "spt:support-popup:shown";

const DAY_MS = 24 * 60 * 60 * 1000;

export function readStore(store: () => Storage, key: string): string | null {
  try {
    return store().getItem(key);
  } catch {
    return null;
  }
}

export function writeStore(store: () => Storage, key: string, value: string) {
  try {
    store().setItem(key, value);
  } catch {
    /* storage blocked: the popup just isn't remembered */
  }
}

/** Whether the popup may open now (not snoozed, not already shown this session). */
export function supportPopupDue(now = Date.now()): boolean {
  const until = Number(readStore(() => localStorage, SNOOZE_KEY) ?? 0);
  if (Number.isFinite(until) && until > now) return false;
  return readStore(() => sessionStorage, SESSION_KEY) !== "1";
}

/** Keep the popup away for SNOOZE_DAYS (on close or a click through). */
export function snoozeSupportPopup(now = Date.now()) {
  writeStore(() => localStorage, SNOOZE_KEY, String(now + SNOOZE_DAYS * DAY_MS));
}

/** Record that the popup has been shown in this browser session. */
export function markSupportPopupShown() {
  writeStore(() => sessionStorage, SESSION_KEY, "1");
}
