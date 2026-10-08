import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import type { DB } from '../db.ts';
import { getDb } from '../db.ts';
import { costFor } from '../pricing.ts';
import { num } from '../util.ts';

type Row = Record<string, any>;

export type Provider = 'anthropic' | 'claude-cli' | 'mock' | 'none';

export const JUDGE_MARKER = '[blackbox-judge]';
export const JUDGE_CONCURRENCY = 3;
export const JUDGE_TIMEOUT_MS = 120000;
const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';

export class BudgetError extends Error {}

export interface CompleteRequest {
  system?: string;
  prompt: string;
  model?: string | null;
  maxTokens?: number;
  json?: boolean;
}

export interface CompleteResult {
  text: string;
  model: string;
  cost_usd: number | null;
  provider: Provider;
  latency_ms: number;
}

export interface Verdict {
  reasoning: string;
  label: string | null;
  score: number | null;
}

export interface VerdictOptions {
  output?: 'binary' | 'score' | 'label';
  labels?: string[];
  threshold?: number;
  passLabels?: string[];
}

let claudePath: string | null | undefined;

export function findClaude(): string | null {
  if (claudePath !== undefined) return claudePath;
  claudePath = null;
  for (const dir of (process.env.PATH ?? '').split(delimiter)) {
    if (!dir) continue;
    const p = join(dir, 'claude');
    try {
      if (existsSync(p) && statSync(p).isFile()) {
        claudePath = p;
        break;
      }
    } catch {}
  }
  return claudePath;
}

export function judgeProvider(): Provider {
  const forced = process.env.BLACKBOX_JUDGE_PROVIDER;
  if (forced === 'mock' || forced === 'anthropic' || forced === 'claude-cli' || forced === 'none') return forced;
  if (process.env.ANTHROPIC_API_KEY) return 'anthropic';
  if (findClaude()) return 'claude-cli';
  return 'none';
}

export function defaultModel(provider: Provider = judgeProvider()): string {
  if (process.env.BLACKBOX_JUDGE_MODEL) return process.env.BLACKBOX_JUDGE_MODEL;
  if (provider === 'claude-cli') return 'haiku';
  if (provider === 'mock') return 'mock';
  return 'claude-haiku-5-5';
}

export function dailyCap(): number {
  return num(process.env.BLACKBOX_JUDGE_DAILY_CAP) ?? 2;
}

