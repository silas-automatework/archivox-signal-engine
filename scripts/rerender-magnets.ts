/** Re-render all magnet HTML files from stored magnet JSON (after template changes). */
import Database from "better-sqlite3";
import { writeFileSync } from "node:fs";
import { renderMagnetHtml } from "../src/pipeline/magnet.js";

const db = new Database("data/engine.sqlite");
const rows = db
  .prepare(
    `SELECT m.magnet_json, m.html_path, m.created_at, s.company_raw
     FROM magnets m JOIN signal_events s ON s.id = m.signal_id`
  )
  .all() as { magnet_json: string; html_path: string; created_at: string; company_raw: string }[];

for (const r of rows) {
  writeFileSync(r.html_path, renderMagnetHtml(r.company_raw, JSON.parse(r.magnet_json), r.created_at.slice(0, 10)));
}
console.log(`re-rendered: ${rows.length}`);
