"use client";

import { useEffect } from "react";
import { APP_NAME } from "@/lib/config";

/**
 * Sets `document.title` for a client page. Dashboard pages are client
 * components and so can't `export const metadata`; this mirrors the root
 * layout's `%s · Linkly` template so their browser-tab titles stay precise
 * and consistent with the server-rendered (auth/landing) pages.
 */
export function useDocumentTitle(title: string) {
  useEffect(() => {
    document.title = `${title} · ${APP_NAME}`;
  }, [title]);
}
