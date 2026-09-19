# bzHarness by Benzo

Chat harness local: interfaz web de chat (localhost) conectada a un LLM **OpenAI-compatible**, con ejecución de comandos, tool calls y creación/edición de ficheros. Cada sesión de chat se abre con su **carpeta de trabajo (sandbox)** y todo lo que el agente cree o ejecute queda **confinado a esa carpeta**.

## Características

- UI web en `http://127.0.0.1:4321` (chat con streaming SSE, tarjetas de tool calls, detener ejecución)
- Markdown completo en las respuestas: tablas (incluidas las que el LLM emite sin fila separadora), código resaltado, citas, listas. Estilizado con `github-markdown-css` (la solución consolidada para el markdown de chats IA), adaptado al tema oscuro. Los emojis se omiten en el texto resultante.
- LLM OpenAI-compatible: `/v1/chat/completions` (streaming) + detección de modelos vía `GET /v1/models`. Funciona con OpenRouter, OpenAI, Ollama, LM Studio, vLLM, etc.
- Configuración propia del LLM: `baseUrl`, `apiKey`, `model` (o `auto`), `maxContextTokens`, `maxOutputTokens`, `temperature`
- **Sesiones con sandbox**: cada sesión declara su `workdir`; las tools de fichero y los comandos no pueden salir de ella (defensa contra `..`, rutas absolutas y symlinks)
- Herramientas (tool calls): `shell_exec`, `file_read`, `file_write`, `file_edit`, `image_read`, `glob_files`, `grep_files`, `web_search` (DuckDuckGo, sin API key), `web_fetch` (lee el contenido de una URL como texto)
- **Visión**: `image_read` lee una imagen del sandbox (`png/jpg/gif/webp/bmp`, máx 10 MB) y la adjunta a la siguiente petición al modelo en el formato vision estándar (`content: [{type:"text"},{type:"image_url", url:"data:<mime>;base64,…"}]`). Antes de enviarse, las imágenes del turno se **escalan automáticamente en bloque** (máx 1568 px de lado por imagen y 4 MP en total, y se re-codifican) para no exceder el presupuesto de visión del gateway, que es por petición (evita errores 413 tipo "raw patches exceed processor budget" cuando adjuntas varias imágenes). Requiere un modelo con visión (p. ej. `gpt-4o`, `claude`, `gemini`, `qwen-vl`); la UI muestra la miniatura en el chat
- **Adjuntos en el chat**: pega (Ctrl+V), arrastra o usa el botón 📎 para adjuntar ficheros al mensaje (máx 8, 10 MB c/u). Se copian a `<workdir>/.attachments/` y el mensaje incluye la referencia; las imágenes se envían además al LLM en formato vision
- **Métricas de tokens**: cada turno muestra `tok/s`, tokens enviados (`↑`) y recibidos (`↓`) y el % de prompt servido desde la cache KV (`◈`), cuando el proveedor reporta `usage` en el stream (el harness lo pide con `stream_options.include_usage` y lo desactiva solo si el gateway no lo soporta). El sidebar muestra el acumulado de tokens por sesión
- Artefactos del agente en `<workdir>/.bzharness/` (transcript de la sesión + logs completos de comandos)
- Opcional: aprobación manual de comandos shell desde la UI

## Puesta en marcha

```bash
npm install
npm run dev        # o: npm start
```

O en Windows, doble clic en `start-harness.bat`: mata cualquier proceso que ocupe el puerto (se lee de `config/config.json`, por defecto `4321`), arranca `node src/server.js` y abre la web en el navegador.

## Empaquetado (Windows)

Genera un **exe portable** (sin Node, sin instalación) con Electron:

```bash
npm install          # incluye electron + electron-builder (devDeps)
npm run dist         # -> dist/bzHarness-0.1.0-win-x64.exe
```

