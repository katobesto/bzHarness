const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

let config = null;
let models = [];
let modelError = null;
let workspaces = null;
let currentId = null;
let busy = false;
let approvalId = null;
let attachments = [];

const chatEl = $("#chat");

async function api(path, opts = {}) {
  const r = await fetch(path, { headers: { "content-type": "application/json" }, ...opts });
  if (!r.ok) {
    let e = null;
    try {
      e = await r.json();
    } catch {
      /* ignore */
    }
    throw new Error(e?.error || `HTTP ${r.status}`);
  }
  return r.json();
}

function toast(msg, isError) {
  const t = document.createElement("div");
  t.className = "toast" + (isError ? " error" : "");
  t.textContent = msg;
  $("#toasts").append(t);
  setTimeout(() => t.remove(), 6000);
}

/* ---------- render ---------- */

function inlineMd(t) {
  return esc(t)
    .replace(/`([^`\n]+)`/g, '<code class="inline">$1</code>')
    .replace(/\*\*([^*\n]+)\*\*/g, "<strong>$1</strong>")
    .replace(/\n/g, "<br>");
}

function highlightIn(root) {
  if (!window.hljs) return;
  for (const code of root.querySelectorAll("pre code")) {
    if (code.textContent.length > 20000) continue;
    const m = code.className.match(/language-([\w+-]+)/);
    const lang = m ? m[1] : code.dataset.lang;
    try {
      code.innerHTML = window.hljs.highlight(code.textContent, lang ? { language: lang, ignoreIllegals: true } : { ignoreIllegals: true }).value;
    } catch {
      /* sin resaltar */
    }
  }
}

function fixTables(src) {
  const lines = String(src).split("\n");
  const isTableLine = (l) => {
    const t = l.trim();
    return t.includes("|") && (t.startsWith("|") || t.split("|").length >= 3);
  };
  const isSeparator = (l) => {
    const t = l.trim().replace(/^\|/, "").replace(/\|$/, "");
    const cells = t.split("|").map((c) => c.trim());
    return cells.length >= 1 && cells.every((c) => c === "" || /^:?-+:?$/.test(c));
  };
  const out = [];
  let i = 0;
  let inFence = false;
  while (i < lines.length) {
    const line = lines[i];
    if (/^\s*(```|~~~)/.test(line)) {
      out.push(line);
      inFence = !inFence;
      i++;
      continue;
    }
    if (inFence) { out.push(line); i++; continue; }
    if (isTableLine(line)) {
      const block = [];
      while (i < lines.length && isTableLine(lines[i])) { block.push(lines[i]); i++; }
      if (block.length >= 2 && !isSeparator(block[1])) {
        const cols = block[0].trim().replace(/^\|/, "").replace(/\|$/, "").split("|").length;
        out.push(block[0]);
        out.push("|" + " --- |".repeat(Math.max(1, cols)));
        out.push(...block.slice(1));
      } else out.push(...block);
    } else { out.push(line); i++; }
  }
  return out.join("\n");
}

function fullMD(src) {
  if (!window.marked || !window.DOMPurify) return inlineMd(String(src ?? ""));
  const holder = document.createElement("div");
  holder.innerHTML = window.DOMPurify.sanitize(window.marked.parse(fixTables(String(src ?? ""))), { ADD_ATTR: ["target"] });
  highlightIn(holder);
  return holder.innerHTML;
}

function scrollBottom() {
  chatEl.scrollTop = chatEl.scrollHeight;
}

function addUserBubble(text, attached = []) {
  const el = document.createElement("div");
  el.className = "msg user";
  el.innerHTML = `<div class="bubble"></div>`;
  const names = attached.map((a) => esc(a.name)).join(", ");
  el.querySelector(".bubble").innerHTML = esc(text) + (names ? `<div class="u-att">📎 ${names}</div>` : "");
  chatEl.append(el);
  scrollBottom();
}

function addAssistantBubble(text) {
  const el = document.createElement("div");
  el.className = "msg assistant";
  el.innerHTML = `<div class="bubble"><div class="thinkwrap" hidden>
      <div class="thinkline">
        <span class="t-label">pensando…</span>
        <button class="t-expand" title="Desplegar/ocultar el pensamiento" aria-label="Desplegar pensamiento">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 9l6 6 6-6"/></svg>
        </button>
      </div>
      <pre class="thinkbox"></pre>
    </div><div class="tcontent"></div></div>`;
  const tw = el.querySelector(".thinkwrap");
  tw.querySelector(".thinkline").onclick = () => tw.classList.toggle("open");
  el.querySelector(".tcontent").innerHTML = text ? fullMD(text) : "";
  chatEl.append(el);
  return el;
}

