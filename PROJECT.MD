# bzHarness — Documento de proyecto (para humanos y AIs)

Herramienta local (solo `127.0.0.1`) que proporciona una **UI web de chat** para operar un
agente LLM con herramientas (shell, ficheros, búsqueda) dentro de un **sandbox por sesión**.
Sin build step, sin bundler: Node.js ESM + HTML/JS/CSS plano. Deps: `express`, `fast-glob`.

> `README.md` documenta la parte "usuario"; este archivo documenta el **funcionamiento interno**
> para poder continuar el desarrollo (idealmente por una IA).

## 1. Ejecución

```bash
npm run dev        # node --watch src/server.js  (auto-reinicia al cambiar src/*.js; NO al morir el proceso)
```

- Puerto por defecto: `4321` (config `port`; cambiarlo exige reiniciar el proceso).
- Config viva: `config/config.json` (gitignorado; `config/.gitignore` = `*`). Se lee en arranque
  y se relee al guardar (PUT `/api/config`). Si el fichero tiene BOM, se tolera (se retira antes de parsear).
- **Ojo**: `node --watch` no relanza tras un crash; tras matar el proceso hay que relanzar `npm run dev`.
- Prueba rápida sin LLM: `node scripts/smoke.js` (config de prueba en `config.json`; 15 aserciones).

## 2. Arquitectura de alto nivel

```
Navegador (public/)                     Node (src/)
┌──────────────────────────┐   SSE     ┌────────────────────────────────────────────┐
│ index.html + app.js      │◄─────────│ server.js  (Express, localhost)            │
│ style.css + vendor/      │   REST   │  /api/chat (POST, stream SSE)              │
│                          │─────────►│  /api/sessions, /api/config, /api/models…  │
└──────────────────────────┘          │        ▼                                    │
                                      │ agent.js  (bucle agente: LLM ⇄ tools)       │
                                      │  ├── llm.js  (cliente OpenAI-compat + SSE)  │
                                      │  └── tools/  (shell, files, search)         │
                                      │        └── util/contain.js (sandbox)        │
                                      └────────────────────────────────────────────┘
```

Flujo de un turno:
1. UI → `POST /api/chat {sessionId, message}`. El servidor responde `Content-Type: text/event-stream`.
2. `server.js` crea un `AbortController` + `run` (child processes, aprobaciones, log de llamadas) y llama a `runAgent`.
3. `agent.js` itera (máx. 8): construye `messages` (system + historial recortado por `util/tokens.js`), llama a `chatStream` y, si el asistente devuelve `tool_calls`, ejecuta cada tool y añade los `role:"tool"` al historial. Sin `tool_calls` → fin.
4. Cada suceso se emite a la UI como evento SSE: `token`, `think`, `tool_call`, `tool_result`, `approval_request`, `retry`, `error`, `done`, `end`.
5. Al terminar, el transcript se persiste en `<workdir>/.bzharness/sessions/<id>.json` y el índice global en `config/sessions-index.json`.

## 3. Módulos principales

### `src/config.js`
- `DEFAULTS` + merge con `config/config.json` (`loadConfig`); `saveConfig(patch)` valida y reescribe.
- Claves: `baseUrl`, `apiKey` (o env `HARNESS_API_KEY`), `model` (`auto` o id), `maxContextTokens`, `maxOutputTokens`, `temperature`, `defaultWorkdir`, `workspacePresets`, `showThinking`, `shellApproval`, `shellTimeoutMs`, `port`.
- `loadIndex/saveIndex`: índice global de sesiones.

### `src/llm.js` — cliente LLM
- `chatStream(cfg, body, {onDelta, onThink, signal, onCall, onRetry})`: **bucle de reintentos** (máx. 4) ante 408/429/5xx o fallo de red, backoff 1.5 s/4 s/8 s, respeta `retry-after` (máx. 30 s).
- `chatStreamOnce`: fetch POST a `joinBase(baseUrl, "/chat/completions")` con `stream:true`; parser SSE manual (líneas `data: …`, tolera keep-alives `: ping`, ignora `[DONE]`). Acumula `delta.content` → `onDelta`, `delta.reasoning_content`/`delta.reasoning` → `onThink`, y `delta.tool_calls[]` por índice (id + name + arguments concatenados).
- **`sanitizeLLMBody`** (antes de enviar): normaliza CRLF→LF, borra control chars y repara tags `</` incompletos al final de cadenas. **NO trunca nada** (decisión explícita del usuario: no perder contexto).
- Errores → `LLMError` con `detail` (ts, url, status, headers, responseBody 20 KB, resumen de la petición, baseUrl) que la UI y el log de errores usan.
- `listModels(cfg)`: GET `/models` relativo a `baseUrl`.
- **IMPORTANTE (quirk del gateway del usuario)**: con `baseUrl = https://benzia.javierbenzo.com/v1` todo funciona (probado con payloads de 17 KB y 100 KB). La **ruta raíz** `…/chat/completions` (sin `/v1`) tiene un buffer de 16 384 bytes en alguna pierna de su proxy: cuerpos mayores → `500 gateway_error` determinista en TODOS los modelos. Por eso la `baseUrl` lleva `/v1`. Si cambias el proveedor, verifica el endpoint `/v1`.

