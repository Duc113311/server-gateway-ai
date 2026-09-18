import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'fs';
import { dirname, resolve } from 'path';
import { config } from '../config';
import { log } from '../log';

/**
 * One served request, as the dashboard shows it.
 *
 * Deliberately flat and JSON-safe: the file is append-only JSONL, so a crash
 * mid-write costs at most the last line, and a damaged line is skipped on load
 * rather than taking the whole history with it.
 */
export interface RequestRecord {
  id: string;
  /** Epoch ms. */
  ts: number;
  uid: string;
  feature: 'chat' | 'image' | 'video' | 'translate';
  provider: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  latencyMs: number;
  status: 'ok' | 'error';
  /** The gateway's own error code, when status is 'error'. */
  errorCode?: string;
  /** Whether the reply was streamed. */
  stream?: boolean;
  locale?: string;
  /** The user's last message. Omitted entirely when ADMIN_LOG_PROMPTS=false. */
  prompt?: string;
  /** Opening of the reply, for scanning the table without opening each row. */
  replyPreview?: string;
}

/** Newest first. The dashboard never wants the oldest page. */
let entries: RequestRecord[] = [];
let filePath = '';
let ready = false;

function truncate(s: string, max: number): string {
  return s.length <= max ? s : `${s.slice(0, max)}…`;
}

/**
 * Loads history into memory once, at first use.
 *
 * A corrupt line is dropped with a warning rather than thrown: losing one
 * request from a report is a far better failure than a gateway that will not
 * boot because of a half-written log line.
 */
function init(): void {
  if (ready) return;
  ready = true;
  filePath = resolve(config.adminLogPath);

  try {
    mkdirSync(dirname(filePath), { recursive: true });
  } catch {
    // Directory already exists, or the path is not writable — the append below
    // reports the real problem.
  }

  if (!existsSync(filePath)) return;

  let damaged = 0;
  const loaded: RequestRecord[] = [];
  for (const line of readFileSync(filePath, 'utf8').split('\n')) {
    const trimmed = line.trim();
    if (trimmed === '') continue;
    try {
      loaded.push(JSON.parse(trimmed) as RequestRecord);
    } catch {
      damaged++;
    }
  }

  loaded.sort((a, b) => b.ts - a.ts);
  entries = loaded.slice(0, config.adminLogMaxEntries);
  log.info(
    `request log loaded (${entries.length} entries` +
      `${damaged > 0 ? `, ${damaged} damaged lines skipped` : ''})`,
  );
}

/**
 * Records one served request.
 *
 * Never throws: a logging failure must not turn a successful chat into a 500,
 * so a write error is reported once and the request still returns.
 */
export function record(
  entry: Omit<RequestRecord, 'id' | 'ts'> & { ts?: number },
): void {
  init();

  const full: RequestRecord = {
    ...entry,
    id: `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`,
    ts: entry.ts ?? Date.now(),
  };

  // Prompts are the sensitive part of this file. When they are off, the field
  // is removed rather than blanked, so the record cannot be mistaken for one
  // whose prompt happened to be empty.
  if (!config.adminLogPrompts) {
    delete full.prompt;
    delete full.replyPreview;
  } else {
    if (full.prompt) full.prompt = truncate(full.prompt, config.adminLogPromptChars);
    if (full.replyPreview) full.replyPreview = truncate(full.replyPreview, 400);
  }

  entries.unshift(full);
  if (entries.length > config.adminLogMaxEntries) entries.pop();

  try {
    appendFileSync(filePath, `${JSON.stringify(full)}\n`, 'utf8');
  } catch (e) {
    log.warn(`request log write failed: ${(e as Error).message}`);
  }
}

export interface LogQuery {
  /** Epoch ms bounds, both optional. */
  from?: number;
  to?: number;
  uid?: string;
  feature?: string;
  model?: string;
  status?: string;
  /** Case-insensitive substring of the prompt or the reply preview. */
  search?: string;
  limit?: number;
  offset?: number;
}

function matches(e: RequestRecord, q: LogQuery): boolean {
  if (q.from !== undefined && e.ts < q.from) return false;
  if (q.to !== undefined && e.ts > q.to) return false;
  if (q.uid && !e.uid.toLowerCase().includes(q.uid.toLowerCase())) return false;
  if (q.feature && e.feature !== q.feature) return false;
  if (q.model && !e.model.toLowerCase().includes(q.model.toLowerCase())) return false;
  if (q.status && e.status !== q.status) return false;
  if (q.search) {
    const needle = q.search.toLowerCase();
    const hay = `${e.prompt ?? ''}\n${e.replyPreview ?? ''}`.toLowerCase();
    if (!hay.includes(needle)) return false;
  }
  return true;
}

