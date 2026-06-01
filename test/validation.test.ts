import { describe, expect, it } from "vitest";
import { buildPlanPrompt, normalizeProviderApiKey, resolveChatCompletionsUrl } from "../src/ai";
import { validateImageGenerationRequest, validateUploadSlotRequest } from "../src/validation";
import type { DesignPlanRequest } from "../src/contracts";

describe("validateUploadSlotRequest", () => {
  it("accepts bounded image uploads", () => {
    const result = validateUploadSlotRequest({
      tenantId: "store-1",
      contentType: "image/jpeg",
      byteCount: 1024,
    });

    expect(result.tenantId).toBe("store-1");
  });

  it("rejects oversized images", () => {
    expect(() =>
      validateUploadSlotRequest({
        tenantId: "store-1",
        contentType: "image/jpeg",
        byteCount: 20_000_000,
      }),
    ).toThrow("Image must be 12 MB or smaller.");
  });
});

describe("buildPlanPrompt", () => {
  it("keeps provider details out of the client contract", () => {
    const request: DesignPlanRequest = {
      tenantId: "store-1",
      language: "en",
      request: {
        id: "request-1",
        occasion: "home",
        recipient: "self",
        style: "fresh",
        budget: 500,
      },
      inventory: [
        {
          id: "flower-1",
          name: "Rose",
          color: "Red",
          quantity: 12,
          category: "main",
          unitCost: 5,
          retailPrice: 15,
          cultureTags: ["western"],
        },
      ],
    };

    const prompt = buildPlanPrompt(request);

    expect(prompt.system).toContain("Return strict JSON only");
    expect(prompt.user).toContain("Rose");
    expect(prompt.user).not.toContain("apiKey");
    expect(prompt.user).not.toContain("model");
  });
});

describe("normalizeProviderApiKey", () => {
  it("accepts pasted bearer and quoted secret values", () => {
    expect(normalizeProviderApiKey(" Bearer 'sk-test' ")).toBe("sk-test");
    expect(normalizeProviderApiKey('"sk-test"')).toBe("sk-test");
    expect(normalizeProviderApiKey("AI_PROVIDER_API_KEY=sk-test")).toBe("sk-test");
    expect(normalizeProviderApiKey("export DASHSCOPE_API_KEY='sk-test'")).toBe("sk-test");
    expect(normalizeProviderApiKey("sk-test")).toBe("sk-test");
  });
});

describe("resolveChatCompletionsUrl", () => {
  it("routes Coding Plan keys to the dedicated endpoint", () => {
    expect(
      resolveChatCompletionsUrl(
        "https://dashscope-intl.aliyuncs.com/compatible-mode/v1/chat/completions",
        "sk-sp-test",
      ),
    ).toBe("https://coding-intl.dashscope.aliyuncs.com/v1/chat/completions");
  });

  it("keeps general DashScope keys on the configured endpoint", () => {
    expect(resolveChatCompletionsUrl("https://example.com/chat/completions", "sk-test")).toBe(
      "https://example.com/chat/completions",
    );
  });
});

describe("validateImageGenerationRequest", () => {
  it("requires a bounded server-side image prompt", () => {
    const result = validateImageGenerationRequest({
      tenantId: "store-1",
      requestId: "request-1",
      prompt: "A compact garden bouquet with soft morning light.",
    });

    expect(result.prompt).toContain("garden bouquet");
  });
});
