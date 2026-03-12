#!/usr/bin/env bun
/**
 * @module doubt-gate
 *
 * Claude Code **Stop hook** that detects uncertainty in the agent's final
 * assistant message. When doubt keywords (`likely`, `maybe`, `might`, …) are
 * found outside of code blocks and blockquotes, the hook blocks the stop and
 * instructs the agent to add logging, assertions, or other verification before
 * concluding — ensuring root-cause certainty rather than speculation.
 *
 * ## Hook API contract
 *
 * Registered in `hooks.json` under `hooks.Stop`. Claude Code pipes a JSON
 * StopHookInput blob to stdin. The hook prints a JSON
 * `{ decision: "block", reason: string }` to stdout to prevent the stop, or
 * exits silently (no output) to allow it.
 *
 * A `stop_hook_active` guard in the input prevents infinite blocking — if the
 * hook already fired once for this turn the stop is always allowed.
 *
 * ## Configuration
 *
 * | Env var                  | Values                        | Default              |
 * |--------------------------|-------------------------------|----------------------|
 * | `DOUBT_GATE_LOG_LEVEL`   | `off` · `info` · `debug`     | `off`                |
 * | `DOUBT_GATE_LOG_PATH`    | file path                     | `/tmp/doubt-gate.log`|
 */
import { appendFileSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import type { StopHookInput, SyncHookJSONOutput } from "@anthropic-ai/claude-agent-sdk";

export const SCHEMA_VERSION = "1.0.0";
export const PLUGIN_VERSION = "1.0.0";

export const DOUBT_PATTERN =
  /\b(likely|maybe|might|probably|possibly|not sure|not certain|uncertain|unclear|could be|appears to|seems like|I think|I believe|I suspect|it's possible|hard to say)\b/gi;

type LogLevel = "off" | "info" | "debug";

interface TraceEntry {
  schema_version: string;
  plugin_version: string;
  timestamp: string;
  event: string;
  level: "info" | "debug";
  session?: string;
  input_hash?: string;
  mode?: string;
  duration_ms?: number;
  keyword?: string | null;
  confidence?: number;
  decision?: string;
  stripped?: string;
  matches?: string[];
}

interface AnalysisResult {
  confidence: number;
  unique: string[];
  keywordList: string;
  stripped: string;
  matches: string[];
}

interface BlockResult extends SyncHookJSONOutput {
  decision: "block";
  reason: string;
  schema_version: string;
  plugin_version: string;
  mode: string;
  duration_ms: number;
  input_hash: string;
}

interface CheckOutput {
  decision: "block" | "allow" | "error";
  reasons?: string[];
  confidence?: number;
  error?: string;
  message?: string;
  schema_version: string;
  plugin_version: string;
  mode: "check";
  duration_ms: number;
  input_hash: string;
}

const LOG_PATH = process.env.DOUBT_GATE_LOG_PATH ?? "/tmp/doubt-gate.log";

/** Compute first 12 hex chars of sha256 of raw input. */
export function computeInputHash(raw: string): string {
  return createHash("sha256").update(raw).digest("hex").slice(0, 12);
}

/** Read the configured log level from DOUBT_GATE_LOG_LEVEL env var. Defaults to 'off'. */
export function getLogLevel(): LogLevel {
  const raw = (process.env.DOUBT_GATE_LOG_LEVEL ?? "").trim().toLowerCase();
  if (raw === "info" || raw === "debug") return raw;
  return "off";
}

/** Strip fenced code blocks, inline backtick spans, and blockquoted lines so keywords inside don't false-positive. */
export function stripCodeBlocks(text: string): string {
  let result = text.replace(/```[\s\S]*?```/g, "");
  result = result.replace(/`[^`]*`/g, "");
  result = result.replace(/^>.*$/gm, "");
  return result;
}

/** Returns true if the given entry level should be emitted at the current log level. */
function shouldLog(entryLevel: "info" | "debug", configLevel: LogLevel): boolean {
  if (configLevel === "off") return false;
  if (configLevel === "debug") return true;
  return entryLevel === "info";
}

/** Build a base trace event with common fields. */
function makeTrace(overrides: Partial<TraceEntry>): TraceEntry {
  return {
    schema_version: SCHEMA_VERSION,
    plugin_version: PLUGIN_VERSION,
    timestamp: new Date().toISOString(),
    event: "",
    level: "info",
    ...overrides,
  };
}

/**
 * Append a structured JSONL trace event to the log file.
 * Respects DOUBT_GATE_LOG_LEVEL — entries are silently dropped when the
 * configured level is too low.
 */
export function emitLog(entry: TraceEntry, configLevel?: LogLevel): void {
  const level = configLevel ?? getLogLevel();
  if (!shouldLog(entry.level, level)) return;
  try {
    appendFileSync(LOG_PATH, JSON.stringify(entry) + "\n");
  } catch {}
}

/**
 * Parse a raw JSON string into a StopHookInput object.
 * Returns the parsed object on success, or null if the input is not valid JSON.
 */
export function parseInput(raw: string): StopHookInput | null {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/**
 * Scan the input for doubt keywords outside of code blocks and blockquotes.
 * Returns a structured analysis result with match details, or null if no
 * doubt was detected (or the stop_hook_active guard is set).
 */
export function analyze(input: StopHookInput): AnalysisResult | null {
  if (input.stop_hook_active) {
    return null;
  }

  const message = input.last_assistant_message ?? "";
  const stripped = stripCodeBlocks(message);
  const matches = [...stripped.matchAll(DOUBT_PATTERN)];
  const confidence = matches.length;

  if (confidence === 0) {
    return null;
  }

  const unique = [...new Set(matches.map((m) => m[0].toLowerCase()))];
  const keywordList = unique.map((k) => `"${k}"`).join(", ");

  return {
    confidence,
    unique,
    keywordList,
    stripped,
    matches: matches.map((m) => m[0]),
  };
}

/**
 * Write a hook decision object to stdout as a JSON line.
 * If result is null/undefined, nothing is written (allowing the stop).
 */
export function emitHookDecision(result: BlockResult | null): void {
  if (result) {
    console.log(JSON.stringify(result));
  }
}

/**
 * Full evaluation pipeline: analyze input and emit JSONL decision traces.
 * This is the primary entry point used in hook mode.
 */
export function evaluate(input: StopHookInput, rawInput: string): BlockResult | null {
  const startMs = performance.now();
  const level = getLogLevel();
  const inputHash = computeInputHash(rawInput);
  const mode = "hook";

  // Trace: invoke
  emitLog(makeTrace({ event: "invoke", level: "info", session: input.session_id, input_hash: inputHash, mode, duration_ms: 0 }), level);

  if (input.stop_hook_active) {
    const durationMs = Math.round(performance.now() - startMs);
    emitLog(makeTrace({ event: "decision_allow", level: "info", session: input.session_id, input_hash: inputHash, mode, duration_ms: durationMs, keyword: null, confidence: 0, decision: "allow" }), level);
    return null;
  }

  // Trace: parse_ok
  emitLog(makeTrace({ event: "parse_ok", level: "info", session: input.session_id, input_hash: inputHash, mode, duration_ms: Math.round(performance.now() - startMs) }), level);

  const analysis = analyze(input);

  // Trace: scan_complete
  emitLog(makeTrace({ event: "scan_complete", level: "info", session: input.session_id, input_hash: inputHash, mode, duration_ms: Math.round(performance.now() - startMs), confidence: analysis?.confidence ?? 0 }), level);

  if (analysis) {
    const durationMs = Math.round(performance.now() - startMs);

    // Trace: decision_block
    emitLog(makeTrace({ event: "decision_block", level: "info", session: input.session_id, input_hash: inputHash, mode, duration_ms: durationMs, keyword: analysis.unique.join(", "), confidence: analysis.confidence, decision: "block" }), level);

    // Debug-level: detailed trace
    emitLog(makeTrace({
      event: "decision_block",
      level: "debug",
      session: input.session_id,
      input_hash: inputHash,
      mode,
      duration_ms: durationMs,
      keyword: analysis.unique.join(", "),
      confidence: analysis.confidence,
      decision: "block",
      stripped: analysis.stripped.slice(0, 500),
      matches: analysis.matches,
    }), level);

    return {
      decision: "block",
      reason: `Doubt detected (${analysis.confidence} keyword${analysis.confidence > 1 ? "s" : ""}: ${analysis.keywordList}). Before stopping, add logging/assertions to verify your hypothesis. Run the verification and report concrete evidence for your conclusion.`,
      schema_version: SCHEMA_VERSION,
      plugin_version: PLUGIN_VERSION,
      mode,
      duration_ms: durationMs,
      input_hash: inputHash,
    };
  }

  const durationMs = Math.round(performance.now() - startMs);

  // Trace: decision_allow
  emitLog(makeTrace({ event: "decision_allow", level: "info", session: input.session_id, input_hash: inputHash, mode, duration_ms: durationMs, keyword: null, confidence: 0, decision: "allow" }), level);

  return null;
}

/** Read all of stdin as a string. */
async function readStdin(): Promise<string> {
  return await Bun.stdin.text();
}

/** Load plugin.json from the parent directory of this script. */
function loadPluginManifest(): { version: string } {
  const __dirname = dirname(fileURLToPath(import.meta.url));
  const manifestPath = join(__dirname, "..", ".claude-plugin", "plugin.json");
  return JSON.parse(readFileSync(manifestPath, "utf-8"));
}

/** Print usage help to stdout. */
function printHelp(): void {
  console.log(`doubt-gate — Claude Code Stop hook that detects uncertainty

Usage:
  echo '<json>' | bun run doubt-gate.ts           Hook mode (default)
  echo '<json>' | bun run doubt-gate.ts --check    Dry-run: emit structured JSON verdict
  bun run doubt-gate.ts --help                     Show this help
  bun run doubt-gate.ts --version                  Print version from plugin.json

Exit codes (--check mode):
  0  decision: allow
  1  decision: block
  2  input error (invalid JSON)

Environment:
  DOUBT_GATE_LOG_LEVEL   off | info | debug  (default: off)
  DOUBT_GATE_LOG_PATH    log file path        (default: /tmp/doubt-gate.log)`);
}

/**
 * --check mode: read stdin, analyze, emit structured JSON verdict.
 * Never writes to DOUBT_GATE_LOG_PATH.
 * Exit codes: 0=allow, 1=block, 2=input-error.
 */
async function runCheck(): Promise<void> {
  const startMs = performance.now();
  const raw = await readStdin();
  const inputHash = computeInputHash(raw);
  const input = parseInput(raw);

  if (!input) {
    const durationMs = Math.round(performance.now() - startMs);
    const output: CheckOutput = {
      decision: "error",
      error: "invalid_json",
      message: "Failed to parse stdin as JSON",
      schema_version: SCHEMA_VERSION,
      plugin_version: PLUGIN_VERSION,
      mode: "check",
      duration_ms: durationMs,
      input_hash: inputHash,
    };
    console.log(JSON.stringify(output));
    process.exit(2);
  }

  const analysis = analyze(input);
  const durationMs = Math.round(performance.now() - startMs);

  if (analysis) {
    const output: CheckOutput = {
      decision: "block",
      reasons: analysis.unique,
      confidence: analysis.confidence,
      schema_version: SCHEMA_VERSION,
      plugin_version: PLUGIN_VERSION,
      mode: "check",
      duration_ms: durationMs,
      input_hash: inputHash,
    };
    console.log(JSON.stringify(output));
    process.exit(1);
  }

  const output: CheckOutput = {
    decision: "allow",
    reasons: [],
    confidence: 0,
    schema_version: SCHEMA_VERSION,
    plugin_version: PLUGIN_VERSION,
    mode: "check",
    duration_ms: durationMs,
    input_hash: inputHash,
  };
  console.log(JSON.stringify(output));
  process.exit(0);
}

// Execution guard: run stdin processing when executed directly
const scriptPath = process.argv[1] ?? "";
const isDirectExecution = scriptPath.endsWith("doubt-gate.ts");
if (isDirectExecution) {
  const args = process.argv.slice(2);
  const flag = args[0];

  if (flag === "--help") {
    printHelp();
    process.exit(0);
  }

  if (flag === "--version") {
    const manifest = loadPluginManifest();
    console.log(manifest.version);
    process.exit(0);
  }

  if (flag === "--check") {
    await runCheck();
  }

  // Default hook mode — existing behavior
  const raw = await readStdin();
  const input = parseInput(raw);

  if (!input) {
    process.exit(0);
  }

  const result = evaluate(input, raw);
  emitHookDecision(result);
}
