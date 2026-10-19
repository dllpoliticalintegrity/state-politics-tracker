// Keep mobile content unobstructed; float the donation link on desktop only.
import { Heart } from "lucide-react";
import { DONATE_URL } from "@/lib/links";

export default function FloatingDonate() {
  return (
    <a
      href={DONATE_URL}
      target="_blank"
      rel="noopener noreferrer"
      className="mx-auto my-4 flex w-fit items-center gap-2 rounded-full bg-primary px-5 py-3 text-sm font-semibold text-primary-foreground shadow-lg transition hover:-translate-y-0.5 hover:shadow-xl focus:outline-none focus-visible:ring-2 focus-visible:ring-ring xl:fixed xl:bottom-6 xl:right-6 xl:z-40 xl:m-0"
    >
      <Heart className="h-4 w-4" />
      Donate
    </a>
  );
}
