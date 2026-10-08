# blackbox TypeScript SDK

Zero dependency tracing for [blackbox](../../DESIGN.md), the local flight recorder for AI agents. One file, `index.ts`, that runs on Node 22.6+ (type stripping) or any TypeScript build. Spans are batched to `POST /api/ingest` and flushed on exit. Telemetry problems never throw into your code.

## Setup

Copy `index.ts` into your project (or depend on this folder), then:

```ts
import { init, trace, span, observe, score, setSession, wrapAnthropic, wrapOpenAI, flush } from './blackbox';

init({ url: 'http://localhost:7777', project: 'my-agent', sessionId: 'chat-123' });
```

Environment variables work too: `BLACKBOX_URL`, `BLACKBOX_PROJECT`, `BLACKBOX_SESSION`, `BLACKBOX_DISABLED=1`.

## Tracing

```ts
const answer = await trace('support agent', async (root) => {
  const docs = await span('search docs', () => search(q), { kind: 'retriever', input: { q } });
  await span('save note', () => memory.add(note), { kind: 'memory', memoryOp: 'write' });
  root.setAttributes({ plan: 'basic' });
  return client.messages.create({ ... });
}, { input: q });
```

- `trace(name, fn, opts)` starts a new trace with a root span (kind `agent` by default).
- `span(name, fn, opts)` creates a child of the current span. Parenting follows async calls through `AsyncLocalStorage`, so nested `await`s and parallel work land in the right place.
- Sync and async functions both work. Return values become the span output, thrown errors mark the span as an error and are rethrown unchanged.
- Options: `kind` (`agent llm tool mcp memory retriever embedding chain guardrail handoff evaluator span`), `input`, `output`, `model`, `provider`, `toolName`, `toolCallId`, `agent`, `sessionId`, `userId`, `memoryOp`, `attributes`, `captureInput`, `captureOutput`.
- The callback receives the `Span`: `setInput`, `setOutput`, `setAttributes`, `setUsage({ input, output, cacheRead, cacheWrite, reasoning, costUsd })`, `error(e)`.

`observe(fn, opts)` wraps a function so every call is a span with the arguments as input:

```ts
const getWeather = observe(async function getWeather(city: string) { ... }, { kind: 'tool' });
```

If `observe` is called with no active span and no kind (or kind `agent`), it starts a new trace.

## LLM clients

```ts
import Anthropic from '@anthropic-ai/sdk';
import OpenAI from 'openai';

const anthropic = wrapAnthropic(new Anthropic());
const openai = wrapOpenAI(new OpenAI());
```

`messages.create`, `beta.messages.create`, `chat.completions.create` and `responses.create` are recorded as `llm` spans with normalized messages, tool calls, tokens (including cache reads and writes), finish reason, and the tool list size. Streaming responses are recorded when the stream finishes, with time to first token. `messages.stream()` goes through `create` and is covered too. The returned objects are the SDK's own, unchanged.

For OpenAI streaming usage, pass `stream_options: { include_usage: true }`.

## Sessions and scores

```ts
setSession('chat-123');
score(traceId, 'helpful', 0.9);
score(traceId, 'task_completion', 'pass', { reasoning: 'tests green' });
score(traceId, 'tests_passed', true);
```

`currentTraceId()` returns the active trace id.

## Flushing

Spans are sent every second or every 50 spans, and once more when the process is about to exit. In short lived scripts or serverless handlers, `await flush()` before returning. If blackbox is not running, spans are buffered (up to 5000) and retried with backoff, then dropped.
