export const CAPABILITY_REGISTRY = {
  answer_schedule_question: { mode: "read", requiresConfirmation: false, supportsDependencies: true, requiresLocalMatch: false, supportsBatch: true },
  read_savings_progress: { mode: "read", requiresConfirmation: false, supportsDependencies: true, requiresLocalMatch: false, supportsBatch: true },
  read_checkin_insights: { mode: "read", requiresConfirmation: false, supportsDependencies: true, requiresLocalMatch: false, supportsBatch: true },
  generate_daily_briefing: { mode: "read", requiresConfirmation: false, supportsDependencies: true, requiresLocalMatch: false, supportsBatch: true },
  create_calendar_event: { mode: "write", requiresConfirmation: true, supportsDependencies: true, requiresLocalMatch: false, supportsBatch: true },
  create_task: { mode: "write", requiresConfirmation: true, supportsDependencies: true, requiresLocalMatch: false, supportsBatch: true },
  create_savings_goal: { mode: "write", requiresConfirmation: true, supportsDependencies: true, requiresLocalMatch: false, supportsBatch: true },
  add_goal_contribution: { mode: "write", requiresConfirmation: true, supportsDependencies: true, requiresLocalMatch: true, supportsBatch: true },
  delete_calendar_event: { mode: "destructive", requiresConfirmation: true, supportsDependencies: true, requiresLocalMatch: true, supportsBatch: true },
} as const;

export type SupportedTool = keyof typeof CAPABILITY_REGISTRY;
export type CapabilityMode = typeof CAPABILITY_REGISTRY[SupportedTool]["mode"];

export const SUPPORTED_TOOLS = Object.keys(CAPABILITY_REGISTRY) as SupportedTool[];

export const isSupportedTool = (value: string): value is SupportedTool => value in CAPABILITY_REGISTRY;

export const effectiveCapabilities = (requested?: SupportedTool[]) => {
  if (!requested) return new Set(SUPPORTED_TOOLS);
  return new Set(requested.filter(isSupportedTool));
};

export const capabilitySummary = () => SUPPORTED_TOOLS.map((name) => ({ name, ...CAPABILITY_REGISTRY[name] }));
