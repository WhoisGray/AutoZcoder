import { randomUUID } from "node:crypto";

type Dict = Record<string, any>;

export function usageOpenai(usage: Dict | undefined): Dict {
  const source = usage ?? {};
  const cache = Number(source.cache_read_input_tokens || 0);
  const prompt =
    Number(source.input_tokens || 0) + cache + Number(source.cache_creation_input_tokens || 0);
  const output = Number(source.output_tokens || 0);
  return {
    prompt_tokens: prompt,
    completion_tokens: output,
    total_tokens: prompt + output,
    prompt_tokens_details: { cached_tokens: cache },
  };
}

export class MessageAccumulator {
  message: Dict = {
    id: "",
    type: "message",
    role: "assistant",
    content: [],
    stop_reason: null,
    stop_sequence: null,
    usage: {},
  };
  blocks = new Map<number, Dict>();
  partialJson = new Map<number, string>();
  stopped = false;

  feed(event: Dict) {
    const kind = event.type;
    if (kind === "message_start") Object.assign(this.message, structuredClone(event.message));
    else if (kind === "content_block_start") this.blocks.set(event.index, structuredClone(event.content_block));
    else if (kind === "content_block_delta") {
      const block = this.blocks.get(event.index);
      if (!block) throw new Error("delta without content block");
      const delta = event.delta ?? {};
      const key =
        delta.type === "text_delta" ? "text" : delta.type === "thinking_delta" ? "thinking" : delta.type === "signature_delta" ? "signature" : "";
      if (key) block[key] = `${block[key] ?? ""}${delta[key] ?? ""}`;
      else if (delta.type === "input_json_delta") {
        this.partialJson.set(event.index, `${this.partialJson.get(event.index) ?? ""}${delta.partial_json ?? ""}`);
      }
    } else if (kind === "message_delta") {
      Object.assign(this.message, event.delta ?? {});
      Object.assign(this.message.usage, event.usage ?? {});
    } else if (kind === "message_stop") this.stopped = true;
  }

  finish(): Dict {
    for (const [index, partial] of this.partialJson) {
      this.blocks.get(index)!.input = JSON.parse(partial || "{}");
    }
    this.message.content = [...this.blocks.keys()].sort((a, b) => a - b).map((index) => this.blocks.get(index));
    return this.message;
  }
}

export class OpenAITranslator {
  model: string;
  id: string;
  created = Math.floor(Date.now() / 1000);
  tools = new Map<number, number>();
  usage: Dict = {};

  constructor(model: string) {
    this.model = model;
    this.id = `chatcmpl-${randomUUID().replace(/-/g, "").slice(0, 24)}`;
  }

  chunk(delta: Dict, finish: string | null = null): Dict {
    return {
      id: this.id,
      object: "chat.completion.chunk",
      created: this.created,
      model: this.model,
      choices: [{ index: 0, delta, finish_reason: finish }],
    };
  }

  feed(event: Dict): Dict[] {
    const kind = event.type;
    if (kind === "message_start") {
      const message = event.message;
      this.id = `chatcmpl-${message.id}`;
      Object.assign(this.usage, message.usage ?? {});
      return [this.chunk({ role: "assistant", content: "" })];
    }
    if (kind === "content_block_start") {
      const block = event.content_block;
      if (block?.type === "tool_use") {
        const index = this.tools.size;
        this.tools.set(event.index, index);
        const initial = block.input;
        return [
          this.chunk({
            tool_calls: [
              {
                index,
                id: block.id,
                type: "function",
                function: { name: block.name, arguments: initial ? JSON.stringify(initial) : "" },
              },
            ],
          }),
        ];
      }
      if (block?.text) return [this.chunk({ content: block.text })];
      if (block?.thinking) return [this.chunk({ reasoning_content: block.thinking, reasoning: block.thinking })];
    }
    if (kind === "content_block_delta") {
      const delta = event.delta;
      if (delta.type === "text_delta") return [this.chunk({ content: delta.text ?? "" })];
      if (delta.type === "thinking_delta") {
        const value = delta.thinking ?? "";
        return [this.chunk({ reasoning_content: value, reasoning: value })];
      }
      if (delta.type === "input_json_delta") {
        return [
          this.chunk({
            tool_calls: [{ index: this.tools.get(event.index), function: { arguments: delta.partial_json ?? "" } }],
          }),
        ];
      }
    }
    if (kind === "message_delta") {
      Object.assign(this.usage, event.usage ?? {});
      const stop = event.delta?.stop_reason;
      const finish =
        ({ end_turn: "stop", stop_sequence: "stop", max_tokens: "length", tool_use: "tool_calls", refusal: "content_filter" } as Record<string, string>)[stop] ??
        "stop";
      return stop ? [this.chunk({}, finish)] : [];
    }
    if (kind === "message_stop") {
      const chunk = this.chunk({});
      chunk.choices = [];
      chunk.usage = usageOpenai(this.usage);
      return [chunk];
    }
    return [];
  }
}

