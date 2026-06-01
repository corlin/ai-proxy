import type { ErrorResponse } from "./contracts";

export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly requestId?: string,
  ) {
    super(message);
  }
}

export function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  const headers = new Headers(init.headers);
  headers.set("content-type", "application/json; charset=utf-8");
  return new Response(JSON.stringify(body), { ...init, headers });
}

export function errorResponse(error: unknown): Response {
  if (error instanceof HttpError) {
    const body: ErrorResponse = {
      code: error.code,
      message: error.message,
    };
    if (error.requestId) {
      body.requestId = error.requestId;
    }
    return jsonResponse(body, { status: error.status });
  }

  console.error("Unhandled error", error);
  return jsonResponse(
    {
      code: "service_unavailable",
      message: "AI service is temporarily unavailable.",
    } satisfies ErrorResponse,
    { status: 500 },
  );
}

export async function readJson<T>(request: Request, maxBytes: number): Promise<T> {
  const contentLength = request.headers.get("content-length");
  if (contentLength && Number(contentLength) > maxBytes) {
    throw new HttpError(413, "payload_too_large", "Request payload is too large.");
  }

  const text = await request.text();
  if (text.length > maxBytes) {
    throw new HttpError(413, "payload_too_large", "Request payload is too large.");
  }

  try {
    return JSON.parse(text) as T;
  } catch {
    throw new HttpError(400, "invalid_json", "Request body must be valid JSON.");
  }
}

export function requireMethod(request: Request, method: string): void {
  if (request.method !== method) {
    throw new HttpError(405, "method_not_allowed", "Method not allowed.");
  }
}

export function routePath(request: Request): string {
  const url = new URL(request.url);
  return url.pathname.replace(/^\/+|\/+$/g, "");
}

export function withCors(response: Response): Response {
  const headers = new Headers(response.headers);
  headers.set("access-control-allow-origin", "*");
  headers.set("access-control-allow-methods", "GET,POST,PUT,OPTIONS");
  headers.set("access-control-allow-headers", "authorization,content-type");
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}
