// Feedback floats bottom-left and Donate bottom-right on every screen size
// (owner's call, 2026-10-19). Pinned here because the Lovable design sandbox
// once moved Donate inline on phones; a design sync that does it again fails
// this test in its PR.
import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import FloatingDonate from "@/components/FloatingDonate";
import FloatingFeedback from "@/components/FloatingFeedback";

vi.mock("@/integrations/supabase/client", () => ({ supabase: { functions: { invoke: vi.fn() } } }));

const classes = (el: HTMLElement) => el.className.split(/\s+/);

describe("floating buttons", () => {
  it("floats Donate bottom-right at every width", () => {
    render(<FloatingDonate />);
    const c = classes(screen.getByRole("link", { name: /donate/i }));
    expect(c).toEqual(expect.arrayContaining(["fixed", "bottom-20", "right-4", "xl:bottom-6"]));
    expect(c.some((x) => /^(xl|lg|md|sm):fixed$/.test(x))).toBe(false);
  });

  it("tags the donate link with this site's source (the hub, in the test build)", () => {
    render(<FloatingDonate />);
    expect(screen.getByRole("link", { name: /donate/i })).toHaveAttribute(
      "href",
      "https://donate.politicalintegrity.us/?source=state-politics-tracker",
    );
  });

  it("floats Feedback bottom-left at every width", () => {
    render(<FloatingFeedback />);
    const c = classes(screen.getByRole("button", { name: /feedback/i }));
    expect(c).toEqual(expect.arrayContaining(["fixed", "bottom-20", "left-4", "xl:bottom-6"]));
    expect(c.some((x) => /^(xl|lg|md|sm):fixed$/.test(x))).toBe(false);
  });
});