export interface LogPage {
  total: number;
  entries: RequestRecord[];
}

export function query(q: LogQuery): LogPage {
  init();
  const hits = entries.filter((e) => matches(e, q));
  const offset = Math.max(0, q.offset ?? 0);
  const limit = Math.min(Math.max(1, q.limit ?? 50), 500);
  return { total: hits.length, entries: hits.slice(offset, offset + limit) };
}

export function byId(id: string): RequestRecord | null {
  init();
  return entries.find((e) => e.id === id) ?? null;
}

export interface Bucket {
  key: string;
  requests: number;
  inputTokens: number;
  outputTokens: number;
}

export interface Stats {
  requests: number;
  errors: number;
  inputTokens: number;
  outputTokens: number;
  uniqueUsers: number;
  avgLatencyMs: number;
  p95LatencyMs: number;
  /** One bucket per hour across the queried window, oldest first. */
  byHour: Bucket[];
  byModel: Bucket[];
  byFeature: Bucket[];
  byUser: Bucket[];
}

function tally(
  hits: RequestRecord[],
  keyOf: (e: RequestRecord) => string,
  sort = true,
): Bucket[] {
  const map = new Map<string, Bucket>();
  for (const e of hits) {
    const key = keyOf(e);
    let b = map.get(key);
    if (!b) {
      b = { key, requests: 0, inputTokens: 0, outputTokens: 0 };
      map.set(key, b);
    }
    b.requests++;
    b.inputTokens += e.inputTokens;
    b.outputTokens += e.outputTokens;
  }
  const out = [...map.values()];
  return sort ? out.sort((a, b) => b.requests - a.requests) : out;
}

/** Local-time hour key, so "khung giờ" matches the operator's own clock. */
function hourKey(ts: number): string {
  const d = new Date(ts);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:00`;
}

export function stats(q: LogQuery): Stats {
  init();
  const hits = entries.filter((e) => matches(e, q));

  const latencies = hits.map((e) => e.latencyMs).sort((a, b) => a - b);
  const sum = latencies.reduce((n, v) => n + v, 0);

  return {
    requests: hits.length,
    errors: hits.filter((e) => e.status === 'error').length,
    inputTokens: hits.reduce((n, e) => n + e.inputTokens, 0),
    outputTokens: hits.reduce((n, e) => n + e.outputTokens, 0),
    uniqueUsers: new Set(hits.map((e) => e.uid)).size,
    avgLatencyMs: latencies.length ? Math.round(sum / latencies.length) : 0,
    // Nearest-rank p95: with a handful of requests a mean hides the one slow
    // call that the user actually noticed.
    p95LatencyMs: latencies.length
      ? latencies[Math.min(latencies.length - 1, Math.ceil(latencies.length * 0.95) - 1)]
      : 0,
    byHour: tally(hits, (e) => hourKey(e.ts), false).sort((a, b) =>
      a.key < b.key ? -1 : 1,
    ),
    byModel: tally(hits, (e) => `${e.provider}/${e.model}`),
    byFeature: tally(hits, (e) => e.feature),
    byUser: tally(hits, (e) => e.uid),
  };
}

/** Distinct values for the dashboard's filter dropdowns. */
export function facets(): { models: string[]; features: string[]; users: string[] } {
  init();
  return {
    models: [...new Set(entries.map((e) => `${e.provider}/${e.model}`))].sort(),
    features: [...new Set(entries.map((e) => e.feature))].sort(),
    users: [...new Set(entries.map((e) => e.uid))].sort().slice(0, 500),
  };
}

/**
 * Drops entries past the retention window, in memory and on disk.
 *
 * The file is rewritten through a temporary path and renamed, so an
 * interrupted prune leaves the previous history intact rather than a truncated
 * one.
 */
export function pruneRequestLog(now = Date.now()): void {
  init();
  if (config.adminLogRetentionDays <= 0) return;

  const cutoff = now - config.adminLogRetentionDays * 24 * 60 * 60 * 1000;
  const kept = entries.filter((e) => e.ts >= cutoff);
  if (kept.length === entries.length) return;

  const dropped = entries.length - kept.length;
  entries = kept;

  try {
    const tmp = `${filePath}.tmp`;
    writeFileSync(tmp, kept.map((e) => `${JSON.stringify(e)}\n`).join(''), 'utf8');
    renameSync(tmp, filePath);
    log.info(`request log pruned (${dropped} entries past retention)`);
  } catch (e) {
    log.warn(`request log prune failed: ${(e as Error).message}`);
  }
}
