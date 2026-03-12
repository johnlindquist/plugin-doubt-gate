import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { readFileSync, unlinkSync, existsSync } from "node:fs";
import { join } from "node:path";

const FIXTURES_DIR = join(import.meta.dir, "fixtures");
const HOOK_PATH = join(import.meta.dir, "..", "hooks", "doubt-gate.ts");
const LOG_PATH = "/tmp/doubt-gate-plugin-test.log";

interface FixtureResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

async function runHookWithFixture(fixtureName: string, extraArgs: string[] = [], env: Record<string, string> = {}): Promise<FixtureResult> {
  const fixtureContent = readFileSync(join(FIXTURES_DIR, fixtureName), "utf-8");
  const proc = Bun.spawn(["bun", "run", HOOK_PATH, ...extraArgs], {
    stdin: new Blob([fixtureContent]),
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, DOUBT_GATE_LOG_LEVEL: "off", ...env },
  });
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  const exitCode = await proc.exited;
  return { stdout: stdout.trim(), stderr: stderr.trim(), exitCode };
}

async function runHookWithStdin(stdin: string, extraArgs: string[] = [], env: Record<string, string> = {}): Promise<FixtureResult> {
  const proc = Bun.spawn(["bun", "run", HOOK_PATH, ...extraArgs], {
    stdin: new Blob([stdin]),
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, DOUBT_GATE_LOG_LEVEL: "off", ...env },
  });
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  const exitCode = await proc.exited;
  return { stdout: stdout.trim(), stderr: stderr.trim(), exitCode };
}

async function runHookNoStdin(extraArgs: string[]): Promise<FixtureResult> {
  const proc = Bun.spawn(["bun", "run", HOOK_PATH, ...extraArgs], {
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, DOUBT_GATE_LOG_LEVEL: "off" },
  });
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  const exitCode = await proc.exited;
  return { stdout: stdout.trim(), stderr: stderr.trim(), exitCode };
}

describe("plugin verification: doubt-gate hook", () => {
  test("doubtful-1.json produces decision:block", async () => {
    const result = await runHookWithFixture("doubtful-1.json");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).not.toBe("");
    const output = JSON.parse(result.stdout);
    expect(output.decision).toBe("block");
    expect(output.reason).toBeString();
    expect(output.reason.length).toBeGreaterThan(0);
  });

  test("doubtful-2.json produces decision:block", async () => {
    const result = await runHookWithFixture("doubtful-2.json");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).not.toBe("");
    const output = JSON.parse(result.stdout);
    expect(output.decision).toBe("block");
    expect(output.reason).toBeString();
    expect(output.reason.length).toBeGreaterThan(0);
  });

  test("clean-1.json passes without blocking (no stdout)", async () => {
    const result = await runHookWithFixture("clean-1.json");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("");
  });

  test("doubtful-1.json output is valid parseable JSON", async () => {
    const result = await runHookWithFixture("doubtful-1.json");
    expect(() => JSON.parse(result.stdout)).not.toThrow();
  });

  test("doubtful-2.json output is valid parseable JSON", async () => {
    const result = await runHookWithFixture("doubtful-2.json");
    expect(() => JSON.parse(result.stdout)).not.toThrow();
  });

  test("doubtful-1.json reason mentions detected keywords", async () => {
    const result = await runHookWithFixture("doubtful-1.json");
    const output = JSON.parse(result.stdout);
    // "might" and "I think" are in the fixture
    expect(output.reason).toContain('"might"');
    expect(output.reason).toContain('"i think"');
  });

  test("doubtful-2.json reason mentions detected keywords", async () => {
    const result = await runHookWithFixture("doubtful-2.json");
    const output = JSON.parse(result.stdout);
    // "probably", "seems like", "not certain" are in the fixture
    expect(output.reason).toContain('"probably"');
    expect(output.reason).toContain('"seems like"');
  });

  test("active-guard.json bypasses blocking when stop_hook_active is true (no stdout)", async () => {
    const result = await runHookWithFixture("active-guard.json");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("");
  });

  test("all fixtures produce exit code 0", async () => {
    for (const fixture of ["doubtful-1.json", "doubtful-2.json", "clean-1.json", "active-guard.json"]) {
      const result = await runHookWithFixture(fixture);
      expect(result.exitCode).toBe(0);
    }
  });

  test("hook produces no stderr output for valid fixtures", async () => {
    for (const fixture of ["doubtful-1.json", "doubtful-2.json", "clean-1.json", "active-guard.json"]) {
      const result = await runHookWithFixture(fixture);
      expect(result.stderr).toBe("");
    }
  });
});

