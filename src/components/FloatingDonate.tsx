// Donate button pinned to the bottom-right corner of every page.
import { Heart } from "lucide-react";
import { DONATE_URL } from "@/lib/links";

export default function FloatingDonate() {
  return (
    <a
      href={DONATE_URL}
      target="_blank"
      rel="noopener noreferrer"
      className="fixed bottom-4 right-4 z-40 inline-flex items-center gap-2 rounded-full bg-primary px-5 py-3 text-sm font-semibold text-primary-foreground shadow-lg ring-1 ring-black/5 transition hover:-translate-y-0.5 hover:shadow-xl focus:outline-none focus-visible:ring-2 focus-visible:ring-ring md:bottom-6 md:right-6"
    >
      <Heart className="h-4 w-4" />
      Donate
    </a>
  );
}
