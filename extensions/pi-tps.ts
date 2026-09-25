/**
 * pi-tps.ts
 *
 * Tokens-per-second meter for Pi's footer/status cluster.
 *
 * Measurement
 * -----------
 * For every assistant message, TPS = output tokens (from the message's final
 * `usage`) divided by the wall-clock time the stream was open (`message_start`
 * -> `message_end`). Output tokens include reasoning/thinking tokens, which
 * matches how providers report generation speed.
 *
 * While a message is streaming, a live estimate is published using accumulated
 * text/thinking delta characters at ~4 chars/token, prefixed with `~` to mark
 * it as an estimate. It is replaced by the exact value when the message ends.
 * Aborted or errored messages are discarded and the last exact value is
 * restored.
 *
 * Display
 * -------
 * Publishes `NN t/s` (or `~NN t/s` while estimating) through the generic
 * status-item protocol consumed by the opencode-prompt status row — which
 * replaces the built-in footer, so ctx.ui.setStatus() alone would be invisible
 * there:
 *
 *   `status-item`         { key, text } — set/clear this extension's item
 *   `status-item:request` re-publish the current value on demand
 *
 * ctx.ui.setStatus() is also kept for UIs that render the standard footer.
 *
 * Commands
 * --------
 * /tps — session stats: last/average/min/max TPS and sample count.
 */

import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import type { AssistantMessage } from "@earendil-works/pi-ai";

// Generic status-item protocol (see opencode-prompt for the consumer side).
const STATUS_EVENT = "status-item";
const STATUS_REQUEST_EVENT = "status-item:request";
const STATUS_KEY = "pi-tps";

const CHARS_PER_TOKEN = 4;
const MIN_STREAM_MS = 100; // shorter streams are noise; skip
const LIVE_MIN_STREAM_MS = 500; // don't publish live estimates for the first 500ms
const LIVE_EMIT_INTERVAL_MS = 300;
const MAX_SAMPLES = 200;

interface Sample {
  tps: number;
  tokens: number;
  ms: number;
  model: string | undefined;
  at: number;
}

let piRef: ExtensionAPI | null = null;
let ui: ExtensionContext["ui"] | null = null;

let samples: Sample[] = [];
let lastExactText: string | undefined;

// In-flight streaming state (one assistant message at a time).
let streamStart: number | undefined;
let streamChars = 0;
let streamModel: string | undefined;
let lastLiveEmit = 0;

// ---------------------------------------------------------------------------
// Publishing
// ---------------------------------------------------------------------------

function publish(text: string | undefined): void {
  if (text) lastExactText = text;
  ui?.setStatus?.(STATUS_KEY, text);
  piRef?.events.emit(STATUS_EVENT, { key: STATUS_KEY, text: text ?? null });
}

function fmtTps(tps: number): string {
  const rounded = Math.round(tps);
  return `${rounded} t/s`;
}

// ---------------------------------------------------------------------------
// Streaming measurement
// ---------------------------------------------------------------------------

function beginStream(message: AssistantMessage): void {
  streamStart = Date.now();
  streamChars = 0;
  streamModel = (message as { model?: string }).model;
  lastLiveEmit = 0;
}

function endStream(): void {
  streamStart = undefined;
  streamChars = 0;
  streamModel = undefined;
}

function publishLiveEstimate(): void {
  if (streamStart === undefined) return;
  const elapsed = Date.now() - streamStart;
  if (elapsed < LIVE_MIN_STREAM_MS) return;
  const now = Date.now();
  if (now - lastLiveEmit < LIVE_EMIT_INTERVAL_MS) return;
  lastLiveEmit = now;
  const estTokens = Math.max(1, Math.round(streamChars / CHARS_PER_TOKEN));
  publish(`~${fmtTps(estTokens / (elapsed / 1000))}`);
}

function isUsableStopReason(message: AssistantMessage): boolean {
  const reason = (message as { stopReason?: string }).stopReason;
  return reason !== "aborted" && reason !== "error";
}

function recordFinal(message: AssistantMessage): void {
  const usage = (message as { usage?: { output?: number } }).usage;
  const tokens = usage?.output ?? 0;
  const elapsed = streamStart !== undefined ? Date.now() - streamStart : 0;

  if (!isUsableStopReason(message) || tokens < 1 || elapsed < MIN_STREAM_MS) {
    // Not a measurable generation — restore the last exact reading.
    endStream();
    publish(lastExactText);
    return;
  }

  const tps = tokens / (elapsed / 1000);
  samples.push({
    tps,
    tokens,
    ms: elapsed,
    model: (message as { model?: string }).model,
    at: Date.now(),
  });
  if (samples.length > MAX_SAMPLES) samples.shift();

  endStream();
  publish(fmtTps(tps));
}

function resetForNewSession(): void {
  samples = [];
  lastExactText = undefined;
  endStream();
  publish(undefined);
}

// ---------------------------------------------------------------------------
// Extension factory
// ---------------------------------------------------------------------------

export default function piTps(pi: ExtensionAPI): void {
  piRef = pi;
  pi.events.on(STATUS_REQUEST_EVENT, () => publish(lastExactText));

  pi.on("session_start", (_event, ctx: ExtensionContext) => {
    ui = ctx.ui ?? null;
    resetForNewSession();
  });

  pi.on("message_start", (event) => {
    const message = event.message as { role?: string };
    if (message.role !== "assistant") return;
    beginStream(event.message as AssistantMessage);
  });

  pi.on("message_update", (event) => {
    if (streamStart === undefined) {
      // Missed message_start (e.g. extension loaded mid-stream) — recover.
      const message = event.message as { role?: string };
      if (message.role !== "assistant") return;
      beginStream(event.message as AssistantMessage);
    }
    const ev = event.assistantMessageEvent as { type?: string; delta?: string };
    if (ev.type === "text_delta" || ev.type === "thinking_delta") {
      streamChars += ev.delta?.length ?? 0;
      publishLiveEstimate();
    }
  });

  pi.on("message_end", (event) => {
    const message = event.message as { role?: string };
    if (message.role !== "assistant") return;
    if (streamStart === undefined) return;
    recordFinal(event.message as AssistantMessage);
  });

  pi.on("session_shutdown", () => {
    resetForNewSession();
  });

  pi.registerCommand("tps", {
    description: "Show tokens-per-second stats for this session",
    handler(_args, ctx) {
      ui = ctx.ui ?? null;
      if (samples.length === 0) {
        ctx.ui?.notify?.("pi-tps: no completed assistant turns yet this session", "info");
        return;
      }
      const tpsValues = samples.map((s) => s.tps);
      const avg = tpsValues.reduce((a, b) => a + b, 0) / tpsValues.length;
      const min = Math.min(...tpsValues);
      const max = Math.max(...tpsValues);
      const totalTokens = samples.reduce((a, s) => a + s.tokens, 0);
      const totalMs = samples.reduce((a, s) => a + s.ms, 0);
      const last = samples[samples.length - 1];
      ctx.ui?.notify?.(
        [
          `pi-tps · ${samples.length} turn${samples.length === 1 ? "" : "s"} this session`,
          `last: ${fmtTps(last.tps)} (${last.tokens} tok in ${(last.ms / 1000).toFixed(1)}s)`,
          `avg: ${fmtTps(avg)} · min: ${fmtTps(min)} · max: ${fmtTps(max)}`,
          `overall: ${fmtTps(totalTokens / (totalMs / 1000))} (${totalTokens} tok in ${(totalMs / 1000).toFixed(1)}s)`,
        ].join("\n"),
        "info",
      );
    },
  });
}
