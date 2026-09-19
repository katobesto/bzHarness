import { TOOLS, runTool } from "./tools/index.js";
import { chatStream, sleepAbortable } from "./llm.js";
import { estimateMsgTokens, estimateImageTokens, trimHistory } from "./util/tokens.js";
import { normalizeVisionBatch } from "./util/vision.js";

const MAX_ITER = 12;
// rondas extra de "continua" automaticas al agotar MAX_ITER (evita paradas en silencio a mitad de tarea)
const MAX_EXTEND = 2;

export function buildSystemPrompt(session) {
  const wd = session.workdir;
  return [
    "Eres bzHarness, un agente de ingenieria que trabaja en la maquina del usuario (Windows).",
    "",
    `SANDBOX: Tu carpeta de trabajo es "${wd}". TODAS tus operaciones de ficheros y comandos estan confinadas a ella. No intentes salir de esa carpeta bajo ninguna circunstancia. Las rutas relativas se resuelven respecto a ella. Si una herramienta devuelve un error de sandbox, corrige la ruta e intenta dentro del sandbox.`,
    `Los artefactos del propio harness (transcripciones, logs de comandos) viven en "${wd}\\.bzharness"; no los edites ni dependas de ellos.`,
    `Los ficheros que el usuario adjunta por chat se copian en "${wd}\\.attachments"; puedes leerlos con file_read o image_read usando rutas relativas (ej. ".attachments/foto.png").`,
    "Entorno: Windows. Shell: cmd/PowerShell. Node.js y Python pueden estar disponibles (verifica con 'node -v' / 'python --version' si los necesitas).",
    "Herramientas: shell_exec (comandos), file_read, file_write, file_edit, image_read, glob_files, grep_files, web_search (busca en internet via DuckDuckGo), web_fetch (lee el contenido de una URL como texto).",
    "Internet: si la tarea necesita informacion externa (documentacion de APIs/librerias, versiones, errores, noticias), usa web_search con consultas concretas, despues web_fetch sobre las 1-3 URLs mas promisorias, y itera (otras consultas u otras paginas) hasta tener la informacion necesaria antes de responder o escribir codigo. Cita las URLs de las fuentes en tu respuesta.",
    "Puedes ver imagenes: usa image_read con una ruta del sandbox y el modelo la recibira en la siguiente peticion (el modelo debe soportar vision). Antes de enviar, las imagenes se escalan automaticamente (máx 1568 px de lado y 4 MP en total por peticion) para caber en el presupuesto de vision del gateway; si adjuntas varias en un turno, el conjunto se escala en bloque.",
    "Cuando una tool devuelva un error, corrige el parametro y reintentalo.",
    "Se conciso en las respuestas. Al terminar una tarea de codigo, verificalo ejecutandolo si es apropiado."
  ].join("\n");
}

function reconcile(messages) {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role !== "assistant") continue;
    if (!m.tool_calls?.length) break;
    const responded = new Set();
    for (let j = i + 1; j < messages.length; j++) {
      if (messages[j].role === "tool") responded.add(messages[j].tool_call_id);
    }
    for (const tc of m.tool_calls) {
      if (!responded.has(tc.id)) {
        messages.push({ role: "tool", tool_call_id: tc.id, name: tc.function.name, content: "Ejecucion interrumpida por el usuario." });
      }
    }
    break;
  }
}

