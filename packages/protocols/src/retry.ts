export interface OverloadConfig {
  overloadBaseDelaySeconds: number;
  overloadMaxDelaySeconds: number;
}

export function isModelOverload(status: number, code: unknown): boolean {
  return status === 529 || String(code) === "1305" || String(code) === "overloaded_error";
}

export function retryAfterSeconds(headers: Record<string, string | undefined> | undefined): number | null {
  const normalized: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers ?? {})) {
    if (value != null) normalized[key.toLowerCase()] = value;
  }
  for (const [key, scale] of [
    ["retry-after-ms", 0.001],
    ["retry-after", 1],
  ] as const) {
    const value = normalized[key];
    if (value == null) continue;
    const numeric = Number(value);
    if (Number.isFinite(numeric)) {
      const seconds = numeric * scale;
      if (seconds >= 0) return seconds;
      continue;
    }
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) {
      const seconds = (parsed - Date.now()) / 1000;
      if (seconds >= 0) return seconds;
    }
  }
  return null;
}

export function overloadDelay(
  cfg: OverloadConfig,
  retryNumber: number,
  retryAfter: number | null = null,
  randomUnit: () => number = Math.random,
): number {
  if (retryAfter != null) return Math.min(retryAfter, cfg.overloadMaxDelaySeconds);
  const base = cfg.overloadBaseDelaySeconds * 2 ** (retryNumber - 1);
  const delay = Math.min(base, cfg.overloadMaxDelaySeconds);
  return delay * (0.5 + randomUnit() * 0.5);
}
