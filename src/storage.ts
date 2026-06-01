import type { DesignResponse, ErrorResponse, JobKind, JobStatus, QueueJobMessage } from "./contracts";
import type { RuntimeEnv } from "./bindings";
import { requireD1, requireQueue } from "./bindings";

export async function createJob(
  env: RuntimeEnv,
  job: {
    id: string;
    tenantId: string;
    kind: JobKind;
    request: unknown;
  },
): Promise<void> {
  const now = Date.now();
  const db = requireD1(env);
  await db.prepare(
    `INSERT INTO ai_jobs
      (id, tenant_id, kind, status, request_json, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(job.id, job.tenantId, job.kind, "queued", JSON.stringify(job.request), now, now)
    .run();

  await requireQueue(env).send({
    jobId: job.id,
    tenantId: job.tenantId,
    kind: job.kind,
  } satisfies QueueJobMessage);
}

export async function setJobRunning(env: RuntimeEnv, jobId: string): Promise<void> {
  await requireD1(env).prepare("UPDATE ai_jobs SET status = ?, updated_at = ? WHERE id = ?")
    .bind("running", Date.now(), jobId)
    .run();
}

export async function setJobSucceeded(env: RuntimeEnv, jobId: string, result: unknown): Promise<void> {
  await requireD1(env).prepare(
    "UPDATE ai_jobs SET status = ?, result_json = ?, updated_at = ? WHERE id = ?",
  )
    .bind("succeeded", JSON.stringify(result), Date.now(), jobId)
    .run();
}

export async function setJobFailed(env: RuntimeEnv, jobId: string, error: ErrorResponse): Promise<void> {
  await requireD1(env).prepare("UPDATE ai_jobs SET status = ?, error_json = ?, updated_at = ? WHERE id = ?")
    .bind("failed", JSON.stringify(error), Date.now(), jobId)
    .run();
}

export async function getJobStatus(env: RuntimeEnv, jobId: string): Promise<JobStatus | null> {
  const row = await requireD1(env).prepare(
    "SELECT id, status, result_json, error_json FROM ai_jobs WHERE id = ?",
  )
    .bind(jobId)
    .first<{
      id: string;
      status: JobStatus["status"];
      result_json: string | null;
      error_json: string | null;
    }>();

  if (!row) return null;

  const status: JobStatus = {
    jobId: row.id,
    status: row.status,
  };
  if (row.status === "queued" || row.status === "running") {
    status.pollAfterSeconds = 2;
  }
  if (row.result_json) {
    status.result = JSON.parse(row.result_json) as DesignResponse;
  }
  if (row.error_json) {
    status.error = JSON.parse(row.error_json) as ErrorResponse;
  }
  return status;
}

export async function createUploadSlot(
  env: RuntimeEnv,
  slot: {
    uploadId: string;
    tenantId: string;
    objectKey: string;
    contentType: string;
    byteCount: number;
    expiresAt: number;
  },
): Promise<void> {
  await requireD1(env).prepare(
    `INSERT INTO reference_uploads
      (id, tenant_id, object_key, content_type, byte_count, created_at, expires_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      slot.uploadId,
      slot.tenantId,
      slot.objectKey,
      slot.contentType,
      slot.byteCount,
      Date.now(),
      slot.expiresAt,
    )
    .run();
}

export async function getUploadSlot(
  env: RuntimeEnv,
  uploadId: string,
): Promise<
  | {
      id: string;
      tenant_id: string;
      object_key: string;
      content_type: string;
      byte_count: number;
      expires_at: number;
    }
  | null
> {
  return requireD1(env).prepare(
    `SELECT id, tenant_id, object_key, content_type, byte_count, expires_at
     FROM reference_uploads
     WHERE id = ?`,
  )
    .bind(uploadId)
    .first();
}
