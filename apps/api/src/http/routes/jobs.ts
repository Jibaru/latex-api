import { createRoute, type OpenAPIHono, z } from "@hono/zod-openapi";
import { isTerminal, type JobEvent } from "@latex-api/core";
import { streamSSE } from "hono/streaming";
import type { Env } from "../auth";
import { toJobDto } from "../dto";
import { problem } from "../errors";
import { JobEnvelopeSchema, JobIdParam, ProblemSchema } from "../schemas";

const getJobRoute = createRoute({
  method: "get",
  path: "/v1/jobs/{id}",
  tags: ["Jobs"],
  summary: "Get a job",
  security: [{ bearerAuth: [] }],
  request: { params: JobIdParam },
  responses: {
    200: { description: "The job", content: { "application/json": { schema: JobEnvelopeSchema } } },
    404: {
      description: "Unknown job",
      content: { "application/problem+json": { schema: ProblemSchema } },
    },
  },
});

const cancelJobRoute = createRoute({
  method: "delete",
  path: "/v1/jobs/{id}",
  tags: ["Jobs"],
  summary: "Cancel a queued or running job",
  security: [{ bearerAuth: [] }],
  request: { params: JobIdParam },
  responses: {
    200: {
      description: "The job after cancellation",
      content: { "application/json": { schema: JobEnvelopeSchema } },
    },
    404: {
      description: "Unknown job",
      content: { "application/problem+json": { schema: ProblemSchema } },
    },
    409: {
      description: "Job already finished",
      content: { "application/problem+json": { schema: ProblemSchema } },
    },
  },
});

const pdfRoute = createRoute({
  method: "get",
  path: "/v1/jobs/{id}/pdf",
  tags: ["Jobs"],
  summary: "Download the PDF of a job",
  security: [{ bearerAuth: [] }],
  request: { params: JobIdParam, query: z.object({ download: z.string().optional() }) },
  responses: {
    200: {
      description: "PDF",
      content: { "application/pdf": { schema: { type: "string", format: "binary" } } },
    },
    404: {
      description: "No PDF for this job",
      content: { "application/problem+json": { schema: ProblemSchema } },
    },
  },
});

const logRoute = createRoute({
  method: "get",
  path: "/v1/jobs/{id}/log",
  tags: ["Jobs"],
  summary: "Download the full LaTeX log of a job",
  security: [{ bearerAuth: [] }],
  request: { params: JobIdParam },
  responses: {
    200: { description: "Log", content: { "text/plain": { schema: { type: "string" } } } },
    404: {
      description: "No log for this job",
      content: { "application/problem+json": { schema: ProblemSchema } },
    },
  },
});

const eventsRoute = createRoute({
  method: "get",
  path: "/v1/jobs/{id}/events",
  tags: ["Jobs"],
  summary: "Stream job events (Server-Sent Events)",
  description:
    "Emits `queued`, `running`, `log` (compiler output chunks), and finally `done` or `error`. " +
    "The stream closes after the terminal event. Reconnecting clients receive the recent history first.",
  security: [{ bearerAuth: [] }],
  request: { params: JobIdParam },
  responses: {
    200: {
      description: "SSE stream",
      content: { "text/event-stream": { schema: { type: "string" } } },
    },
    404: {
      description: "Unknown job",
      content: { "application/problem+json": { schema: ProblemSchema } },
    },
  },
});

export function registerJobRoutes(app: OpenAPIHono<Env>) {
  app.openapi(getJobRoute, async (c) => {
    const container = c.get("container");
    const job = await container.useCases.getJob.execute(
      c.req.valid("param").id,
      c.get("principal"),
    );
    return c.json({ job: toJobDto(job, container.config.publicUrl) }, 200);
  });

  app.openapi(cancelJobRoute, async (c) => {
    const container = c.get("container");
    const job = await container.useCases.cancelJob.execute(
      c.req.valid("param").id,
      c.get("principal"),
    );
    return c.json({ job: toJobDto(job, container.config.publicUrl) }, 200);
  });

  app.openapi(pdfRoute, async (c) => {
    const container = c.get("container");
    const job = await container.useCases.getJob.execute(
      c.req.valid("param").id,
      c.get("principal"),
    );
    if (!job.result?.pdfKey) return problem(c, 404, "not_found", "This job produced no PDF");
    const stream = await container.deps.artifacts.stream(job.result.pdfKey);
    if (!stream) return problem(c, 404, "not_found", "The PDF has expired");
    const disposition = c.req.valid("query").download ? "attachment" : "inline";
    return new Response(stream, {
      headers: {
        "content-type": "application/pdf",
        "content-length": String(job.result.pdfBytes ?? ""),
        "content-disposition": `${disposition}; filename="${job.id}.pdf"`,
        "cache-control": "private, max-age=3600",
      },
    });
  });

  app.openapi(logRoute, async (c) => {
    const container = c.get("container");
    const job = await container.useCases.getJob.execute(
      c.req.valid("param").id,
      c.get("principal"),
    );
    if (!job.result?.logKey)
      return problem(c, 404, "not_found", "This job has no log yet") as never;
    const stream = await container.deps.artifacts.stream(job.result.logKey);
    if (!stream) return problem(c, 404, "not_found", "The log has expired") as never;
    return new Response(stream, {
      headers: {
        "content-type": "text/plain; charset=utf-8",
        "cache-control": "private, max-age=3600",
      },
    }) as never;
  });

  app.openapi(eventsRoute, async (c) => {
    const container = c.get("container");
    const id = c.req.valid("param").id;
    const job = await container.useCases.getJob.execute(id, c.get("principal"));

    return streamSSE(c, async (stream) => {
      let seq = 0;
      const send = (event: JobEvent) =>
        stream.writeSSE({ event: event.type, data: JSON.stringify(event), id: String(++seq) });

      for (const past of container.events.replay(id)) await send(past);
      if (isTerminal(job.status)) {
        await send({
          type: job.status === "succeeded" ? "done" : "error",
          jobId: id,
          at: (job.finishedAt ?? new Date()).toISOString(),
          status: job.status,
          message: job.error?.message ?? "",
        } as JobEvent);
        return;
      }

      let finished = false;
      const queue: JobEvent[] = [];
      let wake: (() => void) | undefined;
      const unsubscribe = container.events.subscribe(id, (event) => {
        queue.push(event);
        wake?.();
      });
      stream.onAbort(() => {
        finished = true;
        unsubscribe();
        wake?.();
      });

      const deadline = Date.now() + 15 * 60_000;
      try {
        while (!finished && Date.now() < deadline) {
          while (queue.length > 0) {
            const event = queue.shift()!;
            await send(event);
            if (event.type === "done" || event.type === "error") finished = true;
          }
          if (finished) break;
          // Wait for the next event, a poll tick, or abort.
          await Promise.race([
            new Promise<void>((resolve) => {
              wake = resolve;
            }),
            new Promise<void>((resolve) => setTimeout(resolve, 2_000)),
          ]);
          wake = undefined;
          if (queue.length === 0 && !finished) {
            const fresh = await container.deps.jobs.get(id);
            if (fresh && isTerminal(fresh.status)) {
              await send({
                type: fresh.status === "succeeded" ? "done" : "error",
                jobId: id,
                at: (fresh.finishedAt ?? new Date()).toISOString(),
                status: fresh.status,
                message: fresh.error?.message ?? "",
              } as JobEvent);
              finished = true;
            } else {
              await stream.writeSSE({ event: "ping", data: new Date().toISOString() });
            }
          }
        }
      } finally {
        unsubscribe();
      }
    });
  });
}
