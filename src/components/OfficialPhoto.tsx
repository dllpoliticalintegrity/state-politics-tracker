import { useState } from "react";
import { cn } from "@/lib/utils";

const sizeClasses = {
  sm: "w-10 h-10",
  md: "w-14 h-14",
  lg: "w-20 h-20",
} as const;

function initialsOf(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return "—";
  return ((parts[0][0] ?? "") + (parts[parts.length - 1][0] ?? "")).toUpperCase();
}

/**
 * Portrait for an Open States officeholder. Their `image` points at the
 * official state or NAAG portrait, which occasionally 404s or hotlink-blocks —
 * fall back to initials rather than a broken image.
 */
export default function OfficialPhoto({
  name,
  imageUrl,
  borderColor,
  size = "md",
  className,
}: {
  name: string;
  imageUrl: string | null | undefined;
  borderColor?: string;
  size?: keyof typeof sizeClasses;
  className?: string;
}) {
  const [failed, setFailed] = useState(false);

  if (!imageUrl || failed) {
    return (
      <div
        className={cn(
          sizeClasses[size],
          "rounded-full border-2 bg-muted flex items-center justify-center font-display text-sm shrink-0",
          className,
        )}
        style={borderColor ? { borderColor } : undefined}
      >
        {initialsOf(name)}
      </div>
    );
  }

  return (
    <img
      src={imageUrl}
      alt={name}
      loading="lazy"
      onError={() => setFailed(true)}
      className={cn(sizeClasses[size], "rounded-full border-2 object-cover shrink-0", className)}
      style={borderColor ? { borderColor } : undefined}
    />
  );
}
