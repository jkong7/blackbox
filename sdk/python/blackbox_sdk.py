import atexit
import contextvars
import functools
import inspect
import json
import os
import secrets
import threading
import time
import urllib.error
import urllib.request

__all__ = [
    "init",
    "observe",
    "span",
    "trace",
    "score",
    "set_session",
    "set_user",
    "current_span",
    "current_trace_id",
    "flush",
    "shutdown",
    "wrap_anthropic",
    "wrap_openai",
    "Span",
]

_config = {
    "url": os.environ.get("BLACKBOX_URL", "http://localhost:7777"),
    "project": os.environ.get("BLACKBOX_PROJECT", "default"),
    "session_id": os.environ.get("BLACKBOX_SESSION"),
    "user_id": None,
    "agent": None,
    "enabled": os.environ.get("BLACKBOX_DISABLED") != "1",
    "batch_size": 50,
    "flush_interval": 1.0,
    "max_queue": 5000,
    "debug": False,
}

_current = contextvars.ContextVar("blackbox_span", default=None)
_MAX_PAYLOAD = 512 * 1024


def _log(*args):
    if _config["debug"]:
        import sys

        print("[blackbox]", *args, file=sys.stderr)


def _hex(n):
    return secrets.token_hex(n)


def _now_ns():
    return time.time_ns()


def _safe(v):
    if v is None:
        return None
    try:
        s = json.dumps(v, default=_default)
    except Exception:
        try:
            return repr(v)[:_MAX_PAYLOAD]
        except Exception:
            return None
    if len(s) > _MAX_PAYLOAD:
        return {"truncated": True, "bytes": len(s), "head": s[:_MAX_PAYLOAD]}
    return json.loads(s)


def _default(o):
    for attr in ("model_dump", "dict", "to_dict"):
        fn = getattr(o, attr, None)
        if callable(fn):
            try:
                return fn()
            except Exception:
                pass
    if isinstance(o, (set, tuple)):
        return list(o)
    if isinstance(o, bytes):
        return "<%d bytes>" % len(o)
    return repr(o)


def _get(o, key, default=None):
    if o is None:
        return default
    if isinstance(o, dict):
        return o.get(key, default)
    return getattr(o, key, default)


def _as_dict(o):
    if o is None or isinstance(o, dict):
        return o
    for attr in ("model_dump", "to_dict", "dict"):
        fn = getattr(o, attr, None)
        if callable(fn):
            try:
                return fn()
            except Exception:
                pass
    return o


class _Exporter:
    def __init__(self):
        self.queue = []
        self.lock = threading.Lock()
        self.event = threading.Event()
        self.thread = None
        self.failures = 0
        self.stopped = False

    def _ensure_thread(self):
        if self.thread and self.thread.is_alive():
            return
        self.thread = threading.Thread(target=self._loop, name="blackbox-exporter", daemon=True)
        self.thread.start()

    def push(self, item):
        if not _config["enabled"]:
            return
        with self.lock:
            self.queue.append(item)
            over = len(self.queue) - _config["max_queue"]
            if over > 0:
                del self.queue[:over]
            full = len(self.queue) >= _config["batch_size"]
        self._ensure_thread()
        if full:
            self.event.set()

    def _loop(self):
        while not self.stopped:
            wait = _config["flush_interval"]
            if self.failures:
                wait = min(30.0, 2 ** min(self.failures, 5))
            self.event.wait(wait)
            self.event.clear()
            self.flush_once()

    def _post(self, path, body):
        data = json.dumps(body, default=_default).encode("utf-8")
        req = urllib.request.Request(_config["url"].rstrip("/") + path, data=data, headers={"content-type": "application/json"}, method="POST")
        try:
            with urllib.request.urlopen(req, timeout=5) as r:
                r.read()
            return True
        except urllib.error.HTTPError as e:
            _log(path, e.code)
            return 400 <= e.code < 500
        except Exception as e:
            _log("export failed", e)
            return False

    def flush_once(self):
        while True:
            with self.lock:
                batch = self.queue[: _config["batch_size"]]
            if not batch:
                self.failures = 0
                return True
            spans = [dict((k, v) for k, v in b.items() if k != "_type") for b in batch if b["_type"] == "span"]
            scores = [dict((k, v) for k, v in b.items() if k != "_type") for b in batch if b["_type"] == "score"]
            ok = True
            if spans:
                ok = self._post("/api/ingest", {"spans": spans})
            if ok:
                for s in scores:
                    if not self._post("/api/scores", s):
                        ok = False
                        break
            if not ok:
                self.failures += 1
                return False
            with self.lock:
                del self.queue[: len(batch)]

    def flush(self, timeout=5.0):
        deadline = time.time() + timeout
        while time.time() < deadline:
            if self.flush_once():
                return True
            time.sleep(0.2)
        return False


