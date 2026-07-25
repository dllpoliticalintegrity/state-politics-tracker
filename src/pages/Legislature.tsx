import { useMemo, useState } from "react";
import { ExternalLink, Mail, Phone } from "lucide-react";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import OfficialPhoto from "@/components/OfficialPhoto";
import {
  useLegislature,
  type ChamberRoster,
  type Official,
  type OfficialFinance,
} from "@/hooks/useOfficials";
import { formatCurrency, partyColor, partyLabel } from "@/lib/finance";
import {
  OPENSTATES_PEOPLE_REPO,
  OPENSTATES_URL,
  chamberLabel,
  memberLabel,
  partyAbbrev,
} from "@/lib/openstates";
import { useStateConfig } from "@/states/StateContext";

/**
 * Who currently sits in the state legislature — the chamber that writes the
 * laws the statewide races are fought over. Rostered from Open States'
 * public-domain people dataset (cf_officials), synced weekly.
 */
export default function Legislature() {
  const stateCfg = useStateConfig();
  const { data: chambers, isLoading } = useLegislature();
  const [query, setQuery] = useState("");

  const totalSeats = (chambers ?? []).reduce((n, c) => n + c.members.length, 0);

  return (
    <div className="min-h-[80vh]">
      <section className="container pt-12 md:pt-16 pb-6 max-w-3xl space-y-3">
        <p className="text-xs font-semibold uppercase tracking-[0.14em] text-muted-foreground">
          {stateCfg.name} Legislature
        </p>
        <h1 className="font-display text-3xl md:text-4xl font-bold tracking-tight leading-tight">
          Who holds power in {stateCfg.name} right now
        </h1>
        <p className="text-base text-muted-foreground">
          Every sitting member of the {stateCfg.name} legislature — party,
          district, contact details, and what their campaign has raised and spent
          this cycle. Whoever wins the 2026 statewide races will govern with — or
          against — this chamber.
        </p>
      </section>

      {isLoading && (
        <div className="container pb-16 text-sm text-muted-foreground">Loading roster…</div>
      )}

      {!isLoading && totalSeats === 0 && (
        <section className="container pb-16">
          <Card className="p-6 text-sm text-muted-foreground max-w-2xl">
            <p className="mb-2 text-foreground font-medium">Roster not synced yet</p>
            <p>
              The {stateCfg.name} roster loads from Open States on the weekly
              officeholder sync. Nothing has landed for this state yet — check
              back after the next run.
            </p>
          </Card>
        </section>
      )}

      {!isLoading && totalSeats > 0 && (
        <section className="container pb-16">
          <Tabs defaultValue={(chambers ?? [])[0]?.chamber ?? "upper"}>
            <div className="flex flex-wrap items-center justify-between gap-3 mb-5">
              <TabsList>
                {(chambers ?? []).map((c) => (
                  <TabsTrigger key={c.chamber} value={c.chamber}>
                    {chamberLabel(stateCfg.code, c.chamber)}
                    <span className="ml-1.5 text-muted-foreground">{c.members.length}</span>
                  </TabsTrigger>
                ))}
              </TabsList>
              <Input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search by name, party, or district"
                className="h-9 w-full sm:w-72"
                aria-label="Search members"
              />
            </div>

            {(chambers ?? []).map((c) => (
              <TabsContent key={c.chamber} value={c.chamber} className="mt-0">
                <ChamberPanel roster={c} stateCode={stateCfg.code} query={query} />
              </TabsContent>
            ))}
          </Tabs>

          <p className="text-xs text-muted-foreground mt-8">
            Officeholder data from{" "}
            <a
              href={OPENSTATES_URL}
              target="_blank"
              rel="noopener noreferrer"
              className="text-primary hover:underline"
            >
              Open States
            </a>{" "}
            — curated in{" "}
            <a
              href={OPENSTATES_PEOPLE_REPO}
              target="_blank"
              rel="noopener noreferrer"
              className="text-primary hover:underline"
            >
              openstates/people
            </a>{" "}
            and released into the public domain (CC0). Synced weekly; vacancies
            and mid-term appointments appear after the next sync.
          </p>
          <p className="text-xs text-muted-foreground mt-2">
            Campaign finance comes from{" "}
            {stateCfg.agency ? (
              <a
                href={stateCfg.agency.url}
                target="_blank"
                rel="noopener noreferrer"
                className="text-primary hover:underline"
              >
                {stateCfg.agency.name}
              </a>
            ) : (
              "the state's disclosure agency"
            )}
            . Each member's committee is matched on the office and district the
            committee itself filed under, and totals count only transactions
            dated inside the 2025–2026 cycle — a committee's lifetime balance is
            not this cycle's fundraising. Money raised for a different office
            (a member running statewide) is not counted here.
          </p>
        </section>
      )}
    </div>
  );
}

