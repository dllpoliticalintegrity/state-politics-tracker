import { ExternalLink, MapPin } from "lucide-react";
import { Button } from "@/components/ui/button";

interface RepresentativeLookupProps {
  url: string;
  stateName: string;
}

export default function RepresentativeLookup({ url, stateName }: RepresentativeLookupProps) {
  return (
    <div>
      <Button asChild>
        <a
          href={url}
          target="_blank"
          rel="noopener noreferrer"
          aria-label={`Who's my rep? — ${stateName} official website (opens in a new tab)`}
        >
          <MapPin aria-hidden="true" />
          Who's my rep?
          <ExternalLink aria-hidden="true" />
        </a>
      </Button>
    </div>
  );
}