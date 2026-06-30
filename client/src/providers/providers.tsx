"use client";

import { Toaster } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import { AuthProvider } from "./auth-provider";
import { QueryProvider } from "./query-provider";
import { ThemeProvider } from "./theme-provider";

/** Single client boundary that composes every app-wide provider. */
export function Providers({ children }: { children: React.ReactNode }) {
  return (
    <ThemeProvider>
      <QueryProvider>
        <AuthProvider>
          <TooltipProvider delayDuration={200}>{children}</TooltipProvider>
        </AuthProvider>
      </QueryProvider>
      <Toaster position="top-center" />
    </ThemeProvider>
  );
}
