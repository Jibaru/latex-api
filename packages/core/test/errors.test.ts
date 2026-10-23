import { describe, expect, it, vi } from "vitest";
import { DeviceFlowError, DomainError, isDomainError, TemplateNotFoundError } from "../src/index";

describe("isDomainError", () => {
  it("recognises errors from another copy of the module (separate bundles)", async () => {
    vi.resetModules();
    const copy = await import("../src/domain/errors");
    const foreign = new copy.JobNotFoundError("x");
    expect(foreign instanceof DomainError).toBe(false);
    expect(isDomainError(foreign)).toBe(true);
    expect(isDomainError(new TemplateNotFoundError("t"))).toBe(true);
    expect(isDomainError(new DeviceFlowError("authorization_pending", "wait"))).toBe(true);
    expect(isDomainError(new Error("plain"))).toBe(false);
    expect(isDomainError(null)).toBe(false);
  });
});
