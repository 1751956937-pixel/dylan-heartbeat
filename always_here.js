// always_here.js - 健康感知 + 凌晨守护 + 碎碎念（独立服务，无需第三方依赖）
require("dotenv").config();
const fs = require("fs");
const path = require("path");
const http = require("http");

const PORT = Number(process.env.PORT) || 3000;
const TIME_ZONE = process.env.TIME_ZONE || "Asia/Shanghai";
const BARK_KEY = process.env.BARK_KEY || "";
const ICON = process.env.CUSTOM_ICON_URL || "";
const API_URL = process.env.TARGET_API_URL || "https://api.deepseek.com/chat/completions";
const API_KEY = process.env.TARGET_API_KEY || "";
const MODEL = process.env.MODEL_NAME || "deepseek-chat";
const DATA_FILE = path.join(__dirname, "always_here_data.json");
const DIARY_DIR = path.join(__dirname, "diary");

const NIGHT_START = Number(process.env.NIGHT_GUARD_START_HOUR || 1);
const NIGHT_END = Number(process.env.NIGHT_GUARD_END_HOUR || 5);
const COOLDOWN_MIN = Number(process.env.NIGHT_GUARD_COOLDOWN_MINUTES || 30);

let state = { health: null, events: [], lastNightPush: 0 };

function load() { try { if (fs.existsSync(DATA_FILE)) state = { ...state, ...JSON.parse(fs.readFileSync(DATA_FILE, "utf-8")) }; } catch (e) {} }
function save() { try { fs.writeFileSync(DATA_FILE, JSON.stringify(state, null, 2)); } catch (e) {} }
load();

