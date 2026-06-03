import type {
  DesignPlanRequest,
  HealthResponse,
  ImageGenerationRequest,
  QueueJobMessage,
  UploadSlotRequest,
  VisualDesignRequest,
} from "./contracts";
import { generatePlan, generateImage } from "./ai";
import type { RuntimeEnv } from "./bindings";
import { requireD1, requireReferenceImages, requireGeneratedImages } from "./bindings";
import { requireAppAuth } from "./auth";
import { errorResponse, HttpError, jsonResponse, readJson, requireMethod, routePath, withCors } from "./http";
import {
  createJob,
  createUploadSlot,
  getJobStatus,
  getUploadSlot,
  setJobFailed,
  setJobRunning,
  setJobSucceeded,
  getJobRequest,
} from "./storage";
import {
  validateDesignPlanRequest,
  validateImageGenerationRequest,
  validateUploadSlotRequest,
  validateVisualDesignRequest,
} from "./validation";

const jsonLimitBytes = 256_000;

export default {
  async fetch(request, env, ctx): Promise<Response> {
    if (request.method === "OPTIONS") {
      return withCors(new Response(null, { status: 204 }));
    }

    try {
      const response = await handleRequest(request, env, ctx);
      return withCors(response);
    } catch (error) {
      return withCors(errorResponse(error));
    }
  },

  async queue(batch, env): Promise<void> {
    for (const message of batch.messages) {
      const job = message.body as QueueJobMessage;
      try {
        await processQueueJob(env, job);
        message.ack();
      } catch (error) {
        console.error("queue_job_failed", { jobId: job.jobId, error });
        await setJobFailed(env, job.jobId, {
          code: "generation_failed",
          message: error instanceof Error ? error.message : "Unknown error",
        });
        message.ack(); // Do not retry to prevent DB flapping
      }
    }
  },
} satisfies ExportedHandler<RuntimeEnv, QueueJobMessage>;