export function sseFrame(obj: Dict): string {
  return `data: ${JSON.stringify(obj)}\n\n`;
}

export function sseEvent(name: string, data: Dict): string {
  return `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`;
}

export function parseSseEvents(text: string): unknown[] {
  const events: unknown[] = [];
  const parts = text.split(/\r\n\r\n|\n\n|\r\r/);
  for (const part of parts) {
    const lines = part
      .split(/\r?\n/)
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).replace(/^ /, ""));
    if (!lines.length) continue;
    const data = lines.join("\n");
    if (data === "[DONE]") {
      events.push("[DONE]");
      continue;
    }
    try {
      events.push(JSON.parse(data));
    } catch {
      /* ignore partial or non-json frames */
    }
  }
  return events;
}

export function aggregateOpenaiStream(text: string, model: string, fallbackId: string): Dict {
  const contentParts: string[] = [];
  const reasoningParts: string[] = [];
  const toolCalls = new Map<number, Dict>();
  let refusal: string | null = null;
  let finishReason: string | null = null;
  let completionId = fallbackId;
  let created = Math.floor(Date.now() / 1000);
  let usage: Dict = {};
  let upstreamError: string | null = null;
  for (const event of parseSseEvents(text)) {
    if (!event || typeof event !== "object") continue;
    const record = event as Dict;
    completionId = record.id ?? completionId;
    created = record.created ?? created;
    if (record.model) model = record.model;
    if (record.usage) usage = record.usage;
    if (record.error) upstreamError = String(record.error);
    for (const choice of record.choices ?? []) {
      const delta = choice.delta ?? {};
      if (delta.content) contentParts.push(delta.content);
      if (delta.reasoning) reasoningParts.push(delta.reasoning);
      else if (delta.reasoning_content) reasoningParts.push(delta.reasoning_content);
      if (delta.refusal) refusal = delta.refusal;
      for (const call of delta.tool_calls ?? []) {
        const index = call.index ?? 0;
        const slot = toolCalls.get(index) ?? {
          id: "",
          type: "function",
          function: { name: "", arguments: "" },
        };
        if (call.id) slot.id = call.id;
        if (call.function?.name) slot.function.name = call.function.name;
        if (call.function?.arguments) slot.function.arguments += call.function.arguments;
        toolCalls.set(index, slot);
      }
      if (choice.finish_reason) finishReason = choice.finish_reason;
    }
  }
  const message: Dict = { role: "assistant", content: contentParts.join("") };
  if (reasoningParts.length) {
    message.reasoning = reasoningParts.join("");
    message.reasoning_content = message.reasoning;
  }
  if (toolCalls.size) {
    message.tool_calls = [...toolCalls.keys()].sort((a, b) => a - b).map((key) => toolCalls.get(key));
    if (!contentParts.length) message.content = null;
  }
  if (refusal) {
    message.refusal = refusal;
    if (finishReason == null) finishReason = "content_filter";
  }
  if (upstreamError && !contentParts.length && toolCalls.size === 0) message.content = upstreamError;
  return {
    id: completionId,
    object: "chat.completion",
    created,
    model,
    choices: [{ index: 0, message, finish_reason: finishReason || "stop" }],
    usage: Object.keys(usage).length ? usage : { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
  };
}
