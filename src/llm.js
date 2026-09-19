import { estimateMsgTokens } from "./util/tokens.js";

export function joinBase(baseUrl, p) {
  return baseUrl.replace(/\/+$/, "") + p;
}

function extractText(c) {
  if (typeof c === "string") return c;
  if (Array.isArray(c)) {
    return c
      .map((p) => {
        if (typeof p === "string") return p;
        if (p && typeof p === "object") {
          if (p.type && p.type !== "text" && p.type !== "refusal") return "";
          return p.text ?? "";
        }
        return "";
      })
      .join("");
  }
  if (c && typeof c === "object") return c.text ?? "";
  return "";
}

function headers(cfg) {
  const h = {};
  if (cfg.apiKey) h.authorization = `Bearer ${cfg.apiKey}`;
  return h;
}

function snippetSync(t) {
  try {
    const j = JSON.parse(t);
    const m =
      (j && (j.error?.message || j.error?.msg || j.message || j.detail)) ||
      (typeof j?.error === "string" ? j.error : null);
    if (m) return String(m).slice(0, 300);
  } catch {
    /* no es JSON */
  }
  return t
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<[^>]*>/g, " ")
    .replace(/&[a-z#0-9]+;/gi, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 300);
}

async function snippet(res) {
  try {
    return snippetSync(await res.text());
  } catch {
    return "";
  }
}

// ---------------------------------------------------------------------------
// Saneo de cadenas ANTES de enviar al proveedor (sin perdida de contenido):
// normaliza saltos de linea, elimina caracteres de control y repara tags
// incompletos colgados al final de la cadena ( "</" sin su ">"). No se
// truncan contenidos: el endpoint /v1 no tiene limite de tamano.
// ---------------------------------------------------------------------------

function cleanString(s) {
  if (typeof s !== "string" || !s) return s;
  let t = s.replace(/\r\n?/g, "\n");
  t = t.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "");
  t = t.replace(/<\/[a-zA-Z0-9-]*$/, "");
  t = t.replace(/<![^<>]*$/, "");
  t = t.replace(/<\/(?![a-zA-Z!][a-zA-Z0-9-]*[\s>])/g, "< /");
  return t;
}

// El gateway (y la API OpenAI) exigen que tool_calls[].function.arguments sea un
// JSON valido; si no lo es, el proveedor lanza una excepcion no capturada y
// devuelve un 500 HTML (no es un fallo de red/proxy). Un argumento puede quedar
// truncado si el usuario pulsa "Parar" mientras el modelo lo esta escribiendo.
// Se repara a "{}" (una llamada cortada no tiene argumentos utiles) para que el
// historial nunca envenene las peticiones siguientes.
function argsJsonOrEmpty(s) {
  if (typeof s !== "string" || !s.trim()) return "{}";
  try {
    JSON.parse(s);
    return s;
  } catch {
    return "{}";
  }
}

export function sanitizeLLMBody(body) {
  for (const m of body.messages || []) {
    if (typeof m.content === "string") m.content = cleanString(m.content);
    if (Array.isArray(m.tool_calls)) {
      for (const tc of m.tool_calls) {
        if (!tc.function) continue;
        if (typeof tc.function.name === "string") tc.function.name = cleanString(tc.function.name).slice(0, 120);
        if (typeof tc.function.arguments === "string") tc.function.arguments = argsJsonOrEmpty(cleanString(tc.function.arguments));
      }
    }
  }
  return body;
}

export async function listModels(cfg) {
  const res = await fetch(joinBase(cfg.baseUrl, "/models"), { headers: headers(cfg) });
  if (!res.ok) throw new Error(`/v1/models -> HTTP ${res.status} ${await snippet(res)}`.trim());
  const data = await res.json().catch(() => ({}));
  let ids = [];
  if (Array.isArray(data.data)) ids = data.data.map((m) => m.id || m.name).filter(Boolean);
  else if (Array.isArray(data)) ids = data;
  return [...new Set(ids.map(String))].sort();
}

export class LLMError extends Error {
  constructor(message, detail) {
    super(message);
    this.name = "LLMError";
    this.detail = detail;
  }
}