_exporter = _Exporter()


@atexit.register
def _at_exit():
    try:
        if _exporter.queue and _exporter.failures < 3:
            _exporter.flush(timeout=3.0)
    except Exception:
        pass


class Span:
    def __init__(self, name, kind="span", parent=None, root=False, **opts):
        trace_id = opts.get("trace_id") or (None if root else (parent.trace_id if parent else None)) or _hex(16)
        parent_id = opts.get("parent_id")
        if parent_id is None and parent is not None and not root and parent.trace_id == trace_id:
            parent_id = parent.span_id
        agent = opts.get("agent")
        if agent is None:
            agent = (_config["agent"] or name) if (kind == "agent" or root) else (parent.data.get("agent_name") if parent else _config["agent"])
        self.data = {
            "trace_id": trace_id,
            "span_id": _hex(8),
            "parent_id": parent_id,
            "name": name,
            "kind": kind,
            "source": "sdk",
            "project": _config["project"],
            "start_ns": _now_ns(),
            "status": "unset",
            "session_id": opts.get("session_id") or (parent.data.get("session_id") if parent else None) or _config["session_id"],
            "user_id": opts.get("user_id") or (parent.data.get("user_id") if parent else None) or _config["user_id"],
            "agent_name": agent,
            "model": opts.get("model"),
            "provider": opts.get("provider"),
            "tool_name": opts.get("tool_name") or (name if kind in ("tool", "mcp", "memory") else None),
            "tool_call_id": opts.get("tool_call_id"),
            "memory_op": opts.get("memory_op"),
        }
        if opts.get("attributes"):
            self.data["attributes"] = dict(opts["attributes"])
        if opts.get("input") is not None:
            self.set_input(opts["input"])
        self._t0 = time.perf_counter()
        self._token = None
        self.ended = False

    @property
    def trace_id(self):
        return self.data["trace_id"]

    @property
    def span_id(self):
        return self.data["span_id"]

    def set(self, **fields):
        self.data.update(fields)
        return self

    def set_input(self, v):
        self.data["input"] = _safe(v)
        return self

    def set_output(self, v):
        self.data["output"] = _safe(v)
        return self

    def set_attributes(self, **attrs):
        a = self.data.get("attributes") or {}
        a.update(attrs)
        self.data["attributes"] = a
        return self

    def set_usage(self, input=None, output=None, cache_read=None, cache_write=None, reasoning=None, cost_usd=None):
        for key, val in (("input_tokens", input), ("output_tokens", output), ("cache_read_tokens", cache_read), ("cache_write_tokens", cache_write), ("reasoning_tokens", reasoning), ("cost_usd", cost_usd)):
            if val is not None:
                self.data[key] = val
        return self

    def error(self, e):
        self.data["status"] = "error"
        self.data["status_message"] = str(e) or type(e).__name__
        if isinstance(e, BaseException):
            self.set_attributes(**{"error.type": type(e).__name__})
        return self

    def end(self):
        if self.ended:
            return
        self.ended = True
        self.data["end_ns"] = self.data["start_ns"] + int((time.perf_counter() - self._t0) * 1e9)
        if self.data["status"] == "unset":
            self.data["status"] = "ok"
        try:
            item = dict(self.data)
            item["_type"] = "span"
            _exporter.push(item)
        except Exception:
            pass

    def __enter__(self):
        self._token = _current.set(self)
        return self

    def __exit__(self, et, ev, tb):
        if ev is not None:
            self.error(ev)
        try:
            if self._token is not None:
                _current.reset(self._token)
        except Exception:
            pass
        self.end()
        return False

    async def __aenter__(self):
        return self.__enter__()

    async def __aexit__(self, et, ev, tb):
        return self.__exit__(et, ev, tb)


