import { LatexApiError } from "@jibaru/latex-api-sdk";
import { describe, expect, it } from "vitest";
import { describePayloadTooLarge, parseByteLimit } from "../src/commands/compile";

function tooLarge(detail: string): LatexApiError {
  return new LatexApiError(`Payload too large: ${detail}`, {
    status: 413,
    code: "payload_too_large",
    problem: {
      type: "https://x/docs/errors#payload_too_large",
      title: "Payload too large",
      status: 413,
      detail,
      code: "payload_too_large",
    },
  });
}

describe("payload too large reporting", () => {
  it("extracts the server limit from the problem detail", () => {
    expect(parseByteLimit(tooLarge("Request body exceeds 52428800 bytes"))).toBe(52428800);
    expect(parseByteLimit(tooLarge("Body exceeds 1048576 bytes"))).toBe(1048576);
    expect(parseByteLimit(tooLarge("Too big"))).toBeUndefined();
  });

  it("mentions the attempted size, the limit and the remedy", () => {
    const message = describePayloadTooLarge(tooLarge("Request body exceeds 52428800 bytes"), {
      uploadBytes: 64_172_032,
      transport: "zip",
    });
    expect(message).toBe(
      "Payload too large; zip was 61.20 MB; limit 50.00 MB; exclude files with .latexapiignore (e.g. figures sources, PDFs, drafts).",
    );
    expect(
      describePayloadTooLarge(tooLarge("Too big"), { uploadBytes: 2048, transport: "single" }),
    ).toBe("Payload too large; file was 2.0 KB; split the document or compile a folder.");
    expect(describePayloadTooLarge(tooLarge("x"), {})).toBe(
      "Payload too large; exclude files with .latexapiignore (e.g. figures sources, PDFs, drafts).",
    );
  });
});
