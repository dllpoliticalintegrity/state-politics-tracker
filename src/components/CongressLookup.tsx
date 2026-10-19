import { ExternalLink, Landmark } from "lucide-react";
import { Button } from "@/components/ui/button";

export const INTEGRITY_INDEX_URL = "https://integrityindex.us/";

export default function CongressLookup() {
  return (
    <div className="flex justify-center sm:block">
      <Button
        asChild
        className="bg-[hsl(var(--logo-green))] text-[hsl(var(--logo-green-foreground))] hover:bg-[hsl(var(--logo-green)/0.9)]"
      >
        <a
          href={INTEGRITY_INDEX_URL}
          target="_blank"
          rel="noopener noreferrer"
          aria-label="Looking for your member of U.S Congress? Open the Integrity Index (opens in a new tab)"
        >
          <Landmark aria-hidden="true" />
          Looking for your member of U.S Congress?
          <ExternalLink aria-hidden="true" />
        </a>
      </Button>
    </div>
  );
}
