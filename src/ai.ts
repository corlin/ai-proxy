import type { DesignPlanRequest, DesignResponse, FlowerSnapshot } from "./contracts";
import type { RuntimeEnv } from "./bindings";
import { requireGeneratedImages } from "./bindings";
import { HttpError } from "./http";

interface ChatChoice {
  message?: {
    content?: string;
  };
}

interface ChatResponse {
  choices?: ChatChoice[];
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
  };
}

export async function generatePlan(env: RuntimeEnv, input: DesignPlanRequest): Promise<{ result: DesignResponse; tokensUsed: number }> {
  const prompt = buildPlanPrompt(input);
  const { content, usage } = await callChatCompletion(env, prompt.system, prompt.user);
  return {
    result: normalizeDesignResponse(input.request.id, content),
    tokensUsed: usage?.total_tokens ?? 0,
  };
}

export async function generateImage(
  env: RuntimeEnv,
  prompt: string,
  tenantId: string,
  jobId: string,
  origin: string,
): Promise<string> {
  const apiKey = normalizeProviderApiKey(env.AI_PROVIDER_API_KEY);
  if (!apiKey) {
    throw new HttpError(503, "service_unavailable", "AI provider is not configured.");
  }
  const chatCompletionsUrl = resolveChatCompletionsUrl(env.AI_CHAT_COMPLETIONS_URL || "https://openrouter.ai/api/v1/chat/completions", apiKey);

  const startedAt = Date.now();
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 25000); // 25s timeout to beat Cloudflare's 30s limit

  try {
    const response = await fetch(chatCompletionsUrl, {
      method: "POST",
      signal: controller.signal,
      headers: {
        authorization: `Bearer ${apiKey}`,
        "content-type": "application/json",
        "HTTP-Referer": "https://floreboard.cybercorlin.workers.dev",
        "X-Title": "Floreboard AI Proxy",
      },
      body: JSON.stringify({
        model: env.AI_IMAGE_MODEL,
        messages: [{ role: "user", content: prompt }],
        modalities: ["image"],
      }),
    });
    clearTimeout(timeoutId);

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
    throw new HttpError(502, "generation_failed", `Image generation failed. Status: ${response.status}. Error: ${body.substring(0, 500)}`);
  }

  const text = await response.text();
  let json: any;
  try {
    json = JSON.parse(text);
  } catch (err) {
    throw new HttpError(502, "generation_failed", "JSON parse failed. Status: " + response.status + ". Raw: " + text.substring(0, 500));
  }

  if (json.error) {
    throw new HttpError(502, "generation_failed", "OpenRouter Error: " + JSON.stringify(json.error));
  }

  const message = json.choices?.[0]?.message;
  if (!message) {
    throw new HttpError(502, "generation_failed", "No message in response. Raw: " + text.substring(0, 500));
  }

  let imageUrl = "";
  if (message.images && message.images.length > 0) {
    imageUrl = message.images[0].imageUrl?.url || message.images[0].image_url?.url || message.images[0].url || "";
  } else if (message.content) {
    imageUrl = message.content.trim();
    const markdownMatch = imageUrl.match(/!\[.*?\]\((.*?)\)/);
    if (markdownMatch?.[1]) {
      imageUrl = markdownMatch[1];
    }
  }

  if (!imageUrl) {
    throw new HttpError(502, "generation_failed", "No image URL found in response. JSON: " + JSON.stringify(json).substring(0, 500));
  }

  if (imageUrl.startsWith("data:image/")) {
    const commaIndex = imageUrl.indexOf(',');
    if (commaIndex === -1) throw new HttpError(502, "generation_failed", "Invalid data URL returned.");
    const prefix = imageUrl.substring(0, commaIndex);
    const contentTypeMatch = prefix.match(/^data:(image\/[a-zA-Z]+);base64$/);
    const contentType = contentTypeMatch ? contentTypeMatch[1] : "image/png";
    const base64Data = imageUrl.substring(commaIndex + 1);
    const binaryString = atob(base64Data);
    const bytes = new Uint8Array(binaryString.length);
    for (let i = 0; i < binaryString.length; i++) {
      bytes[i] = binaryString.charCodeAt(i);
    }

    const objectKey = `${tenantId}/${jobId}`;
    const options: R2PutOptions = {};
    if (contentType) {
      options.httpMetadata = { contentType };
    }
    await requireGeneratedImages(env).put(objectKey, bytes, options);
    
    return `${origin}/v1/images/downloads/${jobId}`;
  }

  return imageUrl;
  } catch (error) {
    clearTimeout(timeoutId);
    throw new HttpError(502, "generation_failed", error instanceof Error ? error.message : "Unknown generation error");
  }
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

async function callChatCompletion(env: RuntimeEnv, system: string, user: string): Promise<{ content: string; usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number } }> {
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
  return json.usage ? { content, usage: json.usage } : { content };
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