function lastSentence(text) {
  const t = text.trim();
  if (!t) return "";
  const re = /[^.!?…]*[.!?…]/g;
  let m;
  let end = 0;
  let last = null;
  while ((m = re.exec(t))) {
    end = re.lastIndex;
    last = m[0];
  }
  const tail = t.slice(end).trim();
  if (tail) return tail;
  if (!last) return t;
  return t.slice(Math.max(0, end - last.length)).trim();
}

function safeParse(s) {
  try {
    return JSON.parse(s);
  } catch {
    return { _raw: s };
  }
}

function formatErrorLog(d) {
  const L = [];
  if (d.ts) L.push(`timestamp: ${d.ts}`);
  if (d.url) L.push(`url: ${d.url}`);
  if (d.baseUrl) L.push(`base_url: ${d.baseUrl}`);
  if (d.status != null) L.push(`http_status: ${d.status}`);
  if (d.error) L.push(`network_error: ${d.error}`);
  if (d.model) L.push(`model: ${d.model}`);
  if (d.durationMs != null) L.push(`duration_ms: ${d.durationMs}`);
  if (d.request) {
    const r = d.request;
    L.push(
      `request: model=${r.model} max_tokens=${r.max_tokens} temperature=${r.temperature} messages=${r.messages} tools=${r.tools} ctx_chars≈${r.approxContextChars}`
    );
  }
  if (d.responseHeaders) L.push(`response_headers: ${JSON.stringify(d.responseHeaders)}`);
  if (Array.isArray(d.calls) && d.calls.length) {
    L.push(`llm_calls_de_esta_ejecucion (${d.calls.length}):`);
    for (const c of d.calls) {
      L.push(
        c.retry
          ? `  #${c.n} reintento programado (espera ${c.waitMs}ms)`
          : `  #${c.n} ok=${c.ok} status=${c.status ?? "-"} model=${c.model || "-"} ${c.durationMs ?? "?"}ms${c.error ? ` error: ${c.error}` : ""}`
      );
    }
  }
  if (d.logFile) L.push(`log_completo: ${d.logFile}`);
  if (d.responseBody) {
    const body =
      d.responseBody.length > 6000
        ? d.responseBody.slice(0, 6000) + "\n… (truncado; ver log completo)"
        : d.responseBody;
    L.push(`response_body:\n${body}`);
  }
  return L.join("\n");
}

function addErrorBubble(text, detail) {
  const el = document.createElement("div");
  el.className = "msg error";
  el.innerHTML = `<div class="bubble"></div>`;
  el.querySelector(".bubble").innerHTML =
    esc(text) + (detail ? `<details class="errinfo"><summary>+ info</summary><pre class="mono"></pre></details>` : "");
  if (detail) el.querySelector(".errinfo pre").textContent = formatErrorLog(detail);
  chatEl.append(el);
  scrollBottom();
}

const TOOL_META = {
  shell_exec: { label: "Shell", icon: "shell" },
  file_read: { label: "Read", icon: "read" },
  file_write: { label: "Write", icon: "write" },
  file_edit: { label: "Edit", icon: "edit" },
  image_read: { label: "Image", icon: "image" },
  glob_files: { label: "Glob", icon: "search" },
  grep_files: { label: "Grep", icon: "search" }
};

const TOOL_ICONS = {
  shell: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><path d="M3 5l3 3-3 3"/><path d="M8 11h5"/></svg>',
  read: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"><path d="M4 2.5h5.5L12 5v8.5H4z"/><path d="M9.5 2.5V5H12"/></svg>',
  write: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"><path d="M11 2.5l2.5 2.5L6 12.5 3 13.5 4 10.5z"/></svg>',
  edit: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"><path d="M11 2.5l2.5 2.5L6 12.5 3 13.5 4 10.5z"/></svg>',
  image: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><rect x="2.5" y="3.5" width="11" height="9" rx="1.5"/><circle cx="6" cy="7" r="1.2"/><path d="M3 11l3-3 2.5 2.5L11 8l2.5 3"/></svg>',
  search: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"><circle cx="7" cy="7" r="3.5"/><path d="M9.8 9.8L13 13"/></svg>'
};

const toolStore = new Map();
let openToolId = null;

function addToolChip(ev, row) {
  row.hidden = false;
  const meta = TOOL_META[ev.name] || { label: ev.name, icon: "read" };
  const chip = document.createElement("button");
  chip.className = "toolchip";
  chip.dataset.id = ev.id;
  const hint = ev.name === "shell_exec" ? ev.args?.command : (ev.args?.path || ev.args?.pattern || "");
  chip.title = (ev.name + (hint ? " · " + hint : "")).slice(0, 300);
  chip.innerHTML = TOOL_ICONS[meta.icon] + "<span>" + esc(meta.label) + "</span>";
  chip.onclick = () => {
    if (openToolId === ev.id) closeToolDetail();
    else openToolDetail(ev.id);
  };
  toolStore.set(ev.id, { name: ev.name, args: ev.args, output: undefined, ok: null });
  row.append(chip);
  scrollBottom();
}

