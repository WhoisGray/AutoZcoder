export const CAPTURED_MODELS = ["GLM-5.3", "GLM-5.3-Flash"] as const;

export const MODEL_CAPS: Record<string, { vision: boolean; max_output_tokens: number; context_window: number }> = {
  "GLM-5.3": { vision: true, max_output_tokens: 128000, context_window: 1_000_000 },
  "GLM-5.3-Flash": { vision: true, max_output_tokens: 128000, context_window: 1_000_000 },
};

export function modelCaps(model: string) {
  return MODEL_CAPS[model] ?? { vision: true, max_output_tokens: 128000, context_window: 1_000_000 };
}

export class Registry {
  aliases: Record<string, string>;
  defaultModel: string;
  defaultAnthropic: string;

  constructor(options: { aliases?: Record<string, string>; defaultModel?: string; defaultAnthropic?: string } = {}) {
    this.aliases = { ...(options.aliases ?? {}) };
    this.defaultModel = options.defaultModel ?? "GLM-5.3-Flash";
    this.defaultAnthropic = options.defaultAnthropic ?? "GLM-5.3";
  }

  resolve(requested: string | undefined | null, dialect = "openai"): string {
    const model = requested || (dialect === "anthropic" ? this.defaultAnthropic : this.defaultModel);
    const aliased = this.aliases[model] ?? model;
    const known = CAPTURED_MODELS.find((item) => item.toLowerCase() === aliased.toLowerCase());
    return known ?? aliased;
  }

  catalogue() {
    const out: Record<string, unknown>[] = CAPTURED_MODELS.map((model) => ({
      id: model,
      name: model,
      object: "model",
      owned_by: "z.ai",
      zcode_variant: "anthropic",
      captured: true,
      catalog_group: "coding_plan",
      context_window: MODEL_CAPS[model]!.context_window,
      max_output_tokens: MODEL_CAPS[model]!.max_output_tokens,
      vision: MODEL_CAPS[model]!.vision,
      reasoning: true,
      reasoning_efforts: ["low", "high", "max"],
    }));
    const canonical = new Set(CAPTURED_MODELS.map((model) => model.toLowerCase()));
    for (const [alias, target] of Object.entries(this.aliases)) {
      if (!canonical.has(alias.toLowerCase())) {
        out.push({
          id: alias,
          object: "model",
          owned_by: "z.ai",
          alias_of: target,
          zcode_variant: "anthropic",
        });
      }
    }
    return out;
  }
}
