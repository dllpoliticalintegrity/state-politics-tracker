import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
import SupportPopup from "@/components/SupportPopup";
import { SESSION_KEY, SNOOZE_DAYS, SNOOZE_KEY, SUPPORT_POPUP_DELAY_MS, supportPopupDue } from "@/lib/supportPopup";

describe("support popup", () => {
  beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
    vi.useFakeTimers();
  });
  afterEach(() => vi.useRealTimers());

  it("opens after 30 seconds, not before", () => {
    expect(SUPPORT_POPUP_DELAY_MS).toBe(30_000);
    render(<SupportPopup />);
    act(() => vi.advanceTimersByTime(29_999));
    expect(screen.queryByRole("dialog")).toBeNull();
    act(() => vi.advanceTimersByTime(1));
    expect(screen.getByRole("dialog")).toBeInTheDocument();
  });

  it("opens with focus on the dialog, Donate first in tab order", () => {
    render(<SupportPopup />);
    act(() => vi.advanceTimersByTime(SUPPORT_POPUP_DELAY_MS));
    expect(document.activeElement).toBe(screen.getByRole("dialog"));
  });

  it("links to the tagged donate page and the newsletter sign-up", () => {
    render(<SupportPopup />);
    act(() => vi.advanceTimersByTime(SUPPORT_POPUP_DELAY_MS));
    expect(screen.getByRole("link", { name: /donate/i })).toHaveAttribute(
      "href",
      "https://donate.politicalintegrity.us/?source=state-politics-tracker",
    );
    expect(screen.getByRole("link", { name: /sign up/i })).toHaveAttribute(
      "href",
      "https://newsletter.politicalintegrity.us/subscribe",
    );
  });

  it("snoozes for two weeks when closed, and shows once per session", () => {
    const now = Date.now();
    render(<SupportPopup />);
    act(() => vi.advanceTimersByTime(SUPPORT_POPUP_DELAY_MS));
    expect(sessionStorage.getItem(SESSION_KEY)).toBe("1");
    fireEvent.click(screen.getByRole("button", { name: /not now/i }));
    const until = Number(localStorage.getItem(SNOOZE_KEY));
    expect(until).toBeGreaterThanOrEqual(now + SNOOZE_DAYS * 24 * 60 * 60 * 1000);
    expect(supportPopupDue()).toBe(false);
    // Snooze lapsed but still this session: not again.
    localStorage.setItem(SNOOZE_KEY, "0");
    expect(supportPopupDue()).toBe(false);
    sessionStorage.clear();
    expect(supportPopupDue()).toBe(true);
  });

  it("stays shut while snoozed", () => {
    localStorage.setItem(SNOOZE_KEY, String(Date.now() + 60_000));
    render(<SupportPopup />);
    act(() => vi.advanceTimersByTime(SUPPORT_POPUP_DELAY_MS * 2));
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});