def init(url=None, project=None, session_id=None, user_id=None, agent=None, enabled=None, batch_size=None, flush_interval=None, debug=None):
    if url:
        _config["url"] = url
    if project:
        _config["project"] = project
    if session_id is not None:
        _config["session_id"] = session_id
    if user_id is not None:
        _config["user_id"] = user_id
    if agent is not None:
        _config["agent"] = agent
    if enabled is not None:
        _config["enabled"] = enabled
    if batch_size:
        _config["batch_size"] = batch_size
    if flush_interval:
        _config["flush_interval"] = flush_interval
    if debug is not None:
        _config["debug"] = debug


def set_session(session_id):
    _config["session_id"] = session_id
    cur = _current.get()
    if cur is not None and session_id:
        cur.data["session_id"] = session_id


def set_user(user_id):
    _config["user_id"] = user_id


def current_span():
    return _current.get()


def current_trace_id():
    s = _current.get()
    return s.trace_id if s else None


def span(name, kind="span", **opts):
    return Span(name, kind=kind, parent=_current.get(), **opts)


def trace(name, kind="agent", **opts):
    return Span(name, kind=kind, parent=_current.get(), root=True, **opts)


def _bind_args(fn, args, kwargs):
    try:
        sig = inspect.signature(fn)
        bound = sig.bind_partial(*args, **kwargs)
        out = dict(bound.arguments)
        out.pop("self", None)
        out.pop("cls", None)
        if len(out) == 1:
            return next(iter(out.values()))
        return out
    except Exception:
        return {"args": list(args), "kwargs": kwargs}


def observe(_fn=None, *, name=None, kind=None, capture_input=True, capture_output=True, **opts):
    def deco(fn):
        span_name = name or getattr(fn, "__qualname__", None) or getattr(fn, "__name__", "function")

        def start(args, kwargs):
            parent = _current.get()
            k = kind or ("agent" if parent is None else "span")
            root = parent is None and k == "agent"
            s = Span(span_name, kind=k, parent=parent, root=root, **opts)
            if capture_input:
                s.set_input(_bind_args(fn, args, kwargs))
            return s

        if inspect.iscoroutinefunction(fn):

            @functools.wraps(fn)
            async def awrapper(*args, **kwargs):
                try:
                    s = start(args, kwargs)
                except Exception:
                    return await fn(*args, **kwargs)
                token = _current.set(s)
                try:
                    out = await fn(*args, **kwargs)
                    if capture_output and out is not None and "output" not in s.data:
                        s.set_output(out)
                    return out
                except BaseException as e:
                    s.error(e)
                    raise
                finally:
                    try:
                        _current.reset(token)
                    except Exception:
                        pass
                    s.end()

            return awrapper

        if inspect.isgeneratorfunction(fn):

            @functools.wraps(fn)
            def gwrapper(*args, **kwargs):
                try:
                    s = start(args, kwargs)
                except Exception:
                    yield from fn(*args, **kwargs)
                    return
                items = []
                token = _current.set(s)
                try:
                    for item in fn(*args, **kwargs):
                        items.append(item)
                        yield item
                    if capture_output:
                        s.set_output(items)
                except BaseException as e:
                    s.error(e)
                    raise
                finally:
                    try:
                        _current.reset(token)
                    except Exception:
                        pass
                    s.end()

            return gwrapper

        @functools.wraps(fn)
        def wrapper(*args, **kwargs):
            try:
                s = start(args, kwargs)
            except Exception:
                return fn(*args, **kwargs)
            token = _current.set(s)
            try:
                out = fn(*args, **kwargs)
                if capture_output and out is not None and "output" not in s.data:
                    s.set_output(out)
                return out
            except BaseException as e:
                s.error(e)
                raise
            finally:
                try:
                    _current.reset(token)
                except Exception:
                    pass
                s.end()

        return wrapper

    if _fn is not None and callable(_fn):
        return deco(_fn)
    return deco


def score(trace_id, name, value=None, label=None, reasoning=None, span_id=None, session_id=None):
    try:
        body = {"trace_id": trace_id, "name": name, "source": "sdk"}
        if isinstance(value, bool):
            body["value"] = 1 if value else 0
            body["label"] = "pass" if value else "fail"
        elif isinstance(value, (int, float)):
            body["value"] = value
        elif isinstance(value, str) and label is None:
            body["label"] = value
        if label is not None:
            body["label"] = label
        if reasoning:
            body["reasoning"] = reasoning
        if span_id:
            body["span_id"] = span_id
        if session_id:
            body["session_id"] = session_id
        body["_type"] = "score"
        _exporter.push(body)
    except Exception:
        pass