function updateToolChip(ev) {
  const chip = chatEl.querySelector(`.toolchip[data-id="${CSS.escape(ev.id)}"]`);
  if (!chip) return;
  const e = toolStore.get(ev.id);
  if (e) {
    e.output = ev.output;
    e.ok = ev.ok;
  }
  chip.classList.add(ev.ok ? "ok" : "fail");
  if (openToolId === ev.id) refreshToolDetail(ev.id);
}

function detailHead(e) {
  const meta = TOOL_META[e.name] || { label: e.name, icon: "read" };
  return `<div class="td-head">${TOOL_ICONS[meta.icon]}<span class="tverb">${esc(meta.label)}</span><span class="td-name">${esc(e.name)}</span></div>`;
}

function detailBody(e) {
  let html = "";
  if (e.name === "shell_exec" && e.args) {
    html += `<div class="tsec">Comando</div><pre class="toolpre"><code data-lang="bash">${esc(e.args.command ?? "")}</code></pre>`;
    if (e.args.workdir) html += `<div class="tsec">Carpeta</div><pre class="toolpre"><code>${esc(e.args.workdir)}</code></pre>`;
  } else if (e.name === "file_write" && e.args) {
    if (e.args.path) html += `<div class="tsec">Archivo</div><pre class="toolpre"><code>${esc(e.args.path)}</code></pre>`;
    if (typeof e.args.content === "string") {
      const ext = String(e.args.path || "").split(".").pop().toLowerCase();
      const lang = { html: "xml", htm: "xml", xhtml: "xml", js: "javascript", mjs: "javascript", cjs: "javascript", ts: "typescript", css: "css", json: "json", py: "python", md: "markdown", yml: "yaml", yaml: "yaml", sh: "bash", ps1: "powershell", c: "c", h: "c", cpp: "cpp", cs: "csharp", java: "java", go: "go", rs: "rust" }[ext];
      html += `<div class="tsec">Contenido</div><pre class="toolpre"><code${lang ? ` data-lang="${lang}"` : ""}>${esc(e.args.content)}</code></pre>`;
    }
  } else if (e.args) {
    html += `<div class="tsec">Argumentos</div><pre class="toolpre">${esc(JSON.stringify(e.args, null, 2))}</pre>`;
  }
  if (e.ok === null) html += `<div class="tsec">Salida</div><pre class="toolpre"><span class="typing bz-pulse">… en curso</span></pre>`;
  else html += `<div class="tsec">Salida</div><pre class="toolpre ${e.ok ? "ok" : "fail"}">${esc(e.output ?? "")}</pre>`;
  return html || `<pre class="toolpre"></pre>`;
}

function openToolDetail(id) {
  const e = toolStore.get(id);
  if (!e) return;
  closeToolDetail();
  openToolId = id;
  const d = document.createElement("div");
  d.className = "tooldetail";
  d.dataset.id = id;
  d.innerHTML = detailHead(e) + detailBody(e);
  const chip = chatEl.querySelector(`.toolchip[data-id="${CSS.escape(id)}"]`);
  const row = chip && chip.parentElement ? chip.parentElement : null;
  if (row && row.parentElement === chatEl) chatEl.insertBefore(d, row.nextSibling);
  else chatEl.append(d);
  highlightIn(d);
  d.scrollIntoView({ block: "nearest" });
}

function refreshToolDetail(id) {
  const e = toolStore.get(id);
  const d = chatEl.querySelector(`.tooldetail[data-id="${CSS.escape(id)}"]`);
  if (!e || !d) return;
  d.innerHTML = detailHead(e) + detailBody(e);
  highlightIn(d);
}

function closeToolDetail() {
  if (openToolId) {
    const d = chatEl.querySelector(`.tooldetail[data-id="${CSS.escape(openToolId)}"]`);
    if (d) d.remove();
  }
  openToolId = null;
}

function renderMessage(m) {
  if (m.role === "user") addUserBubble(m.content);
  else if (m.role === "assistant") {
    const b = addAssistantBubble(m.content || "");
    if (m.tool_calls) {
      const row = document.createElement("div");
      row.className = "toolchips";
      chatEl.append(row);
      for (const tc of m.tool_calls) {
        addToolChip({ id: tc.id, name: tc.function.name, args: safeParse(tc.function.arguments) }, row);
      }
      b.remove();
    }
  } else if (m.role === "tool") {
    updateToolChip({ id: m.tool_call_id, name: m.name, ok: true, output: m.content });
  } else if (m.role === "error") {
    addErrorBubble(m.content, m.detail);
  }
}

