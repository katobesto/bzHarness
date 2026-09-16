import fs from "node:fs";
import path from "node:path";
import { resolveInSandbox } from "../util/contain.js";

function relPath(session, abs) {
  return path.relative(session.workdir, abs).split(path.sep).join("/");
}

export const fileRead = {
  name: "file_read",
  description: "Lee un fichero de texto del sandbox y devuelve sus lineas numeradas. Para ficheros grandes usa offset (linea inicial, 1-based) y limit.",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "ruta relativa al sandbox (o absoluta dentro del sandbox)" },
      offset: { type: "integer", minimum: 1, description: "linea inicial (1-based)" },
      limit: { type: "integer", minimum: 1, maximum: 20000, description: "maximo de lineas (por defecto 2000)" }
    },
    required: ["path"]
  },
  async run(args, ctx) {
    const { session } = ctx;
    const abs = resolveInSandbox(session.workdir, args.path, { mustExist: true });
    const st = fs.statSync(abs);
    let bin = false;
    try {
      const probe = fs.openSync(abs, "r");
      const buf = Buffer.alloc(8192);
      const n = fs.readSync(probe, buf, 0, buf.length, 0);
      fs.closeSync(probe);
      bin = buf.subarray(0, n).includes(0);
    } catch {
      bin = false;
    }
    if (bin) throw new Error(`fichero binario: ${args.path}`);
    if (st.size > 1_000_000 && !args.offset && !args.limit) {
      throw new Error(`fichero grande (${st.size} bytes); usa offset y limit para leerlo por partes`);
    }
    const text = fs.readFileSync(abs, "utf8");
    const lines = text.split(/\r?\n/);
    const start = Math.max(1, args.offset || 1);
    const end = Math.min(lines.length, start + (args.limit || 2000) - 1);
    const body = lines
      .slice(start - 1, end)
      .map((l, i) => `${start + i}: ${l.length > 2000 ? l.slice(0, 2000) + "…" : l}`)
      .join("\n");
    return `lineas ${start}-${end} de ${lines.length} (${relPath(session, abs)})\n${body}`;
  }
};

export const fileWrite = {
  name: "file_write",
  description: "Crea o sobrescribe un fichero dentro del sandbox. Crea las carpetas padre si hacen falta.",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "ruta relativa al sandbox" },
      content: { type: "string", description: "contenido completo del fichero" }
    },
    required: ["path", "content"]
  },
  async run(args, ctx) {
    const { session } = ctx;
    const abs = resolveInSandbox(session.workdir, args.path);
    if (typeof args.content !== "string") throw new Error("content debe ser una cadena");
    const existed = fs.existsSync(abs);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, args.content);
    return `${existed ? "Actualizado" : "Creado"} ${relPath(session, abs)} (${args.content.length} caracteres)`;
  }
};

export const fileEdit = {
  name: "file_edit",
  description:
    "Edicion exacta: sustituye oldString por newString en el fichero. oldString debe incluir contexto suficiente para ser unico. Usa replaceAll=true para sustituir todas las ocurrencias.",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "ruta relativa al sandbox" },
      oldString: { type: "string", description: "texto exacto a localizar (con contexto suficiente)" },
      newString: { type: "string", description: "texto de reemplazo" },
      replaceAll: { type: "boolean", description: "sustituir todas las ocurrencias" }
    },
    required: ["path", "oldString", "newString"]
  },
  async run(args, ctx) {
    const { session } = ctx;
    const abs = resolveInSandbox(session.workdir, args.path, { mustExist: true });
    const text = fs.readFileSync(abs, "utf8");
    let count = 0;
    let idx = 0;
    while ((idx = text.indexOf(args.oldString, idx)) !== -1) {
      count++;
      idx += args.oldString.length;
    }
    if (count === 0) throw new Error("oldString no se encuentra en el fichero; verifica el texto exacto (espacios, tabs)");
    if (count > 1 && !args.replaceAll) {
      throw new Error(`${count} ocurrencias encontradas; añade contexto a oldString o usa replaceAll=true`);
    }
    const next = args.replaceAll ? text.split(args.oldString).join(args.newString) : text.replace(args.oldString, args.newString);
    fs.writeFileSync(abs, next);
    return `Editado ${relPath(session, abs)}: ${count} sustitucion(es)`;
  }
};