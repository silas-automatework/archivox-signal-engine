/** One-off: infer the German salutation form for existing contacts (one LLM call). */
import { Store } from "../src/store.js";
import { jsonCall } from "../src/llm/openai.js";
import { MODELS } from "../src/config.js";

const store = new Store("data/engine.sqlite");
const contacts = store.allContacts().filter((c) => !c.anrede);
if (!contacts.length) {
  console.log("nothing to backfill");
  process.exit(0);
}

const res = await jsonCall<{ items: { linkedin_url: string; anrede: "Herr" | "Frau" | "" }[] }>({
  model: MODELS.classify,
  purpose: "anrede_backfill",
  system:
    'For each person, return the German salutation form based on the first name: "Herr", "Frau", or "" when ambiguous or unclear. Copy linkedin_url exactly.',
  user: contacts.map((c) => `${c.name} | ${c.linkedin_url}`).join("\n"),
  schemaName: "anrede_map",
  schema: {
    type: "object",
    additionalProperties: false,
    required: ["items"],
    properties: {
      items: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["linkedin_url", "anrede"],
          properties: {
            linkedin_url: { type: "string" },
            anrede: { type: "string", enum: ["Herr", "Frau", ""] },
          },
        },
      },
    },
  },
  reasoningEffort: "none",
});

let n = 0;
for (const item of res.data.items) {
  if (item.anrede) {
    store.setContactAnrede(item.linkedin_url, item.anrede);
    n++;
  }
}
store.logLlmUsage(res.usage);
console.log(`backfilled anrede for ${n}/${contacts.length} contacts`);
store.close();
