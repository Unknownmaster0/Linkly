import { Fragment } from "react";
import {
  ArrowRight,
  Clipboard,
  LineChart,
  Link2,
  Share2,
  type LucideIcon,
} from "lucide-react";
import { SectionHeading } from "@/components/marketing/section-heading";

const steps: { icon: LucideIcon; title: string; description: string }[] = [
  {
    icon: Clipboard,
    title: "Paste your URL",
    description: "Drop in any long link, with an optional custom alias and expiry.",
  },
  {
    icon: Link2,
    title: "Get a short link",
    description: "We generate a tidy, shareable short code for you instantly.",
  },
  {
    icon: Share2,
    title: "Share anywhere",
    description: "Drop it into docs, chats, emails, slides, or social posts.",
  },
  {
    icon: LineChart,
    title: "Track every click",
    description: "Watch clicks, referrers, and geography update in real time.",
  },
];

export function HowItWorks() {
  return (
    <section
      id="how-it-works"
      className="scroll-mt-20 border-t border-border/60 py-16 sm:py-24"
    >
      <div className="mx-auto max-w-6xl px-4 sm:px-6">
        <SectionHeading
          eyebrow="How it works"
          title="From a long link to live analytics in seconds"
          description="No setup and no SDKs — four steps from a messy URL to measurable insight."
        />

        <ol className="mt-12 flex flex-col gap-4 md:flex-row md:items-stretch md:gap-2">
          {steps.map((step, index) => {
            const Icon = step.icon;
            return (
              <Fragment key={step.title}>
                <li className="flex flex-1 flex-col items-center gap-3 rounded-2xl border border-border/70 bg-card/40 p-6 text-center">
                  <span className="relative grid size-12 place-items-center rounded-xl bg-primary/10 text-primary">
                    <Icon className="size-6" />
                    <span className="absolute -top-2 -right-2 grid size-5 place-items-center rounded-full bg-primary text-[0.65rem] font-semibold text-primary-foreground tabular-nums">
                      {index + 1}
                    </span>
                  </span>
                  <h3 className="font-heading text-base font-medium">
                    {step.title}
                  </h3>
                  <p className="text-sm text-muted-foreground text-pretty">
                    {step.description}
                  </p>
                </li>
                {index < steps.length - 1 && (
                  <li
                    className="flex items-center justify-center text-muted-foreground/40 md:px-1"
                    aria-hidden
                  >
                    <ArrowRight className="hidden size-5 md:block" />
                    <ArrowRight className="size-5 rotate-90 md:hidden" />
                  </li>
                )}
              </Fragment>
            );
          })}
        </ol>
      </div>
    </section>
  );
}
