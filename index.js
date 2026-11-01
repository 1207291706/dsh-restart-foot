/**
 * Host half of the sidebar-foot restart button.
 *
 * Routes on the DSH web server:
 *   GET  /dsh-restart-foot/ping            — liveness probe, target and last launch failure;
 *   POST /dsh-restart-foot/restart         — schedule a stop-and-relaunch of the desktop app;
 *   POST /dsh-restart-foot/restart?probe=1 — report the target without touching any process;
 *   POST /dsh-restart-foot/selfcheck       — prove what this host can actually start.
 *
 * The host lives inside the application it restarts, so it cannot stop and start
 * itself: it writes a helper and starts it in a way that outlives the application.
 *
 * Two facts decide the design, both measured on the desktop app rather than
 * assumed:
 *   - the application owns its children through a job object, so a helper started
 *     as an ordinary child is killed together with the application — only a
 *     detached child survives;
 *   - on Windows a detached child gets its own console window, which is unwanted,
 *     so the detached process is `wscript.exe`: a GUI-subsystem program that
 *     Windows never gives a console, which then runs the batch with a hidden
 *     window style. (`wscript` → `cmd` works; `wscript` → `powershell` is blocked
 *     by security policy on the tested machine.)
 *
 * The batch stops the application by image name, polls until the image is really
 * gone, force-stops leftovers by pid, and only then starts the executable again —
 * starting a second copy while the first is still shutting down is what makes the
 * shell report a broken installation or an already-running instance.
 *
 * The overall approach follows the MIT-licensed `dsh-restart-button` plugin by
 * CZY1326; this implementation is written for this bundle's own route space.
 */
import { spawn } from "node:child_process";
import { existsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const name = "dsh-restart-foot";
const inject = ["webServer"];

const PING_PATH = "/dsh-restart-foot/ping";
const RESTART_PATH = "/dsh-restart-foot/restart";
const SELFCHECK_PATH = "/dsh-restart-foot/selfcheck";

/** How long the helper waits before stopping, so the HTTP reply reaches the page. */
const KILL_DELAY_SECONDS = 1;
/** How long the helper waits for the application to disappear before force-stopping. */
const EXIT_WAIT_SECONDS = 20;
/** Two-second rounds the helper waits for the relaunched application to appear. */
const START_WAIT_ROUNDS = 10;
/** How long a launch attempt is watched before it counts as started. */
const LAUNCH_WINDOW_MS = 400;
/** Task left behind by an earlier version of this plugin; removed by the self-check. */
const STALE_TASK = "dsh-restart-foot-relaunch";

const HELPER_PREFIX = join(tmpdir(), "dsh-restart-foot-helper");
const LOG_FILE = join(tmpdir(), "dsh-restart-foot.log");

/** Last helper launch failure, surfaced by `/ping` and by the button. */
let lastLaunchError = null;

/**
 * Writes a JSON reply and ends the response.
 * @param response - node HTTP response.
 * @param status - HTTP status code.
 * @param body - serialisable payload.
 */
function sendJson(response, status, body) {
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store"
  });
  response.end(JSON.stringify(body));
}

/**
 * Resolves a system executable, preferring the absolute path.
 *
 * The desktop shell can run its host with a trimmed PATH, where a bare name does
 * not resolve and a spawn fails with ENOENT.
 * @param fileName - file inside `%SystemRoot%\System32`.
 * @returns an executable path.
 */
function systemExe(fileName) {
  const root = process.env.SystemRoot ?? process.env.windir ?? "C:\\Windows";
  const absolute = join(root, "System32", fileName);
  return existsSync(absolute) ? absolute : fileName;
}

