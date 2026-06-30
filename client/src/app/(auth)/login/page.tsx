import type { Metadata } from "next";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { LoginForm } from "@/components/auth/login-form";
import { APP_NAME } from "@/lib/config";

export const metadata: Metadata = {
  title: "Sign in",
  description: `Sign in to your ${APP_NAME} account.`,
};

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string | string[] }>;
}) {
  const { next } = await searchParams;
  const nextPath = Array.isArray(next) ? next[0] : next;

  return (
    <Card>
      <CardHeader className="text-center">
        <CardTitle className="text-xl">Welcome back</CardTitle>
        <CardDescription>
          Sign in to manage your links and analytics.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <LoginForm next={nextPath} />
      </CardContent>
    </Card>
  );
}