const SPARK = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3v3M12 18v3M3 12h3M18 12h3M5.6 5.6l2.1 2.1M16.3 16.3l2.1 2.1M18.4 5.6l-2.1 2.1M7.7 16.3l-2.1 2.1"/><circle cx="12" cy="12" r="3.2"/></svg>';

function showWelcome(s) {
  const d = document.createElement("div");
  d.className = "welcome";
  d.innerHTML = `
    <div class="w-sand"><span class="w-badge">sandbox</span><span class="w-path mono" title="${esc(s.workdir)}">${esc(s.workdir)}</span></div>
    <h2>${esc(s.name)}</h2>
    <p>Todo lo que el agente cree o ejecute en esta sesión queda confinado en la carpeta de trabajo. El harness creará <span class="mono">.bzharness/</span> dentro de ella.</p>`;
  chatEl.append(d);
}

/* ---------- SSE ---------- */

async function consumeSSE(res, h) {
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let i;
    while ((i = buf.indexOf("\n\n")) >= 0) {
      const block = buf.slice(0, i);
      buf = buf.slice(i + 2);
      for (const line of block.split("\n")) {
        if (!line.startsWith("data: ")) continue;
        let ev;
        try {
          ev = JSON.parse(line.slice(6));
        } catch {
          continue;
        }
        if (ev.type === "end") return;
        h[ev.type]?.(ev);
      }
    }
  }
}

/* ---------- acciones de chat ---------- */

function updateButtons() {
  $("#btnSend").disabled = busy || !currentId;
  $("#btnStop").disabled = !busy;
  $("#btnOpenDir").disabled = !currentId;
  $("#btnAttach").disabled = busy;
  $("#input").disabled = busy;
}

