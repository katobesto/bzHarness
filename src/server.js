import express from "express";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { fileURLToPath, pathToFileURL } from "node:url";
import { loadConfig, saveConfig, maskConfig, loadIndex, saveIndex } from "./config.js";
import { listModels } from "./llm.js";
import { runAgent } from "./agent.js";
import { resolveInSandbox } from "./util/contain.js";

const ROOT = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
let cfg = loadConfig();

const SCRIPTS_DIR = process.env.HARNESS_SCRIPTS ? path.resolve(process.env.HARNESS_SCRIPTS) : path.join(ROOT, "scripts");
const CRASH_LOG = path.join(ROOT, "config", "crash.log");
function crashLog(kind, e) {
  try {
    fs.mkdirSync(path.dirname(CRASH_LOG), { recursive: true });
    fs.appendFileSync(CRASH_LOG, `\n=== ${new Date().toISOString()} ${kind} ===\n${(e && e.stack) || String(e)}\n`);
    console.error(`[bzHarness] ${kind} capturado (servicio sigue vivo):`, e && e.message);
  } catch {
    /* sin log */
  }
}
process.on("uncaughtException", (e) => crashLog("uncaughtException", e));
process.on("unhandledRejection", (e) => crashLog("unhandledRejection", e));

const app = express();
app.use(express.json({ limit: "4mb" }));
app.use(express.static(path.join(ROOT, "public"), { setHeaders: (res) => res.setHeader("Cache-Control", "no-store") }));

const sessions = new Map();
const activeRuns = new Map();
const uploadQueue = new Map();

function persistSession(session) {
  const dir = path.join(session.workdir, ".bzharness", "sessions");
  fs.mkdirSync(dir, { recursive: true });
  const { bzharnessDir, ...meta } = session;
  fs.writeFileSync(path.join(dir, session.id + ".json"), JSON.stringify({ ...meta, messages: session.messages }, null, 1));
}

function updateIndexEntry(session) {
  const list = loadIndex();
  const i = list.findIndex((s) => s.id === session.id);
  const entry = {
    id: session.id,
    name: session.name,
    workdir: session.workdir,
    model: session.model,
    createdAt: session.createdAt,
    updatedAt: new Date().toISOString()
  };
  if (i >= 0) list[i] = entry;
  else list.unshift(entry);
  saveIndex(list);
}

function getOrLoad(id) {
  if (sessions.has(id)) return sessions.get(id);
  const entry = loadIndex().find((s) => s.id === id);
  if (!entry) return null;
  try {
    const f = path.join(entry.workdir, ".bzharness", "sessions", id + ".json");
    const data = JSON.parse(fs.readFileSync(f, "utf8"));
    const session = { ...entry, messages: data.messages || [], bzharnessDir: path.join(entry.workdir, ".bzharness") };
    sessions.set(id, session);
    return session;
  } catch {
    return null;
  }
}

function abortRun(run) {
  run.ac.abort();
  for (const resolve of run.approvals.values()) resolve(false);
  run.approvals.clear();
  for (const child of run.children) {
    try {
      child.kill();
    } catch {
      /* ignore */
    }
  }
}

function writeErrorLog(session, detail) {
  try {
    const dir = path.join(session.bzharnessDir, "llm-errors");
    fs.mkdirSync(dir, { recursive: true });
    const ts = new Date().toISOString().replace(/[:.]/g, "-");
    const f = path.join(dir, `${ts}-llm-error.log`);
    fs.writeFileSync(f, JSON.stringify(detail, null, 2));
    return path.relative(session.workdir, f).split(path.sep).join("/");
  } catch {
    return null;
  }
}

app.get("/api/config", (req, res) => res.json(maskConfig(cfg)));

