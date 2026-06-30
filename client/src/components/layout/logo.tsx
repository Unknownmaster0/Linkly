import Link from "next/link";
import Image from "next/image";
import { cn } from "@/lib/utils";
import { APP_NAME } from "@/lib/config";

export function LogoMark({ className }: { className?: string }) {
  return (
    <span
      className={cn(
        "relative grid size-8 shrink-0 place-items-center rounded-lg bg-gradient-to-br from-primary to-brand-accent text-primary-foreground shadow-sm ring-1 ring-black/5",
        className,
      )}
      aria-hidden
    >
      <Image
        src="/linkly-favicon.png"
        alt=""
        fill
        className="object-contain"
      />
    </span>
  );
}

export function Logo({
  href = "/",
  showWordmark = true,
  className,
}: {
  href?: string;
  showWordmark?: boolean;
  className?: string;
}) {
  return (
    <Link
      href={href}
      aria-label={`${APP_NAME} home`}
      className={cn(
        "inline-flex items-center gap-2 rounded-md outline-none focus-visible:ring-2 focus-visible:ring-ring",
        className,
      )}
    >
      <LogoMark />
      {showWordmark && (
        <span className="text-lg font-semibold tracking-tight">{APP_NAME}</span>
      )}
    </Link>
  );
}
