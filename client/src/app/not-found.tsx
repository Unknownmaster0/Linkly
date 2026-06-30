import Link from "next/link";
import { ArrowLeft, Unlink } from "lucide-react";
import { Button } from "@/components/ui/button";

export default function NotFound() {
  return (
    <section className="relative isolate flex flex-1 items-center justify-center overflow-hidden px-4 py-24">
      <div
        className="bg-grid-fade pointer-events-none absolute inset-0"
        aria-hidden
      />
      <div
        className="brand-glow pointer-events-none absolute inset-x-0 top-0 h-80"
        aria-hidden
      />
      <div className="animate-in-up relative flex max-w-md flex-col items-center text-center">
        <span className="grid size-14 place-items-center rounded-2xl bg-primary/10 text-primary ring-1 ring-primary/15">
          <Unlink className="size-7" />
        </span>
        <p className="mt-6 font-heading text-5xl font-semibold tracking-tight text-gradient-brand">
          404
        </p>
        <h1 className="mt-3 font-heading text-2xl font-semibold tracking-tight">
          Page not found
        </h1>
        <p className="mt-2 text-sm text-muted-foreground text-pretty">
          That page could not be found. The short link may have expired or been
          removed.
        </p>
        <div className="mt-8 flex flex-col items-center gap-3 sm:flex-row">
          <Button asChild size="lg" className="h-11 px-6">
            <Link href="/">
              <ArrowLeft className="size-4" />
              Back home
            </Link>
          </Button>
          <Button asChild variant="outline" size="lg" className="h-11 px-6">
            <Link href="/dashboard">Go to dashboard</Link>
          </Button>
        </div>
      </div>
    </section>
  );
}
