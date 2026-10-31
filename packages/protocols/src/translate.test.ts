import assert from "node:assert/strict";
import test from "node:test";
import { buildBody } from "./body.ts";
import { classify, isBlockCode, openaiError } from "./errors.ts";
import { overloadDelay, retryAfterSeconds } from "./retry.ts";
import { AnthropicStreamTranslator, requestToOpenai, responseToAnthropic, toolChoiceToOpenai, toolsToOpenai } from "./translate.ts";
import { ZCODE_IDENTITY } from "./bootstrap.ts";

test("system prompt and simple text", () => {
  const out = requestToOpenai(
    {
      model: "anthropic/claude-opus-5",
      max_tokens: 100,
      system: "be terse",
      messages: [{ role: "user", content: "hello" }],
    },
    "anthropic/claude-opus-5",
  );
  assert.deepEqual(out.messages[0], { role: "system", content: "be terse" });
  assert.deepEqual(out.messages[1], { role: "user", content: "hello" });
  assert.equal(out.max_tokens, 100);
});

test("system as block list", () => {
  const out = requestToOpenai(
    {
      model: "m",
      max_tokens: 10,
      system: [
        { type: "text", text: "one" },
        { type: "text", text: "two" },
      ],
      messages: [{ role: "user", content: "x" }],
    },
    "m",
  );
  assert.equal(out.messages[0].content, "one\n\ntwo");
});

test("image block becomes a data uri", () => {
  const out = requestToOpenai(
    {
      model: "m",
      max_tokens: 10,
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "what is this" },
            { type: "image", source: { type: "base64", media_type: "image/png", data: "AAAA" } },
          ],
        },
      ],
    },
    "m",
  );
  assert.equal(out.messages[0].content[1].image_url.url, "data:image/png;base64,AAAA");
});

test("assistant tool use becomes tool calls", () => {
  const out = requestToOpenai(
    {
      model: "m",
      max_tokens: 10,
      messages: [
        { role: "user", content: "weather?" },
        {
          role: "assistant",
          content: [
            { type: "text", text: "checking" },
            { type: "tool_use", id: "toolu_1", name: "get_weather", input: { city: "Berlin" } },
          ],
        },
      ],
    },
    "m",
  );
  const assistant = out.messages[1];
  assert.equal(assistant.content, "checking");
  assert.equal(assistant.tool_calls[0].id, "toolu_1");
  assert.deepEqual(JSON.parse(assistant.tool_calls[0].function.arguments), { city: "Berlin" });
});

test("tool result becomes a tool message", () => {
  const out = requestToOpenai(
    {
      model: "m",
      max_tokens: 10,
      messages: [
        {
          role: "user",
          content: [
            { type: "tool_result", tool_use_id: "toolu_1", content: "18C sunny" },
            { type: "text", text: "thanks" },
          ],
        },
      ],
    },
    "m",
  );
  assert.equal(out.messages[0].role, "tool");
  assert.equal(out.messages[0].tool_call_id, "toolu_1");
  assert.deepEqual(out.messages[1], { role: "user", content: "thanks" });
});

test("tools and tool choice", () => {
  const tools = toolsToOpenai([
    { name: "get_weather", description: "d", input_schema: { type: "object", properties: { city: { type: "string" } } } },
  ]);
  assert.equal(tools?.[0].function.parameters.properties.city.type, "string");
  assert.equal(toolChoiceToOpenai({ type: "any" }), "required");
  assert.deepEqual(toolChoiceToOpenai({ type: "tool", name: "f" }), { type: "function", function: { name: "f" } });
});

test("response and stream translation", () => {
  const text = responseToAnthropic(
    {
      id: "chatcmpl-1",
      choices: [{ finish_reason: "stop", message: { role: "assistant", content: "hi there" } }],
      usage: { prompt_tokens: 11, completion_tokens: 3 },
    },
    "m",
  );
  assert.equal(text.stop_reason, "end_turn");
  assert.deepEqual(text.usage, { input_tokens: 11, output_tokens: 3 });

  const translator = new AnthropicStreamTranslator("m", "msg_2");
  const events = [
    ...translator.feed({
      choices: [{ delta: { tool_calls: [{ index: 0, id: "call_a", function: { name: "f", arguments: '{"a"' } }] }, finish_reason: null }],
    }),
    ...translator.feed({
      choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: ":1}" } }] }, finish_reason: "tool_calls" }],
    }),
    ...translator.finish(),
  ].join("");
  assert.match(events, /call_a/);
  assert.match(events, /tool_use/);
  const parsed = events
    .split("\n\n")
    .map((frame) => frame.split("\n").find((line) => line.startsWith("data:"))?.slice(5))
    .filter(Boolean)
    .map((line) => JSON.parse(line!));
  const deltas = parsed.filter((event) => event.type === "content_block_delta");
  assert.equal(deltas[0].delta.partial_json, '{"a"');
  assert.equal(deltas[1].delta.partial_json, ":1}");
  assert.equal(parsed.find((event) => event.type === "message_delta").delta.stop_reason, "tool_use");
});

test("upstream body adds the ZCode bootstrap and rejects disabled reasoning", () => {
  const body = buildBody({
    model: "GLM-5.3-Flash",
    messages: [{ role: "user", content: "hello" }],
    reasoning_effort: "medium",
  });
  assert.equal(body.stream, true);
  assert.equal(body.output_config.effort, "high");
  assert.equal(body.system[0].text, ZCODE_IDENTITY);
  assert.equal(body.messages[0].content[0].text, "hello");
  assert.throws(
    () => buildBody({ model: "GLM-5.3", messages: [{ role: "user", content: "x" }], reasoning_effort: "off" }),
    /always use reasoning/,
  );
});

test("max tokens clamps to the model cap and response_format is rejected", () => {
  const body = buildBody(
    { model: "GLM-5.3", messages: [{ role: "user", content: "x" }], max_tokens: 500_000 },
    128000,
    { vision: true, max_output_tokens: 128000 },
  );
  assert.equal(body.max_tokens, 128000);
  assert.throws(
    () => buildBody({ model: "GLM-5.3", messages: [{ role: "user", content: "x" }], response_format: { type: "json_object" } }),
    /response_format/,
  );
});

test("overload delay respects the cap and Retry-After", () => {
  const cfg = { overloadBaseDelaySeconds: 2, overloadMaxDelaySeconds: 60 };
  assert.equal(overloadDelay(cfg, 1, null, () => 0), 1);
  assert.equal(overloadDelay(cfg, 10, null, () => 0), 30);
  assert.equal(overloadDelay(cfg, 1, 10_000, () => 0), 60);
  assert.equal(retryAfterSeconds({ "Retry-After-Ms": "1500" }), 1.5);
});

test("error classification keeps unusual-activity and quota distinct", () => {
  assert.equal(isBlockCode("3012", 405), true);
  assert.equal(classify(402, '{"error":{"code":"11113","message":"exceed quota limit"}}'), "insufficient_credits");
  assert.equal(classify(529, ""), "server");
  assert.equal(openaiError(401, "invalid_api_key", "missing API key").error.type, "authentication_error");
});
