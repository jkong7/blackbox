# blackbox design

A local flight recorder and judge for AI agents. One process on this Mac that records every LLM call, tool call, MCP message and memory operation from any agent, computes the signals that matter, and grades runs with deterministic checks, LLM judges and human labels.

Research behind it: `~/dev/reports/LLM observability and eval market.md` and the notes in `~/dev/research_notes/LLM observability and eval market/`.

## What the market does, and what we take

| Player | Lesson taken |
|---|---|
| Langfuse | observation types, scores as a first-class object, eval rules with filter + sampling + delay and a deterministic job id so racing producers never double-spend a judge |
| Arize Phoenix | single process + SQLite works for one user; OpenInference span kinds; per-span subtree rollups; regex price table from LiteLLM |
| LangSmith | thread evaluators that fire when a conversation goes idle; Insights style clustering of failures |
| Braintrust | experiments diffed against a baseline, each row graded improvement / regression / tie; scorers usable offline and online |
| Datadog / New Relic | accept plain OTLP GenAI, map `gen_ai.operation.name` to span kinds, compute cost server-side because OTel has no cost attribute |
| Raindrop | implicit outcome signals from live traffic (frustration, task failure, forgetting, refusal, jailbreak, praise) without labeled data |
| Laminar / Patronus Percival | whole-trajectory root cause analysis instead of single-answer grading |
| Helicone / Portkey | a proxy captures traffic with zero code changes |
| Hamel Husain / MAST / TRAIL | error analysis first, one binary judge per observed failure, calibrate judges against human labels |

Gaps nobody fills well, which blackbox targets:

