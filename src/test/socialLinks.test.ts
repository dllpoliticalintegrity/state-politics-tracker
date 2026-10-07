import { describe, expect, it } from "vitest";
import { candidateSocialLinks } from "@/lib/socialLinks";

const none = { website: null, twitter_user: null, instagram_user: null, facebook_user: null, youtube_user: null };

describe("candidateSocialLinks", () => {
  it("returns nothing when no links are set", () => {
    expect(candidateSocialLinks(none)).toEqual([]);
  });

  it("builds profile URLs from bare handles and tolerates a stray @", () => {
    const links = candidateSocialLinks({
      ...none,
      twitter_user: "GregAbbott_TX",
      instagram_user: "@ginaforTX",
      facebook_user: "TexansForAbbott",
      youtube_user: "ginaforTX",
    });
    expect(links.map((l) => [l.label, l.href, l.handle])).toEqual([
      ["X", "https://x.com/GregAbbott_TX", "@GregAbbott_TX"],
      ["Instagram", "https://instagram.com/ginaforTX", "@ginaforTX"],
      ["Facebook", "https://facebook.com/TexansForAbbott", "TexansForAbbott"],
      ["YouTube", "https://youtube.com/@ginaforTX", "@ginaforTX"],
    ]);
  });

  it("prefixes a bare website domain with https and shows it without the scheme", () => {
    const [site] = candidateSocialLinks({ ...none, website: "gregabbott.com/" });
    expect(site.href).toBe("https://gregabbott.com/");
    expect(site.handle).toBe("gregabbott.com");
  });

  it("passes a full profile URL through untouched", () => {
    const [x] = candidateSocialLinks({ ...none, twitter_user: "https://x.com/someone" });
    expect(x.href).toBe("https://x.com/someone");
  });
});
