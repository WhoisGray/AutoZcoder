import { randomUUID } from "node:crypto";

const OPENAI_TO_ANTHROPIC_STOP: Record<string, string> = {
  stop: "end_turn",
  length: "max_tokens",
  tool_calls: "tool_use",
  function_call: "tool_use",
  content_filter: "refusal",
  refusal: "refusal",
};

type Dict = Record<string, any>;

function blocks(content: unknown): Dict[] {
  if (content == null) return [];
  if (typeof content === "string") return [{ type: "text", text: content }];
  if (Array.isArray(content)) return content.filter((block) => block && typeof block === "object");
  return [];
}

function systemText(system: unknown): string | null {
  if (!system) return null;
  if (typeof system === "string") return system;
  const parts = blocks(system)
    .filter((block) => block.type === "text")
    .map((block) => String(block.text ?? ""));
  const joined = parts.filter(Boolean).join("\n\n");
  return joined || null;
}

function imageUrl(block: Dict): string | null {
  const src = block.source ?? {};
  if (src.type === "base64") {
    const media = src.media_type ?? "image/png";
    return `data:${media};base64,${src.data ?? ""}`;
  }
  if (src.type === "url") return src.url ?? null;
  return null;
}

export function messagesToOpenai(messages: Iterable<Dict>): Dict[] {
  const out: Dict[] = [];
  for (const msg of messages) {
    if (!msg || typeof msg !== "object" || Array.isArray(msg)) {
      throw new Error("'messages' must be a list of message objects");
    }
    const role = msg.role;
    const contentBlocks = blocks(msg.content);
    if (role === "assistant") {
      const texts: string[] = [];
      const toolCalls: Dict[] = [];
      for (const block of contentBlocks) {
        if (block.type === "text" && typeof block.text === "string") texts.push(block.text);
        else if (block.type === "tool_use") {
          toolCalls.push({
            id: block.id || `call_${randomUUID().replace(/-/g, "").slice(0, 16)}`,
            type: "function",
            function: {
              name: block.name ?? "",
              arguments: JSON.stringify(block.input ?? {}),
            },
          });
        }
      }
      const entry: Dict = {
        role: "assistant",
        content: texts.filter(Boolean).join("\n") || null,
      };
      if (toolCalls.length) entry.tool_calls = toolCalls;
      out.push(entry);
      continue;
    }
    const toolResults: Dict[] = [];
    const parts: Dict[] = [];
    for (const block of contentBlocks) {
      if (block.type === "tool_result") {
        const inner = block.content;
        let text: string;
        if (Array.isArray(inner)) {
          text = inner
            .filter((item) => item && typeof item === "object" && item.type === "text")
            .map((item) => String(item.text ?? ""))
            .join("\n");
        } else if (typeof inner === "string") text = inner;
        else text = JSON.stringify(inner);
        toolResults.push({
          role: "tool",
          tool_call_id: block.tool_use_id ?? "",
          content: text || "",
        });
      } else if (block.type === "text" && typeof block.text === "string") {
        parts.push({ type: "text", text: block.text });
      } else if (block.type === "image") {
        const url = imageUrl(block);
        if (url) parts.push({ type: "image_url", image_url: { url } });
      }
    }
    out.push(...toolResults);
    if (parts.length) {
      if (parts.every((part) => part.type === "text")) {
        out.push({ role: "user", content: parts.map((part) => part.text).join("\n") });
      } else {
        out.push({ role: "user", content: parts });
      }
    }
  }
  return out;
}

export function toolsToOpenai(tools: unknown): Dict[] | null {
  if (!tools) return null;
  const out: Dict[] = [];
  for (const tool of tools as Dict[]) {
    if ("function" in tool) {
      out.push(tool);
      continue;
    }
    out.push({
      type: "function",
      function: {
        name: tool.name ?? "",
        description: tool.description ?? "",
        parameters: tool.input_schema ?? { type: "object", properties: {} },
      },
    });
  }
  return out;
}

export function toolChoiceToOpenai(choice: unknown): unknown {
  if (choice == null) return "auto";
  if (typeof choice === "string") return choice;
  const kind = (choice as Dict).type;
  if (kind === "auto") return "auto";
  if (kind === "any") return "required";
  if (kind === "none") return "none";
  if (kind === "tool" && (choice as Dict).name) {
    return { type: "function", function: { name: (choice as Dict).name } };
  }
  return "auto";
}

