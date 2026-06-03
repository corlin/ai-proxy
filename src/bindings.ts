import { HttpError } from "./http";

export type RuntimeEnv = Env & {
  AI_CHAT_COMPLETIONS_URL?: string;
  AI_PROVIDER_API_KEY?: string;
  APP_AUTH_TOKEN?: string;
};

export function requireD1(env: RuntimeEnv): D1Database {
  if (!env.DB) {
    throw new HttpError(503, "service_unavailable", "Database binding is not configured.");
  }
  return env.DB;
}

export function requireQueue(env: RuntimeEnv): Queue {
  if (!env.AI_JOBS) {
    throw new HttpError(503, "service_unavailable", "Queue binding is not configured.");
  }
  return env.AI_JOBS;
}

export function requireReferenceImages(env: RuntimeEnv): R2Bucket {
  if (!env.REFERENCE_IMAGES) {
    throw new HttpError(503, "service_unavailable", "Reference image storage is not configured.");
  }
  return env.REFERENCE_IMAGES;
}

export function requireGeneratedImages(env: RuntimeEnv): R2Bucket {
  if (!env.GENERATED_IMAGES) {
    throw new HttpError(503, "service_unavailable", "Generated image storage is not configured.");
  }
  return env.GENERATED_IMAGES;
}
