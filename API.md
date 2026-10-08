# blackbox HTTP API

Base: `http://localhost:7777`. All JSON. Times: `*_ns` are Unix nanoseconds (numbers), `created_at` / `*_at` are Unix milliseconds. Costs are USD. Errors return `{error}` with a 4xx/5xx status.

## Ingest

| Method | Path | Body | Notes |
|---|---|---|---|
| POST | `/v1/traces` | OTLP ExportTraceServiceRequest (protobuf or JSON, gzip ok) | also on port 4318 |
| POST | `/v1/logs` | OTLP logs | Claude Code events land here |
| POST | `/v1/metrics` | OTLP metrics | |
| POST | `/api/ingest` | `{spans: [ApiSpan], flush?: bool}` or one span | simple SDK format, see below |
| POST | `/api/flush` | | force the write queue to flush |
| GET | `/api/stream` | | SSE, `data: {type: 'traces'|'signals'|'scores'|'experiment', ids: string[]}` |

ApiSpan: `{trace_id, span_id, parent_id, name, kind, start_ns|start_ms, end_ns|end_ms, status: 'ok'|'error', status_message, session_id, user_id, agent_name, model, provider, tool_name, tool_call_id, mcp_server, mcp_method, memory_op, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, reasoning_tokens, cost_usd, ttft_ms, input, output, attributes, project, source}`. Only `name` is required; ids are generated when missing.

## Core objects

Span (from `/api/traces/:id` and `/api/spans/:id`): all columns of the `spans` table in `src/db.ts`, with `input`, `output`, `attributes`, `events`, `resource` already parsed from JSON. `kind` is one of `agent llm tool mcp memory retriever embedding chain guardrail handoff evaluator span`. For `llm` spans `input` / `output` are usually `Message[]`: `{role, content?, tool_calls?: [{id, name, arguments}], tool_call_id?, reasoning?}`. For tools they are arbitrary JSON or strings.

Trace (list rows): columns of `traces` plus `signals: [{type, severity}]` and `scores: [{name, value, label}]`.

## Observability

| Method | Path | Query / body | Returns |
|---|---|---|---|
| GET | `/api/health` | | `{ok, spans, version}` |
| GET | `/api/overview` | `window=1h|24h|7d|30d`, `project` | `{totals, series, bucket_ms, models, tools, agents, issues, scores}` |
| GET | `/api/facets` | | `{projects, models, agents, tools, sources, kinds, signal_types, score_names}` |
| GET | `/api/traces` | `q` (full text, 3+ chars), `window`, `project`, `session`, `user`, `status=error|ok`, `flagged=1`, `model`, `agent`, `tool`, `kind`, `source`, `signal`, `score=name[:pass|fail]`, `min_cost`, `sort=cost|duration`, `limit`, `cursor` | `{items, total, next}` |
| GET | `/api/traces/:id` | | `{trace, spans, scores, signals, annotations, session_nav: {prev, next}, context_windows: {model: tokens}}` |
| DELETE | `/api/traces/:id` | | |
| GET | `/api/spans/:id` | | span |
| GET | `/api/sessions` | `q`, `project`, `limit`, `cursor` | `{items, next}`; items carry `signals: [{type, count, severity}]` |
| GET | `/api/sessions/:id` | | `{session, traces, turns: [{trace_id, start_ns, user, assistant, tools, cost_usd, duration_ms, error_count, signals, scores}], scores, signals}` |
| GET | `/api/issues` | `window`, `status=open|resolved|ignored`, `project` | `{items: [{fingerprint, type, severity, title, count, traces, first_seen, last_seen, sample_trace_id, status}]}` |
| POST | `/api/issues/:fingerprint/status` | `{status}` | |
| GET | `/api/signals` | `type`, `trace_id`, `fingerprint`, `session_id` | `{items}` with parsed `detail` |
| GET | `/api/tools` | `window` | `{tools: [{tool, kind, mcp_server, memory_op, calls, errors, error_rate, traces, avg_ms, p50_ms, p95_ms, max_ms, last_error}], servers: [{server, calls, errors, error_rate, tools, defined_tools, definition_tokens, avg_ms}], definitions, drift: [{server, name, versions}]}` |
| GET | `/api/agents` | `window` | `{agents: [{agent, traces, llm_calls, tool_calls, cost_usd, errors, tokens, flagged_traces, cost_per_trace, steps_per_trace}], models: [{model, provider, calls, cost_usd, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, cache_hit_ratio, errors, avg_ms, avg_ttft_ms}]}` |
| GET | `/api/memory` | `window`, `limit` | `{ops, summary: [{op, n, errors}], sessions: [{session_id, writes, reads, deletes}]}` |
| GET | `/api/logs` | `session`, `limit` | `{items}` |
| GET | `/api/metrics` | `window` | `{items: [{name, unit, kind, points, total, last_ns}]}` |
| GET | `/api/prices` | `q` | `{items}` |
| POST | `/api/prices` | `{model, pattern?, input, output, cache_read?, cache_write?, context?}` (USD per token) | |

Signal object: `{id, trace_id, span_id, session_id, type, severity: 'high'|'medium'|'low', fingerprint, title, detail, created_at, status}`. Signal types: `tool_loop error_spans tool_retry runaway_cost context_pressure cache_miss toolset_tax slow_llm refusal user_frustration hallucinated_success toxic_flow destructive_action retry_storm abandoned memory_unused empty_output`.

