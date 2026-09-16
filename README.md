# bzHarness

Chat harness local: interfaz web de chat (localhost) conectada a un LLM **OpenAI-compatible**, con ejecución de comandos, tool calls y creación/edición de ficheros. Cada sesión de chat se abre con su **carpeta de trabajo (sandbox)** y todo lo que el agente cree o ejecute queda **confinado a esa carpeta**.

## Características

- UI web en `http://127.0.0.1:4321` (chat con streaming SSE, tarjetas de tool calls, detener ejecución)
- Markdown completo en las respuestas: tablas (incluidas las que el LLM emite sin fila separadora), código resaltado, citas, listas
- LLM OpenAI-compatible: `/v1/chat/completions` (streaming) + detección de modelos vía `GET /v1/models`. Funciona con OpenRouter, OpenAI, Ollama, LM Studio, vLLM, etc.
- Configuración propia del LLM: `baseUrl`, `apiKey`, `model` (o `auto`), `maxContextTokens`, `maxOutputTokens`, `temperature`
- **Sesiones con sandbox**: cada sesión declara su `workdir`; las tools de fichero y los comandos no pueden salir de ella (defensa contra `..`, rutas absolutas y symlinks)
- Herramientas (tool calls): `shell_exec`, `file_read`, `file_write`, `file_edit`, `glob_files`, `grep_files`
- Artefactos del agente en `<workdir>/.bzharness/` (transcript de la sesión + logs completos de comandos)
- Opcional: aprobación manual de comandos shell desde la UI

## Puesta en marcha

```bash
npm install
npm run dev        # o: npm start
```

O en Windows, doble clic en `start-harness.bat`: mata cualquier proceso que ocupe el puerto (se lee de `config/config.json`, por defecto `4321`), arranca `node src/server.js` y abre la web en el navegador.

Abre `http://127.0.0.1:4321` → **Configuración** → base URL + API key → (los modelos se detectan solos) → **Nueva sesión** → elige la carpeta de trabajo → chatea.

Alternativa: variable de entorno `HARNESS_API_KEY` si no quieres guardar el token en disco.

## Configuración

`config/config.json` (se genera con defaults; se edita desde la UI):

| Clave | Descripción |
|---|---|
| `baseUrl` | Endpoint OpenAI-compatible (p.ej. `https://api.openrouter.ai/v1`, `http://localhost:11434/v1`) |
| `apiKey` | Token (también vía env `HARNESS_API_KEY`) |
| `model` | Nombre de modelo o `auto` (detecta el primero de `/v1/models`) |
| `maxContextTokens` | Presupuesto de contexto; el historial se recorta si lo supera |
| `maxOutputTokens` | `max_tokens` por respuesta |
| `temperature` | Temperatura de muestreo |
| `defaultWorkdir` | Carpeta por defecto al crear sesiones |
| `workspacePresets` | Atajos mostrados en el diálogo de nueva sesión |
| `showThinking` | `true` → la UI muestra el stream de razonamiento (`reasoning_content`) en gris fino |
| `shellApproval` | `true` → la UI pide aprobación antes de cada comando shell |
| `shellTimeoutMs` | Timeout por comando (el proceso se mata y se marca TIMEOUT) |
| `port` | Puerto del servidor (cambios requieren reiniciar) |

## Sandbox por sesión

Al crear una sesión con `workdir = W`:

```
W/
  .bzharness/            # creada por el harness (con .gitignore interno)
    sessions/<id>.json   # transcript + metadatos de la sesión
    runs/<ts>-<cmd>.log  # salida completa de cada shell_exec
  ...resto de ficheros generados por el agente
```

- `file_read/write/edit`, `glob_files`, `grep_files`: cualquier ruta se resuelve contra `W`; `..` o rutas absolutas fuera → error de sandbox (el LLM lo ve y puede corregirlo).
- Defensas contra symlinks (el realpath debe permanecer dentro de `W`).
- `shell_exec`: se lanza con `cwd = W` (o subcarpeta relativa dentro). **Limitación**: un shell puede teóricamente `cd`/escribir fuera; para mitigar usa `shellApproval: true` (aprobación por comando en la UI) y revisa los logs en `.bzharness/runs/`.
- El transcript de la sesión vive **dentro** de su carpeta de trabajo; el índice de sesiones (lista global) vive en `config/`.

## API (localhost)

- `GET /api/config` · `PUT /api/config`
- `GET /api/models` — proxy de `/v1/models`
- `GET /api/workspaces` — defaultWorkdir, presets
- `POST /api/pick-dir` `{start}` — abre el selector nativo de carpetas de Windows y devuelve `{path}`
- `POST /api/sessions` `{name?, workdir, model?}`
- `GET /api/sessions` · `GET/DELETE /api/sessions/:id`
- `POST /api/chat` `{sessionId, message}` → SSE: `token`, `tool_call`, `tool_result`, `approval_request`, `done`, `end`, `error`
- `POST /api/approvals/:id` `{approved}` · `POST /api/stop/:sessionId`

## Estructura

```
src/
  server.js     # Express: API, SSE, sesiones, aprobaciones
  config.js     # carga/validación de config + índice de sesiones
  llm.js        # cliente OpenAI-compatible (streaming, /v1/models)
  agent.js      # bucle agéntico: LLM -> tool calls -> results
  tools/        # shell.js, files.js, search.js + registro (index.js)
  util/         # contain.js (sandbox), tokens.js (estimación/recorte)
public/         # UI web (vanilla JS, sin build)
scripts/smoke.js# test de herramientas + sandbox sin LLM
```

## Verificación

```bash
npm run smoke   # crea un sandbox temporal y prueba ficheros, búsqueda, shell y escapes bloqueados
```