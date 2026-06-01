import { describe, expect, it } from "vitest";
import worker from "../src/index";
import type { RuntimeEnv } from "../src/bindings";

const ctx = {
  waitUntil() {},
  passThroughOnException() {},
} as unknown as ExecutionContext;

describe("health endpoint", () => {
  it("matches the iOS health response contract", async () => {
    const response = await worker.fetch(
      new Request("https://example.com/health"),
      { ENVIRONMENT: "development" } as RuntimeEnv,
      ctx,
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      ok: true,
      service: "floreboard-ai-proxy",
      environment: "development",
    });
  });
});