export function requestToOpenai(req: Dict, upstreamModel: string, defaultMaxTokens = 32000): Dict {
  const messages: Dict[] = [];
  const sys = systemText(req.system);
  if (sys) messages.push({ role: "system", content: sys });
  messages.push(...messagesToOpenai(req.messages ?? []));
  const rawMax = req.max_tokens;
  let maxTokens: number;
  if (rawMax == null) maxTokens = defaultMaxTokens;
  else {
    const parsed = Number(rawMax);
    if (!Number.isInteger(parsed)) throw new Error("'max_tokens' must be an integer");
    maxTokens = parsed;
  }
  const payload: Dict = {
    model: upstreamModel,
    messages,
    stream: Boolean(req.stream ?? false),
    max_tokens: maxTokens,
  };
  const tools = toolsToOpenai(req.tools);
  if (tools) {
    payload.tools = tools;
    payload.tool_choice = toolChoiceToOpenai(req.tool_choice);
  }
  if (req.stop_sequences) payload.stop = req.stop_sequences;
  if (req.temperature != null) payload.temperature = req.temperature;
  if (req.top_p != null) payload.top_p = req.top_p;
  if (req.top_k != null) payload.top_k = req.top_k;
  const extra = req.metadata ?? {};
  if (extra && typeof extra === "object" && extra.reasoning_effort) {
    payload.reasoning_effort = extra.reasoning_effort;
  }
  return payload;
}

function mapStopReason(finish: string | null | undefined): string | null {
  if (finish == null) return null;
  return OPENAI_TO_ANTHROPIC_STOP[finish] ?? "end_turn";
}

export function responseToAnthropic(full: Dict, model: string, msgId?: string | null): Dict {
  const choice = (full.choices ?? [{}])[0] ?? {};
  const message = choice.message ?? {};
  const content: Dict[] = [];
  if (message.content) content.push({ type: "text", text: message.content });
  if (message.refusal && !message.content) content.push({ type: "text", text: message.refusal });
  for (const call of message.tool_calls ?? []) {
    const fn = call.function ?? {};
    const rawArgs = fn.arguments ?? "{}";
    let parsed: unknown;
    try {
      parsed = typeof rawArgs === "string" ? JSON.parse(rawArgs) : rawArgs;
    } catch {
      parsed = { _raw: rawArgs };
    }
    content.push({
      type: "tool_use",
      id: call.id || `toolu_${randomUUID().replace(/-/g, "").slice(0, 20)}`,
      name: fn.name ?? "",
      input: parsed,
    });
  }
  const usage = full.usage ?? {};
  return {
    id: msgId || full.id || `msg_${randomUUID().replace(/-/g, "").slice(0, 20)}`,
    type: "message",
    role: "assistant",
    model,
    content: content.length ? content : [{ type: "text", text: "" }],
    stop_reason: mapStopReason(choice.finish_reason),
    stop_sequence: null,
    usage: {
      input_tokens: usage.prompt_tokens ?? 0,
      output_tokens: usage.completion_tokens ?? 0,
    },
  };
}

function evt(name: string, data: Dict): string {
  return `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`;
}

export class AnthropicStreamTranslator {
  model: string;
  msgId: string;
  sentMessageStart = false;
  textBlockOpen = false;
  nextIndex = 0;
  toolBlocks = new Map<number, [number, string, string]>();
  inputTokens = 0;
  outputTokens = 0;
  finishReason: string | null = null;

  constructor(model: string, msgId?: string | null) {
    this.model = model;
    this.msgId = msgId || `msg_${randomUUID().replace(/-/g, "").slice(0, 24)}`;
  }

