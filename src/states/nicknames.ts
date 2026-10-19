// Each state's best-known nickname, for the state home page's headline:
// "Follow the Money across the Lone Star State". Shared by the SPA and the
// Worker's crawler copy (shared/seo.ts).
export const STATE_NICKNAMES: Record<string, string> = {
  al: "Yellowhammer State",
  ak: "Last Frontier",
  az: "Grand Canyon State",
  ar: "Natural State",
  ca: "Golden State",
  co: "Centennial State",
  ct: "Constitution State",
  de: "First State",
  dc: "Nation's Capital",
  fl: "Sunshine State",
  ga: "Peach State",
  hi: "Aloha State",
  id: "Gem State",
  il: "Prairie State",
  in: "Hoosier State",
  ia: "Hawkeye State",
  ks: "Sunflower State",
  ky: "Bluegrass State",
  la: "Pelican State",
  me: "Pine Tree State",
  md: "Old Line State",
  ma: "Bay State",
  mi: "Great Lakes State",
  mn: "North Star State",
  ms: "Magnolia State",
  mo: "Show-Me State",
  mt: "Treasure State",
  ne: "Cornhusker State",
  nv: "Silver State",
  nh: "Granite State",
  nj: "Garden State",
  nm: "Land of Enchantment",
  ny: "Empire State",
  nc: "Tar Heel State",
  nd: "Peace Garden State",
  oh: "Buckeye State",
  ok: "Sooner State",
  or: "Beaver State",
  pa: "Keystone State",
  ri: "Ocean State",
  sc: "Palmetto State",
  sd: "Mount Rushmore State",
  tn: "Volunteer State",
  tx: "Lone Star State",
  ut: "Beehive State",
  vt: "Green Mountain State",
  va: "Old Dominion",
  wa: "Evergreen State",
  wv: "Mountain State",
  wi: "Badger State",
  wy: "Equality State",
};

/** "Follow the Money across the Lone Star State" (the state's name if it has no nickname here). */
export function homeHeadline(code: string, name: string): string {
  const nick = STATE_NICKNAMES[code.toLowerCase()];
  return nick ? `Follow the Money across the ${nick}` : `Follow the Money across ${name}`;
}

/**
 * A race page's headline: "Follow the Money in the Georgia Governor's Race";
 * a district race drops the possessive ("… the Michigan State Senate
 * District 11 Race").
 */
export function raceHeadline(stateName: string, race: { title: string; district?: string | null }): string {
  return race.district
    ? `Follow the Money in the ${stateName} ${race.title} Race`
    : `Follow the Money in the ${stateName} ${race.title}'s Race`;
}

/** A legislative chamber overview's headline: "Follow the Money in the Michigan State Senate". */
export function chamberHeadline(stateName: string, chamberTitle: string): string {
  return `Follow the Money in the ${stateName} ${chamberTitle}`;
}
