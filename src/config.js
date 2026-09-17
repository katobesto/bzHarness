import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HOME = process.env.HARNESS_HOME ? path.resolve(process.env.HARNESS_HOME) : null;
// En empaquetado (Electron) HARNESS_HOME apunta a %APPDATA%/bzHarness; en CLI, raíz del repo.
const ROOT = HOME || path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const PACKAGED = !!HOME;
const CONFIG_DIR = path.join(ROOT, "config");
const CONFIG_PATH = path.join(CONFIG_DIR, "config.json");
export const INDEX_PATH = path.join(CONFIG_DIR, "sessions-index.json");

function defaults() {
  const wd = PACKAGED ? process.env.USERPROFILE || path.join(ROOT, "workspace") : ROOT;
  return {
    baseUrl: "https://api.openrouter.ai/v1",
    apiKey: "",
    model: "auto",
    maxContextTokens: 32000,
    maxOutputTokens: 8192,
    temperature: 0.2,
    defaultWorkdir: wd,
    workspacePresets: [wd],
    shellApproval: false,
    showThinking: false,
    shellTimeoutMs: 60000,
    port: 4321
  };
}
const DEFAULTS = defaults();

function ensureConfigDir() {
  fs.mkdirSync(CONFIG_DIR, { recursive: true });
  fs.writeFileSync(path.join(CONFIG_DIR, ".gitignore"), "*\n");
}

export function rawConfig() {
  ensureConfigDir();
  if (!fs.existsSync(CONFIG_PATH)) {
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(DEFAULTS, null, 2));
  }
  return JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8").replace(/^\uFEFF/, ""));
}

export function loadConfig() {
  const cfg = { ...DEFAULTS, ...rawConfig() };
  if (!cfg.apiKey) cfg.apiKey = process.env.HARNESS_API_KEY || "";
  return cfg;
}

export function saveConfig(patch = {}) {
  const next = { ...DEFAULTS, ...rawConfig(), ...patch };
  delete next.browsableRoots;
  validate(next);
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(next, null, 2));
  return next;
}

export function validate(c) {
  const need = (v, k) => {
    if (typeof v !== "string" || !v.trim()) throw new Error(`config: ${k} no válido`);
  };
  need(c.baseUrl, "baseUrl");
  if (!/^https?:\/\//.test(c.baseUrl)) throw new Error("config: baseUrl debe empezar por http(s)://");
  for (const k of ["maxContextTokens", "maxOutputTokens", "shellTimeoutMs", "port"]) {
    if (!Number.isInteger(c[k]) || c[k] <= 0) throw new Error(`config: ${k} debe ser un entero > 0`);
  }
  if (c.maxOutputTokens > c.maxContextTokens) throw new Error("config: maxOutputTokens no puede superar maxContextTokens");
  if (typeof c.temperature !== "number" || c.temperature < 0 || c.temperature > 2) throw new Error("config: temperature debe estar en [0, 2]");
  for (const k of ["workspacePresets"]) {
    if (!Array.isArray(c[k]) || !c[k].every((x) => typeof x === "string")) throw new Error(`config: ${k} debe ser un array de cadenas`);
  }
  need(c.defaultWorkdir, "defaultWorkdir");
  if (typeof c.shellApproval !== "boolean") throw new Error("config: shellApproval debe ser booleano");
  if (typeof c.showThinking !== "boolean") throw new Error("config: showThinking debe ser booleano");
  need(c.model, "model");
}

export function maskConfig(c) {
  const m = { ...c };
  m.apiKey = m.apiKey ? "••••" + String(m.apiKey).slice(-4) : "";
  return m;
}

export function loadIndex() {
  try {
    return JSON.parse(fs.readFileSync(INDEX_PATH, "utf8"));
  } catch {
    return [];
  }
}

export function saveIndex(list) {
  ensureConfigDir();
  fs.writeFileSync(INDEX_PATH, JSON.stringify(list, null, 2));
}