app.put("/api/config", (req, res) => {
  const patch = { ...(req.body || {}) };
  if (typeof patch.apiKey === "string" && (patch.apiKey === "" || patch.apiKey.startsWith("•"))) delete patch.apiKey;
delete patch.port;
    delete patch.browsableRoots;
    if (Array.isArray(patch.workspacePresets) === false && patch.workspacePresets !== undefined) patch.workspacePresets = String(patch.workspacePresets).split("\n").filter(Boolean);
  try {
    const saved = saveConfig(patch);
    cfg = { ...saved, apiKey: saved.apiKey || process.env.HARNESS_API_KEY || "" };
    res.json(maskConfig(cfg));
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.get("/api/models", async (req, res) => {
  if (!cfg.apiKey) return res.json({ models: [], error: "Falta la API key en la configuración" });
  try {
    const models = await listModels(cfg);
    res.json({ models, error: null });
  } catch (e) {
    res.json({ models: [], error: e.message });
  }
});

app.get("/api/workspaces", (req, res) =>
  res.json({ defaultWorkdir: cfg.defaultWorkdir, presets: cfg.workspacePresets })
);

app.post("/api/pick-dir", async (req, res) => {
  const start = typeof req.body?.start === "string" && req.body.start.trim() ? path.resolve(req.body.start.trim()) : "C:\\";
  const script = path.join(SCRIPTS_DIR, "pick-dir.ps1");
  let out = "";
  try {
    out = await new Promise((resolve) => {
      const child = spawn("powershell", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", script, start], { windowsHide: true });
      let o = "";
      child.stdout.on("data", (d) => (o += d));
      child.stderr.on("data", (d) => (o += d));
      child.on("error", () => {});
      const t = setTimeout(() => {
        try {
          child.kill();
        } catch {
          /* ignore */
        }
      }, 180000);
      child.on("close", () => {
        clearTimeout(t);
        resolve(o);
      });
    });
  } catch (e) {
    return res.status(500).json({ error: "no se pudo abrir el selector: " + e.message });
  }
  const m = out.match(/[A-Za-z]:\\[^\r\n]+/);
  res.json({ path: m ? m[0].trim() : null });
});

app.post("/api/sessions", (req, res) => {
  const { name, workdir, model } = req.body || {};
  if (!workdir || typeof workdir !== "string" || !path.isAbsolute(path.resolve(workdir))) {
    return res.status(400).json({ error: "workdir debe ser una ruta absoluta" });
  }
  const wd = path.resolve(workdir);
  try {
    fs.mkdirSync(wd, { recursive: true });
    const bz = path.join(wd, ".bzharness");
    fs.mkdirSync(path.join(bz, "sessions"), { recursive: true });
    fs.mkdirSync(path.join(bz, "runs"), { recursive: true });
    fs.writeFileSync(path.join(bz, ".gitignore"), "*\n");
    const id = "ses_" + randomUUID().slice(0, 8);
    const session = {
      id,
      name: (name || "").trim() || path.basename(wd) || wd,
      workdir: wd,
      model: model || null,
      createdAt: new Date().toISOString(),
      messages: [],
      bzharnessDir: bz
    };
    sessions.set(id, session);
    persistSession(session);
    const list = loadIndex().filter((s) => s.id !== id);
    list.unshift({ id, name: session.name, workdir: wd, model: session.model, createdAt: session.createdAt });
    saveIndex(list);
    res.json({ id, name: session.name, workdir: wd, model: session.model, createdAt: session.createdAt });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.get("/api/sessions", (req, res) => {
  res.json(loadIndex().map((s) => ({ ...s, busy: activeRuns.has(s.id) })));
});

app.get("/api/sessions/:id", (req, res) => {
  const s = getOrLoad(req.params.id);
  if (!s) return res.status(404).json({ error: "sesión no encontrada" });
  const { bzharnessDir, ...out } = s;
  res.json(out);
});

app.get("/api/sessions/:id/file", (req, res) => {
  const s = getOrLoad(req.params.id);
  if (!s) return res.status(404).json({ error: "sesión no encontrada" });
  const p = req.query.path;
  if (typeof p !== "string" || !p) return res.status(400).json({ error: "path requerido" });
  let abs;
  try {
    abs = resolveInSandbox(s.workdir, p, { mustExist: true });
  } catch {
    return res.status(404).json({ error: "fichero no encontrado o fuera del sandbox" });
  }
  const mime = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp", ".bmp": "image/bmp" }[path.extname(abs).toLowerCase()];
  if (!mime) return res.status(415).json({ error: "solo se sirven imagenes (png, jpg, jpeg, gif, webp, bmp)" });
  const st = fs.statSync(abs);
  if (st.size > 15 * 1024 * 1024) return res.status(413).json({ error: "imagen demasiado grande" });
  res.setHeader("Content-Type", mime);
  res.setHeader("Cache-Control", "no-store");
  fs.createReadStream(abs).pipe(res);
});

const ATTACH_DIR = ".attachments";
const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;
const MAX_UPLOADS = 8;

app.post("/api/sessions/:id/upload", (req, res) => {
  const s = getOrLoad(req.params.id);
  if (!s) return res.status(404).json({ error: "sesión no encontrada" });
  const files = req.body?.files;
  if (!Array.isArray(files) || !files.length) return res.status(400).json({ error: "files requerido" });
  if (files.length > MAX_UPLOADS) return res.status(400).json({ error: `máximo ${MAX_UPLOADS} ficheros por mensaje` });
  const dir = path.join(s.workdir, ATTACH_DIR);
  fs.mkdirSync(dir, { recursive: true });
  const saved = [];
  for (const f of files) {
    if (typeof f?.name !== "string" || typeof f?.b64 !== "string") return res.status(400).json({ error: "fichero inválido" });
    let name = path.basename(f.name).replace(/[\\/:*?"<>|\u0000-\u001f]/g, "_").slice(0, 80).trim();
    if (!name || name.startsWith(".")) return res.status(400).json({ error: "nombre de fichero inválido: " + f.name });
    const buf = Buffer.from(f.b64, "base64");
    if (!buf.length) return res.status(400).json({ error: `fichero vacío: ${name}` });
    if (buf.length > MAX_UPLOAD_BYTES) return res.status(413).json({ error: `fichero demasiado grande: ${name} (máx 10 MB)` });
    let rel = name, n = 1;
    while (fs.existsSync(path.join(dir, rel))) {
      const dot = name.lastIndexOf(".");
      rel = dot > 0 ? `${name.slice(0, dot)} (${n})${name.slice(dot)}` : `${name} (${n})`;
      n++;
    }
    fs.writeFileSync(path.join(dir, rel), buf);
    const mime = f.mime || "application/octet-stream";
    const isImage = /^image\/(png|jpe?g|gif|webp|bmp)$/.test(mime);
    saved.push({
      relPath: `${ATTACH_DIR}/${rel}`,
      mime,
      bytes: buf.length,
      image: isImage,
      b64: isImage ? f.b64 : undefined
    });
  }
  const q = uploadQueue.get(s.id) || [];
  q.push(...saved);
  uploadQueue.set(s.id, q);
  res.json({ ok: true, files: saved.map(({ b64, ...x }) => x) });
});

app.delete("/api/sessions/:id", (req, res) => {
  const id = req.params.id;
  const s = getOrLoad(id);
  if (s && activeRuns.has(id)) return res.status(409).json({ error: "la sesión tiene una ejecución activa" });
  if (s) {
    try {
      fs.rmSync(path.join(s.workdir, ".bzharness", "sessions", id + ".json"), { force: true });
    } catch {
      /* ignore */
    }
  }
  sessions.delete(id);
  saveIndex(loadIndex().filter((x) => x.id !== id));
  res.json({ ok: true });
});

app.post("/api/approvals/:id", (req, res) => {
  for (const run of activeRuns.values()) {
    const resolve = run.approvals.get(req.params.id);
    if (resolve) {
      resolve(!!(req.body && req.body.approved));
      run.approvals.delete(req.params.id);
      return res.json({ ok: true });
    }
  }
  res.status(404).json({ error: "aprobación no encontrada" });
});

app.post("/api/stop/:sessionId", (req, res) => {
  const run = activeRuns.get(req.params.sessionId);
  if (!run) return res.status(404).json({ error: "sin ejecución activa" });
  abortRun(run);
  res.json({ ok: true });
});

app.post("/api/open-dir", (req, res) => {
  const session = getOrLoad(req.body?.sessionId);
  if (!session) return res.status(404).json({ error: "sesión no encontrada" });
  const dir = path.resolve(session.workdir);
  const cmd = process.platform === "win32" ? "explorer" : process.platform === "darwin" ? "open" : "xdg-open";
  try {
    const child = spawn(cmd, [dir], { detached: true, stdio: "ignore" });
    child.on("error", () => {});
    child.unref();
res.json({ ok: true, dir });
  } catch (e) {
    res.status(500).json({ error: "no se pudo abrir el explorador: " + e.message });
  }
});

app.post("/api/chat", async (req, res) => {
  const { sessionId, message } = req.body || {};
  const session = getOrLoad(sessionId);
  if (!session) return res.status(404).json({ error: "sesión no encontrada" });
  if (!message || !String(message).trim()) return res.status(400).json({ error: "message requerido" });
  if (activeRuns.has(session.id)) return res.status(409).json({ error: "la sesión ya tiene una ejecución activa" });

  const ac = new AbortController();
  const run = { ac, signal: ac.signal, children: new Set(), approvals: new Map(), calls: [], pendingImages: [] };
  const onCall = (info) => {
    info.n = run.calls.length + 1;
    run.calls.push(info);
  };
  activeRuns.set(session.id, run);
  let finished = false;
  res.on("close", () => {
    if (!finished && activeRuns.get(session.id) === run) abortRun(run);
  });

  res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  if (res.flushHeaders) res.flushHeaders();
  res.on("error", () => {});
  const emit = (ev) => {
    if (!res.writableEnded && res.writable) res.write("data: " + JSON.stringify(ev) + "\n\n");
  };
  const onRetry = (attempt, waitMs) => {
    const info = { ok: false, retry: true, attempt, waitMs, note: "reintento programado" };
    info.n = run.calls.length + 1;
    run.calls.push(info);
    emit({ type: "retry", attempt, waitMs, maxAttempts: 4 });
  };
  const onThink = cfg.showThinking ? (t) => emit({ type: "think", content: t }) : undefined;

  let model = session.model || null;
  if (!model || model === "auto") {
    if (cfg.model && cfg.model !== "auto") model = cfg.model;
    else {
      try {
        const ms = await listModels(cfg);
        model = ms.find((m) => !m.includes("/")) || ms[0] || null;
      } catch {
        model = null;
      }
    }
  }
  if (!cfg.apiKey) {
    const m = "Falta la API key. Añádela en Configuración.";
    session.messages.push({ role: "error", content: "⚠ " + m });
    emit({ type: "error", message: m });
    emit({ type: "done", aborted: false, model: null });
    emit({ type: "end" });
    finished = true;
    activeRuns.delete(session.id);
    res.end();
    return;
  }
  if (!model) {
    const m =
      "No se pudo determinar el modelo (detección /v1/models falló y model=auto). Fija un modelo concreto en Configuración o en la sesión.";
    session.messages.push({ role: "error", content: "⚠ " + m });
    emit({ type: "error", message: m });
    emit({ type: "done", aborted: false, model: null });
    emit({ type: "end" });
    finished = true;
    activeRuns.delete(session.id);
    res.end();
    return;
  }

  const approve = async (command) => {
    if (!cfg.shellApproval) return true;
    const id = "ap_" + randomUUID().slice(0, 6);
    emit({ type: "approval_request", id, command });
    const ok = await new Promise((r) => run.approvals.set(id, r));
    run.approvals.delete(id);
    emit({ type: "approval_resolved", id, approved: ok });
    return ok;
  };

  let aborted = false;
  try {
    let userMessage = String(message);
    const up = uploadQueue.get(session.id);
    if (up && up.length) {
      uploadQueue.delete(session.id);
      for (const u of up) if (u.image) run.pendingImages.push({ path: u.relPath, mime: u.mime, bytes: u.bytes, b64: u.b64 });
      const refs = up.map((u) => u.relPath + (u.image ? " (imagen)" : "")).join(", ");
      userMessage += `\n\n[Adjuntos que acabas de enviar, copiados al sandbox: ${refs}]`;
    }
    await runAgent({ cfg, model, session, userMessage, emit, signal: ac.signal, run, approve, onCall, onRetry, onThink });
  } catch (e) {
    if (e?.name === "AbortError" || ac.signal.aborted) aborted = true;
    else {
      const retried = run.calls.filter((c) => c.retry).length;
      const msg = retried ? `${e.message} (tras ${retried} reintentos)` : e.message;
      const detail =
        e && e.detail
          ? { ...e.detail, calls: run.calls, model, baseUrl: cfg.baseUrl }
          : { ts: new Date().toISOString(), error: e.message, model: model || null, baseUrl: cfg.baseUrl, calls: run.calls };
      detail.logFile = writeErrorLog(session, detail);
      session.messages.push({ role: "error", content: "⚠ " + msg, detail });
      emit({ type: "error", message: msg, detail });
    }
  }
  if (ac.signal.aborted) aborted = true;
  emit({ type: "done", aborted, model });
  emit({ type: "end" });

  for (const resolve of run.approvals.values()) resolve(false);
  run.approvals.clear();
  for (const child of run.children) {
    try {
      child.kill();
    } catch {
      /* ignore */
    }
  }
  activeRuns.delete(session.id);
  try {
    persistSession(session);
    updateIndexEntry(session);
  } catch (e) {
    emit({ type: "error", message: "error al guardar la sesión: " + e.message });
  }
  finished = true;
  res.end();
});

export function startServer({ port = cfg.port, host = "127.0.0.1" } = {}) {
  return new Promise((resolve, reject) => {
    const server = app.listen(port, host, () => {
      const actual = server.address().port;
      console.log(`bzHarness by Benzo listo -> http://${host}:${actual}`);
      console.log(`  workdir por defecto: ${cfg.defaultWorkdir}`);
      console.log(`  LLM: ${cfg.baseUrl} (model: ${cfg.model || "auto"})`);
      resolve({ server, url: `http://${host}:${actual}`, port: actual });
    });
    server.on("error", reject);
  });
}

let isCli = false;
try {
  isCli = pathToFileURL(path.resolve(process.argv[1] || "")).href === import.meta.url;
} catch {
  /* no cli */
}
if (isCli) {
  startServer().catch((e) => {
    console.error("bzHarness no pudo arrancar:", e && e.message);
    process.exit(1);
  });
}