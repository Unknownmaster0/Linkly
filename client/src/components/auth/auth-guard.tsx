"use client";

import { useEffect } from "react";
import { usePathname, useRouter } from "next/navigation";
import { useAuth } from "@/providers/auth-provider";
import { FullPageLoader } from "@/components/common/full-page-loader";

/** Gate for the dashboard group: waits for the silent refresh, then admits or
 * bounces to /login (preserving where the user was headed via `?next=`). */
export function AuthGuard({ children }: { children: React.ReactNode }) {
  const { status } = useAuth();
  const router = useRouter();
  const pathname = usePathname();

  useEffect(() => {
    if (status === "unauthenticated") {
      router.replace(`/login?next=${encodeURIComponent(pathname)}`);
    }
  }, [status, router, pathname]);

  if (status !== "authenticated") {
    return <FullPageLoader label="Checking your session…" />;
  }

  return <>{children}</>;
}
