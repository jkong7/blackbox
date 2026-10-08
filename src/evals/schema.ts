import type { DB } from '../db.ts';

type Row = Record<string, any>;

const TABLES = `
create table if not exists judge_spend (
  id integer primary key autoincrement,
  created_at integer not null,
  cost_usd real not null,
  provider text,
  model text
);
create index if not exists judge_spend_at on judge_spend(created_at);
create table if not exists explanations (
  trace_id text primary key,
  json text not null,
  judge_model text,
  cost_usd real,
  created_at integer not null
);
create index if not exists eval_jobs_rule on eval_jobs(rule_id, created_at desc);
create index if not exists scores_session on scores(session_id) where session_id is not null;
create index if not exists scores_source_created on scores(source, created_at);
`;

const COLUMNS: [string, string, string][] = [
  ['annotations', 'failure_mode', 'text'],
  ['annotations', 'author', 'text'],
  ['experiments', 'error', 'text'],
  ['eval_jobs', 'started_at', 'integer'],
];

function hasColumn(db: DB, table: string, column: string): boolean {
  const cols = db.prepare(`pragma table_info(${table})`).all() as Row[];
  return cols.some((c) => c.name === column);
}

export function migrateEvals(db: DB): void {
  db.exec(TABLES);
  for (const [table, column, type] of COLUMNS) {
    if (!hasColumn(db, table, column)) db.exec(`alter table ${table} add column ${column} ${type}`);
  }
}