async function sendMessage() {
  const text = $("#input").value.trim();
  if ((!text && !attachments.length) || busy || !currentId) return;
  const sentNames = attachments.map((a) => a.name);
  try {
    await uploadAttachments();
  } catch (e) {
    toast(e.message, true);
    return;
  }
  const msgText = text || "He enviado los adjuntos marcados.";
  $("#input").value = "";
  const w = chatEl.querySelector(".welcome");
  if (w) w.remove();
  addUserBubble(msgText, sentNames);
  let bubble = addAssistantBubble("");
  bubble.querySelector(".tcontent").innerHTML = '<span class="typing bz-pulse">esperando al modelo…</span>';
  let chipsRow = null;
  let textSinceRow = false;
  let segText = "";
  let thinkSeg = "";
  let thinkActive = false;
  const startThink = () => {
    if (thinkActive) return;
    thinkActive = true;
    bubble.querySelector(".thinkwrap").hidden = false;
    bubble.querySelector(".t-label").classList.add("bz-pulse");
  };
  const stopThink = () => {
    if (!thinkActive) return;
    thinkActive = false;
    bubble.querySelector(".t-label").classList.remove("bz-pulse");
  };
  busy = true;
  updateButtons();
  let raf = null;
  let finalized = false;
  const paint = () => {
    raf = null;
    bubble.querySelector(".tcontent").innerHTML =
      inlineMd(segText) || '<span class="typing bz-pulse">esperando al modelo…</span>';
    scrollBottom();
  };
  const finalizeTurn = () => {
    if (finalized) return;
    finalized = true;
    stopThink();
    const tc = bubble.querySelector(".tcontent");
    if (!segText && !thinkSeg) bubble.remove();
    else tc.innerHTML = segText ? fullMD(segText) : "";
    scrollBottom();
  };
  try {
    const res = await fetch("/api/chat", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sessionId: currentId, message: msgText })
    });
    if (!res.ok) {
      const e = await res.json().catch(() => ({}));
      throw new Error(e.error || `HTTP ${res.status}`);
    }
    await consumeSSE(res, {
      token: (ev) => {
        const t =
          typeof ev.content === "string"
            ? ev.content
            : Array.isArray(ev.content)
              ? ev.content.map((p) => (typeof p === "string" ? p : p?.text ?? "")).join("")
              : ev.content?.text ?? "";
        if (t) {
          stopThink();
          segText += t;
          textSinceRow = true;
          if (!raf) raf = requestAnimationFrame(paint);
        }
      },
      think: (ev) => {
        const t = typeof ev.content === "string" ? ev.content : (ev.content?.text ?? "");
        if (!t) return;
        thinkSeg += t;
        startThink();
        bubble.querySelector(".thinkbox").textContent = thinkSeg;
        bubble.querySelector(".t-label").textContent = lastSentence(thinkSeg) || "pensando…";
        scrollBottom();
      },
      tool_call: (ev) => {
        if (chipsRow === null || textSinceRow) {
          stopThink();
          const tc = bubble.querySelector(".tcontent");
          if (!segText && !thinkSeg) bubble.remove();
          else if (segText) tc.innerHTML = fullMD(segText);
          segText = "";
          thinkSeg = "";
          textSinceRow = false;
          thinkActive = false;
          chipsRow = document.createElement("div");
          chipsRow.className = "toolchips";
          chatEl.append(chipsRow);
          bubble = addAssistantBubble("");
          bubble.querySelector(".tcontent").innerHTML =
            '<span class="typing bz-pulse">esperando al modelo…</span>';
        }
        addToolChip(ev, chipsRow);
      },
      tool_result: updateToolChip,
      image_attached: (ev) => {
        const row = document.createElement("div");
        row.className = "img-row";
        for (const img of ev.images || []) {
          const href = `/api/sessions/${currentId}/file?path=${encodeURIComponent(img.path)}`;
          const title = `${img.path} (${img.mime}, ${img.bytes} bytes)`;
          const fig = document.createElement("div");
          fig.className = "imgfig";
          const im = document.createElement("img");
          im.src = href;
          im.alt = img.path;
          im.title = title + " — clic para ampliar";
          im.loading = "lazy";
          im.onclick = () => openLightbox(href, title);
          const x = document.createElement("button");
          x.className = "img-x";
          x.title = "Descartar imagen";
          x.setAttribute("aria-label", "Descartar imagen " + img.path);
          x.textContent = "×";
          x.onclick = (e) => {
            e.stopPropagation();
            fig.remove();
            if (!row.childElementCount) row.remove();
          };
          fig.append(im, x);
          row.append(fig);
        }
        if (row.childNodes.length) {
          chatEl.append(row);
          scrollBottom();
        }
      },
      approval_request: (ev) => {
        approvalId = ev.id;
        $("#apCommand").textContent = ev.command;
        openModal("#modalApproval");
      },
      retry: (ev) => {
        segText = "";
        thinkSeg = "";
        thinkActive = false;
        const tw = bubble.querySelector(".thinkwrap");
        tw.hidden = true;
        tw.classList.remove("open");
        const tl = bubble.querySelector(".t-label");
        tl.classList.remove("bz-pulse");
        tl.textContent = "pensando…";
        bubble.querySelector(".thinkbox").textContent = "";
        const max = Math.max(1, (ev.maxAttempts || 4) - 1);
        bubble.querySelector(".tcontent").innerHTML = `<span class="typing bz-pulse">… gateway inestable, reintento ${ev.attempt}/${max}</span>`;
        scrollBottom();
      },
      error: (ev) => addErrorBubble("⚠ " + ev.message, ev.detail),
      done: (ev) => {
        if (ev.aborted) toast("Ejecución detenida", true);
        finalizeTurn();
      }
    });
    paint();
    finalizeTurn();
  } catch (e) {
    toast(e.message, true);
    bubble.querySelector(".tcontent").innerHTML += `<span class="err">${esc(e.message)}</span>`;
  } finally {
    busy = false;
    updateButtons();
    refreshSessions().catch(() => {});
  }
}

async function answerApproval(ok) {
  const id = approvalId;
  approvalId = null;
  closeModal("#modalApproval");
  if (!id) return;
  try {
    await api(`/api/approvals/${id}`, { method: "POST", body: JSON.stringify({ approved: ok }) });
  } catch (e) {
    toast(e.message, true);
  }
}

/* ---------- sesiones ---------- */

function renderSessionList(list) {
  const el = $("#sessionList");
  el.innerHTML = "";
  for (const s of list) {
    const item = document.createElement("div");
    item.className = "session" + (s.id === currentId ? " active" : "");
    item.innerHTML = `
      <div class="s-name">${esc(s.name)}${s.busy ? '<span class="busy-dot" title="ejecutando"></span>' : ""}</div>
      <div class="s-wd" title="${esc(s.workdir)}">${esc(s.workdir)}</div>
      ${s.model ? `<div class="s-model">${esc(s.model)}</div>` : ""}
      <span class="s-del" title="eliminar sesión">×</span>`;
    item.onclick = () => {
      if (!busy) selectSession(s.id);
    };
    item.querySelector(".s-del").onclick = async (e) => {
      e.stopPropagation();
      if (busy) return;
      if (!confirm(`Eliminar la sesión "${s.name}"? (se borra el transcript; el contenido de la carpeta se conserva)`)) return;
      try {
        await api(`/api/sessions/${s.id}`, { method: "DELETE" });
        if (currentId === s.id) {
          currentId = null;
          closeToolDetail();
          chatEl.innerHTML = "";
        }
        refreshSessions().then((l) => l.length && selectSession(l[0].id));
      } catch (err) {
        toast(err.message, true);
      }
    };
    el.append(item);
  }
}