- El exe arranca el servidor en un puerto aleatorio de `127.0.0.1` y abre su propia ventana; la config vive en `%APPDATA%/bzHarness/config/`.
- `npm run electron:dev` lo ejecuta desde el código fuente sin empaquetar.
- Si `npm run dist` falla al extraer `winCodeSign` (symlinks), activa el **modo desarrollador** de Windows o ejecuta el build en terminal elevada.
- El modo web/CLI (`npm run dev`) sigue funcionando en paralelo; los dos modos conviven (puertos distintos).

Abre `http://127.0.0.1:4321` → **Configuración** → base URL + API key → (los modelos se detectan solos) → **Nueva sesión** → elige la carpeta de trabajo → chatea.

Alternativa: variable de entorno `HARNESS_API_KEY` si no quieres guardar el token en disco.

## Configuración

`config/config.json` (se genera con defaults; se edita desde la UI):

| Clave | Descripción |
|---|---|
| `baseUrl` | Endpoint OpenAI-compatible (p.ej. `https://api.openrouter.ai/v1`, `http://localhost:11434/v1`) |
| `apiKey` | Token (también vía env `HARNESS_API_KEY`) |
| `model` | Modelo concreto. No se usa "auto": si se detecta uno pendiente, el harness lo resuelve al arrancar (primero de `/v1/models` sin "/") y lo guarda |
| `maxContextTokens` | Presupuesto de contexto; el historial se recorta si lo supera |
| `maxOutputTokens` | `max_tokens` por respuesta |
| `temperature` | Temperatura de muestreo |
| `defaultWorkdir` | Carpeta por defecto al crear sesiones |
| `workspacePresets` | Atajos mostrados en el diálogo de nueva sesión |
| `showThinking` | `true` → la UI muestra el razonamiento: "esperando al modelo…" (pulso) → `Thinking` (palabra con pulso) + última frase en gris claro → al terminar, recuadro `Razonamiento` desplegable (auto-crece sin scrollbar) |
| `shellApproval` | `true` → la UI pide aprobación antes de cada comando shell |
| `shellTimeoutMs` | Timeout por comando (el proceso se mata y se marca TIMEOUT) |
| `llmIdleTimeoutMs` | Silencio máximo del stream del LLM (default 90000): si el gateway deja de enviar sin cerrar, se corta la conexión y se reintenta |
| `port` | Puerto del servidor (cambios requieren reiniciar) |

## Sandbox por sesión

Al crear una sesión con `workdir = W`:

```
W/
  .bzharness/            # creada por el harness (con .gitignore interno)
    sessions/<id>.json   # transcript + metadatos de la sesión
    runs/<ts>-<cmd>.log  # salida completa de cada shell_exec
    .attachments/        # ficheros e imágenes que el usuario adjunta por chat
  ...resto de ficheros generados por el agente
```

- `file_read/write/edit`, `image_read`, `glob_files`, `grep_files`: cualquier ruta se resuelve contra `W`; `..` o rutas absolutas fuera → error de sandbox (el LLM lo ve y puede corregirlo). `image_read` solo sirve imágenes (`png/jpg/gif/webp/bmp`, máx 10 MB) y las adjunta a la siguiente llamada al LLM como parte `image_url` (data-URL base64).
- `web_search` / `web_fetch`: el agente puede investigar en internet sin API key — `web_search` consulta DuckDuckGo (HTML público) y devuelve título/URL/snippet; `web_fetch` descarga la URL y la convierte a texto plano (máx 15 000 chars por página). Puede iterar: buscar, leer varias páginas, refinar la búsqueda y sintetizar, citando las URLs de donde sacó la información.
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
- `GET /api/sessions/:id/file?path=` — sirve una **imagen** del sandbox (para las miniaturas del chat); solo `png/jpg/gif/webp/bmp`, máx 15 MB
- `POST /api/sessions/:id/upload` `{files:[{name, mime, b64}]}` — copia los adjuntos a `<workdir>/.attachments/` (máx 8 ficheros, 10 MB c/u); el siguiente `POST /api/chat` los adjunta (imágenes en formato vision + referencia en el mensaje)
- `POST /api/chat` `{sessionId, message}` → SSE: `token`, `tool_call`, `tool_result`, `image_attached`, `approval_request`, `done`, `end`, `error`
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