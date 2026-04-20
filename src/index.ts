#!/usr/bin/env node

import { Command } from "commander";
import pkg from "../package.json" with { type: "json" };
import { initCommand } from "./commands/init/index.js";
import { modCommand } from "./commands/mod/index.js";
import { buildCommand } from "./commands/build/index.js";
import { deployCommand } from "./commands/deploy/index.js";
import { updateCommand } from "./commands/update.js";
import { installSignalHandlers, onProcessShutdown } from "./utils/process-guard.js";
import { clearWindowTitle } from "./utils/ui/theme/window-title.js";

// ── Bun compiled-binary stdin workaround ─────────────────────────────────────
// When `dot` is shipped via `bun build --compile`, Ink's internal
// `stdin.addListener('readable', …)` does NOT receive events until something
// else has already touched `process.stdin.on('readable', …)` first. Symptom:
// every useInput-driven TUI locks up — no arrow keys, no Enter, no Ctrl+C.
//
// Attaching a no-op `readable` listener here warms the stream up so Ink's
// own listener fires normally. Harmless under `bun run` and Node.
// Remove once Bun's compiled-binary TTY stdin behaves like Node's out of the
// box.
if (process.stdin.isTTY) {
    process.stdin.on("readable", () => {});
    // Don't let the listener itself hold the event loop open on exit.
    process.stdin.unref();
}

// Opt out of bulletin-deploy's Sentry telemetry unless the user has
// explicitly opted in. Sentry buffers breadcrumbs + spans in-memory while
// it tries to reach its endpoint — on a flaky or long-running deploy this
// has been observed to balloon the process. Users can re-enable by setting
// `BULLETIN_DEPLOY_TELEMETRY=1` before invoking `dot deploy`.
if (process.env.BULLETIN_DEPLOY_TELEMETRY === undefined) {
    process.env.BULLETIN_DEPLOY_TELEMETRY = "0";
}

// Install SIGINT/SIGTERM/SIGHUP + unhandledRejection handlers so a force-quit
// or a stray async error can't turn `dot` into a zombie that grows memory
// indefinitely.
installSignalHandlers();

// Hand the terminal tab title back to the shell on exit. The shell usually
// repaints its own title immediately, but being explicit avoids leaving
// "dot deploy · my-app.dot · ✓" stuck on a long-lived tab.
onProcessShutdown(clearWindowTitle);

const program = new Command()
    .name("dot")
    .description("CLI for Polkadot Playground")
    .version(pkg.version);

program.addCommand(initCommand);
program.addCommand(modCommand);
program.addCommand(buildCommand);
program.addCommand(deployCommand);
program.addCommand(updateCommand);

program.parseAsync().then(() => process.exit(0));