### `src/agent.js`
- `runAgent({cfg, model, session, userMessage, emit, signal, run, approve, onCall, onRetry, onThink})`.
- `buildSystemPrompt(session)`: identidad + sandbox + políticas (no salir del sandbox, usar `shell_exec` para comandos, etc.).
- Presupuesto de contexto: `maxContextTokens - tokens(system) - min(maxOutputTokens, 8192)` (mín. 4000); `trimHistory` recorta por el **inicio** preservando el par asistente→tool consistente.
- Errores de tool NUNCA lanzan: `runTool` los convierte en `{ok:false, output}` para que el modelo pueda autocorregirse.

### `src/server.js` — API + ciclo de vida
- Endpoints (solo localhost):
  - `GET/PUT /api/config` (PUT: `apiKey` vacío o `••••…` se ignora; `port` no es editable en caliente; se limpia `browsableRoots` si llega)
  - `GET /api/models`, `GET /api/workspaces`
  - `POST /api/pick-dir {start}` → lanza `scripts/pick-dir.ps1` (selector nativo moderno de Windows) y devuelve `{path}` o `null` si se cancela
  - `POST /api/sessions {name?, workdir, model?}` (crea el árbol `.bzharness/`), `GET /api/sessions`, `GET/DELETE /api/sessions/:id`
  - `POST /api/chat {sessionId, message}` (SSE; 409 si ya hay run activo)
  - `POST /api/approvals/:id {approved}`, `POST /api/stop/:sessionId`
- **Modelo `auto`**: primero `cfg.model` si no es `auto`; si lo es, `listModels` y elige el id **sin prefijo de proveedor** (p. ej. `qwen3.8-27b`) si existe, si no el primero.
- SSE: `emit` comprueba `!res.writableEnded && res.writable`; `res.on("error")` silenciado (un cliente que desconecta no tumba el proceso).
- **Resiliencia a crashes** (el proceso ya se nos cayó una vez por un `spawn` sin handler de `error`):
  - `process.on("uncaughtException" / "unhandledRejection")` → log en `config/crash.log` y **el servidor sigue vivo**.
  - `shell_exec`: el hijo escucha `error` y `close`; `killTree` ignora fallos de `taskkill` y salta sin PID.
  - Persistencia de sesión dentro de try/catch.
- `writeErrorLog(session, detail)`: volcado JSON en `<workdir>/.bzharness/llm-errors/<ts>-llm-error.log`; la UI lo enlaza en el panel `+ info` del error.

### `src/tools/` — herramientas del modelo
- `index.js`: registro (`TOOLS` para el schema OpenAI) + `runTool(name, args, ctx)` (catch-all → `{ok, output}`).
- `shell.js` `shell_exec {command, workdir?}`: `spawn(command, {shell:true, cwd})` en el sandbox; timeout `shellTimeoutMs` (mata árbol con `taskkill /T /F` en win32); salida combinada; log completo en `<workdir>/.bzharness/runs/<ts>-<slug>.log`; en la respuesta muestra hasta 30 000 chars. `approve(command)` → si `shellApproval` está activo, la UI pide OK/No.
- `files.js` `file_read {path, startLine?, endLine?}`, `file_write {path, content}`, `file_edit {path, oldText, newText, replaceAll?}`.
- `search.js` `glob_files {pattern, path?}`, `grep_files {pattern, path?, include?}`.
- **Todas** las rutas pasan por `util/contain.js → resolveInSandbox(workdir, p)`: resuelve contra el sandbox, niega `..`/absolutas fuera y revalida con `realpath` (anti-symlink). Violación → `SandboxError` → el modelo ve `VIOLACION DE SANDBOX: …`.

### `src/util/`
- `tokens.js`: `estimateMsgTokens` (≈ chars/3.8) y `trimHistory` (recorte desde el inicio conservando pares asistente→tool).
- `contain.js`: ver sandbox.

