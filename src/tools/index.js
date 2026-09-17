import { shellExec } from "./shell.js";
import { fileRead, fileWrite, fileEdit, imageRead } from "./files.js";
import { globFiles, grepFiles } from "./search.js";
import { SandboxError } from "../util/contain.js";

const ALL = [shellExec, fileRead, fileWrite, fileEdit, imageRead, globFiles, grepFiles];
const byName = Object.fromEntries(ALL.map((t) => [t.name, t]));

export const TOOLS = ALL.map((t) => ({
  type: "function",
  function: { name: t.name, description: t.description, parameters: t.parameters }
}));

export async function runTool(name, args, ctx) {
  const tool = byName[name];
  if (!tool) return { ok: false, output: `herramienta desconocida: ${name}` };
  try {
    const out = await tool.run(args || {}, ctx);
    return { ok: true, output: out };
  } catch (e) {
    if (e instanceof SandboxError) return { ok: false, output: `VIOLACION DE SANDBOX: ${e.message}` };
    return { ok: false, output: e.message };
  }
}