export function startOfToday(): number {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

function sumSince(db: DB, sql: string, since: number): number {
  try {
    const r = db.prepare(sql).get(since) as Row | undefined;
    return Number(r?.v ?? 0);
  } catch {
    return 0;
  }
}

export function spendToday(db: DB = getDb()): number {
  const since = startOfToday();
  return (
    sumSince(db, "select coalesce(sum(cost_usd),0) v from scores where source = 'judge' and created_at >= ?", since) +
    sumSince(db, 'select coalesce(sum(cost_usd),0) v from explanations where created_at >= ?', since) +
    sumSince(db, "select coalesce(sum(r.cost_usd),0) v from experiment_runs r join experiments e on e.id = r.experiment_id where r.created_at >= ? and e.target like '%\"llm\"%'", since)
  );
}

export function assertBudget(db: DB = getDb()): void {
  const spent = spendToday(db);
  const cap = dailyCap();
  if (spent >= cap) throw new BudgetError(`judge daily spend cap reached: $${spent.toFixed(4)} spent today of $${cap.toFixed(2)}. Raise BLACKBOX_JUDGE_DAILY_CAP to keep judging.`);
}

export function judgeStatus(db: DB = getDb()): Row {
  const provider = judgeProvider();
  return {
    provider: provider === 'mock' ? 'mock' : provider,
    model: provider === 'none' ? null : defaultModel(provider),
    spend_today_usd: spendToday(db),
    daily_cap_usd: dailyCap(),
    concurrency: JUDGE_CONCURRENCY,
    active: active,
    queued: waiters.length,
  };
}

let active = 0;
const waiters: (() => void)[] = [];

async function acquire(): Promise<void> {
  if (active < JUDGE_CONCURRENCY) {
    active++;
    return;
  }
  await new Promise<void>((resolve) => waiters.push(resolve));
}

function release(): void {
  const next = waiters.shift();
  if (next) next();
  else active--;
}

export async function complete(req: CompleteRequest, db: DB = getDb()): Promise<CompleteResult> {
  const provider = judgeProvider();
  if (provider === 'none') throw new Error('no judge provider: set ANTHROPIC_API_KEY or install the claude CLI');
  assertBudget(db);
  await acquire();
  const t0 = Date.now();
  try {
    const model = req.model || defaultModel(provider);
    let out: Omit<CompleteResult, 'latency_ms' | 'provider'>;
    if (provider === 'anthropic') out = await anthropicCall(req, model, db);
    else if (provider === 'claude-cli') out = await cliCall(req, model);
    else out = mockCall(req, model);
    return { ...out, provider, latency_ms: Date.now() - t0 };
  } finally {
    release();
  }
}

async function anthropicCall(req: CompleteRequest, model: string, db: DB): Promise<Omit<CompleteResult, 'latency_ms' | 'provider'>> {
  const body: Row = {
    model,
    max_tokens: req.maxTokens ?? 2048,
    messages: [{ role: 'user', content: req.prompt }],
  };
  if (req.system) body.system = req.system;
  const res = await fetch(ANTHROPIC_URL, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': process.env.ANTHROPIC_API_KEY ?? '',
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(JUDGE_TIMEOUT_MS),
  });
  const data = (await res.json().catch(() => ({}))) as Row;
  if (!res.ok) throw new Error(`anthropic api ${res.status}: ${data?.error?.message ?? JSON.stringify(data).slice(0, 300)}`);
  const text = (data.content ?? []).filter((c: Row) => c.type === 'text').map((c: Row) => c.text).join('\n');
  const u = data.usage ?? {};
  const cost = costFor(db, data.model ?? model, {
    input_tokens: u.input_tokens,
    output_tokens: u.output_tokens,
    cache_read_tokens: u.cache_read_input_tokens,
    cache_write_tokens: u.cache_creation_input_tokens,
  });
  return { text, model: data.model ?? model, cost_usd: cost };
}

const STRIP_CLAUDE_VARS = [
  'CLAUDE_CODE_ENTRYPOINT',
  'CLAUDE_CODE_MESSAGING',
  'CLAUDE_CODE_SESSION',
  'CLAUDE_CODE_CHILD_SESSION',
  'CLAUDE_CODE_EXECPATH',
  'CLAUDE_CODE_ENABLE_TELEMETRY',
  'CLAUDE_CODE_OTEL',
  'CLAUDE_CODE_SSE_PORT',
];

export function judgeEnv(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(base)) {
    if (k.startsWith('OTEL_')) continue;
    if (k === 'CLAUDECODE' || STRIP_CLAUDE_VARS.some((p) => k.startsWith(p))) continue;
    if (k === 'ANTHROPIC_BASE_URL' || k === 'ANTHROPIC_API_KEY') continue;
    env[k] = v;
  }
  env.CLAUDE_CODE_ENABLE_TELEMETRY = '0';
  env.DISABLE_TELEMETRY = '1';
  env.DISABLE_ERROR_REPORTING = '1';
  env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC = '1';
  env.BLACKBOX_JUDGE = '1';
  return env;
}

export function cliArgs(model: string, system?: string): string[] {
  const args = [
    '-p',
    '--output-format', 'json',
    '--model', model,
    '--tools', '',
    '--no-session-persistence',
    '--strict-mcp-config',
    '--setting-sources', '',
    '--disable-slash-commands',
  ];
  if (system) args.push('--system-prompt', system);
  return args;
}