async function refreshSessions() {
  const list = await api("/api/sessions");
  renderSessionList(list);
  return list;
}

async function selectSession(id) {
  try {
    const s = await api(`/api/sessions/${id}`);
    currentId = id;
    clearAttachments();
    await refreshSessions();
    closeToolDetail();
    chatEl.innerHTML = "";
    showWelcome(s);
    for (const m of s.messages || []) renderMessage(m);
    scrollBottom();
    updateButtons();
  } catch (e) {
    toast(e.message, true);
  }
}

/* ---------- modal nueva sesión ---------- */

function openModal(sel) {
  $(sel).hidden = false;
}
function closeModal(sel) {
  $(sel).hidden = true;
}

async function openNewSessionModal() {
  if (!workspaces) workspaces = await api("/api/workspaces");
  $("#nsName").value = "";
  $("#nsWorkdir").value = workspaces.defaultWorkdir || "";
  const chips = $("#nsPresets");
  chips.innerHTML = "";
  for (const p of workspaces.presets || []) {
    const b = document.createElement("button");
    b.className = "chip";
    b.textContent = p;
    b.onclick = () => {
      $("#nsWorkdir").value = p;
    };
    chips.append(b);
  }
  const sel = $("#nsModel");
  sel.innerHTML = '<option value="">Usar modelo global</option>';
  for (const m of models) sel.insertAdjacentHTML("beforeend", `<option>${esc(m)}</option>`);
  openModal("#modalNew");
}

async function browseWorkdir() {
  const start = $("#nsWorkdir").value.trim() || workspaces?.defaultWorkdir || "C:\\";
  try {
    const r = await api("/api/pick-dir", { method: "POST", body: JSON.stringify({ start }) });
    if (r.path) $("#nsWorkdir").value = r.path;
  } catch (e) {
    toast(e.message, true);
  }
}

async function createSession() {
  try {
    const workdir = $("#nsWorkdir").value.trim();
    if (!workdir) throw new Error("Indica la carpeta de trabajo (sandbox)");
    const s = await api("/api/sessions", {
      method: "POST",
      body: JSON.stringify({ name: $("#nsName").value.trim(), workdir, model: $("#nsModel").value || null })
    });
    closeModal("#modalNew");
    await refreshSessions();
    await selectSession(s.id);
    toast(`Sesión creada en ${s.workdir}`);
  } catch (e) {
    toast(e.message, true);
  }
}

/* ---------- modal configuración ---------- */

function updateModelBadge() {
  const b = $("#modelBadge");
  if (!config) return;
  if (config.model === "auto") {
    b.textContent = models.length ? `auto → ${models[0]}` : "auto (sin modelos detectados)";
    b.title = modelError ? `error detección: ${modelError}` : `${config.baseUrl} · ${models.length} modelos detectados`;
  } else {
    b.textContent = config.model;
    b.title = config.baseUrl;
  }
}

function openConfigModal() {
  const c = config;
  $("#cfBaseUrl").value = c.baseUrl;
  $("#cfApiKey").value = "";
  $("#cfApiKey").placeholder = c.apiKey ? `••••${c.apiKey.slice(-4)} — dejar en blanco para mantener` : "pegar token aquí";
  $("#cfModel").value = c.model;
  $("#modelList").innerHTML = models.map((m) => `<option value="${esc(m)}">`).join("");
  $("#cfMaxCtx").value = c.maxContextTokens;
  $("#cfMaxOut").value = c.maxOutputTokens;
  $("#cfTemp").value = c.temperature;
  $("#cfShellApproval").checked = !!c.shellApproval;
  $("#cfShowThinking").checked = !!c.showThinking;
  $("#cfShellTimeout").value = c.shellTimeoutMs;
  $("#cfDefaultWorkdir").value = c.defaultWorkdir;
  $("#cfPresets").value = (c.workspacePresets || []).join("\n");
  $("#cfPort").value = c.port;
  openModal("#modalConfig");
}