/** @returns the absolute PowerShell path. */
function powershellPath() {
  const root = process.env.SystemRoot ?? process.env.windir ?? "C:\\Windows";
  const absolute = join(root, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  return existsSync(absolute) ? absolute : "powershell.exe";
}

/**
 * Resolves the desktop executable this host belongs to.
 *
 * Under the desktop shell the host is spawned from the application binary with
 * `ELECTRON_RUN_AS_NODE=1`, so `process.execPath` is that binary. A plain
 * `dsh web` started from a terminal runs on node, where there is no application
 * to relaunch and this returns null.
 * @returns the executable path and its image name, or null.
 */
function desktopExecutable() {
  const override = process.env.DSH_RESTART_EXE;
  const exe = override !== undefined && override !== "" && existsSync(override)
    ? override
    : process.execPath;
  if (typeof exe !== "string" || exe === "") return null;
  const image = exe.split(/[\\/]/).pop() ?? "";
  if (/^node(\.exe)?$/i.test(image) || !/\.exe$/i.test(image)) return null;
  if (!existsSync(exe)) return null;
  return { exe, image };
}

/**
 * Writes the batch that performs the restart.
 *
 * Every attempt gets its own file: an interpreter reads a batch by byte offset
 * while it runs, so rewriting a shared file in place can make it jump into the
 * middle of a line.
 * @param target - executable path and image name.
 * @returns the batch path.
 */
function writeBatchHelper(target) {
  const file = `${HELPER_PREFIX}-${Date.now().toString(36)}.cmd`;
  const pollRounds = Math.ceil(EXIT_WAIT_SECONDS / 2);
  const lines = [
    "@echo off",
    "setlocal enableextensions enabledelayedexpansion",
    `set "LOG=${LOG_FILE}"`,
    `set "EXE=${target.exe}"`,
    `set "IMG=${target.image}"`,
    `echo [%DATE% %TIME%] restart requested: %EXE% >> "%LOG%"`,
    `if not exist "%EXE%" (`,
    `  echo [%DATE% %TIME%] missing executable %EXE% >> "%LOG%"`,
    "  exit /b 1",
    ")",
    `ping -n ${KILL_DELAY_SECONDS + 1} 127.0.0.1 >nul`,
    `echo [%DATE% %TIME%] stopping %IMG% >> "%LOG%"`,
    `taskkill /F /IM "%IMG%" >> "%LOG%" 2>&1`,
    "set /a rounds=0",
    ":waitloop",
    "ping -n 2 127.0.0.1 >nul",
    `tasklist /FI "IMAGENAME eq %IMG%" /NH 2>nul | find /I "%IMG%" >nul`,
    // tasklist prints "no tasks are running" in the local language, so the test is
    // the absence of the image name rather than an exit code from tasklist itself.
    "if errorlevel 1 goto gone",
    "set /a rounds+=1",
    `if !rounds! GEQ ${pollRounds} goto forcekill`,
    "goto waitloop",
    ":forcekill",
    `echo [%DATE% %TIME%] still present after ${EXIT_WAIT_SECONDS}s; killing by pid >> "%LOG%"`,
    `for /f "tokens=2 delims=," %%p in ('tasklist /FI "IMAGENAME eq %IMG%" /FO CSV /NH 2^>nul') do taskkill /F /PID %%p >> "%LOG%" 2>&1`,
    "ping -n 3 127.0.0.1 >nul",
    `tasklist /FI "IMAGENAME eq %IMG%" /NH 2>nul | find /I "%IMG%" >nul`,
    `if not errorlevel 1 echo [%DATE% %TIME%] warning: %IMG% still present >> "%LOG%"`,
    ":gone",
    // The host runs with ELECTRON_RUN_AS_NODE=1, because the desktop shell starts
    // it from the application binary in Node mode. Anything this batch inherits
    // keeps that flag, and the binary launched below would then run as a plain
    // Node process with no script: it exits at once, which is exactly the
    // "it closed and never came back" symptom. The flag must be cleared here.
    'set "ELECTRON_RUN_AS_NODE="',
    'set "ELECTRON_NO_ATTACH_CONSOLE="',
    `echo [%DATE% %TIME%] starting %EXE% >> "%LOG%"`,
    `start "" "%EXE%"`,
    `echo [%DATE% %TIME%] started >> "%LOG%"`,
    "set /a waits=0",
    ":appearloop",
    "ping -n 2 127.0.0.1 >nul",
    `tasklist /FI "IMAGENAME eq %IMG%" /NH 2>nul | find /I "%IMG%" >nul`,
    "if not errorlevel 1 goto appeared",
    "set /a waits+=1",
    `if !waits! GEQ ${START_WAIT_ROUNDS} goto noappear`,
    "goto appearloop",
    ":appeared",
    `echo [%DATE% %TIME%] application is back >> "%LOG%"`,
    "exit /b 0",
    ":noappear",
    `echo [%DATE% %TIME%] warning: application did not appear within ${START_WAIT_ROUNDS * 2}s >> "%LOG%"`,
    "exit /b 0"
  ];
  writeFileSync(file, `${lines.join("\r\n")}\r\n`);
  return file;
}

/**
 * Writes the launcher that hides the batch behind a console-free process.
 *
 * `wscript.exe` is a GUI-subsystem program, so Windows never gives it a console
 * window even when it is started detached; `Run …, 0, False` then starts the batch
 * with a hidden window style and returns immediately.
 * @param batchPath - batch file to run.
 * @returns the launcher path.
 */
function writeVbsLauncher(batchPath) {
  const file = `${HELPER_PREFIX}-${Date.now().toString(36)}.vbs`;
  const command = `${systemExe("cmd.exe")} /d /c ""${batchPath}""`;
  const lines = [
    "' Runs the restart batch with no console window and returns immediately.",
    "Option Explicit",
    "Dim shell, status",
    "Set shell = CreateObject(\"WScript.Shell\")",
    `status = shell.Run("${command.replace(/"/g, '""')}", 0, False)`,
    "WScript.Quit 0"
  ];
  writeFileSync(file, `${lines.join("\r\n")}\r\n`);
  return file;
}

/**
 * Writes the helper launches for one restart attempt.
 *
 * The batch does the work, because `cmd` is the one interpreter that is always
 * available and always allowed; `wscript` is what makes the detached child
 * windowless. The bare batch is the fallback.
 * @param target - executable path and image name.
 * @returns the launches to try, in order.
 */
function writeHelper(target) {
  if (process.platform !== "win32") {
    const file = `${HELPER_PREFIX}-${Date.now().toString(36)}.sh`;
    const lines = [
      `if [ ! -x "${target.exe}" ]; then echo "missing executable ${target.exe}" >> "${LOG_FILE}"; exit 1; fi`,
      `echo "$(date) restart requested" >> "${LOG_FILE}"`,
      `sleep ${KILL_DELAY_SECONDS}`,
      `pkill -f "${target.exe}" >> "${LOG_FILE}" 2>&1`,
      `sleep ${EXIT_WAIT_SECONDS}`,
      `nohup "${target.exe}" >> "${LOG_FILE}" 2>&1 &`
    ];
    writeFileSync(file, `#!/bin/sh\n${lines.join("\n")}\n`, { mode: 0o755 });
    return [{ kind: "sh", file, command: "/bin/sh", args: [file] }];
  }

  const batch = writeBatchHelper(target);
  const launcher = writeVbsLauncher(batch);
  return [
    { kind: "hidden", file: launcher, command: systemExe("wscript.exe"), args: ["//B", "//Nologo", launcher] },
    { kind: "cmd", file: batch, command: systemExe("cmd.exe"), args: ["/d", "/c", batch] }
  ];
}

/**
 * Waits for one spawn attempt to either fail or prove that it started.
 * @param script - command, argv, kind and script path.
 * @param options - spawn options.
 * @returns `{ pid, error }`, where error is non-null only on failure.
 */
function attemptLaunch(script, options) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(script.command, script.args, options);
    } catch (error) {
      resolve({ pid: null, error: `${error?.code ?? ""}: ${error?.message ?? String(error)}` });
      return;
    }
    let settled = false;
    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      resolve({ pid: null, error: `${error?.code ?? ""}: ${error?.message ?? String(error)}` });
    });
    // A child still alive after this window has started successfully.
    setTimeout(() => {
      if (settled) return;
      settled = true;
      child.unref();
      resolve({ pid: child.pid ?? null, error: null });
    }, LAUNCH_WINDOW_MS);
  });
}

