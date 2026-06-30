export default function AuthLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <div className="relative flex flex-1 items-center justify-center px-4 py-12 sm:py-16">
      <div
        className="bg-grid-fade pointer-events-none absolute inset-0 opacity-70"
        aria-hidden
      />
      <div className="animate-in-up relative w-full max-w-sm">{children}</div>
    </div>
  );
}
