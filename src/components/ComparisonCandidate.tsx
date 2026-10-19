import { Link } from "react-router-dom";
import { ExternalLink, ArrowUpRight } from "lucide-react";
import type { TxCandidate } from "@/hooks/useCandidates";
import { CandidatePhoto } from "@/components/CandidatePhoto";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { ballotLabel, inactiveLabel } from "@/lib/candidateStatus";
import { partyLabel } from "@/lib/finance";
import { comparisonTextClass } from "@/lib/headToHead";

export default function ComparisonCandidate({ candidate, otherSlug, candidates, side, base, onChange }: {
  candidate: TxCandidate | undefined;
  otherSlug: string | undefined;
  candidates: TxCandidate[];
  side: string;
  base: string;
  onChange: (slug: string) => void;
}) {
  if (!candidate) return <div className="min-w-0 py-8 text-center text-sm text-muted-foreground">No opposing candidate listed.</div>;
  const status = inactiveLabel(candidate.status) ?? ballotLabel(candidate.status);
  const website = candidate.website && /^https?:\/\//i.test(candidate.website) ? candidate.website : null;
  return (
    <div className="min-w-0 space-y-4 text-center">
      <Select value={candidate.slug} onValueChange={onChange}>
        <SelectTrigger aria-label={`${side} candidate`} className="w-full min-w-0 text-left [&>span]:truncate">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {candidates.map((c) => (
            <SelectItem key={c.id} value={c.slug} disabled={c.slug === otherSlug}>
              {c.name}{inactiveLabel(c.status) ? ` · ${inactiveLabel(c.status)}` : ""}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <CandidatePhoto key={candidate.id} state={candidate.state} slug={candidate.slug} name={candidate.name}
        fallbackPhotoUrl={candidate.photo_url_medium ?? candidate.photo_url ?? candidate.photo_url_thumb}
        size="lg" className="mx-auto border" />
      <div>
        <h2 className="font-display text-xl md:text-3xl font-semibold break-words text-foreground">{candidate.name}</h2>
        <p className={`text-sm mt-1 ${comparisonTextClass(candidate.party)}`}>{partyLabel(candidate.party)}</p>
        {status && <p className="text-xs text-muted-foreground mt-1">{status}</p>}
      </div>
      <div className="flex justify-center flex-wrap gap-1">
        <Button asChild variant="outline" size="sm">
          <Link to={`${base}/candidates/${candidate.slug}`}>Profile <ArrowUpRight aria-hidden="true" /></Link>
        </Button>
        {website && <Button asChild variant="ghost" size="sm">
          <a href={website} target="_blank" rel="noopener noreferrer">Website <ExternalLink aria-hidden="true" /></a>
        </Button>}
      </div>
    </div>
  );
}