describe("hook mode versioned output schema", () => {
  test("block output includes schema_version, plugin_version, mode, duration_ms, input_hash", async () => {
    const result = await runHookWithFixture("doubtful-1.json");
    const output = JSON.parse(result.stdout);
    expect(output.schema_version).toBe("1.0.0");
    expect(output.plugin_version).toBe("1.0.0");
    expect(output.mode).toBe("hook");
    expect(typeof output.duration_ms).toBe("number");
    expect(output.duration_ms).toBeGreaterThanOrEqual(0);
    expect(typeof output.input_hash).toBe("string");
    expect(output.input_hash.length).toBe(12);
    expect(output.input_hash).toMatch(/^[0-9a-f]{12}$/);
  });

  test("input_hash is deterministic across runs", async () => {
    const r1 = await runHookWithFixture("doubtful-1.json");
    const r2 = await runHookWithFixture("doubtful-1.json");
    const o1 = JSON.parse(r1.stdout);
    const o2 = JSON.parse(r2.stdout);
    expect(o1.input_hash).toBe(o2.input_hash);
  });

  test("different fixtures produce different input_hash", async () => {
    const r1 = await runHookWithFixture("doubtful-1.json");
    const r2 = await runHookWithFixture("doubtful-2.json");
    const o1 = JSON.parse(r1.stdout);
    const o2 = JSON.parse(r2.stdout);
    expect(o1.input_hash).not.toBe(o2.input_hash);
  });
});

describe("hook mode JSONL decision traces", () => {
  beforeEach(() => {
    try { unlinkSync(LOG_PATH); } catch {}
  });

  afterEach(() => {
    try { unlinkSync(LOG_PATH); } catch {}
  });

  test("block decision emits JSONL trace events to log file", async () => {
    await runHookWithFixture("doubtful-1.json", [], { DOUBT_GATE_LOG_LEVEL: "info", DOUBT_GATE_LOG_PATH: LOG_PATH });
    expect(existsSync(LOG_PATH)).toBe(true);
    const lines = readFileSync(LOG_PATH, "utf-8").trim().split("\n");
    expect(lines.length).toBeGreaterThanOrEqual(4);
    const events = lines.map(l => JSON.parse(l));
    const eventNames = events.map(e => e.event);
    expect(eventNames).toContain("invoke");
    expect(eventNames).toContain("parse_ok");
    expect(eventNames).toContain("scan_complete");
    expect(eventNames).toContain("decision_block");
  });

  test("allow decision emits JSONL trace events to log file", async () => {
    await runHookWithFixture("clean-1.json", [], { DOUBT_GATE_LOG_LEVEL: "info", DOUBT_GATE_LOG_PATH: LOG_PATH });
    expect(existsSync(LOG_PATH)).toBe(true);
    const lines = readFileSync(LOG_PATH, "utf-8").trim().split("\n");
    const events = lines.map(l => JSON.parse(l));
    const eventNames = events.map(e => e.event);
    expect(eventNames).toContain("invoke");
    expect(eventNames).toContain("parse_ok");
    expect(eventNames).toContain("scan_complete");
    expect(eventNames).toContain("decision_allow");
  });

  test("every trace event line is independently parseable JSON", async () => {
    await runHookWithFixture("doubtful-1.json", [], { DOUBT_GATE_LOG_LEVEL: "info", DOUBT_GATE_LOG_PATH: LOG_PATH });
    const content = readFileSync(LOG_PATH, "utf-8");
    const lines = content.trim().split("\n");
    for (const line of lines) {
      expect(() => JSON.parse(line)).not.toThrow();
    }
  });

  test("every trace event has schema_version, plugin_version, input_hash, timestamp, mode", async () => {
    await runHookWithFixture("doubtful-1.json", [], { DOUBT_GATE_LOG_LEVEL: "info", DOUBT_GATE_LOG_PATH: LOG_PATH });
    const lines = readFileSync(LOG_PATH, "utf-8").trim().split("\n");
    for (const line of lines) {
      const entry = JSON.parse(line);
      expect(entry.schema_version).toBe("1.0.0");
      expect(entry.plugin_version).toBe("1.0.0");
      expect(typeof entry.input_hash).toBe("string");
      expect(entry.input_hash.length).toBe(12);
      expect(typeof entry.timestamp).toBe("string");
      expect(entry.mode).toBe("hook");
      expect(typeof entry.duration_ms).toBe("number");
    }
  });
});

