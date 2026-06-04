import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as https from 'https';
import * as http from 'http';
// NOTE: agentTools.ts carries a file-level `// @ts-nocheck`, which suppresses
// emission of its declared types to importers — so `import { ToolDefinition }
// from './agentTools'` resolves to nothing and TS errors with "has no exported
// member 'ToolDefinition'". The interface is tiny and stable, so we declare a
// structurally-identical local copy here to keep this module self-typed.
export interface ToolDefinition {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: object;
  };
}
import {
  MAX_TRANSIENT_RETRIES,
  STREAM_RETRY_BASE_MS,
  STREAM_RETRY_MAX_MS,
  STREAM_CONNECT_TIMEOUT_MS,
  STREAM_IDLE_TIMEOUT_MS,
} from './hardeningConfig';

import { isTransientStreamError } from './messageUtils';
const keepAliveAgent = new https.Agent({ keepAlive: true, maxSockets: 6 });

const CONFIG_PATH = path.join(os.homedir(), '.config', 'qgenie-cli', 'config.toml');
export const API_BASE = process.env['QGENIE_API_BASE'] || 'https://qgenie-api.qualcomm.com/v1';

/**
 * Chat-capable model exposed by the gateway for the current API key.
 * `vision` gates the chat view's image-attach button (false hides it).
 */
export interface AvailableModel {
  id: string;
  label: string;
  vision?: boolean;
}

/** Make a GET request to `urlStr` and resolve with parsed JSON. Rejects on HTTP ≥400 or parse failures. */
function httpsGetJson(urlStr: string, headers: Record<string, string>): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const url = new URL(urlStr);
    const req = https.request({
      hostname: url.hostname,
      port: url.port || 443,
      path: url.pathname,
      method: 'GET',
      headers: { ...headers, 'User-Agent': 'qgenie-skills-vscode/0.4.0' },
      agent: keepAliveAgent,
    }, (res) => {
      let body = '';
      res.on('data', (c: Buffer) => { body += c.toString(); });
      res.on('end', () => {
        if (res.statusCode && res.statusCode >= 400) {
          reject(new Error(`HTTP ${res.statusCode}: ${body.substring(0, 200)}`));
          return;
        }
        try { resolve(JSON.parse(body)); }
        catch (e) { reject(new Error(`Failed to parse response: ${(e as Error).message}`)); }
      });
      res.on('error', reject);
    });
    req.on('error', reject);
    req.setTimeout(15000, () => { req.destroy(new Error('request timeout')); });
    req.end();
  });
}

/** Fetch live chat-capable models from `/v1/models`; sorted by vendor. */
export async function fetchAvailableModels(config: QGenieConfig): Promise<AvailableModel[]> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const parsed: any = await httpsGetJson(`${API_BASE}/models`, {
    'Authorization': `Bearer ${config.apiKey}`,
    'X-Encrypted-Key': config.apiKey,
  });
  const raw: unknown[] = Array.isArray(parsed?.models) ? parsed.models : [];
  const out: AvailableModel[] = [];
  for (const m of raw) {
    // Only chat-capable LLMs (skip embeddings, audio, etc).
    const mt = (m as any)?.model_type;
    if (!mt || mt.modality !== 'Llm' || !mt.is_chat) { continue; }
    const names: string[] = Array.isArray((m as any)?.name) ? (m as any).name : [];
    if (names.length === 0) { continue; }
    // names[0] is the canonical id the chat endpoint expects.
    const id = names[0];
    out.push({ id, label: friendlyLabel(id, names), vision: inferVision(id) });
  }
  // The gateway lists Claude base ids only; the large-context ":1M" entries are
  // request-time variants, not distinct models. Re-inject any known variant
  // whose base id is present so the user's ":1M" selection stays valid.
  mergeContextVariants(out);
  out.sort((a, b) => vendorRank(a.id) - vendorRank(b.id) || a.label.localeCompare(b.label));
  return out;
}

/** The model id with any trailing ":<suffix>" capability flag removed. */
export function baseModelId(id: string): string {
  // Only strip a suffix AFTER the "::" vendor separator so plain ids with no
  // vendor (e.g. self-hosted "pro") are never touched.
  const sep = id.indexOf('::');
  if (sep === -1) { return id; }
  const colon = id.indexOf(':', sep + 2);
  return colon === -1 ? id : id.slice(0, colon);
}

