import {
  Briefcase,
  Code2,
  GraduationCap,
  Presentation,
  type LucideIcon,
} from "lucide-react";
import { SectionHeading } from "@/components/marketing/section-heading";

const audiences: { icon: LucideIcon; title: string; description: string }[] = [
  {
    icon: Code2,
    title: "Engineers",
    description:
      "Share build artifacts, docs, and demo links — and see exactly what gets opened.",
  },
  {
    icon: GraduationCap,
    title: "Students",
    description:
      "Keep project submissions and portfolios tidy with short, memorable links.",
  },
  {
    icon: Presentation,
    title: "Educators",
    description:
      "Hand out clean links in slides and syllabi, and gauge engagement at a glance.",
  },
  {
    icon: Briefcase,
    title: "Teams",
    description:
      "Measure campaigns by referrer and geography to learn what truly drives clicks.",
  },
];

export function Audience() {
  return (
    <section className="border-t border-border/60 py-16 sm:py-24">
      <div className="mx-auto max-w-6xl px-4 sm:px-6">
        <SectionHeading
          eyebrow="Who it's for"
          title="Built for people who share links and care about results"
        />
        <div className="mt-12 grid gap-5 sm:grid-cols-2 lg:grid-cols-4">
          {audiences.map((audience) => {
            const Icon = audience.icon;
            return (
              <div
                key={audience.title}
                className="flex flex-col gap-3 rounded-2xl border border-border/70 bg-card/40 p-6"
              >
                <span className="grid size-10 place-items-center rounded-lg bg-accent text-accent-foreground">
                  <Icon className="size-5" />
                </span>
                <h3 className="font-heading text-base font-medium">
                  {audience.title}
                </h3>
                <p className="text-sm text-muted-foreground text-pretty">
                  {audience.description}
                </p>
              </div>
            );
          })}
        </div>
      </div>
    </section>
  );
}
