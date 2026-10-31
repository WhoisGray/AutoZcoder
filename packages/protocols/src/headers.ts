import { randomUUID } from "node:crypto";

export interface Fingerprint {
  userAgent: string;
  clientVersion: string;
  platform: string;
  deviceMid: string;
  language: string;
  timezone: string;
  osCategory: string;
  osVersion: string;
}

export const STATIC_HEADERS: Record<string, string> = {
  accept: "*/*",
  "content-type": "application/json",
  "http-referer": "https://zcode.z.ai",
  "anthropic-version": "2023-06-01",
  "anthropic-beta": "mid-conversation-system-2026-04-07",
};

export function defaultFingerprint(): Fingerprint {
  return {
    userAgent: "ZCode/3.16.3 ai-sdk/provider-utils/4.0.27 runtime/node.js/24",
    clientVersion: "3.16.3",
    platform: process.platform === "darwin" ? "darwin" : process.platform === "win32" ? "win32-x64" : "linux",
    deviceMid: "",
    language: "en-US",
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC",
    osCategory: process.platform === "darwin" ? "darwin" : process.platform === "win32" ? "windows" : "linux",
    osVersion: "",
  };
}

export function mergeAnthropicBeta(base: string, extra?: string | null): string {
  const parts = (base || "").split(",").map((part) => part.trim()).filter(Boolean);
  for (const part of (extra || "").split(",")) {
    const value = part.trim();
    if (value && !parts.includes(value)) parts.push(value);
  }
  return parts.join(",");
}

export function buildHeaders(
  accessToken: string,
  fp: Fingerprint,
  taskId?: string | null,
  options: { deviceMid?: string | null; includeDeviceMid?: boolean; anthropicBeta?: string | null } = {},
): Record<string, string> {
  const token = accessToken.replace(/^Bearer\s+/i, "").trim();
  const headers: Record<string, string> = { ...STATIC_HEADERS };
  if (options.anthropicBeta) {
    headers["anthropic-beta"] = mergeAnthropicBeta(STATIC_HEADERS["anthropic-beta"] ?? "", options.anthropicBeta);
  }
  Object.assign(headers, {
    authorization: `Bearer ${token}`,
    "x-api-key": token,
    "user-agent": fp.userAgent,
    "x-device-mid": options.deviceMid || fp.deviceMid,
    "x-client-language": fp.language,
    "x-client-timezone": fp.timezone,
    "x-os-category": fp.osCategory,
    "x-os-version": fp.osVersion,
    "x-platform": fp.platform,
    "x-release-channel": "production",
    "x-title": "Z Code@electron",
    "x-zcode-agent": "glm",
    "x-zcode-app-version": fp.clientVersion,
    "x-zcode-session-type": "main",
    "x-query-id": randomUUID(),
    "x-request-id": randomUUID(),
    "x-zcode-trace-id": randomUUID(),
    "x-session-id": taskId || randomUUID(),
  });
  if (options.includeDeviceMid === false) delete headers["x-device-mid"];
  return headers;
}
