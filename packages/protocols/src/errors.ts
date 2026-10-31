export const ERROR_TYPE_BY_STATUS: Record<number, string> = {
  400: "invalid_request_error",
  401: "authentication_error",
  402: "insufficient_quota",
  403: "permission_error",
  404: "not_found_error",
  413: "invalid_request_error",
  429: "rate_limit_error",
  500: "server_error",
  502: "server_error",
  503: "server_error",
  504: "server_error",
};

const ENTITLEMENT_CODES = new Set([
  "ENTITLEMENT_ERROR",
  "NOT_SUBSCRIBED",
  "PLAN_REQUIRED",
  "MODEL_NOT_IN_PLAN",
]);

const BLOCKED_CODES = new Set(["3012", "405", "HTTP_405"]);

const EDGE_BLOCK_MARKERS = [
  "does not have permission to get url",
  "403 forbidden",
  "error: forbidden",
];

export type ErrorKind =
  | "ok"
  | "insufficient_credits"
  | "unauthorized"
  | "entitlement"
  | "edge_block"
  | "rate_limited"
  | "server"
  | "client"
  | "transport";

function bodyText(body: string | Uint8Array | undefined | null): string {
  if (body == null) return "";
  return typeof body === "string" ? body : new TextDecoder().decode(body);
}

export function isEntitlementCode(code: string): boolean {
  const value = (code || "").toUpperCase();
  if (!value) return false;
  if (ENTITLEMENT_CODES.has(value)) return true;
  return value.includes("ENTITLEMENT") || value.includes("SUBSCRIB") || value.includes("PLAN");
}

export function isBlockCode(code: string, status = 0): boolean {
  if (status === 405) return true;
  const value = String(code || "").toUpperCase();
  return BLOCKED_CODES.has(value) || value.includes("3012") || value.includes("405");
}

function errorCode(body: string | Uint8Array | undefined | null): string {
  try {
    const parsed = JSON.parse(bodyText(body)) as { error?: unknown };
    const err = parsed.error ?? parsed;
    if (err && typeof err === "object") {
      const record = err as Record<string, unknown>;
      return String(record.code || record.statusCode || "").toUpperCase();
    }
  } catch {
    return "";
  }
  return "";
}

export function looksLikeEdgeBlock(body: string | Uint8Array | undefined | null): boolean {
  const text = bodyText(body).toLowerCase();
  if (!text.includes("<html")) return false;
  return EDGE_BLOCK_MARKERS.some((marker) => text.includes(marker));
}

export function parseUpstreamError(status: number, body: string | Uint8Array | undefined | null) {
  const text = bodyText(body);
  try {
    const parsed = JSON.parse(text) as { error?: unknown };
    const err = parsed.error ?? parsed;
    if (err && typeof err === "object") {
      const record = err as Record<string, unknown>;
      return {
        code: String(record.code || record.statusCode || record.type || `http_${status}`),
        message: String(record.message || record.msg || text.slice(0, 400)),
        raw: parsed,
      };
    }
  } catch {
    /* plain text */
  }
  return { code: `http_${status}`, message: text.slice(0, 400), raw: null };
}

export function classify(status: number, body?: string | Uint8Array | null): ErrorKind {
  const info = parseUpstreamError(status, body);
  if (info.code === "11113") return "insufficient_credits";
  if (status === 200) return "ok";
  if (status === 401) return "unauthorized";
  if (status === 403) {
    if (isEntitlementCode(errorCode(body))) return "entitlement";
    if (looksLikeEdgeBlock(body)) return "edge_block";
    return "client";
  }
  if (status === 402) return "insufficient_credits";
  if (status === 429) return "rate_limited";
  if (status >= 500 && status < 600) return "server";
  return "client";
}

export function openaiError(
  status: number,
  code: string,
  message: string,
  extra?: Record<string, unknown> | null,
) {
  const error: Record<string, unknown> = {
    message,
    type: ERROR_TYPE_BY_STATUS[status] ?? "api_error",
    param: null,
    code,
  };
  if (extra) Object.assign(error, extra);
  return { error };
}

export function anthropicError(
  status: number,
  code: string,
  message: string,
  extra?: Record<string, unknown> | null,
) {
  const mapping: Record<number, string> = {
    400: "invalid_request_error",
    401: "authentication_error",
    403: "permission_error",
    404: "not_found_error",
    413: "request_too_large",
    429: "rate_limit_error",
  };
  const type = status >= 500
    ? status === 529
      ? "overloaded_error"
      : "api_error"
    : (mapping[status] ?? "api_error");
  const error: Record<string, unknown> = { type, message };
  if (code) error.code = code;
  if (extra) Object.assign(error, extra);
  return { type: "error", error };
}

export const UNSUPPORTED_FEATURE_MESSAGE =
  "Automated account generation, CAPTCHA solving, and promotional credit claims are not part of this application. Add an account you own by importing a snapshot or signing in.";