  private start(): string {
    this.sentMessageStart = true;
    return evt("message_start", {
      type: "message_start",
      message: {
        id: this.msgId,
        type: "message",
        role: "assistant",
        model: this.model,
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 0, output_tokens: 0 },
      },
    });
  }

  private openTextBlock(): string {
    this.textBlockOpen = true;
    const index = this.nextIndex;
    this.nextIndex += 1;
    return evt("content_block_start", {
      type: "content_block_start",
      index,
      content_block: { type: "text", text: "" },
    });
  }

  feed(chunk: Dict): string[] {
    const out: string[] = [];
    if (!this.sentMessageStart) out.push(this.start());
    const usage = chunk.usage ?? {};
    if (chunk.usage) {
      this.inputTokens = usage.prompt_tokens ?? this.inputTokens;
      this.outputTokens = usage.completion_tokens ?? this.outputTokens;
    }
    for (const choice of chunk.choices ?? []) {
      const delta = choice.delta ?? {};
      const text = delta.content || delta.refusal;
      if (text) {
        if (!this.textBlockOpen) out.push(this.openTextBlock());
        out.push(
          evt("content_block_delta", {
            type: "content_block_delta",
            index: this.nextIndex - 1,
            delta: { type: "text_delta", text },
          }),
        );
      }
      for (const call of delta.tool_calls ?? []) {
        const oaiIndex = call.index ?? 0;
        const fn = call.function ?? {};
        if (!this.toolBlocks.has(oaiIndex)) {
          if (this.textBlockOpen) {
            out.push(
              evt("content_block_stop", {
                type: "content_block_stop",
                index: this.nextIndex - 1,
              }),
            );
            this.textBlockOpen = false;
          }
          const blockIndex = this.nextIndex;
          this.nextIndex += 1;
          const toolId = call.id || `toolu_${randomUUID().replace(/-/g, "").slice(0, 20)}`;
          const name = fn.name || "";
          this.toolBlocks.set(oaiIndex, [blockIndex, toolId, name]);
          out.push(
            evt("content_block_start", {
              type: "content_block_start",
              index: blockIndex,
              content_block: { type: "tool_use", id: toolId, name, input: {} },
            }),
          );
        }
        if (fn.arguments) {
          const [blockIndex] = this.toolBlocks.get(oaiIndex)!;
          out.push(
            evt("content_block_delta", {
              type: "content_block_delta",
              index: blockIndex,
              delta: { type: "input_json_delta", partial_json: fn.arguments },
            }),
          );
        }
      }
      if (choice.finish_reason) this.finishReason = choice.finish_reason;
    }
    return out;
  }

  finish(): string[] {
    const out: string[] = [];
    if (!this.sentMessageStart) out.push(this.start());
    if (this.textBlockOpen) {
      out.push(evt("content_block_stop", { type: "content_block_stop", index: this.nextIndex - 1 }));
      this.textBlockOpen = false;
    }
    const tools = [...this.toolBlocks.values()].sort((a, b) => a[0] - b[0]);
    for (const [blockIndex] of tools) {
      out.push(evt("content_block_stop", { type: "content_block_stop", index: blockIndex }));
    }
    out.push(
      evt("message_delta", {
        type: "message_delta",
        delta: {
          stop_reason: mapStopReason(this.finishReason) || "end_turn",
          stop_sequence: null,
        },
        usage: { input_tokens: this.inputTokens, output_tokens: this.outputTokens },
      }),
    );
    out.push(evt("message_stop", { type: "message_stop" }));
    return out;
  }
}

export function extractStreamError(text: string): Dict | null {
  for (const line of (text || "").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("data:")) continue;
    const payload = trimmed.slice(5).trim();
    if (payload === "" || payload === "[DONE]") continue;
    try {
      const obj = JSON.parse(payload);
      if (obj && typeof obj === "object" && obj.error) {
        const err = obj.error;
        if (err && typeof err === "object") {
          return {
            code: String(err.code || "stream_error"),
            message: String(err.message || err),
            request_id: err.request_id,
            type: err.type || "stream_error",
          };
        }
        return { code: "stream_error", message: String(err), request_id: null, type: "stream_error" };
      }
    } catch {
      continue;
    }
  }
  return null;
}

export function streamHadContent(text: string): boolean {
  for (const line of (text || "").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("data:") || trimmed.includes("[DONE]")) continue;
    try {
      const obj = JSON.parse(trimmed.slice(5).trim());
      for (const choice of obj.choices ?? []) {
        const delta = choice.delta ?? {};
        if (delta.content || delta.tool_calls) return true;
      }
    } catch {
      continue;
    }
  }
  return false;
}
