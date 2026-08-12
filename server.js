require("dotenv").config();
const Fastify = require("fastify");
const fs = require("fs-extra");
const path = require("path");
const { formatDateTimeInTimeZone, resolveTimeZone, zonedWallTimeToDate } = require("./time_utils");

const DEFAULT_BODY_LIMIT_MB = 50;
function readBodyLimitBytes() {
  const configured = Number(process.env.REQUEST_BODY_LIMIT_MB);
  const mb = Number.isFinite(configured) && configured > 0 ? configured : DEFAULT_BODY_LIMIT_MB;
  return Math.floor(mb * 1024 * 1024);
}

const app = Fastify({ logger: true, bodyLimit: readBodyLimitBytes() });
app.register(require("@fastify/formbody"));

const PORT = Number(process.env.PORT) || 3000;
const TARGET_API_URL = process.env.TARGET_API_URL;
const TIME_ZONE = resolveTimeZone();

const IS_RAILWAY_RUNTIME = Boolean(
  process.env.RAILWAY_ENVIRONMENT || process.env.RAILWAY_PROJECT_ID || process.env.RAILWAY_SERVICE_ID
);

const TIMELINE_FILE = "enhanced_messages.json";
const TIMESTAMP_DB_FILE = "./message_timestamps.json";

const DEFAULT_RESTART_COMMAND = "pm2 restart gateway wake-up --update-env";

function readBooleanEnv(key, fallback = false) {
  const raw = String(process.env[key] ?? "").trim().toLowerCase();
  if (!raw) return fallback;
  return ["1", "true", "yes", "on"].includes(raw);
}

function configuredModelName() {
  return String(process.env.MODEL_NAME || "gateway-model").trim() || "gateway-model";
}

function shouldForwardMultimodalContent() {
  const mode = (process.env.MULTIMODAL_MODE || "passthrough").trim().toLowerCase();
  return !["text", "plain", "placeholder", "false", "off", "0"].includes(mode);
}

function isDataImageUrl(value) {
  return typeof value === "string" && /^data:image\//i.test(value);
}

function isImageContentPart(part) {
  if (!part || typeof part !== "object") return false;
  if (part.image_url) return true;
  const type = typeof part.type === "string" ? part.type.toLowerCase() : "";
  return type.includes("image");
}

function isFileContentPart(part) {
  if (!part || typeof part !== "object") return false;
  if (part.file) return true;
  const type = typeof part.type === "string" ? part.type.toLowerCase() : "";
  return type.includes("file");
}

function getTextFromContentPart(part) {
  if (typeof part === "string") return part;
  if (!part || typeof part !== "object") return "";
  const type = typeof part.type === "string" ? part.type.toLowerCase() : "";
  if (type === "text" || type === "input_text") return part.text || part.content || "";
  if (typeof part.text === "string") return part.text;
  return "";
}

function normalizeContentToText(content) {
  if (typeof content === "string") return content;
  if (content == null) return "";
  if (Array.isArray(content)) {
    const parts = content
      .map(part => {
        const text = getTextFromContentPart(part).trim();
        if (text) return text;
        if (isImageContentPart(part)) return "[图片]";
        if (isFileContentPart(part)) return "[文件]";
        return "";
      })
      .filter(Boolean);
    return parts.join("\n");
  }
  if (isImageContentPart(content)) return "[图片]";
  if (isFileContentPart(content)) return "[文件]";
  return "[非文本内容]";
}

function normalizeMessageForTimeline(msg) {
  return { ...msg, content: normalizeContentToText(msg.content) };
}

function prepareMessageForLLM(msg) {
  if (msg.role === "assistant" && msg.tool_calls) return msg;
  if (msg.role === "tool") return msg;
  if (msg.role === "system") return { ...msg, content: normalizeContentToText(msg.content) };
  if (typeof msg.content === "string") return msg;
  if (Array.isArray(msg.content) && shouldForwardMultimodalContent()) return msg;
  const textContent = normalizeContentToText(msg.content);
  if (!textContent) return null;
  return { ...msg, content: textContent };
}

function sanitizeForLog(value) {
  if (typeof value === "string") {
    if (isDataImageUrl(value)) {
      const commaIndex = value.indexOf(",");
      const prefix = commaIndex >= 0 ? value.slice(0, commaIndex + 1) : value.slice(0, 40);
      return `${prefix}[base64 image omitted]`;
    }
    if (value.length > 1000) return `${value.slice(0, 1000)}... [truncated ${value.length - 1000} chars]`;
    return value;
  }
  if (Array.isArray(value)) return value.map(sanitizeForLog);
  if (value && typeof value === "object") {
    const sanitized = {};
    for (const [key, child] of Object.entries(value)) {
      sanitized[key] = sanitizeForLog(child);
    }
    return sanitized;
  }
  return value;
}

function summarizeMessageForLog(msg) {
  const parts = Array.isArray(msg?.content) ? msg.content : [msg?.content];
  const textChars = parts.reduce((sum, part) => sum + getTextFromContentPart(part).length, 0);
  return {
    role: msg?.role || "",
    content_type: Array.isArray(msg?.content) ? "multimodal" : typeof msg?.content,
    text_chars: textChars || normalizeContentToText(msg?.content).length,
    image_parts: parts.filter(isImageContentPart).length,
    file_parts: parts.filter(isFileContentPart).length,
    tool_calls: Array.isArray(msg?.tool_calls) ? msg.tool_calls.length : 0
  };
}