// Sonda por proveedor de soporte para stream_options={include_usage:true} (usage
// dentro del stream, fuente de las metricas de tokens). Se manda en la primera
// llamada; si el gateway la rechaza con 400 mencionando stream_options, se
// desactiva para esa base URL y la llamada se reintenta sin el campo.
const streamOpts = new Map(); // baseUrl -> bool
function streamOptsOn(cfg) {
  if (!streamOpts.has(cfg.baseUrl)) streamOpts.set(cfg.baseUrl, true);
  return streamOpts.get(cfg.baseUrl);
}

function reqSummary(body) {
  const msgs = Array.isArray(body.messages) ? body.messages : [];
  return {
    model: body.model ?? null,
    max_tokens: body.max_tokens ?? null,
    temperature: body.temperature ?? null,
    stream: true,
    messages: msgs.length,
    tools: Array.isArray(body.tools) ? body.tools.length : null,
    approxContextChars: msgs.reduce((s, m) => s + (typeof m.content === "string" ? m.content.length : 0), 0)
  };
}

// Silencio maximo tolerado del stream del gateway (sin tokens ni cierre). Si se
// supera, se corta la conexion y se lanza LLMError (reintentable): evita que una
// ejecucion se quede colgada para siempre si el proveedor deja de enviar sin avisar.
export const LLM_IDLE_TIMEOUT_MS = 90000;

