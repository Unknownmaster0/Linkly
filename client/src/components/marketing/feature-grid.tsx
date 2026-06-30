import {
  BarChart3,
  CalendarClock,
  Globe,
  ShieldCheck,
  Tag,
  Zap,
  type LucideIcon,
} from "lucide-react";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { SectionHeading } from "@/components/marketing/section-heading";

const features: { icon: LucideIcon; title: string; description: string }[] = [
  {
    icon: Tag,
    title: "Custom aliases",
    description:
      "Brand your links with your own readable short codes instead of random characters.",
  },
  {
    icon: CalendarClock,
    title: "Expiry control",
    description:
      "Set links to expire from 1 to 365 days, so stale links retire themselves.",
  },
  {
    icon: BarChart3,
    title: "Click analytics",
    description:
      "Track total, 7-day, and 30-day clicks with a clean clicks-over-time chart.",
  },
  {
    icon: Globe,
    title: "Geo & referrers",
    description:
      "See which countries and referrers drive traffic, broken down per link.",
  },
  {
    icon: Zap,
    title: "Fast 302 redirects",
    description:
      "A cache-backed redirect path sends visitors onward with minimal latency.",
  },
  {
    icon: ShieldCheck,
    title: "Secure by default",
    description:
      "Token auth with silent refresh, per-user link isolation, and rate-limited creation.",
  },
];

export function FeatureGrid() {
  return (
    <section
      id="features"
      className="scroll-mt-20 border-t border-border/60 py-16 sm:py-24"
    >
      <div className="mx-auto max-w-6xl px-4 sm:px-6">
        <SectionHeading
          eyebrow="Features"
          title="Everything you need to ship and measure links"
          description="A focused toolset, not a bloated dashboard — every feature maps to a real endpoint."
        />
        <div className="mt-12 grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
          {features.map((feature) => {
            const Icon = feature.icon;
            return (
              <Card
                key={feature.title}
                className="surface-gradient transition-shadow hover:shadow-md"
              >
                <CardHeader>
                  <span className="grid size-10 place-items-center rounded-lg bg-primary/10 text-primary">
                    <Icon className="size-5" />
                  </span>
                  <CardTitle className="mt-3">{feature.title}</CardTitle>
                </CardHeader>
                <CardContent>
                  <p className="text-sm text-muted-foreground text-pretty">
                    {feature.description}
                  </p>
                </CardContent>
              </Card>
            );
          })}
        </div>
      </div>
    </section>
  );
}
