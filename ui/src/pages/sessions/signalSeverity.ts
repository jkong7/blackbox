import type { Severity } from '../../api.ts';

const HIGH = ['tool_loop', 'runaway_cost', 'hallucinated_success', 'toxic_flow', 'destructive_action', 'prompt_injection', 'retry_storm'];
const LOW = ['cache_miss', 'toolset_tax', 'slow_llm', 'memory_unused', 'empty_output'];

export function severityOf(type: string): Severity {
  if (HIGH.includes(type)) return 'high';
  if (LOW.includes(type)) return 'low';
  return 'medium';
}