def flush(timeout=5.0):
    try:
        return _exporter.flush(timeout=timeout)
    except Exception:
        return False


def shutdown(timeout=5.0):
    ok = flush(timeout)
    _exporter.stopped = True
    _exporter.event.set()
    return ok


def _text(c):
    if c is None:
        return ""
    if isinstance(c, str):
        return c
    if isinstance(c, (list, tuple)):
        parts = []
        for p in c:
            p = _as_dict(p)
            if isinstance(p, str):
                parts.append(p)
            elif isinstance(p, dict):
                t = p.get("type")
                if t in ("text", "input_text", "output_text"):
                    parts.append(p.get("text") or "")
                elif t in ("image", "image_url", "input_image"):
                    parts.append("[image]")
                elif t == "tool_result":
                    parts.append(_text(p.get("content")))
        return "\n".join(x for x in parts if x)
    d = _as_dict(c)
    if isinstance(d, dict) and isinstance(d.get("text"), str):
        return d["text"]
    try:
        return json.dumps(d, default=_default)
    except Exception:
        return str(c)


def _args(v):
    if isinstance(v, str):
        try:
            return json.loads(v)
        except Exception:
            return v
    return v


def anthropic_messages(params):
    out = []
    if params.get("system"):
        out.append({"role": "system", "content": _text(params["system"])})
    for m in params.get("messages") or []:
        m = _as_dict(m)
        content = m.get("content")
        if not isinstance(content, (list, tuple)):
            out.append({"role": m.get("role"), "content": _text(content)})
            continue
        blocks = [_as_dict(b) for b in content]
        results = [b for b in blocks if isinstance(b, dict) and b.get("type") == "tool_result"]
        for r in results:
            out.append({"role": "tool", "tool_call_id": r.get("tool_use_id"), "content": _text(r.get("content"))})
        uses = [b for b in blocks if isinstance(b, dict) and b.get("type") == "tool_use"]
        rest = [b for b in blocks if not (isinstance(b, dict) and b.get("type") in ("tool_result", "tool_use"))]
        text = _text(rest)
        if text or uses or not results:
            msg = {"role": m.get("role"), "content": text}
            if uses:
                msg["tool_calls"] = [{"id": u.get("id"), "name": u.get("name"), "arguments": u.get("input")} for u in uses]
            out.append(msg)
    return out


def anthropic_output(res):
    res = _as_dict(res) or {}
    blocks = [_as_dict(b) for b in (res.get("content") or [])]
    msg = {"role": "assistant", "content": "".join(b.get("text") or "" for b in blocks if b.get("type") == "text")}
    uses = [b for b in blocks if b.get("type") in ("tool_use", "server_tool_use")]
    if uses:
        msg["tool_calls"] = [{"id": u.get("id"), "name": u.get("name"), "arguments": u.get("input")} for u in uses]
    thinking = "\n".join(b.get("thinking") or "" for b in blocks if b.get("type") == "thinking")
    if thinking:
        msg["reasoning"] = thinking
    return [msg]


def openai_messages(params):
    out = []
    for m in params.get("messages") or []:
        m = _as_dict(m)
        role = m.get("role")
        msg = {"role": "system" if role == "developer" else role, "content": _text(m.get("content"))}
        calls = m.get("tool_calls")
        if calls:
            msg["tool_calls"] = [{"id": _get(t, "id"), "name": _get(_get(t, "function"), "name"), "arguments": _args(_get(_get(t, "function"), "arguments"))} for t in calls]
        if m.get("tool_call_id"):
            msg["tool_call_id"] = m["tool_call_id"]
        out.append(msg)
    return out


def openai_output(res):
    res = _as_dict(res) or {}
    out = []
    for c in res.get("choices") or []:
        m = _as_dict(_get(c, "message")) or {}
        msg = {"role": m.get("role") or "assistant", "content": _text(m.get("content"))}
        calls = m.get("tool_calls")
        if calls:
            msg["tool_calls"] = [{"id": _get(t, "id"), "name": _get(_get(t, "function"), "name"), "arguments": _args(_get(_get(t, "function"), "arguments"))} for t in calls]
        out.append(msg)
    return out


