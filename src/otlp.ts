import protobuf from 'protobufjs';

const PROTO = `
syntax = "proto3";
package otlp;

message AnyValue {
  oneof value {
    string string_value = 1;
    bool bool_value = 2;
    int64 int_value = 3;
    double double_value = 4;
    ArrayValue array_value = 5;
    KeyValueList kvlist_value = 6;
    bytes bytes_value = 7;
  }
}
message ArrayValue { repeated AnyValue values = 1; }
message KeyValueList { repeated KeyValue values = 1; }
message KeyValue { string key = 1; AnyValue value = 2; }
message InstrumentationScope { string name = 1; string version = 2; repeated KeyValue attributes = 3; }
message Resource { repeated KeyValue attributes = 1; }

message ExportTraceServiceRequest { repeated ResourceSpans resource_spans = 1; }
message ResourceSpans { Resource resource = 1; repeated ScopeSpans scope_spans = 2; string schema_url = 3; }
message ScopeSpans { InstrumentationScope scope = 1; repeated Span spans = 2; string schema_url = 3; }
message Span {
  bytes trace_id = 1;
  bytes span_id = 2;
  string trace_state = 3;
  bytes parent_span_id = 4;
  string name = 5;
  int32 kind = 6;
  fixed64 start_time_unix_nano = 7;
  fixed64 end_time_unix_nano = 8;
  repeated KeyValue attributes = 9;
  repeated Event events = 11;
  repeated Link links = 13;
  Status status = 15;
  fixed32 flags = 16;
  message Event { fixed64 time_unix_nano = 1; string name = 2; repeated KeyValue attributes = 3; }
  message Link { bytes trace_id = 1; bytes span_id = 2; string trace_state = 3; repeated KeyValue attributes = 4; }
}
message Status { string message = 2; int32 code = 3; }

message ExportLogsServiceRequest { repeated ResourceLogs resource_logs = 1; }
message ResourceLogs { Resource resource = 1; repeated ScopeLogs scope_logs = 2; string schema_url = 3; }
message ScopeLogs { InstrumentationScope scope = 1; repeated LogRecord log_records = 2; string schema_url = 3; }
message LogRecord {
  fixed64 time_unix_nano = 1;
  int32 severity_number = 2;
  string severity_text = 3;
  AnyValue body = 5;
  repeated KeyValue attributes = 6;
  fixed32 flags = 8;
  bytes trace_id = 9;
  bytes span_id = 10;
  fixed64 observed_time_unix_nano = 11;
  string event_name = 12;
}

message ExportMetricsServiceRequest { repeated ResourceMetrics resource_metrics = 1; }
message ResourceMetrics { Resource resource = 1; repeated ScopeMetrics scope_metrics = 2; string schema_url = 3; }
message ScopeMetrics { InstrumentationScope scope = 1; repeated Metric metrics = 2; string schema_url = 3; }
message Metric {
  string name = 1;
  string description = 2;
  string unit = 3;
  oneof data {
    Gauge gauge = 5;
    Sum sum = 7;
    Histogram histogram = 9;
    ExponentialHistogram exponential_histogram = 10;
    Summary summary = 11;
  }
}
message Gauge { repeated NumberDataPoint data_points = 1; }
message Sum { repeated NumberDataPoint data_points = 1; int32 aggregation_temporality = 2; bool is_monotonic = 3; }
message Histogram { repeated HistogramDataPoint data_points = 1; int32 aggregation_temporality = 2; }
message ExponentialHistogram { repeated ExponentialHistogramDataPoint data_points = 1; int32 aggregation_temporality = 2; }
message Summary { repeated SummaryDataPoint data_points = 1; }
message NumberDataPoint {
  fixed64 start_time_unix_nano = 2;
  fixed64 time_unix_nano = 3;
  double as_double = 4;
  sfixed64 as_int = 6;
  repeated KeyValue attributes = 7;
}
message HistogramDataPoint {
  fixed64 start_time_unix_nano = 2;
  fixed64 time_unix_nano = 3;
  fixed64 count = 4;
  double sum = 5;
  repeated fixed64 bucket_counts = 6;
  repeated double explicit_bounds = 7;
  repeated KeyValue attributes = 9;
  double min = 11;
  double max = 12;
}
message ExponentialHistogramDataPoint {
  repeated KeyValue attributes = 1;
  fixed64 start_time_unix_nano = 2;
  fixed64 time_unix_nano = 3;
  fixed64 count = 4;
  double sum = 5;
  double min = 12;
  double max = 13;
}
message SummaryDataPoint {
  fixed64 start_time_unix_nano = 2;
  fixed64 time_unix_nano = 3;
  fixed64 count = 4;
  double sum = 5;
  repeated KeyValue attributes = 7;
}
`;

