export const WINDOW_GRACE_S = 30;

export type AccountState = "ready" | "cooling" | "exhausted" | "dead";

export interface QuotaBucket {
  remaining?: number;
  resets_at?: number;
  starts_at?: number;
}

export interface PlanRecord {
  status?: string;
  starts_at?: number;
  ends_at?: number;
}

export class Account {
  id: string;
  email = "";
  accessToken = "";
  refreshToken = "";
  expiresAt = 0;
  source = "unknown";
  state: AccountState = "ready";
  lastUsed = 0;
  useSeq = 0;
  inFlight = 0;
  errorCount = 0;
  cooldownUntil = 0;
  balanceMicro: number | null = null;
  lastError = "";
  paidExhausted = false;
  modelCaps: Record<string, number> = {};
  modelCapInfo: Record<string, { code?: string; message?: string; release_at?: number }> = {};
  notes: Record<string, any> = {};
  quotaStrikes = 0;

  constructor(id: string) {
    this.id = id;
  }

  isModelCapped(model: string, at = Date.now() / 1000): boolean {
    const until = this.modelCaps[model];
    return Boolean(until && until > at);
  }

  planActive(at = Date.now() / 1000): boolean {
    const plans = this.notes.plans as PlanRecord[] | undefined;
    if (!plans || plans.length === 0) return true;
    return plans.some(
      (plan) =>
        plan.status === "active" &&
        (!plan.starts_at || plan.starts_at <= at) &&
        (!plan.ends_at || plan.ends_at > at),
    );
  }

  modelEligible(model: string, at = Date.now() / 1000): boolean {
    if (!this.planActive(at)) return false;
    const quotas = this.notes.quotas as Record<string, QuotaBucket> | undefined;
    if (!quotas || Object.keys(quotas).length === 0) return true;
    const quota = quotas[model];
    if (!quota) return false;
    if ((quota.starts_at ?? 0) > at + WINDOW_GRACE_S) return false;
    return (quota.remaining ?? 0) > 0 || ((quota.resets_at ?? 0) > 0 && (quota.resets_at ?? 0) < at);
  }

  toPublic() {
    const token = this.accessToken || "";
    return {
      id: this.id,
      email: this.email,
      state: this.state,
      paid_exhausted: this.paidExhausted,
      expires_at: this.expiresAt,
      in_flight: this.inFlight,
      error_count: this.errorCount,
      last_error: this.lastError,
      source: this.source,
      model_caps: this.modelCaps,
      model_cap_info: this.modelCapInfo,
      token_hint: token ? `…${token.slice(-4)}` : "",
      notes: {
        name: this.notes.name ?? "",
        plan: this.notes.plan ?? "",
        file: this.notes.file ?? "",
      },
    };
  }
}
