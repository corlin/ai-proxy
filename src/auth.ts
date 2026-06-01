import type { RuntimeEnv } from "./bindings";
import { HttpError } from "./http";

export async function requireAppAuth(request: Request, env: RuntimeEnv): Promise<void> {
  if (!env.APP_AUTH_TOKEN) {
    return;
  }

  const header = request.headers.get("authorization") ?? "";
  const token = header.startsWith("Bearer ") ? header.slice("Bearer ".length) : "";
  if (!(await timingSafeEqual(token, env.APP_AUTH_TOKEN))) {
    throw new HttpError(401, "unauthorized", "Unauthorized.");
  }
}

async function timingSafeEqual(left: string, right: string): Promise<boolean> {
  const encoder = new TextEncoder();
  const leftHash = await crypto.subtle.digest("SHA-256", encoder.encode(left));
  const rightHash = await crypto.subtle.digest("SHA-256", encoder.encode(right));
  const leftBytes = new Uint8Array(leftHash);
  const rightBytes = new Uint8Array(rightHash);
  if (leftBytes.byteLength !== rightBytes.byteLength) return false;

  let diff = 0;
  for (let index = 0; index < leftBytes.byteLength; index += 1) {
    diff |= (leftBytes[index] ?? 0) ^ (rightBytes[index] ?? 0);
  }
  return diff === 0;
}