/** Add any AVAILABLE_MODELS variant (e.g. "...:1M") whose base id is in `list`
 *  but whose full variant id is missing, so it remains selectable. */
function mergeContextVariants(list: AvailableModel[]): void {
  const present = new Set(list.map(m => m.id));
  const baseIds = new Set(list.map(m => baseModelId(m.id)));
  for (const variant of AVAILABLE_MODELS) {
    if (variant.id === baseModelId(variant.id)) { continue; }
    if (present.has(variant.id)) { continue; }
    if (baseIds.has(baseModelId(variant.id))) { list.push({ ...variant }); }
  }
}

// ── Model metadata helpers (used by fetchAvailableModels to build AvailableModel[]) ──

function friendlyLabel(id: string, names: string[]): string {
  // For vendor-prefixed ids show the part after "::"; prepend a vendor tag.
  const parts = id.split('::');
  const tail = parts.length > 1 ? parts[1] : id;
  const vendor = parts.length > 1 ? parts[0].replace(/^vertexai$/i, 'gemini').toUpperCase() : '';
  // For short self-hosted ids, append a more descriptive alias if one exists.
  if (!vendor && id.length <= 4 && names.length > 1) {
    const better = names.find(n => n.length > id.length && /^[a-z0-9._-]+$/i.test(n));
    if (better) { return id + ' (' + better + ')'; }
  }
  return vendor ? `${vendor}: ${tail}` : tail;
}

function inferVision(id: string): boolean {
  const lower = id.toLowerCase();
  if (lower.startsWith('anthropic::claude-')) { return true; }
  if (lower.startsWith('azure::gpt-') || lower.startsWith('openai::gpt-')) { return true; }
  if (lower.startsWith('vertexai::gemini-') || lower.startsWith('google::gemini-')) { return true; }
  if (lower.indexOf('-vl-') !== -1 || lower.endsWith('-vl')) { return true; }
  return false;
}

function vendorRank(id: string): number {
  if (id.startsWith('anthropic::')) { return 0; }
  if (id.startsWith('azure::') || id.startsWith('openai::')) { return 1; }
  if (id.startsWith('vertexai::') || id.startsWith('google::')) { return 2; }
  return 3; // self-hosted / open-weights
}

// ═══════════════════════════════════════════════════════════════════════════════
// FALLBACK MODEL LIST — used when the live `/v1/models` endpoint is unreachable.
// Authoritative source is `fetchAvailableModels()`; refreshed 2026-05-27.
// ═══════════════════════════════════════════════════════════════════════════════

