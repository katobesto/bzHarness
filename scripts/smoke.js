import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { runTool } from "../src/tools/index.js";

const wd = fs.mkdtempSync(path.join(os.tmpdir(), "bzharness-smoke-"));
const bz = path.join(wd, ".bzharness");
fs.mkdirSync(path.join(bz, "runs"), { recursive: true });

const session = { id: "smoke", workdir: wd, bzharnessDir: bz };
const ctx = {
  cfg: { shellApproval: false, shellTimeoutMs: 20000 },
  session,
  emit: () => {},
  signal: undefined,
  run: { children: new Set(), approvals: new Map() },
  approve: async () => true
};

let pass = 0;
let fail = 0;
function check(name, cond, extra = "") {
  if (cond) {
    pass++;
    console.log("ok   -", name);
  } else {
    fail++;
    console.log("FAIL -", name, extra);
  }
}

const r = (name, args) => runTool(name, args, ctx);

let x = await r("file_write", { path: "src/hola.txt", content: "hola mundo\nsegunda linea\n" });
check("file_write crea fichero", x.ok, x.output);
x = await r("file_read", { path: "src/hola.txt" });
check("file_read", x.ok && x.output.includes("hola mundo"), x.output);
x = await r("file_edit", { path: "src/hola.txt", oldString: "hola mundo", newString: "hola bz" });
check("file_edit", x.ok, x.output);
x = await r("file_edit", { path: "src/hola.txt", oldString: "NO_EXISTE", newString: "x" });
check("file_edit no encontrado -> error", !x.ok, x.output);
x = await r("file_write", { path: "ambig.txt", content: "duplicado\nduplicado\n" });
x = await r("file_edit", { path: "ambig.txt", oldString: "duplicado", newString: "unico" });
check("file_edit ambiguo -> error", !x.ok, x.output);
x = await r("file_edit", { path: "ambig.txt", oldString: "duplicado", newString: "unico", replaceAll: true });
check("file_edit replaceAll -> ok", x.ok, x.output);
x = await r("glob_files", { pattern: "**/*.txt" });
check("glob_files", x.ok && x.output.includes("src/hola.txt"), x.output);
x = await r("grep_files", { pattern: "bz" });
check("grep_files", x.ok && x.output.includes("hola bz"), x.output);
x = await r("shell_exec", { command: 'node -e "console.log(\'ping\')"' });
check("shell_exec", x.ok && x.output.includes("ping"), x.output);
x = await r("file_write", { path: "../escape.txt", content: "x" });
check("sandbox: ../ bloqueado", !x.ok && /sandbox|fuera/i.test(x.output), x.output);
x = await r("file_write", { path: "C:\\temp\\nope.txt", content: "x" });
check("sandbox: ruta absoluta fuera bloqueada", !x.ok, x.output);
x = await r("file_read", { path: "no_existe.txt" });
check("file_read inexistente -> error", !x.ok, x.output);
x = await r("tool_inexistente", {});
check("tool desconocida -> error", !x.ok, x.output);
x = await r("shell_exec", { command: "cmd /c exit 3" });
check("shell_exec exit code != 0 -> ok=true con salida", x.ok, x.output);

const logs = fs.readdirSync(path.join(bz, "runs"));
check("logs de comandos en .bzharness/runs", logs.length >= 2, String(logs.length));

fs.rmSync(wd, { recursive: true, force: true });
console.log(`\n${pass} ok, ${fail} fallidos`);
process.exit(fail ? 1 : 0);