async function chatStreamOnce(cfg, body, { onDelta, onThink, signal, onCall } = {}) {
  sanitizeLLMBody(body);
  // "reasoning" es interno del harness (se persiste en el transcript); "metrics"/
  // "usage" son metricas de tokens agregadas por el servidor. Ninguno es un campo
  // de la API: se eliminan en COPIAS antes de enviar al proveedor.
  body.messages = (body.messages || []).map((m) => {
    if (!("reasoning" in m) && !("metrics" in m) && !("usage" in m)) return m;
    const c = { ...m };
    delete c.reasoning;
    delete c.metrics;
    delete c.usage;
    return c;
  });
  const t0 = Date.now();
  const url = joinBase(cfg.baseUrl, "/chat/completions");
  const idleMs = Number(cfg.llmIdleTimeoutMs) > 0 ? Number(cfg.llmIdleTimeoutMs) : LLM_IDLE_TIMEOUT_MS;

  // watchdog de silencio: aborta si el stream no envia nada en idleMs
  const ctl = new AbortController();
  let idleTimer = null;
  let idleFired = false;
  const armIdle = () => {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      idleFired = true;
      ctl.abort();
    }, idleMs);
  };
  const onExternalAbort = () => {
    if (idleTimer) clearTimeout(idleTimer);
    ctl.abort();
  };
  const disarm = () => {
    // Solo desarma el watchdog temporal; el listener de abort del usuario se
    // mantiene activo durante toda la lectura (se retira en el finally),
    // si no, "parar" en medio del stream no llegaria al fetch del LLM.
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = null;
  };
  signal?.addEventListener("abort", onExternalAbort, { once: true });
  const timeoutDetail = () => ({
    ts: new Date().toISOString(),
    url,
    status: null, // reintentable (no es un fallo HTTP del proveedor)
    note: `silencio de stream > ${Math.round(idleMs / 1000)}s`,
    error: `El stream del gateway se quedo ${Math.round(idleMs / 1000)}s en silencio (sin tokens ni cierre); se corto la conexion`,
    request: reqSummary(body),
    baseUrl: cfg.baseUrl,
    durationMs: Date.now() - t0
  });
  armIdle();
  let res;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: { ...headers(cfg), "content-type": "application/json" },
      body: JSON.stringify({ ...body, stream: true, ...(streamOptsOn(cfg) ? { stream_options: { include_usage: true } } : {}) }),
      signal: ctl.signal
    });
  } catch (e) {
    if (signal?.aborted) throw e; // parada del usuario
    if (idleFired) {
      const d = timeoutDetail();
      onCall?.({ ok: false, status: null, error: d.error, model: body.model, durationMs: d.durationMs });
      throw new LLMError(d.error, d);
    }
    const detail = {
      ts: new Date().toISOString(),
      url,
      status: null,
      error: e.message,
      request: reqSummary(body),
      baseUrl: cfg.baseUrl,
      durationMs: Date.now() - t0
    };
    onCall?.({ ok: false, status: null, error: e.message, model: body.model, durationMs: detail.durationMs });
    throw new LLMError(`No se pudo conectar al LLM: ${e.message}`, detail);
  }
  if (!res.ok) {
    if (signal?.aborted) {
      disarm();
      throw new Error("AbortError");
    }
    const raw = await res.text().catch(() => "");
    const durationMs = Date.now() - t0;
    const ra = res.headers.get("retry-after");
    const retryAfterMs = ra && !isNaN(+ra) ? Math.min(30000, Math.round(+ra * 1000)) : null;
    const detail = {
      ts: new Date().toISOString(),
      url,
      status: res.status,
      retryAfterMs,
      responseHeaders: Object.fromEntries(res.headers),
      responseBody: raw.slice(0, 20000),
      request: reqSummary(body),
      baseUrl: cfg.baseUrl,
      durationMs
    };
    // El gateway rechaza stream_options: se desactiva la sonda para esa base URL
    // y el fallo se convierte en reintentable (status null) para reenviar sin el
    // campo en el siguiente intento.
    if (res.status === 400 && streamOptsOn(cfg) && /stream[ _-]?options/i.test(raw)) {
      streamOpts.set(cfg.baseUrl, false);
      detail.status = null;
      detail.note = "gateway rechazo stream_options (usage en stream); desactivado para este proveedor";
      onCall?.({ ok: false, status: null, error: "el gateway no soporta stream_options", model: body.model, durationMs });
      throw new LLMError("El gateway no soporta stream_options (usage en stream); se desactivo y se reintentara", detail);
    }
    onCall?.({ ok: false, status: res.status, error: snippetSync(raw), model: body.model, durationMs });
    throw new LLMError(`LLM HTTP ${res.status}: ${snippetSync(raw)}`, detail);
  }
  // El watchdog armado antes del fetch sigue vivo: cubre el caso de
  // "cabeceras y luego silencio absoluto"; cada chunk recibido lo re-arma.

  const dec = new TextDecoder();
  const reader = res.body.getReader();
  let buf = "";
  let content = "";
  let reasoning = "";
  let sawDone = false; // [DONE] expliacto del gateway
  let usage = null; // usage del stream (prompt/completion/cached tokens)
  const tcs = new Map();

  const connCutDetail = () => ({
    ts: new Date().toISOString(),
    url,
    status: null,
    note: "stream cerrado sin [DONE]",
    error: "El stream del gateway se cortó sin enviar [DONE] (posible corte de conexión); se tratara como fallo reintentable",
    request: reqSummary(body),
    baseUrl: cfg.baseUrl,
    durationMs: Date.now() - t0
  });
  const processLine = (line) => {
    const l = line.trim();
    if (!l.startsWith("data:")) return;
    const payload = l.slice(5).trim();
    if (!payload) return;
    if (payload === "[DONE]") {
      sawDone = true;
      return;
    }
    let json;
    try {
      json = JSON.parse(payload);
    } catch {
      return;
    }
    // El chunk final (choices vacias) suele llevar el usage; hay que leerlo
    // ANTES del corte por "sin delta".
    if (json.usage && typeof json.usage === "object") usage = json.usage;
    const delta = json.choices?.[0]?.delta;
    if (!delta) return;
    if (delta.content != null) {
      const t = extractText(delta.content);
      if (t) {
        content += t;
        onDelta?.(t);
      }
    }
    const think =
      typeof delta.reasoning_content === "string"
        ? delta.reasoning_content
        : typeof delta.reasoning === "string"
          ? delta.reasoning
          : "";
    if (think) {
      reasoning += think;
      onThink?.(think);
    }
    for (const tc of delta.tool_calls || []) {
      const slot = tcs.get(tc.index) || { id: "", name: "", arguments: "" };
      if (tc.id) slot.id = tc.id;
      if (tc.function?.name) slot.name += tc.function.name;
      if (tc.function?.arguments) slot.arguments += tc.function.arguments;
      tcs.set(tc.index, slot);
    }
  };

  const streamRead = async () => {
    for (;;) {
      let chunk;
      try {
        chunk = await reader.read();
      } catch (e) {
        if (signal?.aborted) break; // parada del usuario
        if (idleFired) {
          const d = timeoutDetail();
          onCall?.({ ok: false, status: null, error: d.error, model: body.model, durationMs: d.durationMs });
          throw new LLMError(d.error, d);
        }
        // fallo real de red al leer el stream (conexion rota por el gateway):
        // se lanza como LLMError reintentable, no como error "fatal" del loop.
        const d = {
          ts: new Date().toISOString(),
          url,
          status: null,
          note: "fallo de red al leer el stream",
          error: e.message,
          request: reqSummary(body),
          baseUrl: cfg.baseUrl,
          durationMs: Date.now() - t0
        };
        onCall?.({ ok: false, status: null, error: d.error, model: body.model, durationMs: d.durationMs });
        throw new LLMError("El stream del gateway fallo al leer: " + e.message, d);
      }
      const { done, value } = chunk;
      if (done) {
        if (!sawDone && !signal?.aborted && !idleFired) {
          // el gateway cerró el stream "limpio" sin [DONE]: no es un fin de
          // respuesta legitimo -> corte de conexion -> fallo reintentable.
          const d = connCutDetail();
          onCall?.({ ok: false, status: null, error: d.error, model: body.model, durationMs: d.durationMs });
          throw new LLMError(d.error, d);
        }
        break;
      }
      if (signal?.aborted) break;
      armIdle(); // reinicia el watchdog por cada chunk recibido
      buf += dec.decode(value, { stream: true });
      let nl;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        processLine(line);
      }
    }
    if (buf.trim()) processLine(buf);
  };

  try {
    await streamRead();
  } finally {
    if (idleTimer) clearTimeout(idleTimer);
    signal?.removeEventListener("abort", onExternalAbort);
  }
  onCall?.({ ok: true, status: res.status, model: body.model, durationMs: Date.now() - t0, ...(usage ? { usage } : {}) });

  const tool_calls = [...tcs.values()]
    .filter((t) => t.name)
    .map((t, i) => ({
      id: t.id || `call_${Date.now().toString(36)}_${i}`,
      type: "function",
      function: { name: t.name, arguments: argsJsonOrEmpty(t.arguments) }
    }));

  return { role: "assistant", content: content || null, ...(reasoning ? { reasoning } : {}), ...(tool_calls.length ? { tool_calls } : {}) };
}