async function handleRequest(request: Request, env: RuntimeEnv, ctx: ExecutionContext): Promise<Response> {
  const path = routePath(request);

  if (path.startsWith("test")) {
    requireMethod(request, "GET");
    const url = new URL(request.url);
    const prompt = url.searchParams.get("prompt") || "Test image";
    try {
      const response = await fetch(env.AI_CHAT_COMPLETIONS_URL, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${env.AI_PROVIDER_API_KEY}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: env.AI_IMAGE_MODEL,
          messages: [{ role: "user", content: prompt }],
          modalities: ["image"],
        }),
      });
      const text = await response.text();
      return jsonResponse({ status: response.status, body: text, model: env.AI_IMAGE_MODEL });
    } catch (e: any) {
      return jsonResponse({ error: e.message });
    }
  }

  if (path === "health") {
    requireMethod(request, "GET");
    return jsonResponse({
      ok: true,
      service: "floreboard-ai-proxy",
      environment: env.ENVIRONMENT,
    } satisfies HealthResponse);
  }

  await requireAppAuth(request, env);

  if (path === "v1/designs/plan") {
    requireMethod(request, "POST");
    const body = validateDesignPlanRequest(await readJson<DesignPlanRequest>(request, jsonLimitBytes));
    const result = await generatePlan(env, body);
    ctx.waitUntil(recordUsage(env, body.tenantId, result.requestId, "plan", "succeeded"));
    return jsonResponse(result);
  }

  if (path === "v1/uploads/reference-image") {
    requireMethod(request, "POST");
    const body = validateUploadSlotRequest(await readJson<UploadSlotRequest>(request, jsonLimitBytes));
    const uploadId = crypto.randomUUID();
    const objectKey = `${body.tenantId}/${uploadId}`;
    const expiresAt = Date.now() + 15 * 60 * 1000;
    await createUploadSlot(env, {
      uploadId,
      tenantId: body.tenantId,
      objectKey,
      contentType: body.contentType,
      byteCount: body.byteCount,
      expiresAt,
    });
    const uploadUrl = new URL(`/v1/uploads/reference-image/${uploadId}`, request.url);
    return jsonResponse({ uploadId, uploadUrl: uploadUrl.toString(), expiresAt });
  }

  const uploadMatch = path.match(/^v1\/uploads\/reference-image\/([^/]+)$/);
  if (uploadMatch) {
    requireMethod(request, "PUT");
    const uploadId = uploadMatch[1];
    if (!uploadId) throw new HttpError(400, "unsupported_image", "Upload id is required.");
    const slot = await getUploadSlot(env, uploadId);
    if (!slot || slot.expires_at < Date.now()) {
      throw new HttpError(404, "unsupported_image", "Upload slot was not found or expired.");
    }
    if (!request.body) {
      throw new HttpError(400, "unsupported_image", "Image body is required.");
    }
    await requireReferenceImages(env).put(slot.object_key, request.body, {
      httpMetadata: { contentType: slot.content_type },
      customMetadata: {
        tenantId: slot.tenant_id,
        uploadId: slot.id,
      },
    });
    return jsonResponse({ uploadId, uploaded: true });
  }

  if (path === "v1/designs/visual") {
    requireMethod(request, "POST");
    const body = validateVisualDesignRequest(await readJson<VisualDesignRequest>(request, jsonLimitBytes));
    const jobId = crypto.randomUUID();
    await createJob(env, { id: jobId, tenantId: body.tenantId, kind: "visual_design", request: body });
    return jsonResponse({ jobId, status: "queued", pollAfterSeconds: 2 }, { status: 202 });
  }

  if (path === "r2-list") {
    const list = await requireGeneratedImages(env).list();
    return jsonResponse(list);
  }

  if (path === "v1/images/generate") {
    requireMethod(request, "POST");
    const body = validateImageGenerationRequest(
      await readJson<ImageGenerationRequest>(request, jsonLimitBytes),
    );
    const jobId = crypto.randomUUID();
    await createJob(env, { id: jobId, tenantId: body.tenantId, kind: "image_generation", request: body });
    return jsonResponse({ jobId, status: "queued", pollAfterSeconds: 2 }, { status: 202 });
  }

  const jobMatch = path.match(/^v1\/jobs\/([^/]+)$/);
  if (jobMatch) {
    requireMethod(request, "GET");
    const jobId = jobMatch[1];
    if (!jobId) throw new HttpError(400, "invalid_request", "Job id is required.");
    const status = await getJobStatus(env, jobId);
    if (!status) throw new HttpError(404, "not_found", "Job was not found.");
    return jsonResponse(status);
  }

  const downloadMatch = path.match(/^v1\/images\/downloads\/([^/]+)$/);
  if (downloadMatch) {
    requireMethod(request, "GET");
    const jobId = downloadMatch[1];
    if (!jobId) throw new HttpError(400, "invalid_request", "Job id is required.");
    
    // Attempt to read from GENERATED_IMAGES R2 bucket
    // To locate the object, we need the tenantId, which is in the ai_jobs table
    const status = await getJobStatus(env, jobId);
    if (!status) throw new HttpError(404, "not_found", "Job was not found.");
    
    // We didn't store tenantId directly in JobStatus, but we can look it up if we have to.
    // Actually, we can list the bucket with prefix */jobId or we can look up the job row.
    // Since we know the job exists, we need the tenantId. Let's just fetch the job request to get the tenantId!
    const jobReq = await getJobRequest<{ tenantId: string }>(env, jobId);
    if (!jobReq) throw new HttpError(404, "not_found", "Job request not found.");

    const objectKey = `${jobReq.tenantId}/${jobId}`;
    const object = await requireGeneratedImages(env).get(objectKey);
    
    if (!object) {
      throw new HttpError(404, "not_found", "Image not found in storage.");
    }

    const headers = new Headers();
    object.writeHttpMetadata(headers);
    headers.set("etag", object.httpEtag);

    return new Response(object.body, {
      headers,
    });
  }

  throw new HttpError(404, "not_found", "Endpoint was not found.");
}

async function processQueueJob(env: RuntimeEnv, job: QueueJobMessage): Promise<void> {
  await setJobRunning(env, job.jobId);

  if (job.kind === "visual_design") {
    await setJobFailed(env, job.jobId, {
      code: "generation_failed",
      message: "Visual design generation is not enabled yet.",
    });
    return;
  }

  if (job.kind === "image_generation") {
    const jobReq = await getJobRequest<ImageGenerationRequest>(env, job.jobId);
    if (!jobReq) {
      await setJobFailed(env, job.jobId, { code: "invalid_request", message: "Job request not found." });
      return;
    }
    
    // Determine the origin for building the callback URL
    // In a queue worker, request object is not available, so we construct from convention.
    const origin = `https://floreboard-ai-proxy.cybercorlin.workers.dev`;
    
    const imageUrl = await generateImage(env, jobReq.prompt, jobReq.tenantId, job.jobId, origin);
    await setJobSucceeded(env, job.jobId, { imageUrl });
    return;
  }

  await setJobFailed(env, job.jobId, {
    code: "generation_failed",
    message: "Image generation is not enabled yet.",
  });
}

async function recordUsage(
  env: RuntimeEnv,
  tenantId: string,
  requestId: string,
  kind: string,
  status: string,
): Promise<void> {
  await requireD1(env).prepare(
    `INSERT INTO usage_events
      (id, tenant_id, request_id, kind, status, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  )
    .bind(crypto.randomUUID(), tenantId, requestId, kind, status, Date.now())
    .run();
}