function cliCall(req: CompleteRequest, model: string): Promise<Omit<CompleteResult, 'latency_ms' | 'provider'>> {
  const bin = findClaude();
  if (!bin) return Promise.reject(new Error('claude CLI not found on PATH'));
  const cwd = mkdtempSync(join(tmpdir(), 'blackbox-judge-'));
  return new Promise((resolve, reject) => {
    const child = spawn(bin, cliArgs(model, req.system), { cwd, env: judgeEnv(), stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let done = false;
    const finish = (err: Error | null, val?: Omit<CompleteResult, 'latency_ms' | 'provider'>) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try {
        rmSync(cwd, { recursive: true, force: true });
      } catch {}
      if (err) reject(err);
      else resolve(val!);
    };
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      finish(new Error(`claude CLI judge timed out after ${JUDGE_TIMEOUT_MS / 1000}s`));
    }, JUDGE_TIMEOUT_MS);
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    child.on('error', (e) => finish(e));
    child.on('close', (code) => {
      let data: Row | null = null;
      try {
        data = JSON.parse(stdout.trim());
      } catch {
        data = null;
      }
      if (!data) return finish(new Error(`claude CLI exited ${code}: ${(stderr || stdout).trim().slice(-500)}`));
      if (data.is_error || data.subtype && data.subtype !== 'success') return finish(new Error(`claude CLI error: ${String(data.result ?? data.subtype ?? 'unknown').slice(0, 500)}`));
      const usedModel = data.modelUsage && typeof data.modelUsage === 'object' ? Object.keys(data.modelUsage)[0] : null;
      finish(null, { text: String(data.result ?? ''), model: usedModel || model, cost_usd: num(data.total_cost_usd) });
    });
    child.stdin.on('error', () => {});
    child.stdin.end(req.prompt);
  });
}

function mockCall(req: CompleteRequest, model: string): Omit<CompleteResult, 'latency_ms' | 'provider'> {
  if (!req.json) return { text: `mock answer: ${req.prompt.slice(-200).trim()}`, model, cost_usd: 0 };
  const fail = req.prompt.includes('MOCK_FAIL');
  const labelMatch = /MOCK_LABEL=([a-z_]+)/.exec(req.prompt);
  const verdict = {
    reasoning: fail ? 'The mock judge saw MOCK_FAIL in the record.' : 'The mock judge found nothing wrong.',
    label: labelMatch ? labelMatch[1] : fail ? 'fail' : 'pass',
    score: fail ? 0 : 1,
    summary: 'Mock summary of the run.',
    outcome: fail ? 'failure' : 'success',
    root_cause: fail ? 'Mock root cause.' : null,
    failure_modes: fail ? [{ mode: 'mock_failure', span_id: null, evidence: 'MOCK_FAIL marker' }] : [],
    suggestions: fail ? ['Remove the MOCK_FAIL marker.'] : [],
  };
  return { text: 'Here is my assessment.\n```json\n' + JSON.stringify(verdict, null, 2) + '\n```', model, cost_usd: 0 };
}

function balancedObjects(text: string): string[] {
  const out: string[] = [];
  for (let start = text.indexOf('{'); start !== -1; start = text.indexOf('{', start + 1)) {
    let depth = 0;
    let inStr = false;
    let esc = false;
    for (let i = start; i < text.length; i++) {
      const c = text[i];
      if (inStr) {
        if (esc) esc = false;
        else if (c === '\\') esc = true;
        else if (c === '"') inStr = false;
        continue;
      }
      if (c === '"') inStr = true;
      else if (c === '{') depth++;
      else if (c === '}') {
        depth--;
        if (depth === 0) {
          out.push(text.slice(start, i + 1));
          break;
        }
      }
    }
  }
  return out;
}

export function extractJson(text: string): Row | null {
  const t = text.trim();
  try {
    const v = JSON.parse(t);
    if (v && typeof v === 'object' && !Array.isArray(v)) return v;
  } catch {}
  const fence = /```(?:json)?\s*([\s\S]*?)```/i.exec(t);
  if (fence) {
    try {
      const v = JSON.parse(fence[1].trim());
      if (v && typeof v === 'object' && !Array.isArray(v)) return v;
    } catch {}
  }
  let best: Row | null = null;
  let bestLen = 0;
  for (const cand of balancedObjects(t)) {
    if (cand.length <= bestLen) continue;
    try {
      const v = JSON.parse(cand);
      if (v && typeof v === 'object' && !Array.isArray(v)) {
        best = v;
        bestLen = cand.length;
      }
    } catch {}
  }
  return best;
}

const PASS_WORDS = new Set(['pass', 'passed', 'yes', 'true', 'correct', 'good', 'success', 'supported', 'faithful', 'relevant', 'safe', 'ok']);
const FAIL_WORDS = new Set(['fail', 'failed', 'no', 'false', 'incorrect', 'bad', 'failure', 'unsupported', 'unfaithful', 'irrelevant', 'unsafe']);