### `public/` — UI (sin framework)
- `index.html`: layout (aside de sesiones + chat + composer), modales: nueva sesión (solo **ruta + Examinar + presets** — el explorador de carpetas web fue retirado; `Examinar` abre el selector nativo de Windows vía `/api/pick-dir`), configuración (incluye el check **"Mostrar cadena de pensamiento"**), aprobación de comandos, popup de tool.
- `vendor/` (vendado, sin CDN en runtime): `marked` (markdown), `highlight.js` + tema GitHub Dark, `DOMPurify`.
- `app.js` (ESM, ~600 líneas):
  - `consumeSSE` (parsea bloques `data: …` separados por `\n\n`) y manejadores: `token` (pinta con `inlineMd` —render rápido—), `think` (rellena la `.thinkbox` del globo), `tool_call`/`tool_result` (chips), `approval_request` (modal), `retry`, `error` (burbuja + `+ info`), `done` (al terminar el turno, `finalizeTurn` re-renderiza el globo con **`fullMD`**: marked + DOMPurify + highlight.js).
  - **Chips de tools**: píldoras `icono + verbo` (Read/Write/Edit/Shell/Glob/Grep) que flotan en horizontal; clic → **popup** `#modalTool` con args/salida. `shell_exec` muestra el **comando** como bloque bash resaltado; `file_write` muestra **ruta + contenido en bruto** (con resaltado según extensión) en lugar del JSON.
  - `toolStore` (Map id → {name,args,output,ok}) alimenta el popup y se actualiza en vivo si está abierto.
  - **think**: solo se emite si `showThinking` está activo en config (el servidor no envía `think` si no); caja fina/gris (`font-weight:200`) dentro del globo.
- `style.css`: tema oscuro; clases `.msg/.bubble/.thinkbox/.toolchips/.toolchip/.toolpre/.errinfo/…`.

### `scripts/`
- `smoke.js`: suite de humo (sandbox, tools, config, LLM fake).
- `pick-dir.ps1` + `FolderPick.cs`: **selector de carpetas nativo moderno** (Win32 `IFileOpenDialog` + `FOS_PICKFOLDERS` vía `Add-Type` bajo demanda; compila la primera vez, ~1-2 s). Fallback al clásico `FolderBrowserDialog` si la compilación fallara. El C# debe compilarse con **Add-Type (C#5)**: nada de interpolación de cadenas ni `dynamic`.

## 4. Decisión clave y quirks a recordar

1. **`baseUrl` termina en `/v1`** — la ruta raíz del proxy del usuario tiene límite de cuerpo de 16 384 B (bug de su gateway, no del harness). No reintroducir trunca de payload: el usuario lo prohíbe.
2. **Ninguna truncación de contexto** en el harness: `sanitizeLLMBody` solo repara bytes (CRLF, control chars, `</` colgado); `fitToWireLimit`/`maxRequestBytes` fueron **eliminados** de forma intencionada.
3. **Crashes**: todo lo que pueda lanzar (`spawn error`, rejections, writes SSE a socket muerto) está capturado; los imprevistos caen a `config/crash.log` y el proceso sobrevive.
4. **`node --watch` no relanza tras un crash** → si el usuario ve el puerto caído, debe relanzar `npm run dev`.
5. PowerShell 5.1 (Windows): `Set-Content -Encoding UTF8` **escribe BOM** (rompió `config.json` una vez; `rawConfig` ya lo tolera). `$pid` es variable reservada. Para JSON, prefiere `[IO.File]::WriteAllText(…, (New-Object System.Text.UTF8Encoding $false))`.
6. `npm run dev` arranca en `127.0.0.1:4321`; las sesiones viven en sus `workdir/.bzharness/` (el índice en `config/`). Borrar una sesión borra el transcript, no la carpeta.
7. El streaming del proveedor puede incluir `: ping` (keep-alive SSE); el parser ya lo ignora. `reasoning_content` solo se ve si el modelo/gateway lo emite.

## 5. Mapa de ficheros

| Fichero | Rol |
|---|---|
| `package.json` | scripts (`dev`), deps mínimas |
| `src/server.js` | Express, API, SSE, sesiones, resiliencia |
| `src/agent.js` | bucle agente + system prompt |
| `src/llm.js` | cliente LLM (SSE, reintentos, saneo, errores) |
| `src/config.js` | config + índice de sesiones |
| `src/tools/index.js` | registro de tools + `runTool` |
| `src/tools/shell.js` | `shell_exec` (spawn, timeout, logs, approval) |
| `src/tools/files.js` | `file_read` / `file_write` / `file_edit` |
| `src/tools/search.js` | `glob_files` / `grep_files` |
| `src/util/contain.js` | sandbox (resolve + realpath) |
| `src/util/tokens.js` | estimación y recorte de historial |
| `public/index.html` | layout + modales |
| `public/app.js` | UI: SSE, chips, popup, think, markdown |
| `public/style.css` | tema |
| `public/vendor/*` | marked, highlight.js, DOMPurify |
| `scripts/smoke.js` | tests de humo |
| `scripts/pick-dir.ps1`, `scripts/FolderPick.cs` | selector nativo de carpetas |
| `config/config.json` | config viva (gitignorada) |
| `README.md` | doc de usuario |