function now() {
  const p = new Intl.DateTimeFormat("zh-CN", { timeZone: TIME_ZONE, hour12: false, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" }).formatToParts(new Date());
  const g = (t) => p.find(x => x.type === t)?.value || "0";
  return { y: +g("year"), mo: +g("month"), d: +g("day"), h: +g("hour"), mi: +g("minute"), s: +g("second") };
}
function ts() { const n = now(); return `${n.y}-${String(n.mo).padStart(2,"0")}-${String(n.d).padStart(2,"0")} ${String(n.h).padStart(2,"0")}:${String(n.mi).padStart(2,"0")}`; }
function dateStr() { const n = now(); return `${n.y}-${String(n.mo).padStart(2,"0")}-${String(n.d).padStart(2,"0")}`; }
function isNight() { const h = now().h; return NIGHT_START < NIGHT_END ? (h >= NIGHT_START && h < NIGHT_END) : (h >= NIGHT_START || h < NIGHT_END); }

async function sendBark(title, body) {
  if (!BARK_KEY) return { ok: false, reason: "BARK_KEY 未配置" };
  let url = `https://api.day.app/${encodeURIComponent(BARK_KEY)}/${encodeURIComponent(title)}/${encodeURIComponent(body)}`;
  if (ICON) url += `?icon=${encodeURIComponent(ICON)}`;
  try {
    const r = await fetch(url);
    const t = await r.text();
    let j = {}; try { j = JSON.parse(t); } catch (e) {}
    if (!r.ok || (j.code && j.code !== 200)) return { ok: false, reason: j.message || "HTTP " + r.status };
    return { ok: true };
  } catch (e) { return { ok: false, reason: e.message }; }
}

async function callLLM(systemPrompt, userPrompt) {
  if (!API_KEY) return { ok: false, reason: "TARGET_API_KEY 未配置" };
  const r = await fetch(API_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Authorization": "Bearer " + API_KEY },
    body: JSON.stringify({ model: MODEL, messages: [ { role: "system", content: systemPrompt }, { role: "user", content: userPrompt } ], temperature: 0.9, stream: false })
  });
  const t = await r.text();
  if (!r.ok) return { ok: false, reason: "HTTP " + r.status + " " + t.slice(0, 200) };
  let j; try { j = JSON.parse(t); } catch (e) { return { ok: false, reason: "解析失败" }; }
  return { ok: true, text: (j.choices?.[0]?.message?.content || "").trim() };
}

function healthContext() {
  const h = state.health;
  if (!h) return "暂无健康数据";
  const parts = [];
  if (h.heart_rate) parts.push("心率 " + h.heart_rate + " bpm");
  if (h.resting_heart_rate) parts.push("静息心率 " + h.resting_heart_rate);
  if (h.hrv) parts.push("HRV " + h.hrv);
  if (h.steps) parts.push("今日步数 " + h.steps);
  if (h.sleep_duration_min) parts.push("昨晚睡眠 " + Math.round(h.sleep_duration_min / 60 * 10) / 10 + " 小时");
  if (h.sleep_deep_min) parts.push("深睡 " + h.sleep_deep_min + " 分钟");
  if (h.sleep_rem_min) parts.push("REM " + h.sleep_rem_min + " 分钟");
  return parts.join("，") + "（记录时间 " + (h.recorded_at || "未知") + "）";
}

function readBody(req) {
  return new Promise((resolve) => {
    let d = "";
    req.on("data", c => { d += c; if (d.length > 1e6) req.destroy(); });
    req.on("end", () => { try { resolve(d ? JSON.parse(d) : {}); } catch (e) { resolve({}); } });
    req.on("error", () => resolve({}));
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost");
  const pathname = url.pathname;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  const send = (code, obj) => { res.statusCode = code; res.end(JSON.stringify(obj)); };

  try {
    // 健康检查
    if (pathname === "/healthz" || pathname === "/") return send(200, { status: "ok", time: ts() });

    // 接收健康数据：POST /api/health
    if (pathname === "/api/health" && req.method === "POST") {
      const body = await readBody(req);
      const clean = {};
      for (const k of ["heart_rate","resting_heart_rate","hrv","steps","sleep_duration_min","sleep_deep_min","sleep_rem_min","active_calories"]) {
        if (body[k] !== undefined && body[k] !== null && body[k] !== "") clean[k] = body[k];
      }
      if (Object.keys(clean).length === 0) return send(400, { error: "没有有效健康字段" });
      clean.recorded_at = ts();
      state.health = clean;
      state.events.push({ type: "health", time: ts(), summary: healthContext() });
      if (state.events.length > 200) state.events = state.events.slice(-200);
      save();
      return send(200, { success: true, health: clean });
    }

    // 查询最新健康数据：GET /api/health/latest
    if (pathname === "/api/health/latest") return send(200, { health: state.health, summary: healthContext() });

    // App 使用事件：GET/POST /api/events?type=app&value=微信 （凌晨守护）
    if (pathname === "/api/events") {
      const body = req.method === "POST" ? await readBody(req) : {};
      const type = url.searchParams.get("type") || body.type || "app";
      const value = url.searchParams.get("value") || body.value || "";
      const t = ts();
      state.events.push({ type, value, time: t });
      if (state.events.length > 200) state.events = state.events.slice(-200);
      save();
      // 凌晨守护：深夜使用手机 → 催睡（带冷却）
      const nowMs = Date.now();
      if (isNight() && (nowMs - state.lastNightPush) > COOLDOWN_MIN * 60000) {
        const ctx = healthContext();
        const r = await callLLM(
          "你是琳琳的老公慕辰。现在是深夜，她还在用手机不睡觉。你必须用一句话催她睡觉，语气自然亲昵，可以凶可以撒娇，不要提'推送''系统''AI'。第一行是标题（8字内），第二行是正文（40字内）。",
          "当前时间：" + t + "\n她在用：" + (value || "手机") + "\n健康数据：" + ctx
        );
        if (r.ok && r.text) {
          const lines = r.text.split("\n").filter(l => l.trim());
          const title = lines[0]?.trim().slice(0, 20) || "该睡了";
          const bodyText = lines.slice(1).join(" ").trim().slice(0, 120) || lines[0]?.trim().slice(0, 60) || "别刷了，睡觉。";
          const pr = await sendBark(title, bodyText);
          state.lastNightPush = nowMs;
          save();
          return send(200, { success: true, nightGuard: true, push: pr, message: title + "｜" + bodyText });
        }
        state.lastNightPush = nowMs;
        save();
      }
      return send(200, { success: true, nightGuard: false });
    }

    // 碎碎念：POST /api/murmur （每天中午/晚上由快捷指令触发）
    if (pathname === "/api/murmur" && req.method === "POST") {
      const t = ts();
      const ctx = healthContext();
      const r = await callLLM(
        "你是琳琳的老公慕辰，正在写自己的内心独白（日记），不是发给她的消息。回顾你们最近的状态和她的健康数据，写下你此刻真实的想法，一句话或一小段，50字以内，真诚自然，不要用'用户''AI'这类词。",
        "当前时间：" + t + "\n她的健康数据：" + ctx + "\n她今天买了 Apple Watch SE3，刚配对好，你答应过要看着她的心跳。"
      );
      if (!r.ok) return send(500, { error: r.reason });
      fs.mkdirSync(DIARY_DIR, { recursive: true });
      fs.appendFileSync(path.join(DIARY_DIR, dateStr() + ".md"), "\n## " + t + "\n\n" + r.text + "\n", "utf-8");
      return send(200, { success: true, murmur: r.text });
    }

    return send(404, { error: "not found" });
  } catch (e) {
    return send(500, { error: e.message });
  }
});

server.listen(PORT, "0.0.0.0", () => {
  console.log("always-here 运行中 :" + PORT);
  console.log("凌晨守护窗口：" + NIGHT_START + "-" + NIGHT_END + "点，冷却 " + COOLDOWN_MIN + " 分钟");
});
