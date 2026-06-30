import { AuthGuard } from "@/components/auth/auth-guard";

export default function DashboardLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <AuthGuard>
      <div className="mx-auto w-full max-w-6xl flex-1 px-4 py-8 sm:px-6 lg:py-10">
        {children}
      </div>
    </AuthGuard>
  );
}
