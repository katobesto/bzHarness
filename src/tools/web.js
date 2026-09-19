// Herramientas web: busqueda (DuckDuckGo HTML, sin API key) + descarga de paginas a texto.
// El agente itera: web_search -> elige URLs -> web_fetch -> analiza -> (refina la busqueda) -> sintetiza.

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
const DDG_ENDPOINT = "https://html.duckduckgo.com/html/";
const searchEndpoint = () => process.env.BZH_WEB_SEARCH_URL || DDG_ENDPOINT;
const SEARCH_TIMEOUT_MS = 15000;
const FETCH_TIMEOUT_MS = 20000;
const FETCH_MAX_BYTES = 3_000_000;
const FETCH_MAX_CHARS = 15000;

async function timedFetch(url, ms, headers = {}) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), ms);
  try {
    return await fetch(url, { headers: { "user-agent": UA, ...headers }, redirect: "follow", signal: ac.signal });
  } finally {
    clearTimeout(t);
  }
}

function decodeEntities(s) {
  return s
    .replace(/&nbsp;/gi, " ")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => {
      try {
        return String.fromCodePoint(+n);
      } catch {
        return " ";
      }
    })
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => {
      try {
        return String.fromCodePoint(parseInt(n, 16));
      } catch {
        return " ";
      }
    })
    .replace(/&amp;/gi, "&");
}

function stripTags(html) {
  let t = html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, " ")
    .replace(/<svg[\s\S]*?<\/svg>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<(header|nav|footer|aside|form|iframe|button|input|select|textarea)[\s\S]*?<\/\1>/gi, " ");
  t = t.replace(/<\/(p|div|li|tr|h[1-6]|blockquote|pre|section|article|table|ul|ol)>/gi, "\n");
  t = t.replace(/<li[^>]*>/gi, "- ");
  t = t.replace(/<br[^>]*>/gi, "\n");
  t = t.replace(/<[^>]+>/g, "");
  t = decodeEntities(t);
  t = t
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/[ \t]{2,}/g, " ")
    .trim();
  return t;
}

function cleanSearchUrl(href) {
  let u = href.trim();
  if (u.startsWith("//")) u = "https:" + u;
  // redirecciones de DuckDuckGo: //duckduckgo.com/l/?uddg=<url-encodado>&rut=...
  if (u.includes("duckduckgo.com/l/")) {
    try {
      const q = new URL(u).searchParams.get("uddg");
      if (q) u = q;
    } catch {
      /* se queda con la url original */
    }
  }
  return u;
}

export const webSearch = {
  name: "web_search",
  description:
    "Busca en internet (DuckDuckGo, sin API key) informacion, documentacion tecnica o noticias. Devuelve una lista de resultados (titulo, URL, resumen). Para leer el contenido completo de una pagina usa despues web_fetch con su URL. Puedes iterar: refinar la busqueda y leer varias paginas hasta tener la informacion necesaria.",
  parameters: {
    type: "object",
    properties: {
      query: { type: "string", description: "consulta de busqueda (usa terminos concretos; incluye el nombre de libreria/version/errores si aplica)" },
      max_results: { type: "number", description: "maximo de resultados (por defecto 8, max 10)" }
    },
    required: ["query"]
  },
  async run(args) {
    const query = String(args.query || "").trim();
    if (!query) throw new Error("query requerida");
    const max = Math.max(1, Math.min(10, Math.round(Number(args.max_results) || 8)));
    const url = searchEndpoint() + "?q=" + encodeURIComponent(query);
    const res = await timedFetch(url, SEARCH_TIMEOUT_MS, { accept: "text/html" });
    if (!res.ok) throw new Error(`busqueda fallida: HTTP ${res.status}`);
    const html = await res.text();

    const links = [...html.matchAll(/<a[^>]+class="[^"]*result__a[^"]*"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g)];
    const snips = [...html.matchAll(/<a[^>]+class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/a>/g)];
    if (!links.length) {
      if (/anomaly|challenge|not a robot/i.test(html)) {
        throw new Error("DuckDuckGo devolvio una pagina de verificacion (anomaly). Intentalo de nuevo o con otra consulta.");
      }
      return "(sin resultados para: " + query + ")";
    }
    const out = [];
    for (let i = 0; i < links.length && out.length < max; i++) {
      const u = cleanSearchUrl(decodeEntities(links[i][1]));
      if (!/^https?:\/\//i.test(u)) continue;
      const title = stripTags(links[i][2]).slice(0, 200);
      const snippet = i < snips.length ? stripTags(snips[i][1]).replace(/\s+/g, " ").slice(0, 300) : "";
      out.push(`${out.length + 1}. ${title}\n   ${u}${snippet ? "\n   " + snippet : ""}`);
    }
    if (!out.length) return "(sin resultados para: " + query + ")";
    return out.join("\n");
  }
};

export const webFetch = {
  name: "web_fetch",
  description:
    "Descarga una pagina web (URL http/https que te devolvio web_search o que conozcas) y devuelve su contenido convertido a texto plano (sin scripts/estilos), truncado si es muy largo. Usala para leer documentacion, articulos o paginas y extraer la informacion que necesitas.",
  parameters: {
    type: "object",
    properties: {
      url: { type: "string", description: "URL absoluta http(s) a descargar" },
      max_chars: { type: "number", description: "maximo de caracteres a devolver (por defecto 15000, max 30000)" }
    },
    required: ["url"]
  },
  async run(args) {
    const url = String(args.url || "").trim();
    if (!/^https?:\/\//i.test(url)) throw new Error("solo se permiten URLs http(s)");
    const maxChars = Math.max(500, Math.min(30000, Math.round(Number(args.max_chars) || FETCH_MAX_CHARS)));
    const res = await timedFetch(url, FETCH_TIMEOUT_MS, { accept: "text/html,text/plain;q=0.9,*/*;q=0.5" });
    if (!res.ok) throw new Error(`no se pudo descargar: HTTP ${res.status}`);
    const ctype = (res.headers.get("content-type") || "").toLowerCase();
    if (!/html|text\/plain|text\/markdown/.test(ctype) && !(!ctype)) {
      return `No se puede procesar el contenido (content-type: ${ctype || "desconocido"}). Prueba otra fuente.`;
    }
    let body = await res.text();
    if (Buffer.byteLength(body, "utf8") > FETCH_MAX_BYTES) body = body.slice(0, FETCH_MAX_BYTES);
    const isHtml = /html/.test(ctype) || /^\s*</.test(body);
    const text = isHtml ? stripTags(body) : decodeEntities(body).trim();
    if (!text) return "La pagina no contiene texto util (puede ser solo imagenes o JavaScript).";
    const cut = text.length > maxChars;
    const content = cut ? text.slice(0, maxChars) : text;
    const head = `URL: ${res.url || url}\n(HTTP ${res.status}, ${content.length} chars${cut ? ", truncado" : ""})\n---\n`;
    return head + content + (cut ? `\n… [truncado a ${maxChars} chars]` : "");
  }
};