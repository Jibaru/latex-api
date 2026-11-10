"use client";

import { useActionState } from "react";
import { type ActionState, reportTemplate } from "@/app/gallery/actions";

const initial: ActionState = { status: "idle" };

export function ReportForm({ id }: { id: string }) {
  const [state, action, pending] = useActionState(reportTemplate, initial);
  return (
    <details className="mt-10 border-t border-rule pt-5 text-[0.88rem]">
      <summary className="quiet-link cursor-pointer">Report this template</summary>
      {state.status === "done" ? (
        <p role="status" className="mt-3 text-ink-2">
          {state.message}
        </p>
      ) : (
        <form action={action} className="mt-3 space-y-3">
          <input type="hidden" name="id" value={id} />
          <label htmlFor="report-reason" className="block text-ink-2">
            What is wrong? (copied without credit, broken, spam, personal data…)
          </label>
          <textarea
            id="report-reason"
            name="reason"
            required
            minLength={5}
            maxLength={500}
            rows={3}
            className="w-full border border-rule-strong bg-paper px-3 py-2 focus-visible:border-accent"
          />
          <button type="submit" className="btn btn-secondary" disabled={pending}>
            {pending ? "Sending…" : "Send report"}
          </button>
          <p aria-live="polite" className="min-h-[1.25rem] text-accent">
            {state.status === "error" ? state.message : ""}
          </p>
        </form>
      )}
    </details>
  );
}
