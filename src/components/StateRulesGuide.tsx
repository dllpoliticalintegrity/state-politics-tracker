import { Check, ExternalLink, X } from "lucide-react";
import { Card } from "@/components/ui/card";
import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from "@/components/ui/accordion";
import type { StateGuide } from "@/states/guides";

/**
 * A state's campaign-finance rules and FAQ on the About page (content from
 * src/states/guides.ts). Emits FAQPage structured data for the questions.
 */
export default function StateRulesGuide({ guide }: { guide: StateGuide }) {
  const { rules, faq } = guide;
  const faqJsonLd = faq?.length
    ? {
        "@context": "https://schema.org",
        "@type": "FAQPage",
        mainEntity: faq.map(({ q, a }) => ({
          "@type": "Question",
          name: q,
          acceptedAnswer: { "@type": "Answer", text: a },
        })),
      }
    : null;

  return (
    <>
      {rules && (
        <>
          <Card className="p-5 space-y-3">
            <h2 className="font-display text-xl font-semibold">{rules.heading}</h2>
            <p className="text-sm text-muted-foreground">
              {rules.intro}{" "}
              <a
                href={rules.sourceUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="text-primary hover:underline inline-flex items-center gap-1"
              >
                {rules.sourceName}
                <ExternalLink className="h-3 w-3" />
              </a>
              .
            </p>
          </Card>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            <RuleList title="Allowed" items={rules.allowed} tone="allowed" />
            <RuleList title="Not allowed" items={rules.notAllowed} tone="not" />
          </div>

          {rules.limits && (
            <TwoColumnTable
              title={rules.limits.title}
              head={["Contributor", "Limit"]}
              rows={rules.limits.rows.map((r) => [r.who, r.limit])}
              note={rules.limits.note}
            />
          )}
          {rules.schedule && (
            <TwoColumnTable
              title="When reports are filed"
              head={["Report", "Due"]}
              rows={rules.schedule.rows.map((r) => [r.report, r.due])}
              note={rules.schedule.note}
            />
          )}
        </>
      )}

      {faq?.length ? (
        <div className="space-y-3">
          <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(faqJsonLd) }} />
          <h2 className="font-display text-xl font-semibold">Common questions</h2>
          <Card className="px-4">
            <Accordion type="single" collapsible className="w-full">
              {faq.map(({ q, a }, i) => (
                <AccordionItem key={q} value={`q${i}`}>
                  <AccordionTrigger className="text-sm text-left">{q}</AccordionTrigger>
                  <AccordionContent className="text-sm text-muted-foreground">{a}</AccordionContent>
                </AccordionItem>
              ))}
            </Accordion>
          </Card>
        </div>
      ) : null}
    </>
  );
}

function RuleList({ title, items, tone }: { title: string; items: string[]; tone: "allowed" | "not" }) {
  const Icon = tone === "allowed" ? Check : X;
  const color = tone === "allowed" ? "text-success" : "text-destructive";
  return (
    <Card className="p-4">
      <div className="flex items-center gap-2 mb-3">
        <Icon className={`h-4 w-4 ${color}`} />
        <span className="text-sm font-semibold">{title}</span>
      </div>
      <ul className="space-y-2">
        {items.map((item) => (
          <li key={item} className="text-sm flex gap-2">
            <span className={`${color} mt-0.5`}>{tone === "allowed" ? "+" : "−"}</span>
            <span className="text-muted-foreground">{item}</span>
          </li>
        ))}
      </ul>
    </Card>
  );
}

function TwoColumnTable({
  title,
  head,
  rows,
  note,
}: {
  title: string;
  head: [string, string];
  rows: [string, string][];
  note?: string;
}) {
  return (
    <div className="space-y-3">
      <h3 className="font-display text-lg font-semibold">{title}</h3>
      <Card className="overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-muted/40">
            <tr className="text-xs text-muted-foreground">
              <th className="text-left px-4 py-2 font-medium">{head[0]}</th>
              <th className="text-right px-4 py-2 font-medium">{head[1]}</th>
            </tr>
          </thead>
          <tbody>
            {rows.map(([a, b]) => (
              <tr key={a} className="border-t">
                <td className="px-4 py-2.5">{a}</td>
                <td className="px-4 py-2.5 text-right font-semibold">{b}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>
      {note && <p className="text-xs text-muted-foreground">{note}</p>}
    </div>
  );
}
