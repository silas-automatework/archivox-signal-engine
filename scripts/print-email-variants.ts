/** Print one rendered email per opener variant (for the presentation). */
import { Store } from "../src/store.js";
import { renderEmail } from "../src/pipeline/emailTemplate.js";
import { openerVariant } from "../src/pipeline/brief.js";
import { redactPerson } from "../src/redact.js";

const store = new Store("data/engine.sqlite");
for (const r of store.signalsForExport()) {
  if (!r.brief_json) continue;
  const v = openerVariant(r.signal_id);
  if (v !== "statement") continue;
  const contacts = store.contactsForCompany(r.company_key).map(redactPerson);
  if (!contacts.length) continue;
  const email = renderEmail(JSON.parse(r.brief_json).email_slots, { recipient: contacts[0] });
  console.log("====", r.company_raw, `[${v}]`, "→", contacts[0].name, `(${contacts[0].role})`);
  console.log("SUBJECT:", email.subject);
  console.log(email.body);
  console.log();
}
store.close();
