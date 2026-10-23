import { SignUp } from "@clerk/nextjs";
import type { Metadata } from "next";
import { AuthShell } from "@/components/account/auth-shell";

export const metadata: Metadata = { title: "Create an account" };

export default function SignUpPage() {
  return (
    <AuthShell
      title="Compile anything."
      lede="Create a free account to get an API token. Papers, CVs, brochures and posters, one HTTP call each."
    >
      <SignUp path="/sign-up" signInUrl="/sign-in" fallbackRedirectUrl="/dashboard" />
    </AuthShell>
  );
}
