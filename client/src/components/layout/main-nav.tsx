"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@/lib/utils";
import { useAuth } from "@/providers/auth-provider";

const authedLinks = [
  { href: "/dashboard", label: "Dashboard" },
  { href: "/links", label: "My links" },
];

const publicLinks = [
  { href: "/#features", label: "Features" },
  { href: "/#how-it-works", label: "How it works" },
];

export function MainNav() {
  const { status } = useAuth();
  const pathname = usePathname();
  const links = status === "authenticated" ? authedLinks : publicLinks;

  return (
    <nav className="hidden items-center gap-1 md:flex">
      {links.map((link) => {
        const active = pathname === link.href;
        return (
          <Link
            key={link.href}
            href={link.href}
            className={cn(
              "rounded-md px-3 py-1.5 text-sm font-medium transition-colors",
              active
                ? "text-foreground"
                : "text-muted-foreground hover:text-foreground",
            )}
          >
            {link.label}
          </Link>
        );
      })}
    </nav>
  );
}