/**
 * Starts one helper: detached first, then as a hidden ordinary child.
 *
 * Detached first is not a style choice: the application's job object kills an
 * ordinary child along with the application, and a helper that dies mid-restart
 * is exactly the failure this plugin exists to avoid. The windowless requirement
 * is met by the launcher instead.
 * @param script - helper to start.
 * @returns the outcome of the two attempts.
 */
async function startOne(script) {
  const detached = await attemptLaunch(script, { detached: true, stdio: "ignore", windowsHide: true });
  if (detached.error === null) {
    return { ok: true, mode: "detached", pid: detached.pid, error: null, kind: script.kind, file: script.file };
  }
  const hidden = await attemptLaunch(script, { stdio: "ignore", windowsHide: true });
  if (hidden.error === null) {
    return {
      ok: true, mode: "hidden", pid: hidden.pid, error: null, kind: script.kind, file: script.file,
      detachedError: detached.error
    };
  }
  return {
    ok: false, mode: null, pid: null, kind: script.kind, file: script.file,
    error: `${script.kind} detached: ${detached.error}; hidden: ${hidden.error}`
  };
}

/**
 * Starts the restart helper, trying every written kind in order.
 * @param scripts - helpers to try, in order.
 * @returns the successful outcome, or the collected failures.
 */