export const AVAILABLE_MODELS: AvailableModel[] = [
  // ── Anthropic Claude (all current Claude models accept images) ──
  { id: 'anthropic::claude-4-6-sonnet:1M', label: 'Claude 4.6 Sonnet (1M ctx)',  vision: true },
  { id: 'anthropic::claude-4-6-sonnet',    label: 'Claude 4.6 Sonnet',           vision: true },
  { id: 'anthropic::claude-4-5-sonnet',    label: 'Claude 4.5 Sonnet',           vision: true },
  { id: 'anthropic::claude-4-6-opus:1M',   label: 'Claude 4.6 Opus (1M ctx)',    vision: true },
  { id: 'anthropic::claude-4-6-opus',      label: 'Claude 4.6 Opus',             vision: true },
  { id: 'anthropic::claude-4-7-opus',      label: 'Claude 4.7 Opus',             vision: true },
  { id: 'anthropic::claude-4-8-opus',      label: 'Claude 4.8 Opus',             vision: true },

  // ── Azure GPT-5 family (all OpenAI multimodal-capable) ──
  { id: 'azure::gpt-5',                    label: 'GPT-5',                       vision: true },
  { id: 'azure::gpt-5.1',                  label: 'GPT-5.1',                     vision: true },
  { id: 'azure::gpt-5.2',                  label: 'GPT-5.2',                     vision: true },
  { id: 'azure::gpt-5.4',                  label: 'GPT-5.4',                     vision: true },
  { id: 'azure::gpt-5.4-mini',             label: 'GPT-5.4 Mini',                vision: true },
  { id: 'azure::gpt-5.4-nano',             label: 'GPT-5.4 Nano',                vision: true },
  { id: 'azure::gpt-5.5',                  label: 'GPT-5.5',                     vision: true },

  // ── Google / VertexAI Gemini (all current Gemini models accept images) ──
  { id: 'vertexai::gemini-3.5-flash',      label: 'Gemini 3.5 Flash',            vision: true },
  { id: 'vertexai::gemini-3.1-pro-preview',label: 'Gemini 3.1 Pro (preview)',    vision: true },
  { id: 'vertexai::gemini-3.1-flash-lite', label: 'Gemini 3.1 Flash Lite',       vision: true },
  { id: 'vertexai::gemini-3-flash-preview',label: 'Gemini 3 Flash (preview)',    vision: true },
  { id: 'vertexai::gemini-2.5-pro',        label: 'Gemini 2.5 Pro',              vision: true },
  { id: 'vertexai::gemini-2.5-flash',      label: 'Gemini 2.5 Flash',            vision: true },
  { id: 'vertexai::gemini-2.0-flash-001',  label: 'Gemini 2.0 Flash',            vision: true },

  // ── Self-hosted / open-weights (text + vision where applicable) ──
  { id: 'qwen2.5-vl-3b-instruct',          label: 'Qwen2.5-VL 3B (vision)',      vision: true },
  { id: 'pro',                             label: 'Qwen3 235B Thinking ("pro")', vision: false },
  { id: 'QGenie-Coder',                    label: 'QGenie Coder (gpt-oss-120b)', vision: false },
  { id: 'codewise_instruct',               label: 'Qwen3 Coder 30B',             vision: false },
  { id: 'qwen3-4b-instruct',               label: 'Qwen3 4B Instruct',           vision: false },
];

export interface QGenieConfig {
  apiKey: string;
  model: string;
  maxTokens: number;
}

export function loadQGenieConfig(): QGenieConfig {
  let apiKey = process.env['QGENIE_API_KEY'] || '';
  let model = 'anthropic::claude-4-6-sonnet:1M';
  let maxTokens = 16000;

  try {
    const content = fs.readFileSync(CONFIG_PATH, 'utf8');
    const keyMatch = content.match(/^api_key\s*=\s*"([^"]+)"/m);
    const modelMatch = content.match(/^default_model\s*=\s*"([^"]+)"/m);
    const tokensMatch = content.match(/^max_tokens\s*=\s*(\d+)/m);
    if (keyMatch) { apiKey = keyMatch[1]; }
    if (modelMatch) { model = modelMatch[1]; }
    if (tokensMatch) { maxTokens = parseInt(tokensMatch[1], 10); }
  } catch {
    // config file absent or unreadable — use defaults
  }

  return { apiKey, model, maxTokens };
}

/** Persist a subset of the QGenie config to ~/.config/qgenie-cli/config.toml.
 *  Updates only the keys present in `partial`, preserving every other line. */
export function saveQGenieConfig(partial: Partial<QGenieConfig>): QGenieConfig {
  let content = '';
  try {
    content = fs.readFileSync(CONFIG_PATH, 'utf8');
  } catch {
    // file doesn't exist yet — start from empty
  }

  const upsert = (src: string, tomlLine: string, matcher: RegExp): string => {
    if (matcher.test(src)) {
      return src.replace(matcher, tomlLine);
    }
    const sep = src.length === 0 || src.endsWith('\n') ? '' : '\n';
    return src + sep + tomlLine + '\n';
  };

  if (partial.apiKey !== undefined) {
    content = upsert(content, `api_key = "${partial.apiKey}"`, /^api_key\s*=\s*"[^"]*"/m);
  }
  if (partial.model !== undefined) {
    content = upsert(content, `default_model = "${partial.model}"`, /^default_model\s*=\s*"[^"]*"/m);
  }
  if (partial.maxTokens !== undefined) {
    content = upsert(content, `max_tokens = ${partial.maxTokens}`, /^max_tokens\s*=\s*\d+/m);
  }

  const dir = path.dirname(CONFIG_PATH);
  try { fs.mkdirSync(dir, { recursive: true }); } catch { /* already exists */ }
  fs.writeFileSync(CONFIG_PATH, content, { mode: 0o600 });

  return loadQGenieConfig();
}

