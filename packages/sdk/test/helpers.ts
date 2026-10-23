import type { Job } from "../src/index";

export interface Recorded {
  url: URL;
  method: string;
  headers: Headers;
  body: Uint8Array;
  text: string;
  json(): unknown;
  formData?: FormData;
  signal: AbortSignal;
}

export type Responder = (req: Recorded) => Response | Promise<Response>;

/** A fetch stub that records every request and lets a test choose the response. */
export function stubFetch(responder: Responder) {
  const calls: Recorded[] = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = input instanceof Request ? input : new Request(input, init);
    const contentType = request.headers.get("content-type") ?? "";
    let formData: FormData | undefined;
    let body = new Uint8Array();
    if (contentType.startsWith("multipart/form-data")) {
      formData = await request.clone().formData();
    }
    body = new Uint8Array(await request.arrayBuffer());
    const text = new TextDecoder().decode(body);
    const recorded: Recorded = {
      url: new URL(request.url),
      method: request.method,
      headers: request.headers,
      body,
      text,
      json: () => JSON.parse(text),
      formData,
      signal: request.signal,
    };
    calls.push(recorded);
    return responder(recorded);
  }) as typeof fetch;
  return { fetch: fetchImpl, calls };
}

export const PDF = new TextEncoder().encode("%PDF-1.7\n1 0 obj\n%%EOF");

export function pdfResponse(headers: Record<string, string> = {}): Response {
  return new Response(PDF, {
    status: 200,
    headers: {
      "content-type": "application/pdf",
      "x-job-id": "11111111-1111-4111-8111-111111111111",
      "x-compile-cached": "false",
      "x-compile-warnings": "2",
      ...headers,
    },
  });
}

export function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

export function problem(
  status: number,
  code: string,
  extra: Record<string, unknown> = {},
  headers: Record<string, string> = {},
): Response {
  return new Response(
    JSON.stringify({
      type: `https://latex-api.crafter.run/docs/errors#${code}`,
      title: code.replace(/_/g, " "),
      status,
      detail: `detail for ${code}`,
      instance: "/v1/compile",
      code,
      ...extra,
    }),
    { status, headers: { "content-type": "application/problem+json; charset=utf-8", ...headers } },
  );
}

export function makeJob(overrides: Partial<Job> = {}): Job {
  const id = overrides.id ?? "11111111-1111-4111-8111-111111111111";
  const self = `https://api.test/v1/jobs/${id}`;
  return {
    id,
    status: "queued",
    mode: "async",
    engine: "pdflatex",
    entrypoint: "main.tex",
    createdAt: "2026-10-22T00:00:00.000Z",
    expiresAt: "2026-10-23T00:00:00.000Z",
    options: { timeoutMs: 60000, bibliography: "auto" },
    links: { self, events: `${self}/events` },
    ...overrides,
  };
}

/** Builds a `text/event-stream` response that emits the frames with small delays. */
export function sseResponse(frames: string[], delayMs = 1): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      for (const frame of frames) {
        await new Promise((r) => setTimeout(r, delayMs));
        controller.enqueue(encoder.encode(frame));
      }
      controller.close();
    },
  });
  return new Response(stream, { status: 200, headers: { "content-type": "text/event-stream" } });
}

export function frame(event: string, data: unknown, id?: number): string {
  const payload = typeof data === "string" ? data : JSON.stringify(data);
  return `${id !== undefined ? `id: ${id}\n` : ""}event: ${event}\ndata: ${payload}\n\n`;
}