async function launchHelper(scripts) {
  const failures = [];
  for (const script of scripts) {
    const outcome = await startOne(script);
    if (outcome.ok) {
      lastLaunchError = null;
      return outcome;
    }
    failures.push(outcome.error);
  }
  lastLaunchError = failures.join(" | ");
  return { ok: false, mode: null, pid: null, kind: null, file: scripts[0]?.file ?? null, error: lastLaunchError };
}

/**
 * Runs one probe command and captures its output, exit code and error.
 * @param tag - variant name.
 * @param command - executable.
 * @param args - argv.
 * @param options - spawn options.
 * @returns a report object.
 */
function probe(tag, command, args, options) {
  return new Promise((resolve) => {
    const report = { tag, command, exitCode: null, signal: null, error: null, stdout: "", stderr: "" };
    let child;
    try {
      child = spawn(command, args, { windowsHide: true, ...options });
    } catch (error) {
      report.error = `${error?.code ?? ""}: ${error?.message ?? String(error)}`;
      return resolve(report);
    }
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      resolve(report);
    };
    child.on("error", (error) => {
      report.error = `${error?.code ?? ""}: ${error?.message ?? String(error)}`;
      finish();
    });
    if (child.stdout) child.stdout.on("data", (chunk) => { report.stdout += chunk.toString(); });
    if (child.stderr) child.stderr.on("data", (chunk) => { report.stderr += chunk.toString(); });
    child.on("exit", (code, signal) => {
      report.exitCode = code;
      report.signal = signal;
      finish();
    });
    setTimeout(finish, 4000);
  });
}

/**
 * Host plugin body: registers the liveness probe, the restart trigger and the
 * launch self-check.
 * @param ctx - host root context.
 */