def responses_messages(params):
    out = []
    if params.get("instructions"):
        out.append({"role": "system", "content": _text(params["instructions"])})
    inp = params.get("input")
    if isinstance(inp, str):
        out.append({"role": "user", "content": inp})
        return out
    for it in inp or []:
        it = _as_dict(it)
        t = it.get("type")
        if t == "function_call":
            out.append({"role": "assistant", "content": "", "tool_calls": [{"id": it.get("call_id"), "name": it.get("name"), "arguments": _args(it.get("arguments"))}]})
        elif t == "function_call_output":
            out.append({"role": "tool", "tool_call_id": it.get("call_id"), "content": _text(_args(it.get("output")))})
        elif it.get("role"):
            out.append({"role": "system" if it["role"] == "developer" else it["role"], "content": _text(it.get("content"))})
    return out


def responses_output(res):
    res = _as_dict(res) or {}
    msg = {"role": "assistant", "content": ""}
    texts = []
    for it in res.get("output") or []:
        it = _as_dict(it)
        if it.get("type") == "message":
            texts.append(_text(it.get("content")))
        elif it.get("type") == "function_call":
            msg.setdefault("tool_calls", []).append({"id": it.get("call_id"), "name": it.get("name"), "arguments": _args(it.get("arguments"))})
    msg["content"] = "\n".join(texts)
    return [msg]


class AnthropicAccumulator:
    def __init__(self):
        self.message = {}
        self.blocks = {}
        self.partial = {}
        self.usage = {}
        self.first_at = None

    def add(self, ev):
        ev = _as_dict(ev) or {}
        t = ev.get("type")
        if t == "message_start":
            self.message = dict(_as_dict(ev.get("message")) or {})
            self.usage.update(dict((k, v) for k, v in (_as_dict(self.message.get("usage")) or {}).items() if v is not None))
        elif t == "content_block_start":
            i = ev.get("index", 0)
            b = dict(_as_dict(ev.get("content_block")) or {})
            self.blocks[i] = b
            if b.get("type") in ("tool_use", "server_tool_use"):
                self.partial[i] = ""
        elif t == "content_block_delta":
            if self.first_at is None:
                self.first_at = time.perf_counter()
            i = ev.get("index", 0)
            b = self.blocks.setdefault(i, {"type": "text", "text": ""})
            d = _as_dict(ev.get("delta")) or {}
            dt = d.get("type")
            if dt == "text_delta":
                b["text"] = (b.get("text") or "") + (d.get("text") or "")
            elif dt == "thinking_delta":
                b["thinking"] = (b.get("thinking") or "") + (d.get("thinking") or "")
            elif dt == "input_json_delta":
                self.partial[i] = self.partial.get(i, "") + (d.get("partial_json") or "")
        elif t == "content_block_stop":
            self._close(ev.get("index", 0))
        elif t == "message_delta":
            d = _as_dict(ev.get("delta")) or {}
            if d.get("stop_reason"):
                self.message["stop_reason"] = d["stop_reason"]
            self.usage.update(dict((k, v) for k, v in (_as_dict(ev.get("usage")) or {}).items() if v is not None))

    def _close(self, i):
        if i not in self.partial:
            return
        raw = self.partial.pop(i)
        if i in self.blocks:
            self.blocks[i]["input"] = _args(raw) if raw else {}

    def result(self):
        for i in list(self.partial.keys()):
            self._close(i)
        out = dict(self.message)
        out["content"] = [self.blocks[k] for k in sorted(self.blocks)]
        out["usage"] = self.usage
        return out