/** Mask an API key for display, keeping a short prefix/suffix. */
export function maskApiKey(key: string): string {
  if (!key) { return '(not set)'; }
  if (key.length <= 8) { return '••••'; }
  return `${key.slice(0, 4)}…${key.slice(-4)} (${key.length} chars)`;
}

/** Probe the gateway with `apiKey`; resolves with the count of visible chat models. */
export function validateApiKey(apiKey: string): Promise<number> {
  return fetchAvailableModels({ apiKey, model: '', maxTokens: 0 }).then((m) => m.length);
}

/** Path to the QGenie CLI config file (exported for display in the UI). */
export const QGENIE_CONFIG_PATH = CONFIG_PATH;

export interface ToolCall {
  id: string;
  type: 'function';
  function: {
    name: string;
    arguments: string;
  };
}

/** One part of a multimodal body — OpenAI-compatible across vendors. */
export type ChatContentPart =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string; detail?: 'low' | 'high' | 'auto' } };

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  /** string for text, ChatContentPart[] for multimodal, null for tool-call assistant msgs. */
  content: string | ChatContentPart[] | null;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
  name?: string;
}

export interface StreamChunk {
  delta: string;
  done: boolean;
  error?: string;
  finishReason?: string;
  toolCallDelta?: {
    index: number;
    id?: string;
    name?: string;
    argumentsDelta?: string;
  };
  usage?: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
  };
}

