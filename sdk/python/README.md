# blackbox Python SDK

Standard library only tracing for [blackbox](../../DESIGN.md), the local flight recorder for AI agents. One file, `blackbox_sdk.py`, Python 3.8+. A background thread batches spans to `POST /api/ingest` and flushes at exit. Telemetry problems never raise into your code.

## Setup

Copy `blackbox_sdk.py` next to your code, then:

```python
import blackbox_sdk as bb

bb.init(url="http://localhost:7777", project="my-agent", session_id="chat-123")
```

Environment variables work too: `BLACKBOX_URL`, `BLACKBOX_PROJECT`, `BLACKBOX_SESSION`, `BLACKBOX_DISABLED=1`.

## Tracing

```python
@bb.observe(kind="tool")
def search(query, limit=5):
    ...

@bb.observe(kind="memory", memory_op="write")
async def remember(fact):
    ...

@bb.observe(name="support agent")
async def agent(question):
    docs = search(question)
    with bb.span("rerank", kind="retriever", input={"n": len(docs)}) as s:
        s.set_output(rerank(docs))
    return answer
```

- `@observe` works on sync functions, async functions and generators. Arguments become the input, the return value the output, exceptions mark the span as an error and are re-raised.
- An `@observe` function called with no active span (and no kind, or kind `agent`) starts a new trace.
- `with bb.trace("name"):` starts a new trace explicitly; `with bb.span("name", kind="tool"):` creates a child span. Both also work with `async with`.
- Parenting uses `contextvars`, so it follows threads started with `contextvars.copy_context()` and asyncio tasks.
- Span methods: `set_input`, `set_output`, `set_attributes(**kv)`, `set_usage(input=, output=, cache_read=, cache_write=, reasoning=, cost_usd=)`, `error(e)`, `set(**fields)`.
- Kinds: `agent llm tool mcp memory retriever embedding chain guardrail handoff evaluator span`.

## LLM clients

```python
from anthropic import Anthropic
from openai import OpenAI

client = bb.wrap_anthropic(Anthropic())
oai = bb.wrap_openai(OpenAI())
```

`messages.create`, `beta.messages.create`, `chat.completions.create` and `responses.create` are recorded as `llm` spans for both sync and async clients, with normalized messages, tool calls, tokens (including cache reads and writes), finish reason and tool list size. With `stream=True` the returned stream is passed through untouched and the span is completed when iteration ends, with time to first token.

## Sessions and scores

```python
bb.set_session("chat-123")
bb.score(trace_id, "helpful", 0.9)
bb.score(trace_id, "task_completion", label="pass", reasoning="tests green")
bb.score(trace_id, "tests_passed", True)
```

`bb.current_trace_id()` returns the active trace id.

## Flushing

Spans are sent every second or every 50 spans, and again at interpreter exit. Call `bb.flush()` at the end of short scripts or serverless handlers. If blackbox is not running, spans are buffered (up to 5000) and retried with backoff, then dropped.
