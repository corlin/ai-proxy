import type { DesignPlanRequest, DesignResponse, FlowerSnapshot } from "./contracts";
import type { RuntimeEnv } from "./bindings";
import { HttpError } from "./http";

interface ChatChoice {
  message?: {
    content?: string;
  };
}

interface ChatResponse {
  choices?: ChatChoice[];
}

export async function generatePlan(env: RuntimeEnv, input: DesignPlanRequest): Promise<DesignResponse> {
  const prompt = buildPlanPrompt(input);
  const responseText = await callChatCompletion(env, prompt.system, prompt.user);
  return normalizeDesignResponse(input.request.id, responseText);
}

export function buildPlanPrompt(input: DesignPlanRequest): { system: string; user: string } {
  const inventory = input.inventory.map(formatFlower).join("\n");
  const language = input.language === "zh" ? "Simplified Chinese" : "English";

  return {
    system: [
      "You are Floreboard's floristry design engine.",
      "Return strict JSON only. Do not include markdown.",
      `Write user-facing text in ${language}.`,
      "Use only flowers that exist in the inventory snapshot.",
      "Keep the plan practical for a working florist.",
      "Required JSON keys: title, description, meaningText, reasoning, steps, imagePrompt, estimatedCost, flowerList.",
      "flowerList items require flowerName, count, and reason.",
    ].join("\n"),
    user: [
      `Design request JSON:\n${JSON.stringify(input.request)}`,
      `Inventory snapshot:\n${inventory || "No inventory available."}`,
    ].join("\n\n"),
  };
}

function formatFlower(flower: FlowerSnapshot): string {
  return [
    `- ${flower.name}`,
    `color=${flower.color}`,
    `quantity=${flower.quantity}`,
    `category=${flower.category}`,
    `unitCost=${flower.unitCost}`,
    `retailPrice=${flower.retailPrice}`,
    flower.meaning ? `meaning=${flower.meaning}` : undefined,
    flower.cultureTags.length ? `cultureTags=${flower.cultureTags.join(",")}` : undefined,
  ]
    .filter(Boolean)
    .join("; ");
}

async function callChatCompletion(env: RuntimeEnv, system: string, user: string): Promise<string> {
  const apiKey = normalizeProviderApiKey(env.AI_PROVIDER_API_KEY);
  if (!apiKey) {
    throw new HttpError(503, "service_unavailable", "AI provider is not configured.");
  }
  if (!env.AI_CHAT_COMPLETIONS_URL) {
    throw new HttpError(503, "service_unavailable", "AI chat endpoint is not configured.");
  }
  const chatCompletionsUrl = resolveChatCompletionsUrl(env.AI_CHAT_COMPLETIONS_URL, apiKey);

  const startedAt = Date.now();
  const response = await fetch(chatCompletionsUrl, {
    method: "POST",
    headers: {
      authorization: `Bearer ${apiKey}`,
      "content-type": "application/json",
      "HTTP-Referer": "https://floreboard.cybercorlin.workers.dev",
      "X-Title": "Floreboard AI Proxy",
    },
    body: JSON.stringify({
      model: env.AI_CHAT_MODEL,
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
      temperature: 0.6,
      response_format: { type: "json_object" },
    }),
  });

  if (!response.ok) {
    const body = await safeReadSmallText(response);
    console.error(
      JSON.stringify({
        event: "provider_error",
        status: response.status,
        latencyMs: Date.now() - startedAt,
        providerHost: new URL(chatCompletionsUrl).host,
        apiKeyKind: describeApiKeyKind(apiKey),
        apiKeyLength: apiKey.length,
        body,
      }),
    );
    throw new HttpError(502, "generation_failed", "AI generation failed.");
  }

  const json = (await response.json()) as ChatResponse;
  const content = json.choices?.[0]?.message?.content;
  if (!content) {
    throw new HttpError(502, "generation_failed", "AI response did not include content.");
  }
  return content;
}

export function normalizeProviderApiKey(value: string | undefined): string {
  let apiKey = value?.trim() ?? "";
  apiKey = apiKey.replace(/^export\s+/i, "").trim();
  const assignment = apiKey.match(/^[A-Z0-9_]*API[A-Z0-9_]*KEY\s*=\s*(.+)$/i);
  if (assignment?.[1]) {
    apiKey = assignment[1].trim();
  }
  if (apiKey.toLowerCase().startsWith("bearer ")) {
    apiKey = apiKey.slice("bearer ".length).trim();
  }
  if (
    (apiKey.startsWith('"') && apiKey.endsWith('"')) ||
    (apiKey.startsWith("'") && apiKey.endsWith("'"))
  ) {
    apiKey = apiKey.slice(1, -1).trim();
  }
  return apiKey;
}

export function resolveChatCompletionsUrl(configuredUrl: string, apiKey: string): string {
  if (apiKey.startsWith("sk-or-v1-")) {
    return "https://openrouter.ai/api/v1/chat/completions";
  }
  return configuredUrl;
}

function describeApiKeyKind(apiKey: string): string {
  if (apiKey.startsWith("sk-or-v1-")) return "openrouter";
  if (apiKey.startsWith("sk-sp-")) return "dashscope_coding_plan";
  if (apiKey.startsWith("sk-")) return "general_openai_compatible";
  if (apiKey.startsWith("LTAI")) return "aliyun_access_key_id";
  return "unknown";
}

function normalizeDesignResponse(localRequestId: string, text: string): DesignResponse {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text.replace(/^```json\s*/i, "").replace(/```$/i, "").trim());
  } catch {
    throw new HttpError(502, "generation_failed", "AI response was not valid JSON.");
  }

  const value = parsed as Partial<DesignResponse>;
  if (
    typeof value.title !== "string" ||
    typeof value.description !== "string" ||
    typeof value.meaningText !== "string" ||
    !Array.isArray(value.steps) ||
    !Array.isArray(value.flowerList)
  ) {
    throw new HttpError(502, "generation_failed", "AI response did not match schema.");
  }

  const normalized: DesignResponse = {
    requestId: localRequestId,
    title: value.title,
    description: value.description,
    meaningText: value.meaningText,
    steps: value.steps.filter((step): step is string => typeof step === "string"),
    flowerList: value.flowerList
      .filter(
        (item): item is { flowerName: string; count: number; reason?: string } =>
          typeof item?.flowerName === "string" &&
          typeof item?.count === "number" &&
          Number.isFinite(item.count),
      )
      .map((item) => {
        const normalized = {
          flowerName: item.flowerName,
          count: item.count,
        } satisfies { flowerName: string; count: number; reason?: string };
        return item.reason ? { ...normalized, reason: item.reason } : normalized;
      }),
  };
  if (typeof value.reasoning === "string") {
    normalized.reasoning = value.reasoning;
  }
  if (typeof value.imagePrompt === "string") {
    normalized.imagePrompt = value.imagePrompt;
  }
  if (typeof value.estimatedCost === "number" && Number.isFinite(value.estimatedCost)) {
    normalized.estimatedCost = value.estimatedCost;
  }
  return normalized;
}

async function safeReadSmallText(response: Response): Promise<string> {
  const text = await response.text();
  return text.slice(0, 2000);
}
