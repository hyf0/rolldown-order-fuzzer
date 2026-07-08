/// <reference types="node" />

import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  EXECUTION_PROTOCOL_VERSION,
  parseExecutionOutcome,
  type ExecutionOutcome,
} from "./protocol.ts";

export interface ExecuteManifestOptions {
  readonly timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 10_000;
const TERMINATION_GRACE_MS = 250;
const CHILD_RUNNER_PATH = fileURLToPath(new URL("./child-runner.ts", import.meta.url));

export async function executeManifest(
  manifestPath: string,
  options: ExecuteManifestOptions = {},
): Promise<ExecutionOutcome> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new Error(`timeoutMs must be a positive finite number, received ${timeoutMs}`);
  }

  const resultDirectory = await mkdtemp(join(tmpdir(), "order-execution-"));
  const resultPath = join(resultDirectory, "result.json");

  try {
    const childResult = await runChild(resolve(manifestPath), resultPath, timeoutMs);
    if (childResult.status === "timeout") {
      return {
        version: EXECUTION_PROTOCOL_VERSION,
        status: "timeout",
        events: [],
      };
    }
    if (childResult.status === "spawn-error") {
      return harnessError(childResult.error.name, childResult.error.message);
    }
    if (childResult.code !== 0 || childResult.signal !== null) {
      return harnessError(
        "ChildProcessError",
        childExitMessage(childResult.code, childResult.signal),
      );
    }

    try {
      return parseExecutionOutcome(JSON.parse(await readFile(resultPath, "utf8")) as unknown);
    } catch {
      return harnessError(
        "ChildProcessError",
        childFailureMessage(childResult.code, childResult.signal),
      );
    }
  } finally {
    await rm(resultDirectory, { recursive: true, force: true });
  }
}

type ChildResult =
  | { readonly status: "timeout" }
  | { readonly status: "spawn-error"; readonly error: Error }
  | {
      readonly status: "closed";
      readonly code: number | null;
      readonly signal: NodeJS.Signals | null;
    };

async function runChild(
  manifestPath: string,
  resultPath: string,
  timeoutMs: number,
): Promise<ChildResult> {
  return new Promise((resolveResult) => {
    const child = spawn(process.execPath, [CHILD_RUNNER_PATH, manifestPath, resultPath], {
      detached: process.platform !== "win32",
      stdio: "ignore",
    });
    let settled = false;
    let resolveClosed: () => void;
    const closed = new Promise<void>((resolvePromise) => {
      resolveClosed = resolvePromise;
    });

    const timer = setTimeout(() => {
      if (settled) {
        return;
      }
      settled = true;
      void terminateRunner(child, closed).finally(() => {
        resolveResult({ status: "timeout" });
      });
    }, timeoutMs);

    child.once("error", (error) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      resolveResult({ status: "spawn-error", error });
    });
    child.once("close", (code, signal) => {
      resolveClosed();
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      resolveResult({ status: "closed", code, signal });
    });
  });
}

async function terminateRunner(child: ChildProcess, closed: Promise<void>): Promise<void> {
  signalRunner(child, "SIGTERM");
  if (await waitForClose(closed, TERMINATION_GRACE_MS)) {
    return;
  }

  signalRunner(child, "SIGKILL");
  await waitForClose(closed, TERMINATION_GRACE_MS);
}

function signalRunner(child: ChildProcess, signal: NodeJS.Signals): void {
  if (process.platform !== "win32" && child.pid !== undefined) {
    try {
      process.kill(-child.pid, signal);
      return;
    } catch {}
  }
  child.kill(signal);
}

async function waitForClose(closed: Promise<void>, timeoutMs: number): Promise<boolean> {
  return new Promise((resolveWait) => {
    const timer = setTimeout(() => {
      resolveWait(false);
    }, timeoutMs);
    void closed.then(() => {
      clearTimeout(timer);
      resolveWait(true);
    });
  });
}

function harnessError(name: string, message: string): ExecutionOutcome {
  return {
    version: EXECUTION_PROTOCOL_VERSION,
    status: "harness-error",
    events: [],
    error: { name, message },
  };
}

function childExitMessage(code: number | null, signal: NodeJS.Signals | null): string {
  const reason = signal === null ? `exit code ${String(code)}` : `signal ${JSON.stringify(signal)}`;
  return `Child runner ended with ${reason}`;
}

function childFailureMessage(code: number | null, signal: NodeJS.Signals | null): string {
  const reason = signal === null ? `exit code ${String(code)}` : `signal ${JSON.stringify(signal)}`;
  return `Child runner ended with ${reason} without a valid result`;
}
