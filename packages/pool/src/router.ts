import { Account } from "./account.ts";

export interface PoolOptions {
  strategy?: string;
  maxInFlightPerAccount?: number;
  minBalanceMicro?: number;
  cooldownSeconds?: number;
  blockedModelCooldownSeconds?: number;
  acquireWaitSeconds?: number;
}

export class Router {
  strategy: string;
  maxInFlight: number;
  minBalanceMicro: number;
  private rrIndex = 0;
  private useCounter = 0;

  constructor(options: PoolOptions = {}) {
    this.strategy = options.strategy ?? "drain_first";
    this.maxInFlight = options.maxInFlightPerAccount ?? 4;
    this.minBalanceMicro = options.minBalanceMicro ?? 0;
  }

  candidates(accounts: Account[], exclude: Set<string>, model?: string | null, at = Date.now() / 1000): Account[] {
    let pool = accounts.filter(
      (account) =>
        !exclude.has(account.id) &&
        account.state !== "dead" &&
        account.state !== "exhausted" &&
        account.planActive(at) &&
        !(model && (account.isModelCapped(model, at) || !account.modelEligible(model, at))) &&
        !(account.state === "cooling" && at < account.cooldownUntil) &&
        account.accessToken,
    );
    if (this.strategy === "quota_aware" && model && pool.length) {
      const remaining = (account: Account) => Number(account.notes.quotas?.[model]?.remaining ?? 0);
      pool = [...pool].sort((a, b) => remaining(b) - remaining(a));
      const best = remaining(pool[0]!);
      pool = pool.filter((account) => remaining(account) === best);
    }
    if (this.strategy === "drain_first" && model) {
      const remaining = (account: Account) => {
        const quotas = account.notes.quotas;
        if (quotas == null) return Number.POSITIVE_INFINITY;
        return Number(quotas[model]?.remaining ?? 0);
      };
      pool = [...pool].sort((a, b) => remaining(a) - remaining(b));
    }
    return pool;
  }

  pick(accounts: Account[]): Account | null {
    if (!accounts.length) return null;
    const under = accounts.filter((account) => account.inFlight < this.maxInFlight);
    if (!under.length) return null;
    if (this.strategy === "round_robin") {
      const account = under[this.rrIndex % under.length]!;
      this.rrIndex = (this.rrIndex + 1) % under.length;
      return account;
    }
    if (this.strategy === "least_recently_used") {
      return [...under].sort((a, b) => a.useSeq - b.useSeq || a.lastUsed - b.lastUsed)[0]!;
    }
    if (this.strategy === "drain_first") return under[0]!;
    return [...under].sort((a, b) => a.inFlight - b.inFlight || a.useSeq - b.useSeq || a.lastUsed - b.lastUsed)[0]!;
  }

  acquire(accounts: Account[], exclude: Set<string>, model?: string | null, at = Date.now() / 1000): Account | null {
    const account = this.pick(this.candidates(accounts, exclude, model, at));
    if (!account) return null;
    account.inFlight += 1;
    account.lastUsed = at;
    this.useCounter += 1;
    account.useSeq = this.useCounter;
    return account;
  }
}

export class PoolManager {
  accounts: Account[];
  router: Router;
  private waiters: Array<() => void> = [];

  constructor(accounts: Account[], options: PoolOptions = {}) {
    this.accounts = accounts;
    this.router = new Router(options);
  }

  async acquire(model?: string | null, exclude: Set<string> = new Set(), waitMs = 0): Promise<Account | null> {
    const deadline = Date.now() + waitMs;
    while (true) {
      const account = this.router.acquire(this.accounts, exclude, model);
      if (account) return account;
      if (Date.now() >= deadline) return null;
      await new Promise<void>((resolve) => {
        const timer = setTimeout(() => {
          this.waiters = this.waiters.filter((item) => item !== resolve);
          resolve();
        }, Math.min(50, Math.max(1, deadline - Date.now())));
        this.waiters.push(() => {
          clearTimeout(timer);
          resolve();
        });
      });
    }
  }

  release(account: Account) {
    account.inFlight = Math.max(0, account.inFlight - 1);
    for (const wake of this.waiters.splice(0)) wake();
  }

  capModel(account: Account, model: string, seconds: number, info: { code?: string; message?: string } = {}) {
    const releaseAt = Date.now() / 1000 + seconds;
    account.modelCaps[model] = releaseAt;
    account.modelCapInfo[model] = { ...info, release_at: releaseAt };
  }

  cool(account: Account, seconds: number, reason = "") {
    account.state = "cooling";
    account.cooldownUntil = Date.now() / 1000 + seconds;
    account.lastError = reason;
  }

  kill(account: Account, reason = "") {
    account.state = "dead";
    account.lastError = reason;
  }

  onSuccess(account: Account) {
    account.errorCount = 0;
    account.quotaStrikes = 0;
    if (account.state === "cooling") account.state = "ready";
  }

  upsert(account: Account) {
    const index = this.accounts.findIndex((item) => item.id === account.id);
    if (index >= 0) this.accounts[index] = account;
    else this.accounts.push(account);
  }

  remove(id: string): boolean {
    const before = this.accounts.length;
    this.accounts = this.accounts.filter((account) => account.id !== id);
    return this.accounts.length !== before;
  }

  readyCount(at = Date.now() / 1000): number {
    return this.accounts.filter(
      (account) => account.state !== "dead" && account.state !== "exhausted" && account.accessToken && !(account.state === "cooling" && at < account.cooldownUntil),
    ).length;
  }

  snapshot() {
    const byState: Record<string, number> = {};
    for (const account of this.accounts) byState[account.state] = (byState[account.state] ?? 0) + 1;
    return {
      accounts: this.accounts.length,
      ready: this.readyCount(),
      by_state: byState,
      items: this.accounts.map((account) => account.toPublic()),
    };
  }
}
