import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const datasetPath = resolve(root, "evals/kairo-400.json");
const resultsPath = resolve(root, "eval-results/kairo-400-results.json");
const reportPath = resolve(root, "eval-results/kairo-400-report.md");
const progressPath = resolve(root, "eval-results/.live-progress.json");
const initialLiveBaseline = { total: 40, passed: 28, failed: 12, passRate: 0.7, verificationRecoveries: 1 };
const cases = JSON.parse(readFileSync(datasetPath, "utf8"));
const supportedTools = ["answer_schedule_question", "read_savings_progress", "read_checkin_insights", "generate_daily_briefing", "create_calendar_event", "create_task", "create_savings_goal", "add_goal_contribution", "delete_calendar_event"];
const capability = Object.fromEntries(supportedTools.map((name) => [name, { mode: name === "delete_calendar_event" ? "destructive" : name.startsWith("read_") || name === "answer_schedule_question" || name === "generate_daily_briefing" ? "read" : "write", confirmation: !["answer_schedule_question", "read_savings_progress", "read_checkin_insights", "generate_daily_briefing"].includes(name) }]));

const projection = (response) => {
  if (!response || typeof response !== "object") return { responseType: "invalid", tools: [], operationCount: 0, arguments: [], missingFields: [], confirmations: [], modes: [], text: "" };
  if (response.type === "tool_call") return { responseType: "tool_call", tools: [response.toolCall?.name], operationCount: 1, arguments: [response.toolCall?.arguments ?? {}], missingFields: [], confirmations: [Boolean(response.toolCall?.requiresConfirmation)], modes: [capability[response.toolCall?.name]?.mode], text: response.reply ?? "" };
  if (response.type === "plan") return { responseType: "plan", tools: response.plan?.operations?.map((item) => item.tool) ?? [], operationCount: response.plan?.operations?.length ?? 0, arguments: response.plan?.operations?.map((item) => item.arguments ?? {}) ?? [], missingFields: response.plan?.operations?.flatMap((item) => item.missingFields ?? []) ?? [], confirmations: response.plan?.operations?.map((item) => Boolean(item.requiresConfirmation)) ?? [], modes: response.plan?.operations?.map((item) => item.mode) ?? [], dependencies: response.plan?.operations?.map((item) => item.dependsOn ?? []) ?? [], text: response.reply ?? "" };
  if (response.type === "follow_up") return { responseType: "follow_up", tools: response.pendingAction?.action ? [response.pendingAction.action] : [], operationCount: response.pendingAction?.action ? 1 : 0, arguments: [response.pendingAction?.collectedData ?? {}], missingFields: response.pendingAction?.missingFields ?? [], confirmations: response.pendingAction?.action ? [capability[response.pendingAction.action]?.confirmation ?? false] : [], modes: response.pendingAction?.action ? [capability[response.pendingAction.action]?.mode] : [], text: response.reply ?? "" };
  return { responseType: response.type ?? "message", tools: [], operationCount: 0, arguments: [], missingFields: [], confirmations: [], modes: [], text: response.reply ?? response.error ?? "" };
};

const containsPartial = (actual, expected) => Object.entries(expected ?? {}).every(([key, value]) => {
  if (value && typeof value === "object" && !Array.isArray(value)) return actual?.[key] && containsPartial(actual[key], value);
  return actual?.[key] === value;
});

const score = (testCase, response) => {
  const actual = projection(response);
  const expected = testCase.expected;
  const issues = [];
  if (actual.responseType !== expected.responseType) issues.push(`responseType expected ${expected.responseType}, received ${actual.responseType}`);
  if (actual.operationCount !== expected.operationCount) issues.push(`operationCount expected ${expected.operationCount}, received ${actual.operationCount}`);
  if (JSON.stringify(actual.tools) !== JSON.stringify(expected.tools)) issues.push(`tools expected ${expected.tools.join(", ") || "none"}, received ${actual.tools.join(", ") || "none"}`);
  if (Object.keys(expected.arguments ?? {}).length && !actual.arguments.some((item) => containsPartial(item, expected.arguments))) issues.push("expected arguments were not preserved");
  for (const field of expected.missingFields ?? []) if (!actual.missingFields.includes(field)) issues.push(`missing clarification field ${field}`);
  if (expected.requiresConfirmation && !actual.confirmations.some(Boolean)) issues.push("mutation did not require confirmation");
  for (const [index, tool] of actual.tools.entries()) {
    const rule = capability[tool];
    if (!rule) issues.push(`unknown or disabled tool ${tool}`);
    else {
      if (actual.confirmations[index] !== rule.confirmation) issues.push(`confirmation policy mismatch for ${tool}`);
      if (actual.modes[index] && actual.modes[index] !== rule.mode) issues.push(`mode mismatch for ${tool}`);
    }
  }
  const serialized = JSON.stringify(response);
  for (const title of expected.forbiddenTitles ?? []) if (new RegExp(`"title"\\s*:\\s*"${title}`, "i").test(serialized)) issues.push(`forbidden malformed title ${title}`);
  for (const claim of expected.forbiddenClaims ?? []) if (actual.text.toLowerCase().includes(claim.toLowerCase())) issues.push(`forbidden persistence/safety claim ${claim}`);
  return { passed: issues.length === 0, issues, expected, actual, response };
};

