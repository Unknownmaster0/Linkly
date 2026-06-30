import type { Metadata } from "next";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { RegisterForm } from "@/components/auth/register-form";
import { APP_NAME } from "@/lib/config";

export const metadata: Metadata = {
  title: "Create account",
  description: `Create a free ${APP_NAME} account to start shortening links.`,
};

export default function RegisterPage() {
  return (
    <Card>
      <CardHeader className="text-center">
        <CardTitle className="text-xl">Create your account</CardTitle>
        <CardDescription>
          Start shortening links and tracking clicks in seconds.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <RegisterForm />
      </CardContent>
    </Card>
  );
}
