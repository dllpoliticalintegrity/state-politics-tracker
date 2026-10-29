// The org's outbound links, shared by the header, footer and floating button.
import { SITE_STATE } from "@/states/site";

/**
 * Source tag the donate link carries: `state-politics-tracker` on the hub,
 * `<code>-politics-tracker` on a dedicated state site (mi-politics-tracker).
 * The donate site records it on the gift (pip_donations.link_source) so the
 * org can see which tracker sent the donor even when the browser sends no
 * referrer.
 */
export const DONATE_SOURCE = SITE_STATE
  ? `${SITE_STATE.code.toLowerCase()}-politics-tracker`
  : "state-politics-tracker";

/**
 * The donate site's rule for a source tag (`normalizeLinkSource` in the
 * donate repo's src/lib/referrer.ts; TAG_PATTERN in the admin console's
 * src/lib/donateLinkBuilder.ts): lowercase, [a-z0-9._-], 64 characters max.
 * A tag that breaks it is dropped there, and the gift reads "untagged".
 */
export const SOURCE_TAG_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/;

/**
 * The donation page tagged with this site's source, plus a placement when
 * the link should be told apart from the others: the popup's donate link
 * is `<site>-popup` (mi-politics-tracker-popup), so the Donations page's
 * "Link sources" card shows what the popup raised beside the floating
 * button and header, which keep the plain site tag.
 */
export function donateUrl(placement?: string): string {
  const tag = placement ? `${DONATE_SOURCE}-${placement}` : DONATE_SOURCE;
  return `https://donate.politicalintegrity.us/?source=${tag}`;
}

/** Hosted donation page, tagged with this site's source. */
export const DONATE_URL = donateUrl();

/** The support popup's donate link (src/components/SupportPopup.tsx). */
export const DONATE_POPUP_URL = donateUrl("popup");

/** Newsletter signup form (Substack, on the org's own domain). */
export const NEWSLETTER_SIGNUP_URL = "https://newsletter.politicalintegrity.us/subscribe";