function apply(ctx) {
  ctx.effect(() => {
    const ping = ctx.webServer.register({
      kind: "exact",
      path: PING_PATH,
      handler: (_request, response) => {
        const target = desktopExecutable();
        sendJson(response, 200, {
          ok: true,
          plugin: name,
          platform: process.platform,
          desktop: target !== null,
          exe: target?.exe ?? null,
          resources: process.resourcesPath ?? null,
          wscript: systemExe("wscript.exe"),
          lastLaunchError
        });
      }
    });

    const restart = ctx.webServer.register({
      kind: "exact",
      path: RESTART_PATH,
      handler: async (request, response) => {
        // A custom header keeps stray GETs, prefetchers and other tabs from
        // stopping the application: a cross-origin caller cannot set it without
        // a CORS preflight this server never grants.
        if (request.method !== "POST") {
          sendJson(response, 405, { ok: false, error: "method not allowed" });
          return;
        }
        if (request.headers["x-dsh-restart-foot"] !== "1") {
          sendJson(response, 403, { ok: false, error: "missing x-dsh-restart-foot header" });
          return;
        }
        const target = desktopExecutable();
        if (target === null) {
          sendJson(response, 501, {
            ok: false,
            error: "no desktop application to relaunch; set DSH_RESTART_EXE to the executable path"
          });
          return;
        }
        const probeOnly = new URL(request.url ?? "", "http://localhost").searchParams.get("probe") === "1";
        if (probeOnly) {
          sendJson(response, 200, { ok: true, scheduled: false, probe: true, exe: target.exe });
          return;
        }
        let launch;
        try {
          launch = await launchHelper(writeHelper(target));
        } catch (error) {
          lastLaunchError = error instanceof Error ? error.message : String(error);
          sendJson(response, 500, { ok: false, error: lastLaunchError });
          return;
        }
        sendJson(response, launch.ok ? 200 : 500, {
          ok: launch.ok,
          scheduled: launch.ok,
          kind: launch.kind,
          mode: launch.mode,
          pid: launch.pid,
          error: launch.error,
          detachedError: launch.detachedError ?? null,
          exe: target.exe,
          delayMs: KILL_DELAY_SECONDS * 1000,
          log: LOG_FILE
        });
      }
    });

    const selfcheck = ctx.webServer.register({
      kind: "exact",
      path: SELFCHECK_PATH,
      handler: async (request, response) => {
        if (request.headers["x-dsh-restart-foot"] !== "1") {
          sendJson(response, 403, { ok: false, error: "missing x-dsh-restart-foot header" });
          return;
        }
        const dir = tmpdir();
        const stamp = Date.now().toString(36);
        const batchFile = join(dir, `dsh-restart-foot-probe-${stamp}.txt`);
        const pipe = { stdio: ["ignore", "pipe", "pipe"] };
        const results = [];

        // The production chain, with a harmless payload: wscript (no console) runs
        // the batch hidden, and the batch writes one marker.
        const probeBatch = join(dir, `dsh-restart-foot-probe-${stamp}.cmd`);
        writeFileSync(probeBatch, `@echo off\r\necho hidden-ok> "${batchFile}"\r\nexit /b 0\r\n`);
        const launcher = writeVbsLauncher(probeBatch);
        results.push(await probe("wscript-hidden-batch", systemExe("wscript.exe"), ["//B", "//Nologo", launcher], { stdio: ["ignore", "ignore", "pipe"] }));
        await new Promise((resolve) => setTimeout(resolve, 2000));

        // The stop path and the wait path, both against a nonexistent image.
        results.push(await probe("cmd-taskkill-missing", systemExe("cmd.exe"), ["/d", "/c", "taskkill /F /IM definitely-not-a-real-image.exe"], pipe));
        results.push(await probe("cmd-tasklist-missing", systemExe("cmd.exe"), ["/d", "/c", "tasklist /FI \"IMAGENAME eq definitely-not-a-real-image.exe\" /NH & echo exit=%errorlevel%"], pipe));

        // Housekeeping: an earlier version of this plugin left a one-shot task whose
        // action was a truncated path, and running it is what produced the
        // "file is corrupted" dialog. Query it, then remove it.
        results.push(await probe("stale-task-query", systemExe("schtasks.exe"), ["/query", "/tn", STALE_TASK, "/fo", "LIST", "/v"], pipe));
        results.push(await probe("stale-task-delete", systemExe("schtasks.exe"), ["/delete", "/tn", STALE_TASK, "/f"], pipe));

        sendJson(response, 200, {
          ok: true,
          selfcheck: true,
          tmpdir: dir,
          platform: process.platform,
          execPath: process.execPath,
          resourcesPath: process.resourcesPath ?? null,
          systemRoot: process.env.SystemRoot ?? null,
          wscriptOnDisk: existsSync(systemExe("wscript.exe")),
          lastLaunchError,
          markers: { hiddenBatch: existsSync(batchFile) },
          results
        });
      }
    });

    return () => {
      for (const dispose of [ping, restart, selfcheck]) {
        if (typeof dispose === "function") dispose();
      }
    };
  }, "dsh-restart-foot: routes");
}

export { apply, desktopExecutable, inject, name, writeHelper };