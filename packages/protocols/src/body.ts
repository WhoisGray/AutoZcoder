import { bootstrapSystem } from "./bootstrap.ts";

type Dict = Record<string, any>;

const EFFORTS: Record<string, string> = {
  minimal: "low",
  low: "low",
  medium: "high",
  high: "high",
  xhigh: "max",
  extra: "max",
  max: "max",
};

export function reasoning(payload: Dict, defaultEffort = "high"): Dict {
  const thinking = payload.thinking;
  let effort =
    payload.output_config?.effort ||
    payload.reasoning_effort ||
    payload.reasoningEffort ||
    payload.reasoning?.effort;
  const disabled =
    payload.enable_thinking === false ||
    payload.reasoning?.enabled === false ||
    (thinking && typeof thinking === "object" && thinking.type === "disabled") ||
    effort === "none" ||
    effort === "off" ||
    effort === "disabled";
  if (disabled) return { thinking: { type: "disabled" } };
  const mapped = EFFORTS[effort || defaultEffort];
  if (!mapped) throw new Error("reasoning effort must be low, medium, high, max, or none");
  return { thinking: { type: "enabled" }, output_config: { effort: mapped } };
}

export function contentBlocks(content: unknown): Dict[] {
  if (content == null) return [];
  if (typeof content === "string") return content ? [{ type: "text", text: content }] : [];
  if (!Array.isArray(content)) throw new Error("message content must be a string or a list of blocks");
  const out: Dict[] = [];
  for (const part of content) {
    if (!part || typeof part !== "object") throw new Error("content blocks must be objects");
    const kind = part.type;
    if (kind === "text" || kind === "input_text") out.push({ type: "text", text: part.text ?? "" });
    else if (kind === "image_url") {
      const image = part.image_url;
      const url = image && typeof image === "object" ? image.url : image;
      if (typeof url !== "string") throw new Error("image_url.url must be a string");
      let source: Dict;
      if (url.startsWith("data:")) {
        const comma = url.indexOf(",");
        const header = comma >= 0 ? url.slice(0, comma) : url;
        const data = comma >= 0 ? url.slice(comma + 1) : "";
        if (comma < 0 || !header.includes(";base64")) throw new Error("images must use a base64 data URL");
        source = { type: "base64", media_type: header.slice(5).split(";")[0], data };
      } else source = { type: "url", url };
      out.push({ type: "image", source });
    } else if (["image", "tool_use", "tool_result", "thinking", "redacted_thinking"].includes(kind)) {
      out.push(structuredClone(part));
    } else throw new Error(`unsupported content block type: ${kind}`);
  }
  return out;
}

export interface ModelCaps {
  vision?: boolean;
  max_output_tokens?: number;
  context_window?: number;
}

export function buildBody(
  payload: Dict,
  defaultMaxTokens = 128000,
  modelCaps?: ModelCaps | null,
  defaultEffort = "high",
): Dict {
  const vision = modelCaps ? Boolean(modelCaps.vision) : null;
  let body: Dict;
  if (payload._anthropic) {
    body = structuredClone(payload._anthropic);
    body.model = payload.model;
    if (vision === false) {
      for (const message of body.messages ?? []) {
        if (Array.isArray(message?.content)) {
          message.content = message.content.filter((block: Dict) => block?.type !== "image");
        }
      }
    }
  } else {
    body = { model: payload.model, messages: [] };
    const system: Dict[] = [];
    for (const message of payload.messages ?? []) {
      let role = message.role;
      let blocks = contentBlocks(message.content);
      if (role === "system" || role === "developer") {
        if (blocks.some((block) => block.type !== "text")) throw new Error("system messages must contain text");
        system.push(...blocks);
        continue;
      }
      if (role === "tool") {
        blocks = [{ type: "tool_result", tool_use_id: message.tool_call_id, content: blocks }];
        role = "user";
      } else if (role === "assistant") {
        for (const call of message.tool_calls ?? []) {
          const fn = call.function ?? {};
          let args = fn.arguments ?? "{}";
          try {
            args = typeof args === "string" ? JSON.parse(args) : args;
          } catch (error) {
            throw new Error("tool call arguments must be valid JSON", { cause: error });
          }
          blocks.push({ type: "tool_use", id: call.id, name: fn.name, input: args });
        }
      }
      if (role !== "user" && role !== "assistant") throw new Error(`unsupported message role: ${role}`);
      if (vision === false) blocks = blocks.filter((block) => block.type !== "image");
      const messages = body.messages as Dict[];
      if (messages.length && messages[messages.length - 1].role === role) {
        messages[messages.length - 1].content.push(...blocks);
      } else messages.push({ role, content: blocks });
    }
    if (system.length) body.system = system;
    if (payload.tools) {
      body.tools = [];
      for (const tool of payload.tools) {
        if (tool.type !== "function") throw new Error("only function tools are supported");
        const fn = tool.function;
        body.tools.push({
          name: fn.name,
          description: fn.description ?? "",
          input_schema: fn.parameters ?? { type: "object" },
        });
      }
      const choice = payload.tool_choice;
      if (choice == null) {
        body.tool_choice = payload.parallel_tool_calls === false ? { type: "auto" } : null;
        if (body.tool_choice == null) delete body.tool_choice;
      } else if (typeof choice === "string") {
        body.tool_choice = { type: choice === "required" ? "any" : choice };
      } else if (typeof choice === "object") {
        body.tool_choice = { type: "tool", name: choice.function.name };
      }
      if (payload.parallel_tool_calls === false && body.tool_choice != null) {
        body.tool_choice.disable_parallel_tool_use = true;
      }
    }
    for (const key of ["temperature", "top_p", "top_k", "metadata"] as const) {
      if (payload[key] != null) body[key] = structuredClone(payload[key]);
    }
    if (payload.stop != null) {
      body.stop_sequences = typeof payload.stop === "string" ? [payload.stop] : payload.stop;
    }
    if (payload.response_format != null) {
      throw new Error("response_format is not supported by the captured ZCode API");
    }
    Object.assign(body, reasoning(payload, defaultEffort));
  }
  let limit = body.max_tokens;
  if (limit == null) limit = payload.max_tokens;
  if (limit == null) limit = payload.max_completion_tokens;
  if (limit == null) limit = defaultMaxTokens;
  if (typeof limit !== "number" || !Number.isInteger(limit) || limit <= 0) {
    throw new Error("max_tokens must be a positive integer");
  }
  if (modelCaps) {
    const cap = Number(modelCaps.max_output_tokens ?? 0);
    if (cap > 0) limit = Math.min(limit, cap);
  }
  body.max_tokens = limit;
  body.stream = true;
  if (!("thinking" in body)) Object.assign(body, reasoning(body, defaultEffort));
  if (body.thinking?.type === "disabled") {
    throw new Error(
      "ZCode GLM models always use reasoning. Use reasoning_effort low, high, or max; disabling reasoning is not supported.",
    );
  }
  body.system = bootstrapSystem(body.system);
  return body;
}
