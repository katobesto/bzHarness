import path from "node:path";
import fs from "node:fs";
import fastglob from "fast-glob";
import { resolveInSandbox } from "../util/contain.js";

function relDir(session, p) {
  if (!p) return null;
  const abs = resolveInSandbox(session.workdir, p, { mustExist: true });
  const r = path.relative(session.workdir, abs);
  return r ? r.split(path.sep).join("/") : "";
}

export const globFiles = {
  name: "glob_files",
  description: "Busca ficheros por patron glob dentro del sandbox (p.ej. 'src/**/*.js'). Devuelve rutas relativas.",
  parameters: {
    type: "object",
    properties: {
      pattern: { type: "string", description: "patron glob, p.ej. '**/*.json'" },
      path: { type: "string", description: "subdirectorio relativo opcional donde buscar" }
    },
    required: ["pattern"]
  },
  async run(args, ctx) {
    const { session } = ctx;
    const dir = relDir(session, args.path);
    const pattern = dir ? path.posix.join(dir, args.pattern) : args.pattern;
    const results = await fastglob(pattern, { cwd: session.workdir, onlyFiles: true, dot: true, followSymbolicLinks: false });
    if (!results.length) return "(sin coincidencias)";
    const shown = results.slice(0, 500);
    return shown.join("\n") + (results.length > 500 ? `\n… (+${results.length - 500} más)` : "");
  }
};

export const grepFiles = {
  name: "grep_files",
  description: "Busca un patron regex en el contenido de ficheros del sandbox (solo ficheros de texto). Devuelve 'ruta:linea: texto'.",
  parameters: {
    type: "object",
    properties: {
      pattern: { type: "string", description: "expresion regular (sintaxis JS)" },
      path: { type: "string", description: "subdirectorio relativo opcional" },
      include: { type: "string", description: "patron glob de ficheros a incluir, p.ej. '**/*.js'" }
    },
    required: ["pattern"]
  },
  async run(args, ctx) {
    const { session } = ctx;
    let re;
    try {
      re = new RegExp(args.pattern);
    } catch (e) {
      throw new Error(`regex inválida: ${e.message}`);
    }
    const dir = relDir(session, args.path);
    const base = dir ? path.posix.join(dir, "**/*") : "**/*";
    const pattern = args.include ? (dir ? path.posix.join(dir, args.include) : args.include) : base;
    const files = await fastglob(pattern, {
      cwd: session.workdir,
      onlyFiles: true,
      dot: true,
      followSymbolicLinks: false,
      ignore: [".bzharness/**", "node_modules/**"]
    });

    const matches = [];
    let scanned = 0;
    for (const f of files) {
      if (matches.length >= 200) break;
      if (scanned >= 2000) break;
      scanned++;
      let abs;
      try {
        abs = resolveInSandbox(session.workdir, f, { mustExist: true });
      } catch {
        continue;
      }
      let st;
      try {
        st = fs.statSync(abs);
      } catch {
        continue;
      }
      if (st.size > 2_000_000) continue;
      let text;
      try {
        text = fs.readFileSync(abs, "utf8");
      } catch {
        continue;
      }
      if (text.includes("\u0000")) continue;
      const lines = text.split(/\r?\n/);
      for (let i = 0; i < lines.length && matches.length < 200; i++) {
        if (re.test(lines[i])) {
          const l = lines[i].trim();
          matches.push(`${f}:${i + 1}: ${l.length > 300 ? l.slice(0, 300) + "…" : l}`);
        }
      }
    }
    if (!matches.length) return "(sin coincidencias)";
    return matches.join("\n") + (matches.length >= 200 ? "\n… (límite de 200 coincidencias)" : "");
  }
};