function summarizeMessagesForLog(messages = []) {
  const list = Array.isArray(messages) ? messages : [];
  const roles = {};
  let imageParts = 0;
  let fileParts = 0;
  let textChars = 0;
  for (const msg of list) {
    const item = summarizeMessageForLog(msg);
    roles[item.role] = (roles[item.role] || 0) + 1;
    imageParts += item.image_parts;
    fileParts += item.file_parts;
    textChars += item.text_chars;
  }
  return { total: list.length, roles, text_chars: textChars, image_parts: imageParts, file_parts: fileParts };
}

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function safeJsonForInlineScript(value) {
  return JSON.stringify(value)
    .replace(/</g, "\\u003c")
    .replace(/>/g, "\\u003e")
    .replace(/&/g, "\\u0026")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
}

function loadTimeline() {
  if (!fs.existsSync(TIMELINE_FILE)) return [];
  try { return fs.readJsonSync(TIMELINE_FILE); } catch { return []; }
}

function saveTimeline(messages) {
  const sp = messages.find(m => m.role === "system");
  const nonSP = messages.filter(m => m.role !== "system");
  const trimmed = nonSP.slice(-49);
  const final = sp ? [sp, ...trimmed] : trimmed;
  fs.writeJsonSync(TIMELINE_FILE, final, { spaces: 2 });
}

function parseTimestampLabel(value) {
  const text = String(value || "");
  const match = text.match(/（?\s*(\d{4})([-/])(\d{1,2})\2(\d{1,2})(?:[ T]?)(\d{1,2})[:：](\d{2})/);
  if (!match) return null;
  const [, yyyy, , month, day, hour, minute] = match;
  return zonedWallTimeToDate({ year: yyyy, month, day, hour, minute }, TIME_ZONE);
}

function stripLeadingTimestamp(content) {
  return String(content || "")
    .replace(/^（?\s*\d{4}[-/]\d{1,2}[-/]\d{1,2}(?:[ T]?)\d{1,2}[:：]\d{2}[）\s]*/, "")
    .trim();
}

function extractTimestamp(content) {
  return parseTimestampLabel(content);
}

function loadTimestampDB() {
  if (!fs.existsSync(TIMESTAMP_DB_FILE)) return {};
  try { return fs.readJsonSync(TIMESTAMP_DB_FILE); } catch { return {}; }
}

function saveTimestampDB(db) {
  fs.writeJsonSync(TIMESTAMP_DB_FILE, db, { spaces: 2 });
}

function makeFingerprint(msg) {
  const raw = normalizeContentToText(msg.content);
  const content = raw.trim().slice(0, 150);
  return `${msg.role}::${content}`;
}

function makeFingerprintStripped(msg) {
  const raw = normalizeContentToText(msg.content);
  const content = stripLeadingTimestamp(raw).slice(0, 150);
  return `${msg.role}::${content}`;
}

function extractTimestampWithMemory(msg, tsDB) {
  const fromContent = extractTimestamp(normalizeContentToText(msg.content));
  if (fromContent) return fromContent;
  const fp = makeFingerprint(msg);
  if (tsDB[fp]) return new Date(tsDB[fp]);
  const fpStripped = makeFingerprintStripped(msg);
  if (tsDB[fpStripped]) return new Date(tsDB[fpStripped]);
  return null;
}

function isSpecialEvent(msg) {
  if (msg.role !== "assistant") return false;
  const c = normalizeContentToText(msg.content);
  return (
    c.includes("刚刚给宝宝发了 Bark") ||
    c.includes("刚刚给用户发了 Bark") ||
    c.includes("自动唤醒：本次未发送 Bark") ||
    c.includes("自动唤醒：本次未发送推送") ||
    (c.includes("刚刚给用户发了") && c.includes("推送"))
  );
}

function isRealMessageForTimeline(msg) {
  if (msg.role === "system") return false;
  if (msg.tool_calls) return false;
  if (isSpecialEvent(msg)) return false;
  const contentText = normalizeContentToText(msg.content);
  if (msg.role === "user" && contentText.trim().startsWith("<")) return false;
  return msg.role === "user" || msg.role === "assistant";
}

function isSystemRule(msg) {
  if (msg.role === "system") return true;
  const contentText = normalizeContentToText(msg.content);
  if (msg.role === "user" && contentText.trim().startsWith("<")) return true;
  return false;
}