describe("--check flag", () => {
  test("doubtful fixture exits 1 with decision:block", async () => {
    const result = await runHookWithFixture("doubtful-1.json", ["--check"]);
    expect(result.exitCode).toBe(1);
    const output = JSON.parse(result.stdout);
    expect(output.decision).toBe("block");
    expect(output.reasons).toBeArray();
    expect(output.reasons.length).toBeGreaterThan(0);
    expect(output.schema_version).toBe("1.0.0");
    expect(output.plugin_version).toBe("1.0.0");
    expect(output.mode).toBe("check");
    expect(typeof output.duration_ms).toBe("number");
    expect(typeof output.input_hash).toBe("string");
    expect(output.input_hash.length).toBe(12);
  });

  test("clean fixture exits 0 with decision:allow", async () => {
    const result = await runHookWithFixture("clean-1.json", ["--check"]);
    expect(result.exitCode).toBe(0);
    const output = JSON.parse(result.stdout);
    expect(output.decision).toBe("allow");
    expect(output.reasons).toEqual([]);
    expect(output.confidence).toBe(0);
    expect(output.schema_version).toBe("1.0.0");
    expect(output.plugin_version).toBe("1.0.0");
    expect(output.mode).toBe("check");
    expect(typeof output.duration_ms).toBe("number");
    expect(typeof output.input_hash).toBe("string");
    expect(output.input_hash.length).toBe(12);
  });

  test("invalid JSON input exits 2 with structured error", async () => {
    const result = await runHookWithStdin("not valid json{{{", ["--check"]);
    expect(result.exitCode).toBe(2);
    const output = JSON.parse(result.stdout);
    expect(output.decision).toBe("error");
    expect(output.error).toBe("invalid_json");
    expect(output.schema_version).toBe("1.0.0");
    expect(output.plugin_version).toBe("1.0.0");
    expect(output.mode).toBe("check");
    expect(typeof output.duration_ms).toBe("number");
    expect(typeof output.input_hash).toBe("string");
    expect(output.input_hash.length).toBe(12);
  });

  test("--check output includes confidence count", async () => {
    const result = await runHookWithFixture("doubtful-1.json", ["--check"]);
    const output = JSON.parse(result.stdout);
    expect(output.confidence).toBeGreaterThan(0);
  });

  test("--check produces no stderr", async () => {
    const result = await runHookWithFixture("doubtful-1.json", ["--check"]);
    expect(result.stderr).toBe("");
  });
});

describe("error paths", () => {
  test("empty stdin in --check mode exits 2 with structured error", async () => {
    const result = await runHookWithStdin("", ["--check"]);
    expect(result.exitCode).toBe(2);
    const output = JSON.parse(result.stdout);
    expect(output.decision).toBe("error");
    expect(output.error).toBe("invalid_json");
    expect(output.schema_version).toBe("1.0.0");
    expect(output.plugin_version).toBe("1.0.0");
    expect(output.mode).toBe("check");
    expect(typeof output.duration_ms).toBe("number");
    expect(typeof output.input_hash).toBe("string");
    expect(output.input_hash.length).toBe(12);
  });

  test("empty stdin in hook mode exits 0 with no output", async () => {
    const result = await runHookWithStdin("");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("");
  });

  test("invalid JSON in hook mode exits 0 with no output (graceful)", async () => {
    const result = await runHookWithStdin("this is not json at all");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("");
  });

  test("missing last_assistant_message field produces allow (no block)", async () => {
    const result = await runHookWithStdin(JSON.stringify({ some_other_field: "value" }));
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("");
  });

  test("missing last_assistant_message in --check mode produces allow", async () => {
    const result = await runHookWithStdin(JSON.stringify({ some_other_field: "value" }), ["--check"]);
    expect(result.exitCode).toBe(0);
    const output = JSON.parse(result.stdout);
    expect(output.decision).toBe("allow");
    expect(output.reasons).toEqual([]);
    expect(output.confidence).toBe(0);
  });

  test("DOUBT_GATE_LOG_PATH to unwritable path does not crash hook", async () => {
    const result = await runHookWithFixture("doubtful-1.json", [], {
      DOUBT_GATE_LOG_LEVEL: "info",
      DOUBT_GATE_LOG_PATH: "/nonexistent/path/doubt-gate.log",
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).not.toBe("");
    const output = JSON.parse(result.stdout);
    expect(output.decision).toBe("block");
  });

  test("unknown DOUBT_GATE_LOG_LEVEL defaults to off without error", async () => {
    const result = await runHookWithFixture("doubtful-1.json", [], {
      DOUBT_GATE_LOG_LEVEL: "invalid_level",
    });
    expect(result.exitCode).toBe(0);
    const output = JSON.parse(result.stdout);
    expect(output.decision).toBe("block");
    expect(result.stderr).toBe("");
  });
});

describe("--help flag", () => {
  test("prints usage and exits 0", async () => {
    const result = await runHookNoStdin(["--help"]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("doubt-gate");
    expect(result.stdout).toContain("--check");
    expect(result.stdout).toContain("--help");
    expect(result.stdout).toContain("--version");
  });
});

describe("--version flag", () => {
  test("prints version from plugin.json and exits 0", async () => {
    const manifest = JSON.parse(
      readFileSync(join(import.meta.dir, "..", ".claude-plugin", "plugin.json"), "utf-8")
    );
    const result = await runHookNoStdin(["--version"]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe(manifest.version);
  });
});
