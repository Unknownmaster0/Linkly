import Link from "next/link";
import {
  ArrowRight,
  Copy,
  Link2,
  MousePointerClick,
  Sparkles,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { APP_DESCRIPTION } from "@/lib/config";

export function Hero() {
  return (
    <section className="relative isolate overflow-hidden">
      {/* Texture + brand glow live behind the content (drawn first in the DOM). */}
      <div
        className="bg-grid-fade pointer-events-none absolute inset-0"
        aria-hidden
      />
      <div
        className="brand-glow pointer-events-none absolute inset-x-0 top-0 h-[460px]"
        aria-hidden
      />

      <div className="animate-in-up relative mx-auto flex max-w-6xl flex-col items-center px-4 pt-20 pb-16 text-center sm:px-6 sm:pt-28 sm:pb-24">
        <span className="inline-flex items-center gap-2 rounded-full border border-border/70 bg-background/60 px-3 py-1 text-xs font-medium text-muted-foreground backdrop-blur">
          <Sparkles className="size-3.5 text-primary" />
          Fast 302 redirects · Real-time click analytics
        </span>

        <h1 className="mt-6 max-w-3xl font-heading text-4xl font-semibold tracking-tight text-balance sm:text-5xl md:text-6xl">
          Shorten, share, and{" "}
          <span className="text-gradient-brand">measure</span> every link.
        </h1>

        <p className="mt-5 max-w-2xl text-base text-muted-foreground text-pretty sm:text-lg">
          {APP_DESCRIPTION}
        </p>

        <div className="mt-8 flex flex-col items-center gap-3 sm:flex-row">
          <Button asChild size="lg" className="h-11 px-6">
            <Link href="/register">
              Get started free
              <ArrowRight className="size-4" />
            </Link>
          </Button>
          <Button asChild variant="outline" size="lg" className="h-11 px-6">
            <Link href="/login">Sign in</Link>
          </Button>
        </div>

        <ShortenPreview />
      </div>
    </section>
  );
}

/** A non-functional product preview: a long URL shortened into a tracked link. */
function ShortenPreview() {
  return (
    <div className="animate-in-up mt-14 w-full max-w-2xl text-left">
      <div className="surface-gradient overflow-hidden rounded-2xl border border-border/70 shadow-sm ring-1 ring-foreground/5">
        <div className="flex flex-col gap-3 p-4 sm:flex-row sm:items-center">
          <div className="flex h-11 min-w-0 flex-1 items-center rounded-xl border border-border bg-background px-3.5">
            <span className="truncate font-mono text-xs text-muted-foreground sm:text-sm">
              https://example.com/2026/announcing-our-new-platform?ref=newsletter
            </span>
          </div>
          <Button asChild size="lg" className="h-11 shrink-0 px-5">
            <Link href="/register">Shorten</Link>
          </Button>
        </div>

        <div className="flex items-center justify-between gap-3 border-t border-border/70 bg-background/40 px-4 py-3">
          <div className="flex min-w-0 items-center gap-2">
            <span className="grid size-8 shrink-0 place-items-center rounded-lg bg-primary/10 text-primary">
              <Link2 className="size-4" />
            </span>
            <span className="truncate font-mono text-sm font-medium">
              lnk.ly/launch-2026
            </span>
          </div>
          <div className="flex shrink-0 items-center gap-3">
            <span className="hidden items-center gap-1.5 text-xs text-muted-foreground sm:inline-flex">
              <MousePointerClick className="size-3.5" />
              <span className="tabular-nums">1,248 clicks</span>
            </span>
            <span
              className="grid size-8 place-items-center rounded-lg text-muted-foreground ring-1 ring-border"
              aria-hidden
            >
              <Copy className="size-4" />
            </span>
          </div>
        </div>
      </div>
    </div>
  );
}
