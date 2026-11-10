"use server";

import { auth } from "@clerk/nextjs/server";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { ApiError, apiAsUser } from "@/lib/account";
import { serverApiBase } from "@/lib/shared";

const ID = /^gt_[0-9A-Za-z]{10}$/;

function idFrom(form: FormData): string | undefined {
  const id = String(form.get("id") ?? "");
  return ID.test(id) ? id : undefined;
}

async function requireSignIn(back: string): Promise<void> {
  const { userId } = await auth();
  if (!userId) redirect(`/sign-in?redirect_url=${encodeURIComponent(back)}`);
}

export async function toggleStar(form: FormData): Promise<void> {
  const id = idFrom(form);
  if (!id) return;
  await requireSignIn(`/gallery/${id}`);
  const starred = form.get("starred") === "true";
  await apiAsUser(`/v1/gallery/${id}/star`, { method: starred ? "DELETE" : "PUT" });
  revalidatePath(`/gallery/${id}`);
  revalidatePath("/gallery");
}

export type ActionState =
  | { status: "idle" }
  | { status: "done"; message: string }
  | { status: "error"; message: string };

export async function reportTemplate(_prev: ActionState, form: FormData): Promise<ActionState> {
  const id = idFrom(form);
  if (!id) return { status: "error", message: "Unknown template." };
  const { userId } = await auth();
  if (!userId) return { status: "error", message: "Sign in to report a template." };
  const reason = String(form.get("reason") ?? "").trim();
  if (reason.length < 5) return { status: "error", message: "Tell us briefly what is wrong." };
  try {
    await apiAsUser(`/v1/gallery/${id}/report`, {
      method: "POST",
      body: JSON.stringify({ reason: reason.slice(0, 500) }),
    });
    return { status: "done", message: "Thanks. A moderator will take a look." };
  } catch (error) {
    return {
      status: "error",
      message: error instanceof ApiError ? error.message : "Could not send the report.",
    };
  }
}

export async function removeTemplate(form: FormData): Promise<void> {
  const id = idFrom(form);
  if (!id) return;
  await requireSignIn(`/gallery/${id}`);
  await apiAsUser(`/v1/gallery/${id}`, { method: "DELETE" });
  revalidatePath("/gallery");
  redirect("/gallery?view=mine");
}

export async function setHidden(form: FormData): Promise<void> {
  const id = idFrom(form);
  if (!id) return;
  await requireSignIn(`/gallery/${id}`);
  await apiAsUser(`/v1/gallery/${id}`, {
    method: "PATCH",
    body: JSON.stringify({ hidden: form.get("hidden") === "true" }),
  });
  revalidatePath(`/gallery/${id}`);
  revalidatePath("/gallery");
}

export interface PublishDiagnostic {
  severity: string;
  file?: string;
  line?: number;
  message: string;
}

export type PublishState =
  | { status: "idle" }
  | { status: "error"; message: string; diagnostics?: PublishDiagnostic[] };

const MAX_UPLOAD = 20 * 1024 * 1024;

/**
 * Uploads the zip (or .tex files) to `POST /v1/gallery` as the signed-in user. The API
 * compiles it first; LaTeX errors come back as diagnostics for the form.
 */
export async function publishTemplate(_prev: PublishState, form: FormData): Promise<PublishState> {
  const { userId, getToken } = await auth();
  if (!userId) return { status: "error", message: "Sign in to publish a template." };
  const token = await getToken();
  if (!token) return { status: "error", message: "Your session expired; sign in again." };

  if (form.get("acceptLicense") !== "on") {
    return { status: "error", message: "Accept the CC-BY 4.0 license to publish." };
  }
  const files = form.getAll("files").filter((f): f is File => f instanceof File && f.size > 0);
  if (files.length === 0) {
    return { status: "error", message: "Choose a .zip of your project or its .tex files." };
  }
  const size = files.reduce((n, f) => n + f.size, 0);
  if (size > MAX_UPLOAD) {
    return {
      status: "error",
      message: "The upload is over 20 MB; leave out build files and PDFs.",
    };
  }

  const body = new FormData();
  for (const file of files) {
    const isZip = /\.zip$/i.test(file.name) || file.type.includes("zip");
    body.append(isZip ? "project" : "files", file, file.name);
  }
  for (const key of ["name", "description", "category", "tags", "entrypoint"]) {
    const value = String(form.get(key) ?? "").trim();
    if (value) body.append(key, value);
  }
  body.append("acceptLicense", "true");

  const replaceId = String(form.get("replaceId") ?? "");
  const replacing = ID.test(replaceId);
  let res: Response;
  try {
    res = await fetch(`${serverApiBase()}/v1/gallery${replacing ? `/${replaceId}` : ""}`, {
      method: replacing ? "PUT" : "POST",
      body,
      headers: { authorization: `Bearer ${token}`, accept: "application/json" },
      cache: "no-store",
      signal: AbortSignal.timeout(120_000),
    });
  } catch {
    return { status: "error", message: "The server did not answer in time. Try again." };
  }
  const payload = (await res.json().catch(() => ({}))) as {
    template?: { id: string };
    code?: string;
    detail?: string;
    title?: string;
    diagnostics?: PublishDiagnostic[];
  };
  if (!res.ok || !payload.template) {
    if (payload.code === "compile_failed") {
      return {
        status: "error",
        message: "It did not compile, so it was not published. Fix these errors and try again:",
        diagnostics: (payload.diagnostics ?? []).filter((d) => d.severity === "error").slice(0, 8),
      };
    }
    return {
      status: "error",
      message: payload.detail ?? payload.title ?? `Publishing failed (${res.status}).`,
    };
  }
  revalidatePath("/gallery");
  redirect(`/gallery/${payload.template.id}`);
}
