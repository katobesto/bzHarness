import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { resolveInSandbox } from "../util/contain.js";

function killTree(child) {
  if (child.exitCode !== null || child.killed || !child.pid) return;
  try {
    if (process.platform === "win32") {
      const killer = spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
      killer.on("error", () => {});
    } else {
      child.kill("SIGKILL");
    }
  } catch {
    /* ignore */
  }
}

export const shellExec = {
  name: "shell_exec",
  description:
    "Ejecuta un comando en la shell de Windows dentro del sandbox (cwd = raiz del sandbox o una subcarpeta relativa). Devuelve la salida combinada. Usar para builds, tests, git, ejecutar scripts, etc.",
  parameters: {
    type: "object",
    properties: {
      command: { type: "string", description: "linea de comando, p.ej. 'node script.js'" },
      workdir: { type: "string", description: "subcarpeta relativa opcional dentro del sandbox" }
    },
    required: ["command"]
  },
  async run(args, ctx) {
    const { cfg, session, signal, run, approve } = ctx;
    const cwd = args.workdir ? resolveInSandbox(session.workdir, args.workdir, { mustExist: true }) : session.workdir;

    const approved = await approve(args.command);
    if (approved === false) return "Comando rechazado por el usuario. No lo reintentes; pide al usuario como desea proceder.";
    if (signal?.aborted) return "Ejecución abortada por el usuario.";

    const runsDir = path.join(session.bzharnessDir, "runs");
    fs.mkdirSync(runsDir, { recursive: true });
    const ts = new Date().toISOString().replace(/[:.]/g, "-");
    const slug = args.command.replace(/[^\w]+/g, "_").slice(0, 40) || "cmd";
    const logPath = path.join(runsDir, `${ts}-${slug}.log`);

    const child = spawn(args.command, { cwd, shell: true, windowsHide: true, env: { ...process.env } });
    run.children.add(child);
    let out = "";
    let spawnErr = null;
    let timedOut = false;
    const t0 = Date.now();
    const timer = setTimeout(() => {
      timedOut = true;
      killTree(child);
    }, cfg.shellTimeoutMs);
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (out += d));
    child.on("error", (e) => {
      spawnErr = e;
    });
    await new Promise((res) => {
      const done = () => res();
      child.on("close", done);
      child.on("error", done);
      if (signal) signal.addEventListener("abort", () => killTree(child), { once: true });
    });
    clearTimeout(timer);
    run.children.delete(child);
    const durationMs = Date.now() - t0;

    fs.writeFileSync(
      logPath,
      `command: ${args.command}\ncwd: ${cwd}\ntimed_out: ${timedOut}\nduration_ms: ${durationMs}\n---\n${out}`
    );

    let shown = out;
    if (shown.length > 30000) {
      shown = shown.slice(0, 30000) + `\n… [truncado; log completo: .bzharness/runs/${path.basename(logPath)}]`;
    }
    const status = timedOut ? `TIMEOUT tras ${cfg.shellTimeoutMs}ms` : spawnErr ? `ERROR de arranque: ${spawnErr.message}` : "ok";
    return `[${status} en ${durationMs}ms]\n${shown.trim() || "(sin salida)"}`;
  }
};