import Link from "next/link";
import { LogoMark } from "@/components/layout/logo";
import { APP_NAME, APP_TAGLINE } from "@/lib/config";

const productLinks = [
  { label: "Dashboard", href: "/dashboard" },
  { label: "My links", href: "/links" },
];

export function SiteFooter() {
  const year = new Date().getFullYear();

  return (
    <footer className="border-t border-border/60 bg-background">
      <div className="mx-auto w-full max-w-6xl px-4 py-12 sm:px-6">
        <div className="grid gap-10 md:grid-cols-[1.5fr_1fr_1fr]">
          <div className="space-y-3">
            <div className="flex items-center gap-2">
              <LogoMark />
              <span className="text-base font-semibold tracking-tight">
                {APP_NAME}
              </span>
            </div>
            <p className="max-w-xs text-sm text-muted-foreground">
              {APP_TAGLINE} A modern URL shortener with first-class click
              analytics.
            </p>
          </div>

          <FooterColumn title="Product" links={productLinks} />
        </div>

        <div className="mt-10 flex flex-col items-start justify-between gap-3 border-t border-border/60 pt-6 text-sm text-muted-foreground sm:flex-row sm:items-center">
          <p>
            &copy; {year} {APP_NAME}. All rights reserved.
          </p>
        </div>
      </div>
    </footer>
  );
}

function FooterColumn({
  title,
  links,
}: {
  title: string;
  links: { label: string; href: string; external?: boolean }[];
}) {
  return (
    <div className="space-y-3">
      <h3 className="text-sm font-medium">{title}</h3>
      <ul className="space-y-2 text-sm">
        {links.map((link) => (
          <li key={link.label}>
            {link.external ? (
              <a
                href={link.href}
                target="_blank"
                rel="noreferrer"
                className="text-muted-foreground transition-colors hover:text-foreground"
              >
                {link.label}
              </a>
            ) : (
              <Link
                href={link.href}
                className="text-muted-foreground transition-colors hover:text-foreground"
              >
                {link.label}
              </Link>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}