const root = protobuf.parse(PROTO, { keepCase: false }).root;
const TraceReq = root.lookupType('otlp.ExportTraceServiceRequest');
const LogsReq = root.lookupType('otlp.ExportLogsServiceRequest');
const MetricsReq = root.lookupType('otlp.ExportMetricsServiceRequest');

export type Attrs = Record<string, unknown>;

export interface RawSpan {
  traceId: string;
  spanId: string;
  parentSpanId: string | null;
  name: string;
  kind: number;
  startNs: number;
  endNs: number | null;
  attributes: Attrs;
  events: { name: string; timeNs: number; attributes: Attrs }[];
  links: { traceId: string; spanId: string; attributes: Attrs }[];
  statusCode: number;
  statusMessage: string | null;
  resource: Attrs;
  scope: string | null;
}

export interface RawLog {
  timeNs: number;
  name: string | null;
  severity: string | null;
  body: unknown;
  attributes: Attrs;
  resource: Attrs;
  traceId: string | null;
  spanId: string | null;
  scope: string | null;
}

export interface RawMetricPoint {
  name: string;
  unit: string | null;
  kind: string;
  timeNs: number;
  value: number;
  attributes: Attrs;
  resource: Attrs;
}

const DECODE_OPTS = { longs: String, enums: Number, bytes: String, defaults: false, arrays: true, objects: true, oneofs: false };

export function decodeTraces(body: Buffer, contentType: string): RawSpan[] {
  const obj = isProto(contentType) ? TraceReq.toObject(TraceReq.decode(body), DECODE_OPTS) : JSON.parse(body.toString('utf8'));
  return flattenTraces(obj);
}

export function decodeLogs(body: Buffer, contentType: string): RawLog[] {
  const obj = isProto(contentType) ? LogsReq.toObject(LogsReq.decode(body), DECODE_OPTS) : JSON.parse(body.toString('utf8'));
  return flattenLogs(obj);
}

export function decodeMetrics(body: Buffer, contentType: string): RawMetricPoint[] {
  const obj = isProto(contentType) ? MetricsReq.toObject(MetricsReq.decode(body), DECODE_OPTS) : JSON.parse(body.toString('utf8'));
  return flattenMetrics(obj);
}

export function encodeTraces(obj: unknown): Uint8Array {
  return TraceReq.encode(TraceReq.fromObject(obj as Record<string, unknown>)).finish();
}

function isProto(ct: string): boolean {
  return /protobuf|octet-stream/i.test(ct || '');
}

type Any = Record<string, any>;

function list(v: unknown): Any[] {
  return Array.isArray(v) ? (v as Any[]) : [];
}

function pick(o: Any | undefined, camel: string, snake: string): any {
  if (!o) return undefined;
  return o[camel] !== undefined ? o[camel] : o[snake];
}

export function normId(v: unknown): string | null {
  if (v === undefined || v === null || v === '') return null;
  const s = String(v);
  let hex: string;
  if (/^[0-9a-fA-F]+$/.test(s) && (s.length === 32 || s.length === 16)) hex = s.toLowerCase();
  else hex = Buffer.from(s, 'base64').toString('hex');
  if (!hex || /^0+$/.test(hex)) return null;
  return hex;
}

