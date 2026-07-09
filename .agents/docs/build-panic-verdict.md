# Build-panic verdict

A reproducible Rolldown build panic on a Node-legal program is a real bug, not a harness problem
(rolldown #9038 SIGILL/SIGSEGV, #9651, #4447, #8216). The oracle reclassifies it as a distinct
**failing** verdict instead of an invalid-harness discard, while keeping genuine harness
misconfiguration (package load errors, timeouts, spawn failures) as harness errors.

## Two panic shapes

- **Thrown**: a Rust panic caught by napi and rethrown as a JS `Error`, or a napi fatal. The build
  child catches it (`build-error`) and marks it `panic: true` when the message matches
  `looksLikePanic` (Rust `panicked at`, fatal-runtime/fatal-error, signal names, `process crashed`,
  `RolldownBuildPanic`). This path already failed the campaign (exit 1); the change gives it the
  distinct `panic` identity.
- **Crash**: a panic/abort/stack-overflow that kills the child process (non-zero exit or signal),
  leaving no response. Previously this became a `harness-error` (exit 2) — a real bug masquerading as
  a config error. Now it is a `build-error` panic (exit 1).

## Phase marker disambiguates crash-during-load from crash-during-build

The correctness of the crash path rests on _not_ misclassifying a crash while importing the package
(an environment problem) as a Rolldown bug. The child writes a phase-marker file
(`build-phase.json`, `{"phase":"package-loaded"}`) **after** the package imports cleanly and
**before** the build starts (via the `onPackageLoaded` hook). On a child crash the parent reads it:

- marker present -> crash happened during the build -> **panic** (`build-error`, exit 1)
- marker absent -> crash during startup/import -> **harness error** (exit 2)

This drives the exit-code correctness (harness vs. bug) structurally, not by string-matching. Graceful
load failures (bad specifier, missing `rolldown` export) already return a harness-error _response_
and never reach the crash path, so they stay harness regardless.

## Verdict shape

`build-failure:panic:["<name>","<normalized-message>"]` — `reason: "panic"`,
`FailedRolldownAdapterResult.status: "build-error"` so `isHarnessFailure` is false (exit 1). The
message is normalized (temp/fuzzer roots stripped) for a stable, deduplicated identity; a synthesized
crash carries name `RolldownBuildPanic` and message `Rolldown build process crashed with <signal|exit
code>`. It produces failure artifacts like any other failure.
