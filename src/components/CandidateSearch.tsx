// Search box for candidate names on a site's home page: the pinned state's
// candidates on a dedicated site, every tracker-backed state's on the hub.
// Names only; committees and donors are not searched.
import { useId, useRef, useState, type KeyboardEvent } from "react";
import { Link, useNavigate } from "react-router-dom";
import { Search, Loader2 } from "lucide-react";
import { Input } from "@/components/ui/input";
import { useCandidateSearch } from "@/hooks/useCandidateSearch";
import { partyColor, partyLabel } from "@/lib/finance";
import { MIN_QUERY, cleanQuery } from "@/lib/candidateSearch";

export default function CandidateSearch({
  states,
  placeholder,
  className = "",
}: {
  /** Two-letter codes to search. */
  states: string[];
  placeholder: string;
  className?: string;
}) {
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const { results, isFetching, ready } = useCandidateSearch(query, states);
  const navigate = useNavigate();
  const listId = useId();
  const inputRef = useRef<HTMLInputElement>(null);
  const showList = open && cleanQuery(query).length >= MIN_QUERY;

  const go = (href: string) => {
    setOpen(false);
    setQuery("");
    navigate(href);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setOpen(true);
      setActive((i) => Math.min(i + 1, Math.max(results.length - 1, 0)));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive((i) => Math.max(i - 1, 0));
    } else if (e.key === "Enter") {
      const hit = results[active] ?? results[0];
      if (hit) {
        e.preventDefault();
        go(hit.href);
      }
    } else if (e.key === "Escape") {
      setOpen(false);
      inputRef.current?.blur();
    }
  };

  return (
    <div className={`relative w-full max-w-xl mx-auto text-left ${className}`}>
      <label htmlFor={`${listId}-input`} className="sr-only">
        Search candidates by name
      </label>
      <Search className="pointer-events-none absolute left-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
      <Input
        ref={inputRef}
        id={`${listId}-input`}
        type="search"
        role="combobox"
        aria-expanded={showList}
        aria-controls={listId}
        aria-autocomplete="list"
        aria-activedescendant={showList && results[active] ? `${listId}-${active}` : undefined}
        autoComplete="off"
        spellCheck={false}
        value={query}
        placeholder={placeholder}
        onChange={(e) => {
          setQuery(e.target.value);
          setActive(0);
          setOpen(true);
        }}
        onFocus={() => setOpen(true)}
        onBlur={() => setTimeout(() => setOpen(false), 150)}
        onKeyDown={onKeyDown}
        className="h-11 pl-10 pr-10 text-base bg-card"
      />
      {isFetching && (
        <Loader2 className="absolute right-3.5 top-1/2 h-4 w-4 -translate-y-1/2 animate-spin text-muted-foreground" />
      )}
      {showList && (
        <ul
          id={listId}
          role="listbox"
          className="absolute z-40 mt-1.5 w-full overflow-hidden rounded-md border bg-popover shadow-lg"
        >
          {results.map((r, i) => (
            <li key={r.href} id={`${listId}-${i}`} role="option" aria-selected={i === active}>
              <Link
                to={r.href}
                onMouseDown={(e) => e.preventDefault()}
                onClick={(e) => {
                  e.preventDefault();
                  go(r.href);
                }}
                onMouseEnter={() => setActive(i)}
                className={`flex items-center gap-3 px-3.5 py-2.5 text-sm ${i === active ? "bg-accent" : ""}`}
              >
                <span
                  className="h-2.5 w-2.5 shrink-0 rounded-full"
                  style={{ background: partyColor(r.party) }}
                  aria-label={partyLabel(r.party)}
                  role="img"
                />
                <span className="min-w-0 flex-1">
                  <span className={`block truncate font-medium ${r.offBallot ? "text-muted-foreground" : ""}`}>
                    {r.name}
                  </span>
                  <span className="block truncate text-xs text-muted-foreground">
                    {r.context}
                    {r.statusLabel ? ` · ${r.statusLabel}` : ""}
                  </span>
                </span>
              </Link>
            </li>
          ))}
          {ready && !isFetching && results.length === 0 && (
            <li className="px-3.5 py-3 text-sm text-muted-foreground">No candidates match “{cleanQuery(query)}”.</li>
          )}
        </ul>
      )}
    </div>
  );
}