export function streamChatCompletion(
  messages: ChatMessage[],
  config: QGenieConfig,
  onChunk: (chunk: StreamChunk) => void,
  signal?: AbortSignal,
  tools?: ToolDefinition[]
): void {
  // Short-circuit a pre-aborted signal so callers always get exactly one terminal chunk.
  if (signal?.aborted) {
    onChunk({ delta: '', done: true, error: 'Cancelled before request sent' });
    return;
  }

  const bodyObj: Record<string, unknown> = {
    model: config.model,
    messages,
    max_tokens: config.maxTokens,
    stream: true,
    // Opt in to the final usage chunk (prompt/completion tokens) so the TOKENS bar updates.
    stream_options: { include_usage: true },
  };

  if (tools && tools.length > 0) {
    bodyObj['tools'] = tools;
    bodyObj['tool_choice'] = 'auto';
  }

  const body = JSON.stringify(bodyObj);

  // ── Network-resilience: connection/idle deadlines come from hardeningConfig ──
  // so the streaming layer agrees with the orchestration layer on the same
  // bounds. STREAM_CONNECT_TIMEOUT_MS bounds time-to-first-headers; once headers
  // arrive STREAM_IDLE_TIMEOUT_MS bounds the gap between data chunks.
  const CONNECT_MS = STREAM_CONNECT_TIMEOUT_MS;
  const IDLE_MS = STREAM_IDLE_TIMEOUT_MS;

  // RESTART SEMANTIC (correctness rule): we only retry a transient connection /
  // first-byte failure. The moment ANY assistant content/tool/usage chunk has
  // been emitted for an attempt, that attempt is "committed" — retrying would
  // duplicate/garble already-streamed output, so we surface the error instead.
  // `attempt` is the 0-based retry counter; the loop is capped at
  // MAX_TRANSIENT_RETRIES total attempts before the last error is surfaced.
  let attempt = 0;
  // Per-process terminal guard (across attempts): once a real terminal chunk
  // (done:true) has been emitted to the caller, never emit another.
  let finished = false;

  // The `req`, `onAbort`, `idleTimer` and `connectTimer` are re-created per
  // attempt; declared with `let` so the per-attempt closures can rebind them.
  let req: http.ClientRequest;
  let idleTimer: NodeJS.Timeout | null = null;
  let connectTimer: NodeJS.Timeout | null = null;
  // True once the current attempt emitted any content (delta/tool/usage). Reset
  // at the start of each attempt; gates whether a failure may be retried.
  let emittedThisAttempt = false;

  const url = new URL(`${API_BASE}/chat/completions`);

  const clearIdleWatchdog = (): void => {
    if (idleTimer) { clearTimeout(idleTimer); idleTimer = null; }
  };
  const clearConnectTimer = (): void => {
    if (connectTimer) { clearTimeout(connectTimer); connectTimer = null; }
  };

  // Single-shot terminal-chunk guard: suppress any done:true after the first,
  // so overlapping termination paths (res 'end' + abort) only fire once.
  const emit = (chunk: StreamChunk): void => {
    if (chunk.done && finished) { return; }
    if (!chunk.done) { emittedThisAttempt = true; }
    onChunk(chunk);
    if (chunk.done) { finished = true; }
    if (!chunk.done) { armIdleWatchdog(); }
  };

  // Idle-stream watchdog: if the gateway stops sending data mid-stream
  // (no Node http timer would rescue us), abort the request after IDLE_MS.
  const armIdleWatchdog = (): void => {
    clearIdleWatchdog();
    idleTimer = setTimeout(() => {
      idleTimer = null;
      try { req.destroy(new Error('idle stream timeout')); } catch { /* ignore */ }
      emit({ delta: '', done: true, error: `stream idle for ${Math.round(IDLE_MS / 1000)}s — server stopped sending data` });
    }, IDLE_MS);
  };

  // Cleanup: detach abort listener + clear ALL timers from every terminal path.
  const onAbort = (): void => {
    clearIdleWatchdog();
    clearConnectTimer();
    try { req.destroy(); } catch { /* ignore */ }
    emit({ delta: '', done: true, error: 'Cancelled' });
  };
  const cleanup = (): void => {
    clearIdleWatchdog();
    clearConnectTimer();
    if (signal) { signal.removeEventListener('abort', onAbort); }
  };

  /** Shared terminal-path helper: stop watchdogs, emit final chunk, clean up. */
  const terminate = (error?: string): void => {
    clearIdleWatchdog();
    clearConnectTimer();
    emit({ delta: '', done: true, ...(error ? { error } : {}) });
    cleanup();
  };

  /** Parse a Retry-After header (delta-seconds OR HTTP-date) into milliseconds.
   *  Returns null when the header is absent/unparseable so the caller falls
   *  back to exponential backoff. */
  const parseRetryAfter = (raw: string | string[] | undefined): number | null => {
    if (!raw) { return null; }
    const v = Array.isArray(raw) ? raw[0] : raw;
    const secs = Number(v);
    if (Number.isFinite(secs)) { return Math.max(0, secs * 1000); }
    const when = Date.parse(v);
    if (!Number.isNaN(when)) { return Math.max(0, when - Date.now()); }
    return null;
  };

  /** Decide a retry delay (ms) for a failed attempt, honoring Retry-After on
   *  429/503, otherwise exponential backoff capped at STREAM_RETRY_MAX_MS. */
  const backoffMs = (statusCode: number | undefined, retryAfter: number | null): number => {
    if ((statusCode === 429 || statusCode === 503) && retryAfter !== null) {
      return Math.min(STREAM_RETRY_MAX_MS, retryAfter);
    }
    return Math.min(STREAM_RETRY_MAX_MS, STREAM_RETRY_BASE_MS * 2 ** attempt);
  };

  /** Terminal failure for one attempt: retry if transient AND nothing was
   *  emitted yet this attempt AND the cap is not exhausted; else surface. */
  const failAttempt = (error: string, statusCode?: number, retryAfter?: number | null): void => {
    clearIdleWatchdog();
    clearConnectTimer();
    // Only restart when this attempt produced NO output (see RESTART SEMANTIC).
    const canRetry = !signal?.aborted
      && !emittedThisAttempt
      && isTransientStreamError(error)
      && attempt + 1 < MAX_TRANSIENT_RETRIES;
    if (!canRetry) {
      // Cap exhausted or non-retryable: surface the last error as terminal.
      terminate(error);
      return;
    }
    const delay = backoffMs(statusCode, retryAfter ?? null);
    attempt++;
    setTimeout(() => {
      if (signal?.aborted || finished) { terminate('Cancelled'); return; }
      startAttempt();
    }, delay);
  };

  const startAttempt = (): void => {
    emittedThisAttempt = false;

    const options: https.RequestOptions = {
      hostname: url.hostname,
      port: url.port || 443,
      path: url.pathname,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${config.apiKey}`,
        'X-Encrypted-Key': config.apiKey,
        'User-Agent': 'qgenie-skills-vscode/0.4.0',
        'Content-Length': Buffer.byteLength(body),
      },
      agent: keepAliveAgent,
      // Node 18+ uses this to wire AbortSignal natively; older versions ignore unknown options.
      ...(signal ? { signal } : {}),
    };

    // Connection timeout: abort if headers/first byte don't arrive in time.
    // Cleared the moment a response is received (see res handler below).
    connectTimer = setTimeout(() => {
      connectTimer = null;
      try { req.destroy(new Error('connect timeout')); } catch { /* ignore */ }
      failAttempt(`connection timeout (${Math.round(CONNECT_MS / 1000)}s with no response)`);
    }, CONNECT_MS);

    req = https.request(options, (res) => {
      // Headers arrived → connection established; stop the connect timer.
      clearConnectTimer();

      if (res.statusCode && res.statusCode >= 400) {
        const status = res.statusCode;
        const retryAfter = parseRetryAfter(res.headers['retry-after']);
        let errBody = '';
        res.on('data', (c: Buffer) => { errBody += c.toString(); });
        res.on('end', () => { failAttempt(`HTTP ${status}: ${errBody.substring(0, 300)}`, status, retryAfter); });
        res.on('error', (err) => { failAttempt(err.message, status, retryAfter); });
        return;
      }

      res.setEncoding('utf8');

      let buffer = '';

      // Arm idle watchdog on response (headers alone don't count as data).
      armIdleWatchdog();

      res.on('data', (chunk: string) => {
      armIdleWatchdog();
      if (signal?.aborted) { try { req.destroy(); } catch { /* ignore */ } return; }
      buffer += chunk;
      // Incremental newline parsing — avoids re-splitting the entire buffer on every chunk.
      let newlineIdx: number;
      while ((newlineIdx = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, newlineIdx);
        buffer = buffer.slice(newlineIdx + 1);
        const trimmed = line.trim();
        if (!trimmed || !trimmed.startsWith('data: ')) { continue; }
        const data = trimmed.slice(6);
        if (data === '[DONE]') {
          terminate();
          return;
        }
        try {
          const parsed = JSON.parse(data);

          // include_usage emits a final chunk with empty `choices` and only `usage`.
          // Process this BEFORE the choices early-exit so the TOKENS bar updates.
          if (parsed?.usage) {
            emit({
              delta: '',
              done: false,
              usage: {
                promptTokens: parsed.usage.prompt_tokens || 0,
                completionTokens: parsed.usage.completion_tokens || 0,
                totalTokens: parsed.usage.total_tokens || 0,
              },
            });
          }

          const choice = parsed?.choices?.[0];
          if (!choice) { continue; }

          const finishReason = choice.finish_reason;
          const delta = choice.delta;

          if (delta?.content) {
            emit({ delta: delta.content, done: false });
          }

          if (delta?.tool_calls) {
            for (const tc of delta.tool_calls) {
              emit({
                delta: '',
                done: false,
                toolCallDelta: {
                  index: tc.index ?? 0,
                  id: tc.id,
                  name: tc.function?.name,
                  argumentsDelta: tc.function?.arguments,
                },
              });
            }
          }

          if (finishReason) {
            emit({ delta: '', done: false, finishReason });
          }
        } catch {
          // skip malformed chunks
        }
      } // end while (incremental newline parsing)
    });

    res.on('end', () => { terminate(); });
    res.on('error', (err) => { terminate(err.message); });
    });

    // A pre-response socket/network error (ECONNRESET, ETIMEDOUT, etc.) is a
    // connection failure → eligible for retry via failAttempt.
    req.on('error', (err: Error) => {
      clearConnectTimer();
      // If output already started this attempt, failAttempt will surface
      // (not retry) per the RESTART SEMANTIC above.
      failAttempt(err.message);
    });

    req.write(body);
    req.end();
  };

  if (signal) {
    signal.addEventListener('abort', onAbort, { once: true });
  }

  // Kick off the first attempt; failAttempt drives the bounded retry loop.
  startAttempt();
}


