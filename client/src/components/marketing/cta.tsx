import Link from "next/link";
import { ArrowRight } from "lucide-react";
import { Button } from "@/components/ui/button";
import { APP_TAGLINE } from "@/lib/config";

export function Cta() {
  return (
    <section className="border-t border-border/60 py-16 sm:py-24">
      <div className="mx-auto max-w-6xl px-4 sm:px-6">
        <div className="surface-gradient relative isolate overflow-hidden rounded-3xl border border-border/70 px-6 py-14 text-center shadow-sm sm:px-12 sm:py-20">
          <div
            className="brand-glow pointer-events-none absolute inset-0"
            aria-hidden
          />
          <div className="relative mx-auto flex max-w-2xl flex-col items-center">
            <h2 className="font-heading text-3xl font-semibold tracking-tight text-balance sm:text-4xl">
              Start shortening links in under a minute
            </h2>
            <p className="mt-4 max-w-xl text-base text-muted-foreground text-pretty">
              {APP_TAGLINE} Create a free account and turn your next link into
              measurable insight.
            </p>
            <div className="mt-8 flex flex-col items-center gap-3 sm:flex-row">
              <Button asChild size="lg" className="h-11 px-6">
                <Link href="/register">
                  Create your free account
                  <ArrowRight className="size-4" />
                </Link>
              </Button>
              <Button asChild variant="outline" size="lg" className="h-11 px-6">
                <Link href="/login">Sign in</Link>
              </Button>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
