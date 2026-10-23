"use server";

import { redirect } from "next/navigation";
import { ApiError, apiAsUser } from "@/lib/account";

const EXPIRY_CHOICES = new Set(["never", "30", "90", "365"]);

function codeFrom(form: FormData): string {
  const code = String(form.get("code") ?? "").toUpperCase();
  if (!/^[A-Z2-9]{4}-[A-Z2-9]{4}$/.test(code)) throw new Error("Invalid code");
  return code;
}

export async function approveDevice(form: FormData): Promise<void> {
  const code = codeFrom(form);
  const expiry = String(form.get("expiry") ?? "never");
  const name = String(form.get("tokenName") ?? "")
    .trim()
    .slice(0, 80);
  let outcome = "approved";
  try {
    await apiAsUser(`/v1/auth/device/${code}/approve`, {
      method: "POST",
      body: JSON.stringify({
        tokenName: name || undefined,
        expiresInDays: EXPIRY_CHOICES.has(expiry) && expiry !== "never" ? Number(expiry) : null,
      }),
    });
  } catch (error) {
    outcome = error instanceof ApiError ? `error:${error.code}` : "error:internal";
  }
  redirect(`/cli/authorize?code=${code}&result=${encodeURIComponent(outcome)}`);
}

export async function denyDevice(form: FormData): Promise<void> {
  const code = codeFrom(form);
  let outcome = "denied";
  try {
    await apiAsUser(`/v1/auth/device/${code}/deny`, { method: "POST", body: "{}" });
  } catch (error) {
    outcome = error instanceof ApiError ? `error:${error.code}` : "error:internal";
  }
  redirect(`/cli/authorize?code=${code}&result=${encodeURIComponent(outcome)}`);
}