## Evals

Evaluator: `{id, name, type: 'llm_judge'|'code', description, target: 'trace'|'llm'|'tool'|'session', config, builtin: 0|1, created_at, updated_at, stats: {runs, avg, pass_rate, last_run}}`.

- `llm_judge` config: `{prompt: string (rubric, may use {{input}} {{output}} {{trajectory}} {{context}} {{expected}} {{conversation}}), output: 'binary'|'score'|'label', labels?: string[], model?: string}`. Built-ins have `template` set instead of `prompt`.
- `code` config: `{check: 'regex'|'contains'|'not_contains'|'json_valid'|'latency'|'cost'|'no_error'|'max_steps'|'tool_called'|'trajectory_match'|'output_length', params: {...}}`.

Score: `{id, trace_id, span_id, session_id, name, value (0..1 or null), label, reasoning, source: 'judge'|'code'|'human'|'sdk', evaluator_id, rule_id, experiment_id, run_id, judge_model, cost_usd, author, created_at}`.

| Method | Path | Body / query | Returns |
|---|---|---|---|
| GET | `/api/judge/status` | | `{provider: 'anthropic'|'claude-cli'|'mock'|'none', model, spend_today_usd, daily_cap_usd, concurrency, active, queued}` |
| GET | `/api/evaluators/:id` | | evaluator |
| GET | `/api/evaluators` | | `{items}` |
| POST | `/api/evaluators` | evaluator without id | evaluator |
| PUT | `/api/evaluators/:id` | partial | evaluator |
| DELETE | `/api/evaluators/:id` | | |
| POST | `/api/evaluators/:id/run` | `{trace_id?, span_id?, session_id?, trace_ids?: string[]}` | `{jobs: string[]}` (async) |
| POST | `/api/evaluators/test` | `{evaluator, trace_id}` | `{score}` (sync, not stored) |
| GET | `/api/evaluators/:id/calibration` | | `{n, tp, fp, tn, fn, tpr, tnr, precision, accuracy, kappa, disagreements: [{trace_id, judge_label, human_label, reasoning}]}` |
| GET | `/api/rules` | | `{items}` with `evaluator_name` |
| POST | `/api/rules` | `{name, evaluator_id, target, filter: {project?, agent?, model?, tool?, status?, signal?, source?, name_contains?}, sampling: 0..1, delay_ms, enabled: boolean}` | rule |
| PATCH | `/api/rules/:id` | partial | rule |
| DELETE | `/api/rules/:id` | | |
| POST | `/api/rules/:id/backfill` | `{limit}` | `{queued}` |
| GET | `/api/jobs` | `status`, `limit` | `{items, counts: {queued, running, done, failed, skipped}}` |
| GET | `/api/scores` | `name`, `evaluator_id`, `trace_id`, `source`, `limit` | `{items}` |
| POST | `/api/scores` | `{trace_id, span_id?, session_id?, name, value?, label?, reasoning?, source?}` | score |
| GET | `/api/annotations/queues` | | `{items: [{queue, pending, done}]}` |
| GET | `/api/annotations` | `queue`, `status=pending|done` | `{items: [annotation + trace preview fields]}` |
| POST | `/api/annotations` | `{trace_ids, queue}` | `{added}` |
| POST | `/api/annotations/:id` | `{label: 'pass'|'fail', comment?, failure_mode?}` | annotation |
| GET | `/api/datasets` | | `{items}` with `item_count` |
| POST | `/api/datasets` | `{name, description?}` | dataset |
| GET | `/api/datasets/:id` | | `{dataset, items}` |
| POST | `/api/datasets/:id/items` | `{items: [{input, expected?, metadata?}]}`, `{trace_ids: string[]}` or `{jsonl: string}` | `{added}` |
| DELETE | `/api/datasets/:id/items/:itemId` | | |
| DELETE | `/api/datasets/:id` | | |
| GET | `/api/experiments` | `dataset_id` | `{items}` with `summary` |
| POST | `/api/experiments` | `{dataset_id, name, target: {type: 'command', command} | {type: 'http', url} | {type: 'llm', model, system?}, evaluator_ids, baseline_id?}` | experiment (runs async) |
| GET | `/api/experiments/:id` | | `{experiment, runs: [{id, item_id, input, expected, output, latency_ms, cost_usd, error, scores}]}` |
| GET | `/api/experiments/:id/compare` | `baseline` (required unless the experiment has one) | `{rows: [{item_id, input, expected, a: {output, error, scores: {name: value}}, b, verdict: 'improved'|'regressed'|'tie'|'tradeoff'}], summary: {evaluator_name: {a_avg, b_avg, improved, regressed, ties}}}`; `a` is the baseline |
| DELETE | `/api/experiments/:id` | | |
| POST | `/api/traces/:id/explain` | | `{summary, outcome, root_cause, failure_modes: [{mode, span_id, evidence}], suggestions, judge_model}` |
| GET | `/api/traces/:id/explain` | | last explanation or `null` |

## Integrations

| Method | Path | Body | Returns |
|---|---|---|---|
| POST | `/api/mcp/tools` | `{server, tools: [{name, description, inputSchema}]}` | `{added, changed, tokens}` |
| GET | `/api/mcp/tools` | | `{items}` |
| GET | `/api/connect` | | setup snippets for Claude Code, Codex, OTel SDKs, the proxy, the MCP wrapper and server, and the SDKs |
