import fs from "node:fs";
import path from "node:path";

export class SandboxError extends Error {}

const norm = (p) => (process.platform === "win32" ? String(p).toLowerCase() : String(p));

export function resolveInSandbox(workdir, p, { mustExist = false } = {}) {
  if (typeof p !== "string" || !p.trim()) throw new SandboxError("ruta vacía");
  const root = path.resolve(workdir);
  const target = path.isAbsolute(p) ? path.resolve(p) : path.resolve(root, p);
  if (norm(target) !== norm(root) && !norm(target).startsWith(norm(root) + path.sep)) {
    throw new SandboxError(`ruta fuera del sandbox: ${p}`);
  }
  if (mustExist || fs.existsSync(target)) {
    const real = fs.realpathSync(target);
    const realRoot = fs.realpathSync(root);
    if (norm(real) !== norm(realRoot) && !norm(real).startsWith(norm(realRoot) + path.sep)) {
      throw new SandboxError(`el symlink escapa del sandbox: ${p}`);
    }
  }
  return target;
}