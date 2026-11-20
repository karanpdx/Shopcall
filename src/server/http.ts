import { ZodError } from "zod";
import type { ApiErrorCode } from "@/contracts/api";

/** Domain error carrying the HTTP status and stable API error code. */
export class HttpError extends Error {
  constructor(readonly status: number, readonly code: ApiErrorCode, message: string) {
    super(message);
  }
}

export const fail = (status: number, code: ApiErrorCode, message: string): never => {
  throw new HttpError(status, code, message);
};

export function ok<T>(data: T, init: ResponseInit = {}) {
  const headers = new Headers(init.headers);
  if (!headers.has("cache-control")) headers.set("cache-control", "no-store");
  return Response.json({ ok: true, data }, { ...init, headers });
}

export function errorResponse(err: unknown, headers?: HeadersInit) {
  if (err instanceof HttpError) {
    return Response.json({ ok: false, error: { code: err.code, message: err.message } }, { status: err.status, headers });
  }
  if (err instanceof ZodError) {
    const message = err.issues.map(i => `${i.path.join(".") || "body"}: ${i.message}`).join("; ");
    return Response.json({ ok: false, error: { code: "INVALID_INPUT", message } }, { status: 400, headers });
  }
  console.error("[api] unhandled error", err);
  return Response.json({ ok: false, error: { code: "INTERNAL", message: "Internal server error" } }, { status: 500, headers });
}

/** Wraps a route handler so every thrown error becomes a typed ApiError response. */
export function handle<A extends unknown[]>(fn: (...args: A) => Promise<Response>) {
  return async (...args: A) => {
    try {
      return await fn(...args);
    } catch (err) {
      return errorResponse(err);
    }
  };
}

export async function readJson(req: Request): Promise<unknown> {
  try {
    return await req.json();
  } catch {
    return fail(400, "INVALID_INPUT", "Request body must be valid JSON");
  }
}

export type IdParams = { params: Promise<{ id: string }> };