async function saveConfig() {
  const lines = (s) => (s || "").split("\n").map((x) => x.trim()).filter(Boolean);
  const patch = {
    baseUrl: $("#cfBaseUrl").value.trim(),
    apiKey: $("#cfApiKey").value.trim(),
    model: $("#cfModel").value.trim() || "auto",
    maxContextTokens: Number($("#cfMaxCtx").value),
    maxOutputTokens: Number($("#cfMaxOut").value),
    temperature: Number($("#cfTemp").value),
    shellApproval: $("#cfShellApproval").checked,
    showThinking: $("#cfShowThinking").checked,
    shellTimeoutMs: Number($("#cfShellTimeout").value),
    defaultWorkdir: $("#cfDefaultWorkdir").value.trim(),
    workspacePresets: lines($("#cfPresets").value)
  };
  try {
    config = await api("/api/config", { method: "PUT", body: JSON.stringify(patch) });
    const m = await api("/api/models");
    models = m.models || [];
    modelError = m.error;
    workspaces = await api("/api/workspaces");
    updateModelBadge();
    closeModal("#modalConfig");
    toast("Configuración guardada");
  } catch (e) {
    toast(e.message, true);
  }
}

/* ---------- init ---------- */

/* ---------- adjuntos (ficheros e imágenes) ---------- */

const MAX_ATTACH = 8;
const MAX_ATTACH_BYTES = 10 * 1024 * 1024;

function bufToB64(buf) {
  const bytes = new Uint8Array(buf);
  let s = "";
  const CH = 0x8000;
  for (let i = 0; i < bytes.length; i += CH) s += String.fromCharCode.apply(null, bytes.subarray(i, i + CH));
  return btoa(s);
}

function addFiles(fileList) {
  for (const f of [...(fileList || [])]) {
    if (attachments.length >= MAX_ATTACH) {
      toast(`máximo ${MAX_ATTACH} adjuntos por mensaje`, true);
      break;
    }
    if (f.size > MAX_ATTACH_BYTES) {
      toast(`${f.name}: máximo 10 MB`, true);
      continue;
    }
    const isImage = /^image\//.test(f.type || "");
    attachments.push({ name: f.name, size: f.size, mime: f.type, isImage, file: f, url: isImage ? URL.createObjectURL(f) : null });
  }
  renderAttachments();
}

function renderAttachments() {
  const row = $("#attachRow");
  row.innerHTML = "";
  attachments.forEach((a, i) => {
    const chip = document.createElement("div");
    chip.className = "attach";
    if (a.isImage) {
      const im = document.createElement("img");
      im.src = a.url;
      im.alt = a.name;
      chip.append(im);
    } else {
      chip.insertAdjacentHTML(
        "beforeend",
        '<span class="a-file"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round" aria-hidden="true"><path d="M6 2.5h8L19 7.5v14H6z"/><path d="M14 2.5V8h5"/></svg></span>'
      );
    }
    const nm = document.createElement("span");
    nm.className = "a-name";
    nm.textContent = a.name;
    nm.title = `${a.name} (${a.size} bytes)`;
    const x = document.createElement("button");
    x.className = "a-x";
    x.title = "Quitar adjunto";
    x.setAttribute("aria-label", "Quitar " + a.name);
    x.textContent = "×";
    x.onclick = () => {
      if (a.url) URL.revokeObjectURL(a.url);
      attachments.splice(i, 1);
      renderAttachments();
    };
    chip.append(nm, x);
    row.append(chip);
  });
  row.hidden = !attachments.length;
}

function clearAttachments() {
  for (const a of attachments) if (a.url) URL.revokeObjectURL(a.url);
  attachments = [];
  renderAttachments();
}

async function uploadAttachments() {
  if (!attachments.length) return;
  const files = await Promise.all(
    attachments.map(async (a) => ({ name: a.name, mime: a.mime, b64: bufToB64(await a.file.arrayBuffer()) }))
  );
  await api(`/api/sessions/${currentId}/upload`, { method: "POST", body: JSON.stringify({ files }) });
  clearAttachments();
}

/* ---------- zoom de texto del chat ---------- */

const ZOOM_MIN = 0.8, ZOOM_MAX = 1.5, ZOOM_STEP = 0.1;
let chatZoom = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, Number(localStorage.getItem("bz.chatZoom")) || 1));

function applyZoom() {
  document.documentElement.style.setProperty("--chat-zoom", String(chatZoom));
  $("#btnZoomIn").disabled = chatZoom >= ZOOM_MAX;
  $("#btnZoomOut").disabled = chatZoom <= ZOOM_MIN;
}
function bumpZoom(delta) {
  chatZoom = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, Math.round((chatZoom + delta) * 10) / 10));
  localStorage.setItem("bz.chatZoom", String(chatZoom));
  applyZoom();
}

/* ---------- visor de imágenes ---------- */

function openLightbox(src, caption) {
  $("#lbImg").src = src;
  $("#lbImg").alt = caption || "";
  $("#lbCaption").textContent = caption || "";
  $("#lightbox").hidden = false;
}
function closeLightbox() {
  $("#lightbox").hidden = true;
  $("#lbImg").src = "";
}

/* ---------- barra lateral ---------- */

