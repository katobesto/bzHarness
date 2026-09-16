export function estimateMsgTokens(m) {
  let c = typeof m.content === "string" ? m.content.length : 0;
  for (const tc of m.tool_calls || []) {
    c += (tc.function?.name || "").length + (tc.function?.arguments || "").length;
  }
  return Math.ceil(c / 4) + 4;
}

export function trimHistory(messages, budget) {
  if (!messages.length) return [];
  let tokens = messages.reduce((s, m) => s + estimateMsgTokens(m), 0);
  const minKeep = Math.min(6, messages.length);
  let start = 0;
  while (tokens > budget && start < messages.length - minKeep) {
    tokens -= estimateMsgTokens(messages[start]);
    start++;
  }
  const out = messages.slice(start);
  while (out.length && out[0].role === "tool") out.shift();
  return out;
}