export function normalizeLabel(v: unknown): string | null {
  if (v == null) return null;
  if (typeof v === 'boolean') return v ? 'pass' : 'fail';
  const s = String(v).trim().toLowerCase().replace(/[\s-]+/g, '_');
  return s || null;
}

export function isPassLabel(label: string | null | undefined): boolean | null {
  if (!label) return null;
  const l = label.toLowerCase();
  if (PASS_WORDS.has(l)) return true;
  if (FAIL_WORDS.has(l)) return false;
  return null;
}

function toScore(v: unknown): number | null {
  const n = num(v);
  if (n == null) return null;
  if (n > 1 && n <= 10) return n / 10;
  if (n > 10 && n <= 100) return n / 100;
  return Math.max(0, Math.min(1, n));
}

export function parseVerdict(text: string, opts: VerdictOptions = {}): Verdict {
  const output = opts.output ?? 'binary';
  const threshold = opts.threshold ?? 0.5;
  const obj = extractJson(text);
  let reasoning = '';
  let label: string | null = null;
  let score: number | null = null;
  if (obj) {
    reasoning = String(obj.reasoning ?? obj.reason ?? obj.explanation ?? obj.rationale ?? '');
    label = normalizeLabel(obj.label ?? obj.verdict ?? obj.result ?? obj.grade);
    score = toScore(obj.score ?? obj.value);
  } else {
    reasoning = text.trim();
    const m = /"?(?:label|verdict)"?\s*[:=]\s*"?([A-Za-z_-]+)/i.exec(text) ?? /\b(PASS|FAIL)\b(?![\s\S]*\b(?:PASS|FAIL)\b)/.exec(text);
    if (m) label = normalizeLabel(m[1]);
    const s = /"?score"?\s*[:=]\s*([0-9.]+)/i.exec(text);
    if (s) score = toScore(s[1]);
  }
  if (label == null && score == null) throw new Error(`judge output had no label or score: ${text.slice(0, 300)}`);
  if (output === 'binary') {
    const pass = isPassLabel(label);
    if (pass != null) label = pass ? 'pass' : 'fail';
    else if (score != null) label = score >= threshold ? 'pass' : 'fail';
    score = label === 'pass' ? 1 : 0;
  } else if (output === 'score') {
    if (score == null) {
      const pass = isPassLabel(label);
      score = pass == null ? null : pass ? 1 : 0;
    }
    if (score != null) label = score >= threshold ? 'pass' : 'fail';
  } else {
    if (opts.labels?.length && label && !opts.labels.includes(label)) {
      const near = opts.labels.find((l) => label!.includes(l) || l.includes(label!));
      if (near) label = near;
    }
    if (opts.passLabels?.length && label) score = opts.passLabels.includes(label) ? 1 : 0;
  }
  return { reasoning, label, score };
}

export function fillTemplate(tpl: string, vars: Record<string, string>): string {
  return tpl.replace(/\{\{\s*([a-zA-Z_]+)\s*\}\}/g, (_, k) => {
    const v = vars[k];
    return v == null || v === '' ? '(none)' : v;
  });
}

export function outputInstructions(opts: VerdictOptions): string {
  const output = opts.output ?? 'binary';
  const head = 'Respond with one JSON object and nothing else, with the fields in this order: {"reasoning": string, "label": string, "score": number}. Write the reasoning first and decide only after it.';
  if (output === 'score') {
    const t = opts.threshold ?? 0.5;
    return `${head}\n"score" is a number from 0 to 1. "label" is "pass" if score >= ${t}, otherwise "fail".`;
  }
  if (output === 'label') {
    const labels = (opts.labels ?? []).map((l) => `"${l}"`).join(', ');
    const pass = opts.passLabels?.length ? ` "score" is 1 if the label is ${opts.passLabels.map((l) => `"${l}"`).join(' or ')}, otherwise 0.` : ' "score" is your confidence from 0 to 1.';
    return `${head}\n"label" must be exactly one of: ${labels}.${pass}`;
  }
  return `${head}\n"label" must be "pass" or "fail". "score" is 1 for pass and 0 for fail.`;
}
