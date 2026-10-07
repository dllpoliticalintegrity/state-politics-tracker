import type { TxCandidate } from "@/hooks/useCandidates";

export type SocialLink = { key: string; label: string; href: string; handle: string };

/**
 * Build the outbound links a candidate profile shows (ported from the Texas
 * Politics Tracker). `cf_candidates` stores bare handles (the admin console
 * strips "@" and profile-URL prefixes on save), so the URL shape lives here
 * in one place. A handle that is somehow still a full URL is passed through
 * untouched.
 */
export function candidateSocialLinks(
  c: Pick<TxCandidate, "website" | "twitter_user" | "instagram_user" | "facebook_user" | "youtube_user">,
): SocialLink[] {
  const links: SocialLink[] = [];
  const clean = (v: string | null | undefined) => (v ?? "").trim().replace(/^@+/, "");
  const url = (base: string, handle: string) =>
    /^https?:\/\//i.test(handle) ? handle : `${base}${encodeURIComponent(handle)}`;

  if (c.website?.trim()) {
    const site = c.website.trim();
    links.push({
      key: "website",
      label: "Website",
      href: /^https?:\/\//i.test(site) ? site : `https://${site}`,
      handle: site.replace(/^https?:\/\//i, "").replace(/\/$/, ""),
    });
  }
  const tw = clean(c.twitter_user);
  if (tw) links.push({ key: "twitter", label: "X", href: url("https://x.com/", tw), handle: `@${tw}` });
  const ig = clean(c.instagram_user);
  if (ig) links.push({ key: "instagram", label: "Instagram", href: url("https://instagram.com/", ig), handle: `@${ig}` });
  const fb = clean(c.facebook_user);
  if (fb) links.push({ key: "facebook", label: "Facebook", href: url("https://facebook.com/", fb), handle: fb });
  const yt = clean(c.youtube_user);
  if (yt) links.push({ key: "youtube", label: "YouTube", href: url("https://youtube.com/@", yt), handle: `@${yt}` });
  return links;
}