const validateCase = (item) => {
  const issues = [];
  if (!/^[-a-z]+-\d{3}$/.test(item.id)) issues.push("invalid id");
  if (!item.message?.trim()) issues.push("missing message");
  if (!Array.isArray(item.history) || !Array.isArray(item.capabilities)) issues.push("invalid arrays");
  if (Number.isNaN(Date.parse(item.currentDate))) issues.push("invalid currentDate");
  if (item.expected.operationCount !== item.expected.tools.length) issues.push("operation count/tool count mismatch");
  for (const tool of item.expected.tools) if (!capability[tool]) issues.push(`disabled tool ${tool}`);
  if (item.category === "schedule" && item.expected.tools.some((tool) => tool !== "answer_schedule_question")) issues.push("schedule case is not read-only");
  if (item.category === "multi_intent" && item.expected.operationCount < 2) issues.push("multi-intent case has fewer than two operations");
  return issues;
};

const distribution = () => Object.fromEntries([...new Set(cases.map((item) => item.category))].map((category) => [category, cases.filter((item) => item.category === category).length]));
const summarize = (records, mode) => {
  const byCategory = {};
  for (const category of new Set(records.map((item) => item.category))) {
    const selected = records.filter((item) => item.category === category);
    byCategory[category] = { total: selected.length, passed: selected.filter((item) => item.passed).length, passRate: selected.length ? selected.filter((item) => item.passed).length / selected.length : 0 };
  }
  return { generatedAt: new Date().toISOString(), mode, exactEvaluationCount: cases.length, distribution: distribution(), ...(mode.startsWith("live") ? { initialLiveBaseline } : {}), total: records.length, passed: records.filter((item) => item.passed).length, failed: records.filter((item) => !item.passed).length, passRate: records.length ? records.filter((item) => item.passed).length / records.length : 0, firstAttemptPassed: records.filter((item) => item.firstAttemptPassed).length, repairAttemptPassed: records.filter((item) => !item.firstAttemptPassed && item.passed).length, failingIds: records.filter((item) => !item.passed).map((item) => item.id), categories: byCategory, results: records };
};
const save = (summary) => {
  mkdirSync(resolve(root, "eval-results"), { recursive: true });
  writeFileSync(resultsPath, `${JSON.stringify(summary, null, 2)}\n`);
  const categoryRows = Object.entries(summary.categories).map(([name, value]) => `| ${name} | ${value.passed}/${value.total} | ${(value.passRate * 100).toFixed(1)}% |`).join("\n");
  const failures = summary.results.filter((item) => !item.passed).map((item) => `- **${item.id}**: ${item.issues.join("; ")}\n  - Expected: \`${JSON.stringify(item.expected)}\`\n  - Actual: \`${JSON.stringify(item.actual)}\``).join("\n") || "None.";
  const baseline = summary.initialLiveBaseline ? `- Initial pre-hardening live sample: ${summary.initialLiveBaseline.passed}/${summary.initialLiveBaseline.total} (${(summary.initialLiveBaseline.passRate * 100).toFixed(2)}%)\n- Improvement from initial sample: ${summary.passed - summary.initialLiveBaseline.passed} additional passing cases\n` : "";
  writeFileSync(reportPath, `# Kairo 400 Reliability Report\n\n- Mode: ${summary.mode}\n- Total evaluated: ${summary.total}\n- Passed: ${summary.passed}\n- Failed: ${summary.failed}\n- Pass rate: ${(summary.passRate * 100).toFixed(2)}%\n${baseline}- First-attempt passes: ${summary.firstAttemptPassed}\n- Verification-attempt recoveries: ${summary.repairAttemptPassed}\n\n## Category pass rates\n\n| Category | Passed | Rate |\n|---|---:|---:|\n${categoryRows}\n\n## Exact failing IDs\n\n${summary.failingIds.join(", ") || "None"}\n\n## Expected versus actual\n\n${failures}\n\n## Common failure patterns\n\n${summary.failed ? "See the issue lists above; repeated issue text identifies common patterns." : "No contract failures were detected."}\n`);
};

