import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const failuresPath = resolve(root, "evals/field-failures.json");
const datasetPath = resolve(root, "evals/kairo-400.json");
const failures = JSON.parse(readFileSync(failuresPath, "utf8"));
const dataset = JSON.parse(readFileSync(datasetPath, "utf8"));
if (!Array.isArray(failures)) throw new Error("field-failures.json must contain an array.");
const fingerprint = (item) => JSON.stringify([item.message.trim().toLowerCase(), item.history ?? []]);
const existing = new Set(dataset.map(fingerprint));
let imported = 0;
for (const failure of failures) {
  if (!failure || typeof failure.message !== "string" || !failure.message.trim() || !Array.isArray(failure.history) || !failure.actualResult || !failure.expectedResult || typeof failure.source !== "string" || Number.isNaN(Date.parse(failure.addedAt))) throw new Error("A field failure record is invalid.");
  if (existing.has(fingerprint(failure))) continue;
  dataset.push({ id: `field-failure-${String(imported + 1).padStart(3, "0")}`, category: "field_failure", description: `Imported regression from ${failure.source}`, message: failure.message.trim(), history: failure.history, currentDate: failure.currentDate ?? failure.addedAt, timezone: failure.timezone ?? "America/New_York", capabilities: [], expected: failure.expectedResult, provenance: { source: failure.source, addedAt: failure.addedAt, appVersion: failure.appVersion, workerVersion: failure.workerVersion, actualResult: failure.actualResult } });
  existing.add(fingerprint(failure));
  imported += 1;
}
writeFileSync(datasetPath, `${JSON.stringify(dataset, null, 2)}\n`);
console.log(`Imported ${imported} new field failure${imported === 1 ? "" : "s"}; skipped ${failures.length - imported} duplicate${failures.length - imported === 1 ? "" : "s"}.`);
