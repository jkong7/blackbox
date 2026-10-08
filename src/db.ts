import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';

export type DB = DatabaseSync;

export function homeDir(): string {
  return process.env.BLACKBOX_HOME || join(homedir(), '.blackbox');
}

export function dbPath(): string {
  return process.env.BLACKBOX_DB || join(homeDir(), 'blackbox.db');
}

const SCHEMA = `
create table if not exists spans (
  span_id text primary key,
  trace_id text not null,
  parent_id text,
  project text not null default 'default',
  name text not null,
  kind text not null default 'span',
  source text not null default 'otel',
  operation text,
  start_ns real not null,
  end_ns real,
  duration_ms real,
  status text not null default 'unset',
  status_message text,
  session_id text,
  user_id text,
  agent_name text,
  model text,
  provider text,
  tool_name text,
  tool_call_id text,
  mcp_server text,
  mcp_method text,
  memory_op text,
  input_tokens integer,
  output_tokens integer,
  cache_read_tokens integer,
  cache_write_tokens integer,
  reasoning_tokens integer,
  cost_usd real,
  ttft_ms real,
  finish_reason text,
  input text,
  output text,
  input_preview text,
  output_preview text,
  attributes text,
  events text,
  resource text,
  updated_at integer not null
);
create index if not exists spans_trace on spans(trace_id, start_ns);
create index if not exists spans_parent on spans(parent_id) where parent_id is not null;
create index if not exists spans_start on spans(start_ns desc);
create index if not exists spans_session on spans(session_id, start_ns);
create index if not exists spans_kind on spans(kind, start_ns desc);
create index if not exists spans_tool on spans(tool_name) where tool_name is not null;
create index if not exists spans_model on spans(model) where model is not null;

create virtual table if not exists spans_fts using fts5(
  span_id unindexed, trace_id unindexed, name, input, output, tokenize = 'trigram'
);

create table if not exists traces (
  trace_id text primary key,
  project text not null default 'default',
  name text,
  root_span_id text,
  session_id text,
  user_id text,
  agent_names text,
  models text,
  sources text,
  start_ns real,
  end_ns real,
  duration_ms real,
  span_count integer not null default 0,
  llm_calls integer not null default 0,
  tool_calls integer not null default 0,
  error_count integer not null default 0,
  input_tokens integer not null default 0,
  output_tokens integer not null default 0,
  cache_read_tokens integer not null default 0,
  cache_write_tokens integer not null default 0,
  cost_usd real not null default 0,
  input_preview text,
  output_preview text,
  tags text,
  signal_count integer not null default 0,
  analyzed_at integer,
  updated_at integer not null
);
create index if not exists traces_start on traces(start_ns desc);
create index if not exists traces_session on traces(session_id, start_ns);
create index if not exists traces_updated on traces(updated_at);
create index if not exists traces_agent on traces(agent_names, start_ns);
create index if not exists traces_unanalyzed on traces(analyzed_at) where analyzed_at is null;

create table if not exists sessions (
  session_id text primary key,
  project text not null default 'default',
  user_id text,
  start_ns real,
  end_ns real,
  trace_count integer not null default 0,
  llm_calls integer not null default 0,
  tool_calls integer not null default 0,
  error_count integer not null default 0,
  input_tokens integer not null default 0,
  output_tokens integer not null default 0,
  cost_usd real not null default 0,
  first_input text,
  sources text,
  updated_at integer not null
);
create index if not exists sessions_end on sessions(end_ns desc);

create table if not exists logs (
  id integer primary key autoincrement,
  ts_ns real not null,
  name text,
  severity text,
  body text,
  trace_id text,
  span_id text,
  session_id text,
  attributes text,
  resource text
);
create index if not exists logs_ts on logs(ts_ns desc);
create index if not exists logs_session on logs(session_id, ts_ns);

create table if not exists metric_points (
  id integer primary key autoincrement,
  name text not null,
  ts_ns real not null,
  value real not null,
  kind text,
  unit text,
  attributes text,
  session_id text
);
create index if not exists metric_points_name on metric_points(name, ts_ns);

create table if not exists scores (
  id text primary key,
  trace_id text,
  span_id text,
  session_id text,
  name text not null,
  value real,
  label text,
  reasoning text,
  source text not null,
  evaluator_id text,
  rule_id text,
  experiment_id text,
  run_id text,
  judge_model text,
  cost_usd real,
  author text,
  created_at integer not null
);
create index if not exists scores_trace on scores(trace_id);
create index if not exists scores_name on scores(name, created_at desc);
create index if not exists scores_eval on scores(evaluator_id, created_at desc);
create index if not exists scores_run on scores(run_id);

create table if not exists signals (
  id text primary key,
  trace_id text not null,
  span_id text,
  session_id text,
  type text not null,
  severity text not null,
  fingerprint text not null,
  title text not null,
  detail text,
  created_at integer not null,
  status text not null default 'open'
);
create index if not exists signals_trace on signals(trace_id);
create index if not exists signals_fp on signals(fingerprint, created_at desc);
create index if not exists signals_type on signals(type, created_at desc);

create table if not exists evaluators (
  id text primary key,
  name text not null unique,
  type text not null,
  description text,
  target text not null default 'trace',
  config text not null,
  builtin integer not null default 0,
  created_at integer not null,
  updated_at integer not null
);

create table if not exists eval_rules (
  id text primary key,
  name text not null,
  evaluator_id text not null,
  target text not null default 'trace',
  filter text,
  sampling real not null default 1,
  delay_ms integer not null default 5000,
  enabled integer not null default 1,
  created_at integer not null
);

create table if not exists eval_jobs (
  id text primary key,
  rule_id text,
  evaluator_id text not null,
  trace_id text,
  span_id text,
  session_id text,
  experiment_id text,
  run_id text,
  status text not null default 'queued',
  run_after integer not null,
  attempts integer not null default 0,
  lease_until integer,
  error text,
  created_at integer not null,
  finished_at integer
);
create index if not exists eval_jobs_due on eval_jobs(status, run_after);

create table if not exists datasets (
  id text primary key,
  name text not null unique,
  description text,
  created_at integer not null
);

create table if not exists dataset_items (
  id text primary key,
  dataset_id text not null,
  input text not null,
  expected text,
  metadata text,
  source_trace_id text,
  created_at integer not null
);
create index if not exists dataset_items_ds on dataset_items(dataset_id, created_at);

create table if not exists experiments (
  id text primary key,
  dataset_id text not null,
  name text not null,
  target text not null,
  evaluator_ids text not null,
  baseline_id text,
  status text not null default 'pending',
  summary text,
  created_at integer not null,
  finished_at integer
);

create table if not exists experiment_runs (
  id text primary key,
  experiment_id text not null,
  item_id text not null,
  output text,
  trace_id text,
  latency_ms real,
  cost_usd real,
  error text,
  created_at integer not null
);
create index if not exists experiment_runs_exp on experiment_runs(experiment_id);

create table if not exists annotations (
  id text primary key,
  trace_id text not null,
  session_id text,
  queue text not null default 'default',
  status text not null default 'pending',
  label text,
  value real,
  comment text,
  created_at integer not null,
  labeled_at integer
);
create unique index if not exists annotations_trace_queue on annotations(trace_id, queue);

create table if not exists prices (
  model text primary key,
  pattern text,
  provider text,
  input real not null,
  output real not null,
  cache_read real,
  cache_write real,
  reasoning real,
  context integer,
  custom integer not null default 0
);

create table if not exists mcp_tools (
  server text not null,
  name text not null,
  hash text not null,
  description text,
  schema text,
  tokens integer,
  first_seen integer not null,
  last_seen integer not null,
  primary key (server, name, hash)
);

create table if not exists kv (
  key text primary key,
  value text not null
);
`;

let shared: DB | null = null;

export function openDb(path = dbPath()): DB {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec('pragma journal_mode = wal');
  db.exec('pragma synchronous = normal');
  db.exec('pragma busy_timeout = 5000');
  db.exec('pragma foreign_keys = off');
  db.exec(SCHEMA);
  return db;
}

export function getDb(): DB {
  if (!shared) shared = openDb();
  return shared;
}

export function setDb(db: DB): void {
  shared = db;
}

export function tx<T>(db: DB, fn: () => T): T {
  db.exec('begin immediate');
  try {
    const out = fn();
    db.exec('commit');
    return out;
  } catch (e) {
    db.exec('rollback');
    throw e;
  }
}

export function kvGet(db: DB, key: string): string | null {
  const row = db.prepare('select value from kv where key = ?').get(key) as { value: string } | undefined;
  return row ? row.value : null;
}

export function kvSet(db: DB, key: string, value: string): void {
  db.prepare('insert into kv(key, value) values(?, ?) on conflict(key) do update set value = excluded.value').run(key, value);
}
