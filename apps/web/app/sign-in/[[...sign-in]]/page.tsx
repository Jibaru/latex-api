import { SignIn } from "@clerk/nextjs";
import type { Metadata } from "next";
import { AuthShell } from "@/components/account/auth-shell";

export const metadata: Metadata = { title: "Sign in" };

export default function SignInPage() {
  return (
    <AuthShell
      title="Welcome back."
      lede="Sign in to manage your API tokens and approve CLI sign-ins."
    >
      <SignIn path="/sign-in" signUpUrl="/sign-up" fallbackRedirectUrl="/dashboard" />
    </AuthShell>
  );
}
