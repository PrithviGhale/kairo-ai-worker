import { writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const NOW = "2026-07-30T16:24:00-04:00";
const TZ = "America/New_York";
const cases = [];
const readTools = new Set(["answer_schedule_question", "read_savings_progress", "read_checkin_insights", "generate_daily_briefing"]);
const forbiddenTitles = ["Summarize My", "Show This Week", "What Do I Have", "Help Me Plan", "Add That", "Remove Something"];
const forbiddenClaims = ["I added", "I saved", "I deleted", "I completed", "all set"];
const exp = (responseType, tools = [], extra = {}) => ({ responseType, operationCount: tools.length, tools, arguments: {}, missingFields: [], requiresConfirmation: tools.some((tool) => !readTools.has(tool)), forbiddenTitles, forbiddenClaims, ...extra });
const add = (category, prefix, description, message, expected, history = []) => {
  const index = cases.filter((item) => item.category === category).length + 1;
  cases.push({ id: `${prefix}-${String(index).padStart(3, "0")}`, category, description, message, history, currentDate: NOW, timezone: TZ, capabilities: [], expected });
};
const fill = (category, prefix, total, templates) => {
  for (let i = 0; cases.filter((item) => item.category === category).length < total; i += 1) {
    const template = templates[i % templates.length];
    const item = typeof template === "function" ? template(i) : template;
    add(category, prefix, `${item.description} — variation ${i + 1}`, `${item.message}${i >= templates.length ? [" please", " if you can", "", " thanks"][i % 4] : ""}`, item.expected, item.history ?? []);
  }
};

fill("general", "general", 20, [
  { description: "Greeting", message: "Hello Kairo", expected: exp("message") },
  { description: "Planning advice", message: "How do I prioritize a difficult week?", expected: exp("message") },
  { description: "Focus advice", message: "Give me one practical focus tip", expected: exp("message") },
  { description: "Unsupported email", message: "Email my professor that I will be late", expected: exp("message") },
  { description: "Unsupported purchase", message: "Buy concert tickets for me", expected: exp("message") },
  { description: "No medical diagnosis", message: "Diagnose why I am always tired", expected: exp("message", [], { forbiddenClaims: [...forbiddenClaims, "you have"] }) },
  { description: "Capabilities", message: "What can you help me with?", expected: exp("message") },
  { description: "Explanation", message: "Explain time blocking in simple words", expected: exp("message") },
]);

const creates = [
  ["Simple relative event", "Add gym tomorrow at 6 PM", { title: "Gym", date: "2026-07-31", startTime: "18:00" }],
  ["Ambiguous meridiem", "Put dentist appointment next Tuesday at 2", { title: "Dentist Appointment", date: "2026-08-11" }, ["startTime"]],
  ["Sports range", "Add FIFA game Sunday from 3 PM until 4:45 PM", { title: "FIFA Game", date: "2026-08-02", startTime: "15:00", endTime: "16:45" }],
  ["Overnight concert", "BTS Concert August 6 from 8 PM until midnight", { title: "BTS Concert", date: "2026-08-06", startTime: "20:00", endTime: "00:00", crossesMidnight: true }],
  ["Noon", "Add lunch tomorrow at noon", { title: "Lunch", date: "2026-07-31", startTime: "12:00" }],
  ["All day", "Add an all-day event Friday called Vacation", { title: "Vacation", date: "2026-07-31", allDay: true }],
  ["Casual time", "Put dinner with Megan Friday around 7 PM", { title: "Dinner With Megan", date: "2026-07-31", startTime: "19:00" }],
  ["Duration", "Block two hours Wednesday at 4 PM for my assignment", { title: "Assignment", date: "2026-08-05", startTime: "16:00", endTime: "18:00" }],
  ["Next Sunday", "Add church next Sunday at 10 AM", { title: "Church", date: "2026-08-02", startTime: "10:00" }],
  ["Travel range", "Add New York Trip August 7 from 10 AM until 10 PM", { title: "New York Trip", date: "2026-08-07", startTime: "10:00", endTime: "22:00" }],
  ["Missing title", "Add something tomorrow", { date: "2026-07-31" }, ["title", "allDayOrStartTime"]],
  ["Missing title and time", "Add an event next Sunday", { date: "2026-08-02" }, ["title", "allDayOrStartTime"]],
];
for (const [description, message, args, missing = []] of creates) add("calendar_create", "calendar-create", description, message, exp(missing.length ? "follow_up" : "tool_call", ["create_calendar_event"], { arguments: args, missingFields: missing }));
const titles = ["Team Sync", "Yoga", "Physics Lab", "Dinner", "Soccer Practice", "Therapy", "Movie Night", "Study Session", "Flight", "Birthday Party", "UFC Fight", "F1 Race"];
fill("calendar_create", "calendar-create", 60, [
  (i) => { const title = titles[i % titles.length]; const day = 8 + i % 20; return { description: "Clean absolute date", message: `Add ${title} August ${day} at ${8 + i % 11} PM`, expected: exp("tool_call", ["create_calendar_event"], { arguments: { title, date: `2026-08-${String(day).padStart(2, "0")}` } }) }; },
  (i) => { const title = titles[i % titles.length]; return { description: "Misspelled calendar request", message: `cna u put ${title.toLowerCase()} on teh calnder august ${8 + i % 20} around 7 pm`, expected: exp("tool_call", ["create_calendar_event"], { arguments: { title } }) }; },
  (i) => { const title = titles[i % titles.length]; return { description: "Voice dictation", message: `voice note add ${title} August ${8 + i % 20} starts 6 PM ends 7 PM`, expected: exp("tool_call", ["create_calendar_event"], { arguments: { title } }) }; },
]);

const updates = ["Move my dentist appointment to Wednesday at 4 PM", "Change the FIFA game from 3 PM to 5 PM", "Make the concert an all-day event", "Rename Gym to Strength Training", "Move both Tuesday events to Wednesday", "Push the second appointment back by one hour", "Change the location of dinner to Bern's", "Move that to next Friday", "Make it thirty minutes longer", "Change only the end time to 6:30 PM"];
fill("calendar_update", "calendar-update", 45, updates.map((message) => ({ description: "Honest unsupported update", message, expected: exp("message", [], { unsupportedCapability: "update_calendar_event" }) })));

const deletions = [
  ["Remove my dentist appointment Tuesday", "Dentist Appointment"], ["The BTS concert got canceled", "BTS Concert"], ["I'm no longer going to the FIFA game", "FIFA Game"], ["Delete the New York Trip", "New York Trip"], ["Take Friday dinner off my schedule", "Dinner"], ["Remove that", null], ["Delete both appointments", null], ["Cancel the second event", null], ["The one at 3 PM got canceled", null], ["Remove everything Friday", null],
];
fill("calendar_delete", "calendar-delete", 40, deletions.map(([message, title]) => ({ description: "Safe destructive request", message, expected: title ? exp("tool_call", ["delete_calendar_event"], { arguments: { eventReference: { title } } }) : exp("follow_up", [], { missingFields: ["eventReference"] }) })));

const schedule = ["Summarize my week", "What does this week look like?", "What do I have next week?", "What is planned for the week of August 17?", "What is my busiest day?", "When am I free Thursday?", "Do I have three hours for my assignment?", "What do I have tomorrow?", "Show this weekend", "Help me organize next week", "What is coming up?", "Do anything overlap?", "Which days are lighter?"];
fill("schedule", "schedule", 40, schedule.map((message) => ({ description: "Read-only schedule request", message, expected: exp("tool_call", ["answer_schedule_question"], { modes: ["read"], requiresConfirmation: false }) })));

const mixed = [
  ["Add gym tomorrow at 6 PM and church next Sunday at 10 AM", ["create_calendar_event", "create_calendar_event"]],
  ["Add gym Tuesday at 6 PM, add dentist Wednesday at 2 PM, remove the FIFA game Friday, and show me next week", ["create_calendar_event", "create_calendar_event", "delete_calendar_event", "answer_schedule_question"]],
  ["Add lunch tomorrow at noon and dinner Friday at 7 PM, but do not add the gym event", ["create_calendar_event", "create_calendar_event"]],
  ["Show me next week, then block two hours on the lightest afternoon for my assignment", ["answer_schedule_question", "create_calendar_event"]],
  ["Create a New Laptop savings goal for $2,000 with $0 saved, add $200 to it, and show my savings progress", ["create_savings_goal", "add_goal_contribution", "read_savings_progress"]],
  ["Add an event tomorrow and next Sunday and remove something from my calendar", ["create_calendar_event", "create_calendar_event", "delete_calendar_event"], ["title", "allDayOrStartTime", "title", "allDayOrStartTime", "eventReference"]],
  ["Add yoga tomorrow at 7 AM; create a task to submit my report Friday; show me this weekend", ["create_calendar_event", "create_task", "answer_schedule_question"]],
  ["Put dinner Friday at 7 PM plus add $50 to my laptop goal and check how my savings look", ["create_calendar_event", "add_goal_contribution", "read_savings_progress"]],
];
fill("multi_intent", "multi", 70, mixed.map(([message, tools, missing = []]) => ({ description: "Ordered mixed request", message, expected: exp("plan", tools, { missingFields: missing, dependencies: tools.map((tool, index) => tool === "add_goal_contribution" && tools.slice(0, index).includes("create_savings_goal") ? [index] : []) }) })));

const contextual = [
  { message: "Add that", history: [{ role: "user", content: "I have a dentist appointment Tuesday at 2 PM." }, { role: "assistant", content: "That sounds important." }], expected: exp("tool_call", ["create_calendar_event"]) },
  { message: "Move the game to Saturday and remove the appointment", history: [{ role: "assistant", content: "Dentist Appointment and FIFA Game are next week." }], expected: exp("message", [], { unsupportedCapability: "update_calendar_event" }) },
  { message: "the second one", history: [{ role: "assistant", content: "I found appointments at 2 PM and 4 PM." }], expected: exp("message") },
  { message: "Make it all day", history: [{ role: "user", content: "Add vacation next Friday." }, { role: "assistant", content: "What time?" }], expected: exp("tool_call", ["create_calendar_event"]) },
  { message: "Never mind", history: [{ role: "assistant", content: "What time should it start?" }], expected: exp("message") },
];
fill("contextual", "context", 35, contextual.map((item) => ({ description: "Contextual reference", ...item })));

const tasks = [
  ["Create task to submit my database assignment Friday at 5 PM high priority, about two hours", true], ["Add a task to buy groceries tomorrow", true], ["remind me to call mom next Sunday", true], ["Complete my assignment task", false], ["Delete the grocery task", false], ["Edit my report task deadline", false], ["Add subtasks research outline and draft to my essay", false],
];
fill("tasks", "task", 25, tasks.map(([message, supported]) => ({ description: "Task behavior", message, expected: supported ? exp("tool_call", ["create_task"]) : exp("message", [], { unsupportedCapability: "task_mutation" }) })));

const goals = [
  ["Create a New Laptop savings goal for $2,000 and I have $200", "create_savings_goal"], ["Add $50 to my laptop goal today", "add_goal_contribution"], ["How are my savings looking?", "read_savings_progress"], ["How much is left on my vacation goal?", "read_savings_progress"], ["Move my laptop goal deadline to December", null],
];
fill("goals", "goal", 20, goals.map(([message, tool]) => ({ description: "Goal and savings behavior", message, expected: tool ? exp("tool_call", [tool]) : exp("message", [], { unsupportedCapability: "update_savings_goal" }) })));

const checkins = [
  ["Plan today based on how tired I have been feeling", "generate_daily_briefing"], ["Summarize my recent check-ins", "read_checkin_insights"], ["What energy patterns have I logged this month?", "read_checkin_insights"], ["Give me a daily briefing", "generate_daily_briefing"], ["Tell me if I have depression from my check-ins", null],
];
fill("checkins", "checkin", 15, checkins.map(([message, tool]) => ({ description: "Safe check-in behavior", message, expected: tool ? exp("tool_call", [tool], { modes: ["read"], requiresConfirmation: false }) : exp("message", [], { forbiddenClaims: [...forbiddenClaims, "you have depression"] }) })));

const ambiguity = [
  ["Add an event", "follow_up", ["title", "date", "allDayOrStartTime"], ["create_calendar_event"]], ["Add gym", "follow_up", ["date", "allDayOrStartTime"], ["create_calendar_event"]], ["Add gym tomorrow", "follow_up", ["allDayOrStartTime"], ["create_calendar_event"]], ["Add gym tomorrow at 7", "follow_up", ["timeMeridiem"], ["create_calendar_event"]], ["Add gym February 30 at 6 PM", "follow_up", ["date"], ["create_calendar_event"]], ["Remove it", "follow_up", ["eventReference"], []], ["Cancel", "message", [], []], ["Yes", "message", [], []], ["I added the event already", "message", [], []], ["Add eleven different events tomorrow", "message", [], []],
];
fill("ambiguity", "ambiguity", 30, ambiguity.map(([message, type, missing, tools]) => ({ description: "Ambiguity and safety", message, expected: exp(type, tools, { missingFields: missing }) })));

const distribution = { general: 20, calendar_create: 60, calendar_update: 45, calendar_delete: 40, schedule: 40, multi_intent: 70, contextual: 35, tasks: 25, goals: 20, checkins: 15, ambiguity: 30 };
if (cases.length !== 400) throw new Error(`Expected 400 cases, got ${cases.length}`);
for (const [category, count] of Object.entries(distribution)) if (cases.filter((item) => item.category === category).length !== count) throw new Error(`Bad ${category} count`);
writeFileSync(resolve(root, "evals/kairo-400.json"), `${JSON.stringify(cases, null, 2)}\n`);
console.log(`Generated ${cases.length} Kairo reliability cases.`);
