import { hs } from "./hubspotAuth.js";
import { renderEmail } from "../pipeline/emailTemplate.js";
import { openerVariant } from "../pipeline/brief.js";
import type { Brief } from "../pipeline/brief.js";
import type { Store } from "../store.js";

/** Custom company properties the engine owns. Created once by `hubspot:setup`. */
const PROPERTIES = [
  { name: "archivox_signal_type", label: "ArchivoX Signal Type", type: "string", fieldType: "text" },
  { name: "archivox_signal_strength", label: "ArchivoX Signal Strength", type: "number", fieldType: "number" },
  { name: "archivox_signal_detected", label: "ArchivoX Signal Detected", type: "date", fieldType: "date" },
  { name: "archivox_opener_variant", label: "ArchivoX Opener Variant", type: "string", fieldType: "text" },
  { name: "archivox_industry", label: "ArchivoX Industry", type: "string", fieldType: "text" },
];

export async function setupHubspot(): Promise<void> {
  for (const p of PROPERTIES) {
    try {
      await hs("/crm/v3/properties/companies", {
        method: "POST",
        json: { ...p, groupName: "companyinformation" },
      });
      console.log(`  property created: ${p.name}`);
    } catch (err) {
      if (String(err).includes("409")) {
        console.log(`  property exists:  ${p.name}`);
      } else {
        throw err;
      }
    }
  }
}

async function findOrCreateCompany(name: string, props: Record<string, string>): Promise<{ id: string; created: boolean }> {
  const search = await hs("/crm/v3/objects/companies/search", {
    method: "POST",
    json: { filterGroups: [{ filters: [{ propertyName: "name", operator: "EQ", value: name }] }], limit: 1 },
  });
  if (search.total > 0) {
    const id = search.results[0].id;
    await hs(`/crm/v3/objects/companies/${id}`, { method: "PATCH", json: { properties: props } });
    return { id, created: false };
  }
  const created = await hs("/crm/v3/objects/companies", { method: "POST", json: { properties: { name, ...props } } });
  return { id: created.id, created: true };
}

function briefToNoteHtml(companyRaw: string, brief: Brief, evidence: { postings?: { title: string; url: string }[] }): string {
  const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const parts = [
    `<strong>ArchivoX Signal-Brief · ${esc(companyRaw)}</strong>`,
    `<p><em>"${esc(brief.signal_quote)}"</em></p>`,
    `<p><strong>Why now:</strong> ${esc(brief.why_now)}</p>`,
    `<p><strong>Angles:</strong></p><ul>${brief.angles.map((a) => `<li><strong>${esc(a.title)}:</strong> ${esc(a.detail)}</li>`).join("")}</ul>`,
    brief.flags.length ? `<p><strong>Flags:</strong> ${brief.flags.map(esc).join(" · ")}</p>` : "",
    `<p><strong>Evidence:</strong></p><ul>${(evidence.postings ?? []).map((p) => `<li><a href="${esc(p.url)}">${esc(p.title)}</a></li>`).join("")}</ul>`,
  ];
  return parts.filter(Boolean).join("");
}

/**
 * Route signal events into HubSpot: company upsert with signal properties,
 * brief as note, follow-up task with 48h SLA and the drafted email in the
 * task body (draft only; sending stays human).
 */
export async function routeSignals(store: Store, maxSignals: number): Promise<{ routed: number }> {
  const rows = store.signalsForExport().filter((r) => r.status === "candidate" && r.brief_json);
  let routed = 0;

  for (const r of rows.slice(0, maxSignals)) {
    const brief: Brief = JSON.parse(r.brief_json!);
    const evidence = JSON.parse(r.evidence_json);
    const contacts = store.contactsForCompany(r.company_key);
    const email = renderEmail(brief.email_slots, { recipient: contacts[0] ?? null });

    const company = await findOrCreateCompany(r.company_raw, {
      archivox_signal_type: r.signal_type,
      archivox_signal_strength: String(r.strength),
      archivox_signal_detected: String(r.created_at).slice(0, 10),
      archivox_opener_variant: openerVariant(r.signal_id),
      archivox_industry: r.industry ?? "",
    });

    await hs("/crm/v3/objects/notes", {
      method: "POST",
      json: {
        properties: { hs_note_body: briefToNoteHtml(r.company_raw, brief, evidence), hs_timestamp: new Date().toISOString() },
        associations: [{ to: { id: company.id }, types: [{ associationCategory: "HUBSPOT_DEFINED", associationTypeId: 190 }] }],
      },
    });

    const due = new Date(Date.now() + 48 * 3600 * 1000).toISOString();
    await hs("/crm/v3/objects/tasks", {
      method: "POST",
      json: {
        properties: {
          hs_task_subject: `Signal-Follow-up: ${r.company_raw} (SLA 48h)`,
          hs_task_body: `Empfänger: ${contacts[0]?.name ?? "offen"} (${contacts[0]?.role ?? ""})\n\nBetreff: ${email.subject}\n\n${email.body}\n\n[Entwurf. Prüfen, anpassen, senden.]`,
          hs_task_status: "NOT_STARTED",
          hs_task_priority: r.strength >= 0.9 ? "HIGH" : "MEDIUM",
          hs_timestamp: due,
        },
        associations: [{ to: { id: company.id }, types: [{ associationCategory: "HUBSPOT_DEFINED", associationTypeId: 192 }] }],
      },
    });

    for (const c of contacts.slice(0, 3)) {
      const [firstname, ...rest] = c.name.split(" ");
      try {
        await hs("/crm/v3/objects/contacts", {
          method: "POST",
          json: {
            properties: { firstname, lastname: rest.join(" "), jobtitle: c.role, hs_linkedin_url: c.linkedin_url },
            associations: [{ to: { id: company.id }, types: [{ associationCategory: "HUBSPOT_DEFINED", associationTypeId: 279 }] }],
          },
        });
      } catch (err) {
        if (!String(err).includes("409")) console.log(`    contact skipped (${c.name}): ${String(err).slice(0, 120)}`);
      }
    }

    store.markSignalRouted(r.signal_id);
    routed++;
    console.log(`  ROUTED  ${r.company_raw} -> company ${company.id}${company.created ? " (neu)" : ""}, note, task, ${Math.min(contacts.length, 3)} contacts`);
  }
  return { routed };
}
