/** One parsed Server-Sent Events frame. */
export interface SseMessage {
  event: string;
  data: string;
  id?: string;
  retry?: number;
}

/**
 * Minimal SSE parser over a `fetch` body stream. Works in Node 20+ and browsers,
 * no `EventSource` needed. Yields one message per blank-line-terminated frame.
 */
export async function* parseSse(
  stream: ReadableStream<Uint8Array>,
  signal?: AbortSignal,
): AsyncGenerator<SseMessage, void, undefined> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let event = "";
  let data: string[] = [];
  let id: string | undefined;
  let retry: number | undefined;

  const onAbort = () => {
    reader.cancel().catch(() => {});
  };
  signal?.addEventListener("abort", onAbort, { once: true });

  const flush = (): SseMessage | undefined => {
    if (data.length === 0) {
      event = "";
      return undefined;
    }
    const message: SseMessage = { event: event || "message", data: data.join("\n") };
    if (id !== undefined) message.id = id;
    if (retry !== undefined) message.retry = retry;
    event = "";
    data = [];
    return message;
  };

  const handleLine = (line: string): SseMessage | undefined => {
    if (line === "") return flush();
    if (line.startsWith(":")) return undefined;
    const colon = line.indexOf(":");
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? "" : line.slice(colon + 1);
    if (value.startsWith(" ")) value = value.slice(1);
    switch (field) {
      case "event":
        event = value;
        break;
      case "data":
        data.push(value);
        break;
      case "id":
        if (!value.includes("\0")) id = value;
        break;
      case "retry": {
        const n = Number(value);
        if (Number.isInteger(n)) retry = n;
        break;
      }
      default:
        break;
    }
    return undefined;
  };

  try {
    while (!signal?.aborted) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let newline = buffer.indexOf("\n");
      while (newline !== -1) {
        let line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        if (line.endsWith("\r")) line = line.slice(0, -1);
        const message = handleLine(line);
        if (message) yield message;
        newline = buffer.indexOf("\n");
      }
    }
    buffer += decoder.decode();
    if (buffer) {
      const message = handleLine(buffer.replace(/\r$/, ""));
      if (message) yield message;
    }
    const last = flush();
    if (last) yield last;
  } finally {
    signal?.removeEventListener("abort", onAbort);
    reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
