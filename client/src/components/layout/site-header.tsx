"use client";

import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { useAuth } from "@/providers/auth-provider";
import { Logo } from "@/components/layout/logo";
import { MainNav } from "@/components/layout/main-nav";
import { ThemeToggle } from "@/components/layout/theme-toggle";
import { UserMenu } from "@/components/layout/user-menu";

export function SiteHeader() {
  const { status } = useAuth();
  const authed = status === "authenticated";

  return (
    <header className="sticky top-0 z-50 border-b border-border/60 bg-background/80 backdrop-blur supports-[backdrop-filter]:bg-background/65">
      <div className="mx-auto flex h-16 w-full max-w-6xl items-center justify-between gap-4 px-4 sm:px-6">
        <div className="flex items-center gap-6">
          <Logo href={authed ? "/dashboard" : "/"} />
          <MainNav />
        </div>

        <div className="flex items-center gap-2">
          <ThemeToggle />
          {status === "loading" ? (
            <Skeleton className="size-7 rounded-full" />
          ) : authed ? (
            <UserMenu />
          ) : (
            <div className="flex items-center gap-1.5">
              <Button asChild variant="ghost" size="sm">
                <Link href="/login">Sign in</Link>
              </Button>
              <Button asChild size="sm">
                <Link href="/register">Get started</Link>
              </Button>
            </div>
          )}
        </div>
      </div>
    </header>
  );
}