class OpenAIChatAccumulator:
    def __init__(self):
        self.model = None
        self.choices = {}
        self.usage = None
        self.first_at = None

    def add(self, ch):
        ch = _as_dict(ch) or {}
        self.model = ch.get("model") or self.model
        if ch.get("usage"):
            self.usage = _as_dict(ch["usage"])
        for c in ch.get("choices") or []:
            c = _as_dict(c)
            i = c.get("index") or 0
            cur = self.choices.setdefault(i, {"message": {"role": "assistant", "content": ""}, "finish_reason": None})
            d = _as_dict(c.get("delta")) or {}
            if d.get("content"):
                if self.first_at is None:
                    self.first_at = time.perf_counter()
                cur["message"]["content"] += d["content"]
            for t in d.get("tool_calls") or []:
                t = _as_dict(t)
                if self.first_at is None:
                    self.first_at = time.perf_counter()
                calls = cur["message"].setdefault("tool_calls", {})
                x = calls.setdefault(t.get("index") or 0, {"id": t.get("id"), "function": {"name": "", "arguments": ""}})
                if t.get("id"):
                    x["id"] = t["id"]
                f = _as_dict(t.get("function")) or {}
                if f.get("name"):
                    x["function"]["name"] += f["name"]
                if f.get("arguments"):
                    x["function"]["arguments"] += f["arguments"]
            if c.get("finish_reason"):
                cur["finish_reason"] = c["finish_reason"]

    def result(self):
        choices = []
        for i in sorted(self.choices):
            c = self.choices[i]
            calls = c["message"].get("tool_calls")
            if isinstance(calls, dict):
                c["message"]["tool_calls"] = [calls[k] for k in sorted(calls)]
            choices.append(c)
        return {"model": self.model, "choices": choices, "usage": self.usage}


class ResponsesAccumulator:
    def __init__(self):
        self.response = None
        self.first_at = None

    def add(self, ev):
        ev = _as_dict(ev) or {}
        t = ev.get("type") or ""
        if t.endswith(".delta") and self.first_at is None:
            self.first_at = time.perf_counter()
        if t in ("response.created", "response.completed", "response.incomplete", "response.failed") and ev.get("response") is not None:
            self.response = _as_dict(ev["response"])

    def result(self):
        return self.response or {}


def _apply_anthropic(s, res):
    res = _as_dict(res) or {}
    u = _as_dict(res.get("usage")) or {}
    s.set(model=res.get("model") or s.data.get("model"), finish_reason=res.get("stop_reason"))
    s.set_usage(input=u.get("input_tokens"), output=u.get("output_tokens"), cache_read=u.get("cache_read_input_tokens"), cache_write=u.get("cache_creation_input_tokens"))
    s.set_output(anthropic_output(res))


def _apply_openai(s, res):
    res = _as_dict(res) or {}
    u = _as_dict(res.get("usage")) or {}
    cached = (_as_dict(u.get("prompt_tokens_details")) or {}).get("cached_tokens")
    prompt = u.get("prompt_tokens")
    s.set(model=res.get("model") or s.data.get("model"), finish_reason=",".join(c.get("finish_reason") for c in (_as_dict(x) for x in res.get("choices") or []) if c.get("finish_reason")) or None)
    s.set_usage(input=(prompt - (cached or 0)) if prompt is not None else None, output=u.get("completion_tokens"), cache_read=cached, reasoning=(_as_dict(u.get("completion_tokens_details")) or {}).get("reasoning_tokens"))
    s.set_output(openai_output(res))


def _apply_responses(s, res):
    res = _as_dict(res) or {}
    u = _as_dict(res.get("usage")) or {}
    cached = (_as_dict(u.get("input_tokens_details")) or {}).get("cached_tokens")
    prompt = u.get("input_tokens")
    s.set(model=res.get("model") or s.data.get("model"), finish_reason=res.get("status"))
    s.set_usage(input=(prompt - (cached or 0)) if prompt is not None else None, output=u.get("output_tokens"), cache_read=cached, reasoning=(_as_dict(u.get("output_tokens_details")) or {}).get("reasoning_tokens"))
    s.set_output(responses_output(res))


_PARAMS = ("temperature", "max_tokens", "max_completion_tokens", "max_output_tokens", "top_p", "tool_choice", "thinking", "reasoning", "reasoning_effort", "stream")


def _llm_span(name, provider, params, messages):
    attrs = {}
    for k in _PARAMS:
        if params.get(k) is not None:
            attrs["gen_ai.request." + k] = _safe(params[k])
    tools = params.get("tools")
    if tools:
        attrs["blackbox.tools"] = [_get(t, "name") or _get(_get(t, "function"), "name") or _get(t, "type") for t in tools]
        attrs["blackbox.tools_count"] = len(tools)
        try:
            attrs["blackbox.tools_tokens"] = (len(json.dumps(tools, default=_default)) + 3) // 4
        except Exception:
            pass
    s = Span(name, kind="llm", parent=_current.get(), model=params.get("model"), provider=provider, attributes=attrs)
    s.set_input(messages)
    return s


