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

/** Hosted donation page, tagged with this site's source. */
export const DONATE_URL = `https://donate.politicalintegrity.us/?source=${DONATE_SOURCE}`;

/** Newsletter signup form (Substack, on the org's own domain). */
export const NEWSLETTER_SIGNUP_URL = "https://newsletter.politicalintegrity.us/subscribe";
