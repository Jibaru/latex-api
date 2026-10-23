"use server";

import { revalidatePath } from "next/cache";
import { ApiError, type ApiToken, apiAsUser } from "@/lib/account";

export type CreateTokenState =
  | { status: "idle" }
  | { status: "created"; secret: string; token: ApiToken }
  | { status: "error"; message: string };

const EXPIRY_CHOICES = new Set(["never", "7", "30", "90", "365"]);

export async function createToken(
  _prev: CreateTokenState,
  form: FormData,
): Promise<CreateTokenState> {
  const name = String(form.get("name") ?? "").trim();
  const expiry = String(form.get("expiry") ?? "never");
  if (!name)
    return { status: "error", message: "Give the token a name so you can recognise it later." };
  if (name.length > 80) return { status: "error", message: "Keep the name under 80 characters." };
  if (!EXPIRY_CHOICES.has(expiry))
    return { status: "error", message: "Pick an expiry from the list." };
  try {
    const res = await apiAsUser<{ token: string; apiToken: ApiToken }>("/v1/tokens", {
      method: "POST",
      body: JSON.stringify({ name, expiresInDays: expiry === "never" ? null : Number(expiry) }),
    });
    revalidatePath("/dashboard/tokens");
    revalidatePath("/dashboard");
    return { status: "created", secret: res.token, token: res.apiToken };
  } catch (error) {
    return {
      status: "error",
      message: error instanceof ApiError ? error.message : "Could not create the token.",
    };
  }
}

export async function revokeToken(form: FormData): Promise<void> {
  const id = String(form.get("id") ?? "");
  if (!/^tok_[A-Za-z0-9]{6,40}$/.test(id)) return;
  await apiAsUser(`/v1/tokens/${encodeURIComponent(id)}`, { method: "DELETE" });
  revalidatePath("/dashboard/tokens");
  revalidatePath("/dashboard");
}