class _SyncStreamProxy:
    def __init__(self, inner, span, acc, apply):
        self._inner = inner
        self._span = span
        self._acc = acc
        self._apply = apply

    def __iter__(self):
        try:
            for ev in self._inner:
                try:
                    self._acc.add(ev)
                except Exception:
                    pass
                yield ev
        except BaseException as e:
            if not isinstance(e, GeneratorExit):
                self._span.error(e)
            self._finish(aborted=isinstance(e, GeneratorExit))
            raise
        self._finish()

    def _finish(self, aborted=False):
        if self._span.ended:
            return
        try:
            self._apply(self._span, self._acc.result())
            if self._acc.first_at is not None:
                self._span.set(ttft_ms=(self._acc.first_at - self._span._t0) * 1000)
            if aborted:
                self._span.set_attributes(**{"blackbox.aborted": True})
        except Exception:
            pass
        self._span.end()

    def __enter__(self):
        if hasattr(self._inner, "__enter__"):
            self._inner.__enter__()
        return self

    def __exit__(self, *a):
        self._finish(aborted=True)
        if hasattr(self._inner, "__exit__"):
            return self._inner.__exit__(*a)
        return False

    def __getattr__(self, item):
        return getattr(self._inner, item)


class _AsyncStreamProxy(_SyncStreamProxy):
    def __iter__(self):
        raise TypeError("use async for")

    async def _agen(self):
        try:
            async for ev in self._inner:
                try:
                    self._acc.add(ev)
                except Exception:
                    pass
                yield ev
        except BaseException as e:
            if not isinstance(e, GeneratorExit):
                self._span.error(e)
            self._finish(aborted=isinstance(e, GeneratorExit))
            raise
        self._finish()

    def __aiter__(self):
        return self._agen()

    async def __aenter__(self):
        if hasattr(self._inner, "__aenter__"):
            await self._inner.__aenter__()
        return self

    async def __aexit__(self, *a):
        self._finish(aborted=True)
        if hasattr(self._inner, "__aexit__"):
            return await self._inner.__aexit__(*a)
        return False


def _instrument(target, method, name, provider, to_messages, apply, make_acc):
    if target is None:
        return
    orig = getattr(target, method, None)
    if orig is None or getattr(orig, "__blackbox__", False):
        return

    def start(kwargs):
        try:
            return _llm_span(name, provider, kwargs, to_messages(kwargs))
        except Exception:
            return None

    if inspect.iscoroutinefunction(orig):

        @functools.wraps(orig)
        async def apatched(*args, **kwargs):
            s = start(kwargs)
            if s is None:
                return await orig(*args, **kwargs)
            try:
                res = await orig(*args, **kwargs)
            except BaseException as e:
                s.error(e)
                s.end()
                raise
            try:
                if kwargs.get("stream"):
                    return _AsyncStreamProxy(res, s, make_acc(), apply)
                apply(s, res)
            except Exception:
                pass
            s.end()
            return res

        apatched.__blackbox__ = True
        setattr(target, method, apatched)
        return

    @functools.wraps(orig)
    def patched(*args, **kwargs):
        s = start(kwargs)
        if s is None:
            return orig(*args, **kwargs)
        try:
            res = orig(*args, **kwargs)
        except BaseException as e:
            s.error(e)
            s.end()
            raise
        try:
            if kwargs.get("stream"):
                return _SyncStreamProxy(res, s, make_acc(), apply)
            apply(s, res)
        except Exception:
            pass
        s.end()
        return res

    patched.__blackbox__ = True
    setattr(target, method, patched)


def wrap_anthropic(client):
    try:
        _instrument(getattr(client, "messages", None), "create", "anthropic.messages", "anthropic", anthropic_messages, _apply_anthropic, AnthropicAccumulator)
        beta = getattr(client, "beta", None)
        _instrument(getattr(beta, "messages", None) if beta is not None else None, "create", "anthropic.messages", "anthropic", anthropic_messages, _apply_anthropic, AnthropicAccumulator)
    except Exception:
        pass
    return client


def wrap_openai(client):
    try:
        chat = getattr(client, "chat", None)
        _instrument(getattr(chat, "completions", None) if chat is not None else None, "create", "openai.chat", "openai", openai_messages, _apply_openai, OpenAIChatAccumulator)
        _instrument(getattr(client, "responses", None), "create", "openai.responses", "openai", responses_messages, _apply_responses, ResponsesAccumulator)
    except Exception:
        pass
    return client