const RETRYABLE_STATUS = new Set([408, 429, 500, 502, 503, 504]);
const MAX_ATTEMPTS = 4;
const BACKOFFS = [1500, 4000, 8000];

function sleepAbortable(ms, signal) {
  return new Promise((resolve, reject) => {
    const fail = () => {
      clearTimeout(t);
      reject(signal ? new DOMException("Aborted", "AbortError") : new Error("Aborted"));
    };
    const t = setTimeout(() => {
      signal?.removeEventListener("abort", fail);
      resolve();
    }, ms);
    signal?.addEventListener("abort", fail, { once: true });
  });
}

export async function chatStream(cfg, body, opts = {}) {
  for (let attempt = 1; ; attempt++) {
    let err;
    try {
      return await chatStreamOnce(cfg, body, opts);
    } catch (e) {
      err = e;
      if (e?.name === "AbortError" || opts.signal?.aborted) throw e;
      const status = e instanceof LLMError ? e.detail?.status : null;
      const retryable =
        e instanceof LLMError ? status === null || RETRYABLE_STATUS.has(status) : false;
      if (!retryable || attempt >= MAX_ATTEMPTS) throw e;
      const wait =
        (e.detail?.retryAfterMs ?? 0) > 0
          ? e.detail.retryAfterMs
          : BACKOFFS[Math.min(attempt - 1, BACKOFFS.length - 1)];
      opts.onRetry?.(attempt, wait);
      try {
        await sleepAbortable(wait, opts.signal);
      } catch (e2) {
        throw e2;
      }
    }
  }
}

export { estimateMsgTokens, sleepAbortable };