1. Local, neutral, zero-config. Works with Claude Code, Codex, any OTel SDK, any framework, with no account and no cloud.
2. MCP observability at the wire: an stdio wrapper that records every JSON-RPC message, tool definition hash and token cost of the tool list.
3. Memory observability: memory reads and writes as first-class spans with a per-run memory ledger.
4. Agent-native signals computed with no labels: loops, runaway cost, context pressure, cache efficiency, toolset tax, toxic flows, hallucinated success, abandonment.
5. Judge calibration built in: every judge shows its agreement with human labels (TPR, TNR, Cohen's kappa) so you know whether to trust it.
6. Cost per task, not per token.

## Architecture

```
 OTLP/HTTP (json + protobuf) ─┐
   traces, logs, metrics      │
 LLM proxy (Anthropic, OpenAI)┼─► normalize ─► write queue ─► SQLite (WAL)
 MCP stdio wrapper            │    (OTel GenAI, OpenInference,   │  spans, traces, sessions,
 SDKs (TS, Python) / REST ────┘     OpenLLMetry, Vercel AI,      │  logs, metrics, scores,
                                    Claude Code, OpenAI Agents)  │  signals, evals, datasets
                                                                 ▼
                                         workers: rollup, cost, signals, eval jobs, idle sessions
                                                                 │
                                         REST + SSE live tail ◄──┘──► React UI
```

One Node process (Node 26 runs TypeScript directly, `node:sqlite` with FTS5). The receiver appends to an in-memory queue and a single writer flushes every 100 ms in one transaction. Spans are upserted with merge, never replace, so partial updates and out-of-order children are safe. Trace and session rollups are recomputed for the traces touched by each flush.

Ports: `7777` serves the UI, the API and OTLP. `4318` also accepts OTLP so anything with default exporter settings just works. `7778` is the LLM proxy.

## Data model

`spans` is the one wide table (Langfuse `events_full` and Phoenix `spans` converge on this): ids, `kind`, `source`, timing, status, session, user, agent, model, provider, tool, MCP server and method, memory op, tokens split into input / output / cache read / cache write / reasoning, cost, ttft, normalized `input` and `output` (chat messages when recognizable), previews for list views, raw attributes, events and resource.

Kinds: `agent`, `llm`, `tool`, `mcp`, `memory`, `retriever`, `embedding`, `chain`, `guardrail`, `handoff`, `evaluator`, `span`.

`traces` and `sessions` are folds over spans. `scores` hold every grade from any source (`judge`, `code`, `human`, `sdk`) with value, label and reasoning. `signals` hold detector hits with a fingerprint so repeats group into issues. `logs` and `metric_points` keep raw OTLP logs and metrics (Claude Code emits most of its data as log events). Evals add `evaluators`, `eval_rules`, `eval_jobs`, `datasets`, `dataset_items`, `experiments`, `experiment_runs`, `annotations`.

## Normalization

Every source is mapped onto the same span shape:

| Source | Recognized by | LLM span | Tool span | Agent span |
|---|---|---|---|---|
| OTel GenAI | `gen_ai.operation.name` | `chat`, `text_completion`, `generate_content` | `execute_tool` | `invoke_agent`, `create_agent`, `invoke_workflow`, `plan` |
| OpenInference | `openinference.span.kind` | `LLM` | `TOOL` | `AGENT` |
| OpenLLMetry | `traceloop.span.kind`, `llm.request.type` | `gen_ai.prompt.N.*` | `tool` | `agent`, `workflow` |
| Vercel AI SDK legacy | `ai.*` | `ai.generateText.doGenerate` | `ai.toolCall` | `ai.generateText` |
| OpenAI Agents SDK | `openai.agents.*` / span data type | `generation` | `function` | `agent`, `handoff`, `guardrail` |
| Claude Code traces | `claude_code.*` span names | `llm_request` | `tool` | `interaction` |
| Claude Code events | log event names | `api_request` | `tool_result` | one synthetic trace per `prompt.id` |
| MCP | `mcp.method.name` | | `tools/call` | |

Memory spans come from OTel memory operations (`search_memory`, `create_memory`, ...), from tool names that look like memory tools (`memory`, `mem0`, `remember`, `recall`), and from MCP servers named like memory.

## Signals

Computed after a trace goes quiet, no labels needed:

| Signal | Rule |
|---|---|
| `tool_loop` | the same tool with the same arguments three or more times in a trace |
| `error_spans` | any span with error status, grouped by tool or model |
| `tool_error_rate` | a tool that failed in this trace and was retried |
| `runaway_cost` | trace cost above a threshold or 5x the median for that agent |
| `context_pressure` | an LLM call above 80 percent of its model's context window |
| `cache_miss` | a multi-call trace with a large prompt and cache hit ratio under 20 percent |
| `toolset_tax` | tool definitions above 15k tokens or more than 40 tools offered |
| `slow_llm` | an LLM call over 30 seconds or ttft over 10 seconds |
| `refusal` | assistant output that matches refusal phrasing |
| `user_frustration` | user turns matching frustration phrasing |
| `hallucinated_success` | the agent claims tests passed or work is done with no successful matching tool call |
| `toxic_flow` | untrusted read (web fetch, issue, email) followed by a private read and an egress write |
| `destructive_action` | `rm -rf`, `DROP TABLE`, force push and similar in tool arguments |
| `retry_storm` | three or more API errors or retries in one trace |
| `abandoned` | session ends right after an error or a refusal |
| `memory_unused` | memory written but never read in the session |

## Evals

Evaluators are either `code` (regex, contains, JSON validity, latency, cost, trajectory match strict / unordered / subset / superset, tool called) or `llm_judge`. Judges return `{reasoning, label, score}` and reason before scoring. Built-in judges:

- `task_completion`: did the agent achieve the user's goal (agent trajectory)
- `faithfulness`: extract claims from the answer, verify each against the retrieved or tool context, score the supported share
- `answer_relevance`
- `tool_selection`: right tools, right arguments, no needless calls
- `trajectory_review`: label the run with the MAST failure taxonomy (step repetition, reasoning action mismatch, unaware of termination, and so on)
- `hallucination`
- `user_frustration` and `forgetting` over a session
- `safety`: prompt injection, data exfiltration, destructive action
- `custom`: G-Eval style rubric written by the user, binary pass / fail by default

Judge providers: the Anthropic API when `ANTHROPIC_API_KEY` is set, otherwise the local `claude -p` CLI, so evals work on a Claude subscription with no key.

Online rules: evaluator + target (trace, llm span, tool span, session) + filter + sampling rate + delay. Jobs get id `sha256(rule, trace, span)` and are inserted with `ON CONFLICT DO NOTHING`. Sampling hashes the trace id so a trace is kept or dropped as a whole. A worker leases due jobs.

Offline: datasets built from traces or JSONL; experiments run a target (shell command or HTTP endpoint) over every item, score with chosen evaluators, and compare to a baseline per item as improvement, regression or tie.

Calibration: an annotation queue collects human pass / fail labels on traces; each judge page shows confusion matrix, TPR, TNR and kappa against those labels.

## UI

- Overview: cost, tokens, calls, error rate, p50 / p95 latency, cache hit ratio, top models, top tools, open issues, live feed
- Traces: searchable table (full text over inputs and outputs), filters by kind, model, agent, status, session, signal
- Trace: span tree beside a waterfall, span detail with chat rendering, tool calls, JSON, scores and signals; agent graph tab; context window track; memory ledger; "add to dataset", "run judge", "explain this run"
- Sessions: conversation replay across traces with per-turn signals
- Issues: signals grouped by fingerprint with counts and example traces
- Agents and tools: per agent, per tool and per MCP server reliability, latency, cost
- Evals: evaluators, rules, recent scores, calibration
- Datasets and experiments with side-by-side compare
- Annotate: keyboard-driven pass / fail queue
- Connect: copy-paste setup for Claude Code, Codex, the proxy, the MCP wrapper, OTel SDKs and the blackbox SDKs

## CLI

`blackbox serve`, `blackbox demo` (seeds realistic agent traces that cover every signal), `blackbox env claude-code`, `blackbox mcp -- <server command>`, `blackbox eval run <experiment>`, `blackbox doctor`.
