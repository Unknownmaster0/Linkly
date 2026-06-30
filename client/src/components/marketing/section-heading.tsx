import { cn } from "@/lib/utils";

/**
 * Shared heading block for marketing sections: a brand eyebrow, a balanced
 * title, and an optional supporting line. Centered by default; pass
 * `align="left"` for left-aligned sections.
 */
export function SectionHeading({
  eyebrow,
  title,
  description,
  align = "center",
  className,
}: {
  eyebrow: string;
  title: string;
  description?: string;
  align?: "center" | "left";
  className?: string;
}) {
  const centered = align === "center";
  return (
    <div
      className={cn(
        "flex flex-col gap-3",
        centered ? "items-center text-center" : "items-start text-left",
        className,
      )}
    >
      <span className="text-xs font-semibold tracking-wider text-primary uppercase">
        {eyebrow}
      </span>
      <h2 className="max-w-2xl font-heading text-3xl font-semibold tracking-tight text-balance sm:text-4xl">
        {title}
      </h2>
      {description && (
        <p
          className={cn(
            "max-w-2xl text-base text-muted-foreground text-pretty",
            centered && "mx-auto",
          )}
        >
          {description}
        </p>
      )}
    </div>
  );
}