function buildTimeline(kelivoMessages, tsDB) {
  const oldTimeline = loadTimeline();
  const newSystemMessages = kelivoMessages
    .filter(msg => msg.role === "system")
    .map(normalizeMessageForTimeline);
  const latestSP = newSystemMessages.length > 0 ? newSystemMessages[newSystemMessages.length - 1] : null;
  const oldSP = oldTimeline.find(msg => msg.role === "system");
  const newRealMessages = kelivoMessages
    .filter(isRealMessageForTimeline)
    .map(normalizeMessageForTimeline);

  const oldSpecialEvents = oldTimeline.filter(isSpecialEvent).sort((a, b) => {
    const timeA = extractTimestampWithMemory(a, tsDB);
    const timeB = extractTimestampWithMemory(b, tsDB);
    if (timeA && timeB) return timeA - timeB;
    return 0;
  });

  const merged = [...newRealMessages];
  for (const event of oldSpecialEvents) {
    const eventTime = extractTimestampWithMemory(event, tsDB);
    if (!eventTime) { merged.push(event); continue; }
    let inserted = false;
    for (let i = 0; i < merged.length; i++) {
      const msgTime = extractTimestampWithMemory(merged[i], tsDB);
      if (msgTime && msgTime >= eventTime) {
        merged.splice(i, 0, event);
        inserted = true;
        break;
      }
    }
    if (!inserted) merged.push(event);
  }

  const seen = new Set();
  const unique = merged.filter(msg => {
    const key = JSON.stringify({ role: msg.role, content: msg.content });
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  const result = [];
  if (latestSP) result.push({ ...latestSP, position: 0 });
  else if (oldSP) result.push({ ...oldSP, position: 0 });

  let realPos = 1;
  const finalMessages = [];
  let pendingSpecial = [];
  for (const msg of unique) {
    if (isSpecialEvent(msg)) {
      pendingSpecial.push(msg);
    } else {
      if (pendingSpecial.length > 0) {
        const prevRealPos = realPos - 1;
        const step = 1 / (pendingSpecial.length + 1);
        for (let i = 0; i < pendingSpecial.length; i++) {
          finalMessages.push({ ...pendingSpecial[i], position: parseFloat((prevRealPos + step * (i + 1)).toFixed(4)) });
        }
        pendingSpecial = [];
      }
      finalMessages.push({ ...msg, position: realPos });
      realPos++;
    }
  }
  if (pendingSpecial.length > 0) {
    const lastRealPos = realPos - 1;
    for (let i = 0; i < pendingSpecial.length; i++) {
      finalMessages.push({ ...pendingSpecial[i], position: parseFloat((lastRealPos + 0.3 * (i + 1)).toFixed(4)) });
    }
  }
  result.push(...finalMessages);
  return result;
}

function appendSpecialEvent(content) {
  const timeline = loadTimeline();
  let maxPos = 0;
  for (const msg of timeline) {
    if (msg.position && msg.position > maxPos) maxPos = msg.position;
  }
  const newEvent = { role: "assistant", content, position: maxPos + 0.5 };
  timeline.push(newEvent);
  saveTimeline(timeline);
  console.log(`\n已记录特殊事件 (position ${newEvent.position}, chars ${normalizeContentToText(content).length})\n`);
}

function stripPosition(messages) {
  return messages.map(({ position, ...rest }) => rest);
}

let wakeUpLastHeartbeat = null;

const PRESETS_FILE = "./presets.json";
const ENV_FILE = ".env";

const PREFERRED_ENV_ORDER = [
  "TARGET_API_URL", "TARGET_API_KEY", "GATEWAY_API_KEY", "MODEL_NAME", "BARK_KEY",
  "CUSTOM_ICON_URL", "ALLOW_PUBLIC_API", "PUSH_PROVIDER", "NTFY_SERVER_URL", "NTFY_TOPIC",
  "NTFY_TOKEN", "NTFY_PRIORITY", "NTFY_TAGS", "DIARY_ENABLED", "DIARY_DIR",
  "REQUEST_BODY_LIMIT_MB", "MULTIMODAL_MODE", "DAY_WAKE_AFTER_MINUTES", "NIGHT_WAKE_AFTER_MINUTES",
  "DAY_CHECK_INTERVAL_MINUTES", "NIGHT_CHECK_INTERVAL_MINUTES", "WAKE_DAY_START_HOUR", "WAKE_DAY_END_HOUR",
  "WEATHER_ENABLED", "WEATHER_LOCATION_NAME", "WEATHER_LAT", "WEATHER_LON", "WEATHER_UNITS",
  "PORT", "GATEWAY_BASE_URL", "TIME_ZONE", "RESTART_COMMAND", "ADMIN_USER", "ADMIN_PASSWORD"
];

function loadPresets() {
  if (!fs.existsSync(PRESETS_FILE)) return [];
  try { return fs.readJsonSync(PRESETS_FILE); } catch { return []; }
}

function savePresets(presets) {
  fs.writeJsonSync(PRESETS_FILE, presets, { spaces: 2 });
}

function wantsJsonResponse(req) {
  const contentType = req.headers["content-type"] || "";
  const accept = req.headers.accept || "";
  return contentType.includes("application/json") || accept.includes("application/json");
}

function loadEnvFileObject() {
  const result = {};
  try {
    const envContent = fs.readFileSync(ENV_FILE, "utf-8");
    for (const line of envContent.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const eqIndex = trimmed.indexOf("=");
      if (eqIndex <= 0) continue;
      const key = trimmed.slice(0, eqIndex).trim();
      const value = trimmed.slice(eqIndex + 1).trim();
      result[key] = value;
    }
  } catch {}
  return result;
}

function serializeEnvValue(value) {
  return String(value ?? "").replace(/\r?\n/g, "\\n");
}

function writeEnvUpdates(updates) {
  const merged = { ...loadEnvFileObject(), ...updates };
  const orderedKeys = [
    ...PREFERRED_ENV_ORDER.filter(key => Object.prototype.hasOwnProperty.call(merged, key)),
    ...Object.keys(merged).filter(key => !PREFERRED_ENV_ORDER.includes(key)).sort()
  ];
  const lines = orderedKeys.map(key => `${key}=${serializeEnvValue(merged[key])}`);
  fs.writeFileSync(ENV_FILE, lines.join("\n") + "\n");
}

function readRestartCommand() {
  return readEnvValue("RESTART_COMMAND") || DEFAULT_RESTART_COMMAND;
}

app.addHook("onRequest", (req, reply, done) => {
  if (req.url.startsWith("/admin")) return done();
  if (readBooleanEnv("ALLOW_PUBLIC_API", false) && req.url.startsWith("/v1/")) {
    const configuredKey = readEnvValue("GATEWAY_API_KEY");
    if (!configuredKey) {
      reply.code(401).send({ error: "公网 /v1 已开启，但 GATEWAY_API_KEY 未配置" });
      return;
    }
    const auth = String(req.headers.authorization || "");
    const bearer = auth.match(/^Bearer\s+(.+)$/i)?.[1]?.trim() || "";
    const headerKey = String(req.headers["x-gateway-api-key"] || req.headers["x-api-key"] || "").trim();
    if (bearer === configuredKey || headerKey === configuredKey) return done();
    console.warn(JSON.stringify({ event: "gateway_auth_rejected", path: req.url.split("?")[0], auth_source: bearer ? "bearer" : headerKey ? "x-api-key" : "missing" }));
    reply.code(401).send({ error: "Gateway API Key 无效或缺失" });
    return;
  }
  const ip = req.ip || req.connection.remoteAddress;
  const isTrustedNetwork = ip === "127.0.0.1" || ip === "::1" || ip === "localhost" || /^(10\.|172\.(1[6-9]|2\d|3[01])\.|192\.168\.)/.test(ip);
  if (isTrustedNetwork) return done();
  reply.code(403).send("Forbidden");
});

app.get("/v1/models", async (req, reply) => {
  reply.send({ object: "list", data: [{ id: configuredModelName(), object: "model", created: 0, owned_by: "gateway" }] });
});

app.post("/v1/chat/completions", async (req, reply) => {
  try {
    const body = req.body;
    console.log(JSON.stringify({
      event: "kelivo_request",
      model: body?.model || "",
      stream: body?.stream === true,
      messages: summarizeMessagesForLog(body?.messages || [])
    }));

    const kelivoMessages = body.messages || [];
    const oldTimeline = loadTimeline();
    const tsDB = loadTimestampDB();

    let tsDBDirty = false;
    for (const msg of kelivoMessages) {
      if (msg.role === "system") continue;
      if (msg.role === "tool") continue;
      const ts = extractTimestamp(normalizeContentToText(msg.content));
      if (!ts) continue;
      const fp = makeFingerprint(msg);
      const fpStripped = makeFingerprintStripped(msg);
      if (!tsDB[fp]) { tsDB[fp] = ts.toISOString(); tsDBDirty = true; }
      if (!tsDB[fpStripped]) { tsDB[fpStripped] = ts.toISOString(); tsDBDirty = true; }
    }
    if (tsDBDirty) saveTimestampDB(tsDB);

    const finalTimeline = buildTimeline(kelivoMessages, tsDB);
    saveTimeline(finalTimeline);

    const llmMessages = kelivoMessages
      .map(prepareMessageForLLM)
      .filter(Boolean);

    console.log(JSON.stringify({ event: "llm_forward_summary", messages: summarizeMessagesForLog(llmMessages) }));

    const removeSet = new Set();

    for (let i = 0; i < llmMessages.length; i++) {
      const msg = llmMessages[i];
      if (msg.role !== "assistant" || !msg.tool_calls) continue;
      const expectedIds = msg.tool_calls.map(tc => tc.id);
      const followingTools = [];
      for (let j = i + 1; j < llmMessages.length; j++) {
        const nxt = llmMessages[j];
        if (nxt.role === "tool") { followingTools.push(nxt); } else { break; }
      }
      const foundIds = followingTools.map(t => t.tool_call_id);
      const complete = expectedIds.every(id => foundIds.includes(id));
      if (!complete) {
        removeSet.add(i);
        for (let j = i + 1; j < llmMessages.length; j++) {
          if (llmMessages[j].role === "tool") { removeSet.add(j); } else { break; }
        }
        console.log(`⚠️ 自动修复：移除不完整的 tool_calls (索引 ${i})`);
      }
    }

    for (let i = 0; i < llmMessages.length; i++) {
      if (llmMessages[i].role !== "tool") continue;
      let hasMatchingToolCalls = false;
      for (let j = i - 1; j >= 0; j--) {
        const prev = llmMessages[j];
        if (prev.role === "assistant" && prev.tool_calls) {
          const ids = prev.tool_calls.map(tc => tc.id);
          if (ids.includes(llmMessages[i].tool_call_id)) { hasMatchingToolCalls = true; }
          break;
        } else if (prev.role === "tool") {
          continue;
        } else {
          break;
        }
      }
      if (!hasMatchingToolCalls) {
        removeSet.add(i);
        console.log(`⚠️ 自动修复：移除孤立的 tool 消息 (索引 ${i})`);
      }
    }

    const sortedRemove = Array.from(removeSet).sort((a, b) => b - a);
    for (const idx of sortedRemove) {
      llmMessages.splice(idx, 1);
    }

    if (!TARGET_API_URL || !process.env.TARGET_API_KEY) {
      return reply.code(500).send({ error: "TARGET_API_URL / TARGET_API_KEY 未配置" });
    }

    const requestedStream = body?.stream === true;
    const response = await fetch(TARGET_API_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${process.env.TARGET_API_KEY}`
      },
      body: JSON.stringify({ ...body, messages: llmMessages })
    });

    const upstreamContentType = response.headers.get("content-type") || "";
    const shouldStreamResponse = requestedStream || upstreamContentType.includes("text/event-stream");

    if (!shouldStreamResponse) {
      const responseText = await response.text();
      return reply
        .code(response.status)
        .header("Content-Type", upstreamContentType || "application/json")
        .send(responseText);
    }

    if (!response.body) {
      return reply.code(response.status).send({ error: "上游 API 没有返回可读取的响应体" });
    }

    reply.raw.writeHead(response.status, {
      "Content-Type": upstreamContentType || "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive"
    });
    const reader = response.body.getReader();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      reply.raw.write(value);
    }
    reply.raw.end();
  } catch (err) {
    console.error(err);
    reply.code(500).send({ error: err.message });
  }
});

app.post("/internal/wake-event", async (req, reply) => {
  try {
    const { content } = req.body;
    if (!content) return reply.code(400).send({ error: "content is required" });
    appendSpecialEvent(content);
    reply.send({ success: true });
  } catch (err) {
    console.error(err);
    reply.code(500).send({ error: err.message });
  }
});

function readEnvValue(key) {
  if (IS_RAILWAY_RUNTIME && process.env[key]) return process.env[key];
  try {
    const envContent = fs.readFileSync(ENV_FILE, "utf-8");
    const lines = envContent.split("\n");
    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed.startsWith(key + "=")) return trimmed.substring(key.length + 1).trim();
    }
  } catch {}
  return process.env[key] || "";
}

function readEnvValueOrDefault(key, fallback) {
  const value = readEnvValue(key);
  return value === "" ? fallback : value;
}

function normalizePositiveInteger(value, key, fallback) {
  const n = Number(value);
  if (Number.isFinite(n) && n >= 1) return String(Math.floor(n));
  return readEnvValueOrDefault(key, fallback);
}

function normalizeHour(value, key, fallback, min, max) {
  const n = Number(value);
  if (Number.isFinite(n) && n >= min && n <= max) return String(Math.floor(n));
  return readEnvValueOrDefault(key, fallback);
}

function normalizeBooleanString(value, key, fallback) {
  const raw = String(value ?? "").trim().toLowerCase();
  if (["true", "1", "yes", "on"].includes(raw)) return "true";
  if (["false", "0", "no", "off"].includes(raw)) return "false";
  return readEnvValueOrDefault(key, fallback);
}

function normalizeWeatherUnits(value) {
  return String(value || "").trim().toLowerCase() === "fahrenheit" ? "fahrenheit" : "metric";
}

function diaryDirectoryPath() {
  const configured = readEnvValueOrDefault("DIARY_DIR", "diary");
  return path.isAbsolute(configured) ? configured : path.join(process.cwd(), configured);
}

function readDiaryEntries(limit = 20) {
  const dir = diaryDirectoryPath();
  try {
    if (!fs.existsSync(dir)) return [];
    return fs.readdirSync(dir)
      .filter(name => /^[^/\\]+\.md$/i.test(name))
      .sort((a, b) => b.localeCompare(a))
      .slice(0, limit)
      .map(name => {
        const filePath = path.join(dir, name);
        const stat = fs.statSync(filePath);
        const content = fs.readFileSync(filePath, "utf-8").slice(0, 24000);
        return { name, updated_at: stat.mtime.toISOString(), content };
      });
  } catch (err) {
    return [{ name: "读取日记失败", updated_at: new Date().toISOString(), content: err.message || String(err) }];
  }
}

function basicAuth(req, reply, done) {
  const auth = req.headers.authorization || "";
  const [scheme, encoded] = auth.split(" ");
  if (scheme !== "Basic" || !encoded) {
    reply.code(401).header("WWW-Authenticate", 'Basic realm="Admin"').send("Unauthorized");
    return;
  }
  const decoded = Buffer.from(encoded, "base64").toString();
  const colonIndex = decoded.indexOf(":");
  const user = decoded.substring(0, colonIndex);
  const password = decoded.substring(colonIndex + 1);
  if (user === process.env.ADMIN_USER && password === process.env.ADMIN_PASSWORD) {
    done();
  } else {
    reply.code(401).header("WWW-Authenticate", 'Basic realm="Admin"').send("Unauthorized");
  }
}

app.get("/admin", { preHandler: basicAuth }, async (req, reply) => {
  const serverUptime = Math.floor(process.uptime());
  const wakeUpStatus = wakeUpLastHeartbeat
    ? `在线（上次心跳: ${formatDateTimeInTimeZone(new Date(wakeUpLastHeartbeat), TIME_ZONE)}）`
    : "离线或未启动";
  const currentUrl = readEnvValue("TARGET_API_URL");
  const currentModel = readEnvValue("MODEL_NAME");
  const currentIcon = readEnvValue("CUSTOM_ICON_URL");
  const gatewayKeyStatus = readEnvValue("GATEWAY_API_KEY") ? "已配置" : "未配置";

  const wakeConfig = {
    dayWakeAfter: readEnvValueOrDefault("DAY_WAKE_AFTER_MINUTES", "60"),
    nightWakeAfter: readEnvValueOrDefault("NIGHT_WAKE_AFTER_MINUTES", "120"),
    dayCheckInterval: readEnvValueOrDefault("DAY_CHECK_INTERVAL_MINUTES", "10"),
    nightCheckInterval: readEnvValueOrDefault("NIGHT_CHECK_INTERVAL_MINUTES", "120"),
    dayStartHour: readEnvValueOrDefault("WAKE_DAY_START_HOUR", "10"),
    dayEndHour: readEnvValueOrDefault("WAKE_DAY_END_HOUR", "24")
  };

  const weatherConfig = {
    enabled: readEnvValueOrDefault("WEATHER_ENABLED", "false"),
    locationName: readEnvValue("WEATHER_LOCATION_NAME"),
    lat: readEnvValue("WEATHER_LAT"),
    lon: readEnvValue("WEATHER_LON"),
    units: readEnvValueOrDefault("WEATHER_UNITS", "metric")
  };

  const diaryEntries = readDiaryEntries(20);
  const diaryHtml = diaryEntries.length
    ? diaryEntries.map(entry => `
      <details>
        <summary>${escapeHtml(entry.name)} <small>${escapeHtml(formatDateTimeInTimeZone(new Date(entry.updated_at), TIME_ZONE))}</small></summary>
        <pre>${escapeHtml(entry.content)}</pre>
      </details>
    `).join("")
    : `还没有日记。模型在 wake-up 回复里输出 [DIARY]...[/DIARY] 后会保存到这里。`;

  const authToken = Buffer.from(`${process.env.ADMIN_USER}:${process.env.ADMIN_PASSWORD}`).toString("base64");
  const runtimeConfigNotice = IS_RAILWAY_RUNTIME
    ? `Railway 检测到：此页面保存的是当前容器的 .env。Railway Variables 会优先提供运行时配置，且未挂载 Volume 的文件会在重新部署后丢失；请在 Railway Variables 修改唤醒数值并重新部署。`
    : "";

  const presets = loadPresets();
  const presetsJson = safeJsonForInlineScript(presets);
  const authHeaderJson = safeJsonForInlineScript(`Basic ${authToken}`);

  const html = `
<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>HEARTBEAT · Runtime</title>
<style>
  body { font-family: -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif; background: #0f1115; color: #e6e8eb; margin: 0; padding: 24px; }
  h1 { font-size: 20px; }
  .card { background: #1a1d24; border-radius: 10px; padding: 16px 20px; margin-bottom: 16px; }
  .card h2 { font-size: 14px; color: #8b93a7; margin: 0 0 12px; text-transform: uppercase; letter-spacing: .5px; }
  label { display: block; font-size: 12px; color: #8b93a7; margin: 10px 0 4px; }
  input, select { width: 100%; box-sizing: border-box; background: #12151c; border: 1px solid #2a2f3a; color: #e6e8eb; border-radius: 6px; padding: 8px 10px; font-size: 14px; }
  button { background: #2f6fed; color: #fff; border: 0; border-radius: 6px; padding: 10px 16px; font-size: 14px; cursor: pointer; margin-top: 12px; }
  button.secondary { background: #2a2f3a; }
  .row { display: flex; gap: 10px; }
  .row > div { flex: 1; }
  .status { font-size: 13px; color: #8b93a7; }
  details { background: #12151c; border-radius: 6px; padding: 8px 12px; margin-bottom: 6px; }
  pre { white-space: pre-wrap; font-size: 12px; color: #b9c0cf; }
  a { color: #6ea0ff; }
</style>
</head>
<body>
  <h1>HEARTBEAT Runtime · AI Residency Gateway</h1>
  <div class="card">
    <p class="status">Gateway 运行中 (${serverUptime}秒)</p>
    <p class="status">Auto Wakeup: ${wakeUpStatus}</p>
    ${runtimeConfigNotice}
  </div>
  <div class="card">
    <h2>Wake Diary</h2>
    ${diaryHtml}
  </div>
  <div class="card">
    <h2>预设方案</h2>
    <div id="presetButtons"></div>
    <button class="secondary" onclick="saveCurrentAsPreset()">保存当前配置为新预设</button>
  </div>
  <div class="card">
    <h2>保存为预设</h2>
    <label>预设名称</label>
    <input id="presetName" placeholder="例如：日常 / 深夜">
    <button onclick="saveAsPreset()">保存预设</button>
  </div>
  <div class="card">
    <h2>API URL</h2>
    <input id="target_url" value="${escapeHtml(currentUrl)}" placeholder="https://你的API地址/v1/chat/completions">
    <label>API Key</label>
    <input id="target_key" type="password" placeholder="留空则保持不变">
    <label>Gateway API Key</label>
    <input id="gateway_api_key" type="password" placeholder="留空则保持不变">
    <p class="status">当前状态：${escapeHtml(gatewayKeyStatus)}。公开部署并开启 ALLOW_PUBLIC_API=true 时，Kelivo 的 API Key 请填写这个 Gateway API Key，不要填写上游 API Key。</p>
    <label>Model Name</label>
    <input id="model_name" value="${escapeHtml(currentModel)}">
    <label>Bark Key</label>
    <input id="bark_key" type="password" placeholder="留空则保持不变">
    <label>Bark Icon URL</label>
    <input id="custom_icon" value="${escapeHtml(currentIcon)}" placeholder="https://你的图标URL（可选）">
  </div>
  <div class="card">
    <h2>Wake Settings</h2>
    <div class="row">
      <div>
        <label>白天多久未回复后唤醒（分钟）</label>
        <input id="day_wake_after" value="${wakeConfig.dayWakeAfter}">
      </div>
      <div>
        <label>夜间多久未回复后唤醒（分钟）</label>
        <input id="night_wake_after" value="${wakeConfig.nightWakeAfter}">
      </div>
    </div>
    <div class="row">
      <div>
        <label>白天检查间隔（分钟）</label>
        <input id="day_check_interval" value="${wakeConfig.dayCheckInterval}">
      </div>
      <div>
        <label>夜间检查间隔（分钟）</label>
        <input id="night_check_interval" value="${wakeConfig.nightCheckInterval}">
      </div>
    </div>
    <div class="row">
      <div>
        <label>白天开始小时</label>
        <input id="wake_day_start_hour" value="${wakeConfig.dayStartHour}">
      </div>
      <div>
        <label>白天结束小时</label>
        <input id="wake_day_end_hour" value="${wakeConfig.dayEndHour}">
      </div>
    </div>
  </div>
  <div class="card">
    <h2>Weather</h2>
    <label>天气注入</label>
    <select id="weather_enabled">
      <option value="false" ${weatherConfig.enabled !== "true" ? "selected" : ""}>关闭</option>
      <option value="true" ${weatherConfig.enabled === "true" ? "selected" : ""}>开启</option>
    </select>
    <label>位置名称</label>
    <input id="weather_location_name" value="${escapeHtml(weatherConfig.locationName)}" placeholder="Beijing">
    <label>纬度 Latitude</label>
    <input id="weather_lat" value="${escapeHtml(weatherConfig.lat)}" placeholder="39.9042">
    <label>经度 Longitude</label>
    <input id="weather_lon" value="${escapeHtml(weatherConfig.lon)}" placeholder="116.4074">
    <label>单位</label>
    <select id="weather_units">
      <option value="metric" ${weatherConfig.units !== "fahrenheit" ? "selected" : ""}>摄氏度 / km/h</option>
      <option value="fahrenheit" ${weatherConfig.units === "fahrenheit" ? "selected" : ""}>华氏度 / mph</option>
    </select>
    <p class="status">天气使用 Open-Meteo 免费接口，不需要 API Key；只有开启后才会按你填写的经纬度读取天气。</p>
  </div>
  <div class="card">
    <button onclick="saveConfig()">保存配置</button>
    <button class="secondary" onclick="restartServices()">一键重启所有服务</button>
    <p class="status">修改配置后先保存，再点重启按钮生效</p>
  </div>
<script>
const AUTH = ${authHeaderJson};
const PRESETS = ${presetsJson};
function renderPresets() {
  const wrap = document.getElementById('presetButtons');
  wrap.innerHTML = '';
  PRESETS.forEach(p => {
    const btn = document.createElement('button');
    btn.className = 'secondary';
    btn.textContent = p.name;
    btn.onclick = () => {
      document.getElementById('target_url').value = p.target_url || '';
      document.getElementById('model_name').value = p.model_name || '';
      if (p.target_key) document.getElementById('target_key').value = p.target_key;
    };
    wrap.appendChild(btn);
  });
}
renderPresets();
async function api(path, data) {
  const res = await fetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Authorization': AUTH },
    body: new URLSearchParams(data).toString()
  });
  const text = await res.text();
  try { return JSON.parse(text); } catch { return text; }
}
async function saveConfig() {
  const data = {
    target_url: document.getElementById('target_url').value.trim(),
    target_key: document.getElementById('target_key').value.trim(),
    gateway_api_key: document.getElementById('gateway_api_key').value.trim(),
    model_name: document.getElementById('model_name').value.trim(),
    bark_key: document.getElementById('bark_key').value.trim(),
    custom_icon: document.getElementById('custom_icon').value.trim(),
    day_wake_after: document.getElementById('day_wake_after').value.trim(),
    night_wake_after: document.getElementById('night_wake_after').value.trim(),
    day_check_interval: document.getElementById('day_check_interval').value.trim(),
    night_check_interval: document.getElementById('night_check_interval').value.trim(),
    wake_day_start_hour: document.getElementById('wake_day_start_hour').value.trim(),
    wake_day_end_hour: document.getElementById('wake_day_end_hour').value.trim(),
    weather_enabled: document.getElementById('weather_enabled').value,
    weather_location_name: document.getElementById('weather_location_name').value.trim(),
    weather_lat: document.getElementById('weather_lat').value.trim(),
    weather_lon: document.getElementById('weather_lon').value.trim(),
    weather_units: document.getElementById('weather_units').value
  };
  const result = await api('/admin/save', data);
  alert(typeof result === 'object' ? '已保存，请重启服务生效' : result);
}
async function restartServices() {
  const result = await api('/admin/restart', {});
  alert(typeof result === 'object' ? result.output : result);
}
async function saveCurrentAsPreset() {
  const name = prompt('预设名称');
  if (!name) return;
  const data = {
    name,
    target_url: document.getElementById('target_url').value.trim(),
    target_key: document.getElementById('target_key').value.trim(),
    model_name: document.getElementById('model_name').value.trim()
  };
  await api('/admin/presets/save', data);
  location.reload();
}
async function saveAsPreset() {
  const name = document.getElementById('presetName').value.trim();
  if (!name) return alert('请填写预设名称');
  const data = {
    name,
    target_url: document.getElementById('target_url').value.trim(),
    target_key: document.getElementById('target_key').value.trim(),
    model_name: document.getElementById('model_name').value.trim()
  };
  await api('/admin/presets/save', data);
  location.reload();
}
</script>
</body>
</html>
`;
  reply.type("text/html").send(html);
});

app.post("/admin/save", { preHandler: basicAuth }, async (req, reply) => {
  try {
    const {
      target_url, target_key, gateway_api_key, model_name, bark_key, custom_icon,
      day_wake_after, night_wake_after, day_check_interval, night_check_interval,
      wake_day_start_hour, wake_day_end_hour,
      weather_enabled, weather_location_name, weather_lat, weather_lon, weather_units
    } = req.body || {};

    if (!target_url || !model_name) {
      return reply.code(400).send({ error: "target_url / model_name 必填" });
    }

    const finalTargetKey = target_key || readEnvValue("TARGET_API_KEY");
    const finalGatewayKey = gateway_api_key || readEnvValue("GATEWAY_API_KEY");
    const finalBarkKey = bark_key || readEnvValue("BARK_KEY");

    writeEnvUpdates({
      TARGET_API_URL: target_url,
      TARGET_API_KEY: finalTargetKey,
      GATEWAY_API_KEY: finalGatewayKey,
      MODEL_NAME: model_name,
      BARK_KEY: finalBarkKey,
      CUSTOM_ICON_URL: custom_icon || "",
      DAY_WAKE_AFTER_MINUTES: normalizePositiveInteger(day_wake_after, "DAY_WAKE_AFTER_MINUTES", "60"),
      NIGHT_WAKE_AFTER_MINUTES: normalizePositiveInteger(night_wake_after, "NIGHT_WAKE_AFTER_MINUTES", "120"),
      DAY_CHECK_INTERVAL_MINUTES: normalizePositiveInteger(day_check_interval, "DAY_CHECK_INTERVAL_MINUTES", "10"),
      NIGHT_CHECK_INTERVAL_MINUTES: normalizePositiveInteger(night_check_interval, "NIGHT_CHECK_INTERVAL_MINUTES", "120"),
      WAKE_DAY_START_HOUR: normalizeHour(wake_day_start_hour, "WAKE_DAY_START_HOUR", "10", 0, 23),
      WAKE_DAY_END_HOUR: normalizeHour(wake_day_end_hour, "WAKE_DAY_END_HOUR", "24", 1, 24),
      WEATHER_ENABLED: normalizeBooleanString(weather_enabled, "WEATHER_ENABLED", "false"),
      WEATHER_LOCATION_NAME: weather_location_name || "",
      WEATHER_LAT: weather_lat || "",
      WEATHER_LON: weather_lon || "",
      WEATHER_UNITS: normalizeWeatherUnits(weather_units),
      ADMIN_USER: readEnvValue("ADMIN_USER"),
      ADMIN_PASSWORD: readEnvValue("ADMIN_PASSWORD")
    });

    console.log("\n✅ .env 已更新，可通过管理页重启服务\n");

    if (wantsJsonResponse(req)) {
      return reply.send({ success: true });
    }
    reply.type("text/html").send(`
      <html><body style="font-family:sans-serif;background:#0f1115;color:#e6e8eb;padding:24px">
      <h2>已保存 ✅</h2>
      <p>配置已保存</p>
      <p>现在可以返回管理页，点击重启按钮让新配置生效。</p>
      <p><a href="/admin">← 返回设置</a></p>
      </body></html>
    `);
  } catch (err) {
    console.error(err);
    reply.code(500).send({ error: err.message });
  }
});

app.post("/admin/presets/save", { preHandler: basicAuth }, async (req, reply) => {
  const { name, target_url, target_key, model_name } = req.body || {};
  if (!name || !target_url || !model_name) {
    return reply.code(400).send({ error: "name / target_url / model_name 必填" });
  }
  const presets = loadPresets();
  const existing = presets.findIndex(p => p.name === name);
  const entry = { name, target_url, target_key: target_key || "", model_name };
  if (existing >= 0) presets[existing] = entry;
  else presets.push(entry);
  savePresets(presets);
  reply.send({ success: true });
});

app.post("/admin/presets/delete", { preHandler: basicAuth }, async (req, reply) => {
  const { name } = req.body || {};
  const presets = loadPresets().filter(p => p.name !== name);
  savePresets(presets);
  reply.send({ success: true });
});

app.post("/internal/heartbeat", async (req, reply) => {
  wakeUpLastHeartbeat = Date.now();
  reply.send({ status: "ok" });
});

app.post("/admin/restart", { preHandler: basicAuth }, async (req, reply) => {
  const restartCommand = readRestartCommand();
  reply.send({ success: true, output: `重启指令已发送：${restartCommand}` });
  const { exec } = require("child_process");
  exec(restartCommand, (err, stdout, stderr) => {
    if (err) { console.error("重启失败:", stderr); }
    else { console.log("服务已重启:", stdout); }
  });
});

app.get("/test-bark", async (req, reply) => {
  const formattedTime = formatDateTimeInTimeZone(new Date(), TIME_ZONE);
  appendSpecialEvent(`（${formattedTime} 刚刚给用户发了 Bark：这是一条测试推送。）`);
  reply.send({ success: true });
});

app.listen({ port: PORT, host: "0.0.0.0" }, (err, address) => {
  if (err) {
    console.error(err);
    process.exit(1);
  }
  console.log(`✅ Gateway 运行在 ${address}`);
});