function setAsideHidden(hidden) {
  document.body.classList.toggle("no-aside", hidden);
  localStorage.setItem("bz.noAside", hidden ? "1" : "0");
}

async function init() {
  let lastErr = null;
  for (let i = 0; i < 5; i++) {
    try {
      config = await api("/api/config");
      const m = await api("/api/models");
      models = m.models || [];
      modelError = m.error;
      workspaces = await api("/api/workspaces");
      updateModelBadge();
      if (modelError) toast(`Detección de modelos: ${modelError}`, true);
      const list = await refreshSessions();
      if (list.length) await selectSession(list[0].id);
      else {
        currentId = null;
        chatEl.innerHTML = "";
        const d = document.createElement("div");
        d.className = "welcome";
        d.innerHTML = `
          <div class="w-logo" aria-hidden="true">${SPARK}</div>
          <h2>bzHarness <span class="w-by">by Benzo</span></h2>
          <p>Agente LLM con herramientas — shell, ficheros y búsqueda — confinado en un sandbox por sesión.</p>`;
        const btn = document.createElement("button");
        btn.className = "btn primary";
        btn.textContent = "Nueva sesión";
        btn.onclick = openNewSessionModal;
        d.append(btn);
        const steps = document.createElement("div");
        steps.className = "w-steps";
        steps.innerHTML = `
          <div class="w-step"><span class="n">1</span><b>Configura el LLM</b><span>Base URL OpenAI-compatible, API key y modelo.</span></div>
          <div class="w-step"><span class="n">2</span><b>Crea una sesión</b><span>Elige la carpeta de trabajo: será el sandbox del agente.</span></div>
          <div class="w-step"><span class="n">3</span><b>Chatea</b><span>El agente ejecuta comandos y edita ficheros dentro del sandbox.</span></div>`;
        d.append(steps);
        chatEl.append(d);
      }
      lastErr = null;
      break;
    } catch (e) {
      lastErr = e;
      await new Promise((r) => setTimeout(r, 1500));
    }
  }
  if (lastErr) toast(lastErr.message, true);
  updateButtons();
}

$("#btnSend").onclick = sendMessage;
$("#btnStop").onclick = async () => {
  if (!currentId) return;
  try {
    await api(`/api/stop/${currentId}`, { method: "POST" });
  } catch (e) {
    toast(e.message, true);
  }
};
$("#input").addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    sendMessage();
  }
});
$("#btnConfig").onclick = openConfigModal;
$("#btnNewSession").onclick = openNewSessionModal;
$("#nsBrowse").onclick = browseWorkdir;
$("#nsCreate").onclick = createSession;
$("#cfSave").onclick = saveConfig;
$("#apApprove").onclick = () => answerApproval(true);
$("#apDeny").onclick = () => answerApproval(false);
$("#btnZoomIn").onclick = () => bumpZoom(ZOOM_STEP);
$("#btnZoomOut").onclick = () => bumpZoom(-ZOOM_STEP);
$("#btnAside").onclick = () => setAsideHidden(!document.body.classList.contains("no-aside"));
$("#btnOpenDir").onclick = async () => {
  if (!currentId) return;
  try {
    const r = await api("/api/open-dir", { method: "POST", body: JSON.stringify({ sessionId: currentId }) });
    toast(`Explorador abierto en ${r.dir}`);
  } catch (e) {
    toast(e.message, true);
  }
};
document.querySelectorAll("[data-close]").forEach((b) => {
  b.onclick = () => b.closest(".modal").setAttribute("hidden", "");
});
$("#lbClose").onclick = closeLightbox;
$("#lightbox").addEventListener("click", (e) => {
  if (e.target === e.currentTarget) closeLightbox();
});
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && !$("#lightbox").hidden) closeLightbox();
});

/* adjuntos: botón, pegado y arrastrar-soltar */
$("#btnAttach").onclick = () => $("#fileInput").click();
$("#fileInput").onchange = (e) => {
  addFiles(e.target.files);
  e.target.value = "";
};
$("#input").addEventListener("paste", (e) => {
  const fs2 = e.clipboardData?.files;
  if (fs2 && fs2.length) {
    e.preventDefault();
    addFiles(fs2);
  }
});
const composerEl = $(".composer");
composerEl.addEventListener("dragover", (e) => {
  e.preventDefault();
  composerEl.classList.add("drag");
});
composerEl.addEventListener("dragleave", () => composerEl.classList.remove("drag"));
composerEl.addEventListener("drop", (e) => {
  e.preventDefault();
  composerEl.classList.remove("drag");
  if (e.dataTransfer?.files?.length) addFiles(e.dataTransfer.files);
});

applyZoom();
setAsideHidden(localStorage.getItem("bz.noAside") === "1");

init();