function ChamberPanel({
  roster,
  stateCode,
  query,
}: {
  roster: ChamberRoster;
  stateCode: string;
  query: string;
}) {
  const [sort, setSort] = useState<"district" | "raised">("raised");
  const q = query.trim().toLowerCase();
  const members = useMemo(() => {
    const filtered = !q
      ? roster.members
      : roster.members.filter((m) =>
          [m.name, m.party, m.district && `district ${m.district}`]
            .filter(Boolean)
            .join(" ")
            .toLowerCase()
            .includes(q),
        );
    return sort === "raised"
      ? [...filtered].sort((a, b) => (b.finance?.raised ?? 0) - (a.finance?.raised ?? 0))
      : filtered; // already district-ordered by the hook
  }, [roster.members, q, sort]);

  return (
    <div className="space-y-5">
      <PartySplit roster={roster} />
      <div className="flex items-center justify-between gap-3 text-xs">
        <span className="text-muted-foreground">
          {roster.seatsWithFinance === roster.members.length
            ? `Campaign finance matched for all ${roster.members.length} seats`
            : `Campaign finance matched for ${roster.seatsWithFinance} of ${roster.members.length} seats`}
        </span>
        <div className="inline-flex rounded-md border p-0.5">
          {(["raised", "district"] as const).map((mode) => (
            <button
              key={mode}
              onClick={() => setSort(mode)}
              className={`px-2 py-1 rounded-sm transition-colors ${
                sort === mode
                  ? "bg-accent font-medium text-foreground"
                  : "text-muted-foreground hover:text-foreground"
              }`}
            >
              {mode === "raised" ? "By money raised" : "By district"}
            </button>
          ))}
        </div>
      </div>
      {members.length === 0 ? (
        <div className="text-sm text-muted-foreground py-10 text-center">
          No members match “{query}”.
        </div>
      ) : (
        <div className="grid gap-3 grid-cols-[repeat(auto-fill,minmax(280px,1fr))]">
          {members.map((m) => (
            <MemberCard key={m.id} member={m} stateCode={stateCode} />
          ))}
        </div>
      )}
    </div>
  );
}

function PartySplit({ roster }: { roster: ChamberRoster }) {
  const total = roster.members.length;
  return (
    <div className="rounded-lg border bg-card p-4">
      <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1 mb-3 text-sm">
        {roster.parties.map((p) => (
          <span key={p.party} className="inline-flex items-center gap-1.5">
            <span
              className="inline-block h-2.5 w-2.5 rounded-sm"
              style={{ backgroundColor: partyColor(p.party) }}
              aria-hidden
            />
            <span className="font-semibold tabular-nums">{p.seats}</span>
            <span className="text-muted-foreground">{partyLabel(p.party)}</span>
          </span>
        ))}
        <span className="ml-auto text-xs text-muted-foreground">
          {total} seats
          {roster.totalRaised > 0 && ` · ${formatCurrency(roster.totalRaised)} raised this cycle`}
        </span>
      </div>
      <div className="flex h-2.5 w-full overflow-hidden rounded-full bg-muted" role="img"
        aria-label={roster.parties.map((p) => `${p.seats} ${partyLabel(p.party)}`).join(", ")}>
        {roster.parties.map((p) => (
          <div
            key={p.party}
            style={{
              width: `${(p.seats / Math.max(1, total)) * 100}%`,
              backgroundColor: partyColor(p.party),
            }}
          />
        ))}
      </div>
    </div>
  );
}

function MemberCard({
  member,
  stateCode,
}: {
  member: Official & { finance?: OfficialFinance };
  stateCode: string;
}) {
  const color = partyColor(member.party);
  const link = (member.links ?? [])[0]?.url ?? null;
  const abbrev = partyAbbrev(member.party);
  const finance = member.finance;

  return (
    <div className="rounded-lg border bg-card p-4 flex items-start gap-3">
      <OfficialPhoto name={member.name} imageUrl={member.image_url} borderColor={color} size="sm" />
      <div className="min-w-0 flex-1">
        <div className="font-medium leading-tight truncate">{member.name}</div>
        <div className="text-xs text-muted-foreground mt-0.5">
          {[
            abbrev,
            member.district ? `District ${member.district}` : null,
            member.chamber ? memberLabel(stateCode, member.chamber) : null,
          ]
            .filter(Boolean)
            .join(" · ")}
        </div>

        {finance && (
          <div className="mt-2.5 pt-2.5 border-t border-dashed">
            <div className="flex items-baseline justify-between gap-2">
              <span className="font-mono font-semibold tabular-nums">
                {formatCurrency(finance.raised)}
              </span>
              <span className="text-[11px] text-muted-foreground">
                raised · {formatCurrency(finance.spent)} spent
              </span>
            </div>
            <div className="text-[11px] text-muted-foreground mt-1 truncate">
              {finance.committees.map((c) => c.name).join(", ")}
            </div>
            {finance.weakest_match && finance.weakest_match !== "district_id" && (
              // The total rests on something weaker than an office+district
              // match — say so rather than presenting it with equal confidence.
              <div className="text-[11px] text-muted-foreground/80 mt-0.5">
                Committee matched by name only
              </div>
            )}
          </div>
        )}

        <div className="flex items-center gap-3 mt-2 text-xs">
          {member.email && (
            <a
              href={`mailto:${member.email}`}
              className="text-muted-foreground hover:text-foreground inline-flex items-center gap-1"
              aria-label={`Email ${member.name}`}
            >
              <Mail className="h-3 w-3" /> Email
            </a>
          )}
          {member.phone && (
            <span className="text-muted-foreground inline-flex items-center gap-1">
              <Phone className="h-3 w-3" /> {member.phone}
            </span>
          )}
          {link && (
            <a
              href={link}
              target="_blank"
              rel="noopener noreferrer"
              className="text-primary hover:underline inline-flex items-center gap-1 ml-auto"
              aria-label={`Official page for ${member.name}`}
            >
              Page <ExternalLink className="h-3 w-3" />
            </a>
          )}
        </div>
      </div>
    </div>
  );
}