export async function runAgent({ cfg, model, session, userMessage, emit, signal, run, approve, onCall, onRetry, onThink }) {
  session.messages.push({ role: "user", content: userMessage });
  const system = buildSystemPrompt(session);
  const budget = Math.max(
    4000,
    cfg.maxContextTokens - estimateMsgTokens({ content: system }) - Math.min(cfg.maxOutputTokens, 8192)
  );

  let emptyStreak = 0;
  let iters = MAX_ITER;
  let extCount = 0;
  try {
    for (;;) {
      if (signal?.aborted) break;
      if (iters <= 0) {
        if (extCount < MAX_EXTEND) {
          extCount++;
          iters = MAX_ITER;
          emit({ type: "notice", message: `Tope de ${MAX_ITER} iteraciones alcanzado - continuando automaticamente (${extCount}/${MAX_EXTEND})` });
          session.messages.push({ role: "user", content: "Continua exactamente donde lo dejaste. Si la tarea ya esta terminada, resuelvela sin llamar a mas herramientas." });
          continue;
        }
        const m = `Tope de iteraciones (${MAX_ITER} x ${extCount + 1} rondas) alcanzado sin respuesta final. La tarea puede quedar incompleta: envia "continua" para reanudar.`;
        session.messages.push({ role: "error", content: "⚠ " + m });
        emit({ type: "error", message: m });
        break;
      }
      iters--;
      const hist = session.messages.filter((m) => m.role !== "error");
      const pending = (run.pendingImages || []).splice(0);
       let extra = [];
       let imgTokens = 0;
       if (pending.length) {
         if (signal?.aborted) break; // parada detectada en prefill: salir sin enviar nada
         // Escala/re-codifica las imagenes ANTES de enviarlas al LLM (evita 413 por
         // presupuesto de patches del gateway, que es por peticion: suma de pixeles).
         // Fallar aqui no debe tumbar la ejecucion: se envian las originales.
         let norm;
         try {
           norm = await normalizeVisionBatch(pending, {
             maxSide: Number(cfg.visionMaxSide) > 0 ? Number(cfg.visionMaxSide) : undefined,
             maxTotalPixels: Number(cfg.visionMaxTotalPixels) > 0 ? Number(cfg.visionMaxTotalPixels) : undefined
           });
         } catch {
           norm = pending;
         }
         if (signal?.aborted) break; // parada durante la escalada: no enviar al LLM
         imgTokens = norm.reduce((s, i) => s + estimateImageTokens(i.bytes), 0);
        extra = [
          {
            role: "user",
            content: [
              {
                type: "text",
                text: `Imagenes leidas con image_read, adjuntadas a esta peticion: ${norm.map((i) => i.path).join(", ")}${norm.some((i) => i.resized) ? " (escala reducida para caber en el modelo vision)" : ""}`
              },
              ...norm.map((i) => ({
                type: "image_url",
                image_url: { url: `data:${i.mime};base64,${i.b64}` }
              }))
            ]
          }
        ];
        emit({ type: "image_attached", images: norm.map(({ path, mime, bytes, resized, w, h }) => ({ path, mime, bytes, resized, w, h })) });
      }
      const msg = await chatStream(
        cfg,
        {
          model,
          messages: [
            { role: "system", content: system },
            ...trimHistory(hist, Math.max(2000, budget - imgTokens)),
            ...extra
          ],
          tools: TOOLS,
          max_tokens: cfg.maxOutputTokens,
          temperature: cfg.temperature
        },
        { onDelta: (t) => emit({ type: "token", content: t }), onThink, signal, onCall, onRetry }
      );

      const msgText = String(msg.content ?? "").trim();
      if (!msg.tool_calls?.length && !msgText) {
        // El modelo termino sin contenido ni herramientas: no dar por terminado en silencio.
        // Se reintenta hasta 2 veces; si sigue vacio, se notifica al usuario.
        emptyStreak++;
        if (emptyStreak <= 2) {
          emit({ type: "notice", message: `El modelo devolvio una respuesta vacia - reintento ${emptyStreak}/2` });
          await sleepAbortable(2000, signal);
          continue;
        }
        session.messages.push(msg);
        const m = "El modelo termino sin producir respuesta ni acciones (3 intentos). Reenvia el mensaje o prueba con otro modelo.";
        session.messages.push({ role: "error", content: "⚠ " + m });
        emit({ type: "error", message: m });
        break;
      }
      emptyStreak = 0;
      session.messages.push(msg);
      if (!msg.tool_calls?.length) break;

      for (const tc of msg.tool_calls) {
        if (signal?.aborted) break;
let args = {};
        try {
          args = JSON.parse(tc.function.arguments || "{}");
        } catch {
          args = { _raw: tc.function.arguments };
        }
        emit({ type: "tool_call", id: tc.id, name: tc.function.name, args });
        const result = await runTool(tc.function.name, args, { cfg, session, emit, signal, run, approve });
        emit({ type: "tool_result", id: tc.id, name: tc.function.name, ok: result.ok, output: result.output });
        session.messages.push({ role: "tool", tool_call_id: tc.id, name: tc.function.name, content: result.output });
      }
    }
  } finally {
    reconcile(session.messages);
  }
}