const contract = () => {
  if (cases.length !== 400) throw new Error(`Dataset must contain exactly 400 cases; found ${cases.length}.`);
  if (new Set(cases.map((item) => item.id)).size !== cases.length) throw new Error("Duplicate case IDs detected.");
  const records = cases.map((item) => {
    const issues = validateCase(item);
    return { id: item.id, category: item.category, passed: issues.length === 0, firstAttemptPassed: issues.length === 0, issues, expected: item.expected, actual: { contractValidated: issues.length === 0 } };
  });
  const summary = summarize(records, "contract");
  save(summary);
  console.log(`Contract: ${summary.passed}/${summary.total} passed (${(summary.passRate * 100).toFixed(2)}%).`);
  if (summary.failed) process.exitCode = 1;
};

const sampleCases = () => {
  const categories = [...new Set(cases.map((item) => item.category))];
  const picked = categories.flatMap((category) => cases.filter((item) => item.category === category).slice(0, 3));
  for (const item of cases) if (picked.length < 40 && !picked.some((candidate) => candidate.id === item.id)) picked.push(item);
  return picked.slice(0, 40);
};
const fetchCase = async (endpoint, item) => {
  const response = await fetch(endpoint, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ message: item.message, history: item.history, currentDate: item.currentDate, timezone: item.timezone, weekStartsOn: "sunday", pendingAction: null, appContext: { relevantTasks: [], relevantEvents: [], relevantGoals: [] }, capabilityRegistry: { tools: supportedTools }, toolResult: null }) });
  let json;
  try { json = await response.json(); } catch { json = { ok: false, type: "error", error: `HTTP ${response.status} returned invalid JSON` }; }
  return json;
};
const live = async (mode) => {
  const endpoint = process.env.KAIRO_ASSISTANT_V2_URL;
  if (!endpoint) throw new Error("Set KAIRO_ASSISTANT_V2_URL before running live evaluations.");
  let selected = mode === "live-sample" ? sampleCases() : cases;
  let retained = [];
  if (mode === "failed") {
    if (!existsSync(resultsPath)) throw new Error("No prior result file exists.");
    const previous = JSON.parse(readFileSync(resultsPath, "utf8"));
    const failed = new Set(previous.failingIds ?? []);
    selected = cases.filter((item) => failed.has(item.id));
    retained = (previous.results ?? []).filter((item) => !failed.has(item.id));
  }
  const progress = existsSync(progressPath) ? JSON.parse(readFileSync(progressPath, "utf8")) : {};
  if (mode === "failed") for (const item of selected) delete progress[item.id];
  const records = [];
  for (let offset = 0; offset < selected.length; offset += 2) {
    const batch = selected.slice(offset, offset + 2);
    const batchResults = await Promise.all(batch.map(async (item) => {
      if (progress[item.id]) return progress[item.id];
      const firstResponse = await fetchCase(endpoint, item);
      const first = score(item, firstResponse);
      let final = first;
      let secondResponse;
      if (!first.passed) { secondResponse = await fetchCase(endpoint, item); final = score(item, secondResponse); }
      const record = { id: item.id, category: item.category, ...final, firstAttemptPassed: first.passed, firstResponse, repairResponse: secondResponse };
      progress[item.id] = record;
      writeFileSync(progressPath, JSON.stringify(progress, null, 2));
      return record;
    }));
    records.push(...batchResults);
    console.log(`Live progress: ${Math.min(offset + batch.length, selected.length)}/${selected.length}`);
  }
  const summary = summarize([...retained, ...records], mode === "failed" ? "live-post-repair" : mode);
  save(summary);
  console.log(`Live: ${summary.passed}/${summary.total} passed; ${summary.repairAttemptPassed} recovered on the verification attempt.`);
  if (summary.failed) process.exitCode = 1;
};

const mode = process.argv[2] ?? "contract";
if (mode === "contract") contract();
else if (mode === "report") {
  if (!existsSync(resultsPath)) throw new Error("No result file exists.");
  save(JSON.parse(readFileSync(resultsPath, "utf8")));
  console.log(`Rebuilt ${reportPath}`);
} else await live(mode);
