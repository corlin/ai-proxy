import type {
  DesignPlanRequest,
  ImageGenerationRequest,
  QueueJobMessage,
  UploadSlotRequest,
  VisualDesignRequest,
} from "./contracts";
import { generatePlan } from "./ai";
import type { RuntimeEnv } from "./bindings";
import { requireD1, requireReferenceImages } from "./bindings";
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
          message: "Generation failed after retry.",
        });
        message.retry();
      }
    }
  },
} satisfies ExportedHandler<RuntimeEnv, QueueJobMessage>;

async function handleRequest(request: Request, env: RuntimeEnv, ctx: ExecutionContext): Promise<Response> {
  const path = routePath(request);

  if (path === "health") {
    requireMethod(request, "GET");
    return jsonResponse({ ok: true, environment: env.ENVIRONMENT });
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