function toNs(v: unknown): number {
  if (v === undefined || v === null || v === '') return 0;
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

export function anyValue(v: Any | undefined | null): unknown {
  if (!v || typeof v !== 'object') return v ?? null;
  if ('stringValue' in v || 'string_value' in v) return pick(v, 'stringValue', 'string_value');
  if ('boolValue' in v || 'bool_value' in v) return pick(v, 'boolValue', 'bool_value');
  if ('intValue' in v || 'int_value' in v) {
    const n = Number(pick(v, 'intValue', 'int_value'));
    return Number.isSafeInteger(n) ? n : String(pick(v, 'intValue', 'int_value'));
  }
  if ('doubleValue' in v || 'double_value' in v) return Number(pick(v, 'doubleValue', 'double_value'));
  if ('arrayValue' in v || 'array_value' in v) return list(pick(v, 'arrayValue', 'array_value')?.values).map(anyValue);
  if ('kvlistValue' in v || 'kvlist_value' in v) return kvs(pick(v, 'kvlistValue', 'kvlist_value')?.values);
  if ('bytesValue' in v || 'bytes_value' in v) return pick(v, 'bytesValue', 'bytes_value');
  return null;
}

export function kvs(v: unknown): Attrs {
  const out: Attrs = {};
  for (const kv of list(v)) {
    if (kv && typeof kv.key === 'string') out[kv.key] = anyValue(kv.value);
  }
  return out;
}

function flattenTraces(obj: Any): RawSpan[] {
  const out: RawSpan[] = [];
  for (const rs of list(pick(obj, 'resourceSpans', 'resource_spans'))) {
    const resource = kvs(rs.resource?.attributes);
    for (const ss of list(pick(rs, 'scopeSpans', 'scope_spans') ?? pick(rs, 'instrumentationLibrarySpans', 'instrumentation_library_spans'))) {
      const scope = (ss.scope?.name ?? ss.instrumentationLibrary?.name ?? null) as string | null;
      for (const s of list(ss.spans)) {
        const traceId = normId(pick(s, 'traceId', 'trace_id'));
        const spanId = normId(pick(s, 'spanId', 'span_id'));
        if (!traceId || !spanId) continue;
        const status = s.status ?? {};
        const end = toNs(pick(s, 'endTimeUnixNano', 'end_time_unix_nano'));
        out.push({
          traceId,
          spanId,
          parentSpanId: normId(pick(s, 'parentSpanId', 'parent_span_id')),
          name: String(s.name ?? 'span'),
          kind: typeof s.kind === 'number' ? s.kind : spanKindNum(s.kind),
          startNs: toNs(pick(s, 'startTimeUnixNano', 'start_time_unix_nano')),
          endNs: end || null,
          attributes: kvs(s.attributes),
          events: list(s.events).map((e) => ({
            name: String(e.name ?? ''),
            timeNs: toNs(pick(e, 'timeUnixNano', 'time_unix_nano')),
            attributes: kvs(e.attributes),
          })),
          links: list(s.links).map((l) => ({
            traceId: normId(pick(l, 'traceId', 'trace_id')) ?? '',
            spanId: normId(pick(l, 'spanId', 'span_id')) ?? '',
            attributes: kvs(l.attributes),
          })),
          statusCode: typeof status.code === 'number' ? status.code : statusCodeNum(status.code),
          statusMessage: status.message || null,
          resource,
          scope,
        });
      }
    }
  }
  return out;
}

function spanKindNum(k: unknown): number {
  const m: Record<string, number> = { SPAN_KIND_INTERNAL: 1, SPAN_KIND_SERVER: 2, SPAN_KIND_CLIENT: 3, SPAN_KIND_PRODUCER: 4, SPAN_KIND_CONSUMER: 5 };
  return typeof k === 'string' ? (m[k] ?? 0) : 0;
}

function statusCodeNum(c: unknown): number {
  if (c === 'STATUS_CODE_OK') return 1;
  if (c === 'STATUS_CODE_ERROR') return 2;
  return 0;
}

function flattenLogs(obj: Any): RawLog[] {
  const out: RawLog[] = [];
  for (const rl of list(pick(obj, 'resourceLogs', 'resource_logs'))) {
    const resource = kvs(rl.resource?.attributes);
    for (const sl of list(pick(rl, 'scopeLogs', 'scope_logs'))) {
      const scope = (sl.scope?.name ?? null) as string | null;
      for (const r of list(pick(sl, 'logRecords', 'log_records'))) {
        const attributes = kvs(r.attributes);
        const body = anyValue(r.body);
        const eventName = pick(r, 'eventName', 'event_name') || attributes['event.name'] || null;
        out.push({
          timeNs: toNs(pick(r, 'timeUnixNano', 'time_unix_nano')) || toNs(pick(r, 'observedTimeUnixNano', 'observed_time_unix_nano')) || Date.now() * 1e6,
          name: (eventName as string) ?? (typeof body === 'string' && body.length < 80 ? body : null),
          severity: pick(r, 'severityText', 'severity_text') || null,
          body,
          attributes,
          resource,
          traceId: normId(pick(r, 'traceId', 'trace_id')),
          spanId: normId(pick(r, 'spanId', 'span_id')),
          scope,
        });
      }
    }
  }
  return out;
}

function flattenMetrics(obj: Any): RawMetricPoint[] {
  const out: RawMetricPoint[] = [];
  for (const rm of list(pick(obj, 'resourceMetrics', 'resource_metrics'))) {
    const resource = kvs(rm.resource?.attributes);
    for (const sm of list(pick(rm, 'scopeMetrics', 'scope_metrics'))) {
      for (const m of list(sm.metrics)) {
        const name = String(m.name);
        const unit = m.unit || null;
        const kinds: [string, Any | undefined][] = [
          ['gauge', m.gauge],
          ['sum', m.sum],
          ['histogram', m.histogram],
          ['exponential_histogram', pick(m, 'exponentialHistogram', 'exponential_histogram')],
          ['summary', m.summary],
        ];
        for (const [kind, data] of kinds) {
          if (!data) continue;
          for (const p of list(pick(data, 'dataPoints', 'data_points'))) {
            let value: number;
            if (kind === 'gauge' || kind === 'sum') value = Number(pick(p, 'asDouble', 'as_double') ?? pick(p, 'asInt', 'as_int') ?? 0);
            else value = Number(p.sum ?? 0);
            out.push({
              name,
              unit,
              kind,
              timeNs: toNs(pick(p, 'timeUnixNano', 'time_unix_nano')) || Date.now() * 1e6,
              value,
              attributes: kvs(p.attributes),
              resource,
            });
          }
        }
      }
    }
  }
  return out;
}
