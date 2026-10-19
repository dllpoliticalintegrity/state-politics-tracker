import { ExternalLink, Landmark } from "lucide-react";
import { Button } from "@/components/ui/button";

export const INTEGRITY_INDEX_URL = "https://integrityindex.us/";

export default function CongressLookup() {
  return (
    <div className="flex justify-center sm:block">
      <Button
        asChild
        className="h-auto min-h-11 max-w-full whitespace-normal py-2.5 text-center bg-[hsl(var(--logo-green))] text-[hsl(var(--logo-green-foreground))] hover:bg-[hsl(var(--logo-green)/0.9)]"
      >
        <a
          href={INTEGRITY_INDEX_URL}
          target="_blank"
          rel="noopener noreferrer"
          aria-label="Looking for your member of U.S Congress? Open the Integrity Index (opens in a new tab)"
        >
          <Landmark aria-hidden="true" />
          <span className="min-w-0 break-words">Looking for your member of U.S Congress?</span>
          <ExternalLink aria-hidden="true" />
        </a>
      </Button>
    </div>
  );
}
