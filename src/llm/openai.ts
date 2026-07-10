import { requireEnv } from "../config.js";

export interface LlmUsage {
  model: string;
  purpose: string;
  inputTokens: number;
  outputTokens: number;
}

export interface JsonCallResult<T> {
  data: T;
  usage: LlmUsage;
}

/**
 * Structured-output call against the OpenAI Chat Completions API.
 * Model is provider-swappable by design; this adapter is the only file
 * that knows about OpenAI.
 */
export async function jsonCall<T>(opts: {
  model: string;
  purpose: string;
  system: string;
  user: string;
  schemaName: string;
  schema: object;
  /** gpt-5.4+ vocabulary; older models get the param dropped via the 400 retry below. */
  reasoningEffort?: "none" | "low" | "medium" | "high" | "xhigh";
}): Promise<JsonCallResult<T>> {
  const key = requireEnv("OPENAI_API_KEY");

  const body: Record<string, unknown> = {
    model: opts.model,
    messages: [
      { role: "system", content: opts.system },
      { role: "user", content: opts.user },
    ],
    response_format: {
      type: "json_schema",
      json_schema: { name: opts.schemaName, strict: true, schema: opts.schema },
    },
  };
  if (opts.reasoningEffort) body.reasoning_effort = opts.reasoningEffort;

  let res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
    body: JSON.stringify(body),
  });

  // Older models reject reasoning_effort; retry once without it.
  if (res.status === 400 && opts.reasoningEffort) {
    delete body.reasoning_effort;
    res = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
      body: JSON.stringify(body),
    });
  }
  if (!res.ok) throw new Error(`OpenAI call failed: ${res.status} ${await res.text()}`);

  const json = (await res.json()) as {
    choices: { message: { content: string } }[];
    usage: { prompt_tokens: number; completion_tokens: number };
    model: string;
  };

  return {
    data: JSON.parse(json.choices[0].message.content) as T,
    usage: {
      model: json.model,
      purpose: opts.purpose,
      inputTokens: json.usage.prompt_tokens,
      outputTokens: json.usage.completion_tokens,
    },
  };
}
