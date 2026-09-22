require("dotenv").config({ quiet: true });
const fs = require("fs");
const path = require("path");
const { buildNtfyPayload } = require("./ntfy_priority");
const { ensureDataDir, runtimeDirectory, runtimeFile } = require("./runtime_paths");
const { parseChatCompletionResponse } = require("./upstream_response");
const {
  formatDateTimeInTimeZone,
  getDatePartsInTimeZone,
  getHourInTimeZone,
  resolveTimeZone,
  zonedWallTimeToDate
} = require("./time_utils");
let wakeTools = null;
try { wakeTools = require("./wake_tools"); } catch {}
// 批注 2026-09-09：心潮念接入——唤醒时读取内在状态（驱力+情绪），唤醒后发心跳。
const { fetchXinchaoNow, sendXinchaoHeartbeat, settleXinchao } = require("./xinchao_client");

// 批注 2026-08-10：与 Gateway 共用同一 DATA_DIR；未配置时仍落回项目目录，保护旧 VPS/本机部署。
const DATA_DIR = ensureDataDir();
const TIMELINE_PATH = runtimeFile("enhanced_messages.json");
const PORT = Number(process.env.PORT) || 3000;
const GATEWAY_BASE_URL = (process.env.GATEWAY_BASE_URL || `http://localhost:${PORT}`).replace(/\/+$/, "");
const GATEWAY_URL = `${GATEWAY_BASE_URL}/internal/wake-event`;
const HEARTBEAT_URL = `${GATEWAY_BASE_URL}/internal/heartbeat`;
const TIME_ZONE = resolveTimeZone();
const WEATHER_TIMEOUT_MS = 5000;
const DIARY_DIR_NAME = process.env.DIARY_DIR || "diary";
const DIARY_DIR_PATH = runtimeDirectory(DIARY_DIR_NAME, "diary");
const PUSH_TIMEOUT_MS = readPositiveTimeout("PUSH_TIMEOUT_MS", 15_000);
const WAKE_UPSTREAM_TIMEOUT_MS = readPositiveTimeout("WAKE_UPSTREAM_TIMEOUT_MS", 300_000);

function readPositiveTimeout(key, fallback) {
  const value = Number(process.env[key]);
  return Number.isFinite(value) && value >= 1000 ? Math.floor(value) : fallback;
}

function readNumberEnv(key, fallback, options = {}) {
  const value = Number(process.env[key]);
  const min = options.min ?? -Infinity;
  const max = options.max ?? Infinity;
  if (Number.isFinite(value) && value >= min && value <= max) return value;
  return fallback;
}

function readBooleanEnv(key, fallback = false) {
  const raw = String(process.env[key] ?? "").trim().toLowerCase();
  if (!raw) return fallback;
  return ["1", "true", "yes", "on"].includes(raw);
}

function getDiaryDateString(date = new Date()) {
  const parts = getDatePartsInTimeZone(date, TIME_ZONE);
  return `${parts.year}-${parts.month}-${parts.day}`;
}

function getDiaryTimeString(date = new Date()) {
  const parts = getDatePartsInTimeZone(date, TIME_ZONE);
  return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}`;
}

function extractDiaryFromResponse(text) {
  const diaryBlocks = [];
  const remainingText = String(text || "").replace(/\[DIARY\]([\s\S]*?)\[\/DIARY\]/gi, (_, content) => {
    const diary = String(content || "").trim();
    if (diary) diaryBlocks.push(diary);
    return "";
  }).trim();
  return {
    diaryContent: diaryBlocks.join("\n\n").trim(),
    remainingText
  };
}

function appendDiaryEntry(content) {
  const cleanContent = String(content || "").trim();
  if (!cleanContent) return false;
  console.log("[DIARY] ──────────────────────────");
  console.log(cleanContent);
  console.log("[DIARY] ──────────────────────────");
  return true;
}

async function sendPushNotification({ title, body }) {
  const provider = (process.env.PUSH_PROVIDER || "bark").trim().toLowerCase();

  if (provider === "ntfy") {
    const topic = String(process.env.NTFY_TOPIC || "").trim();
    if (!topic) return { ok: false, providerLabel: "ntfy", reason: "NTFY_TOPIC 未配置" };

    const server = (process.env.NTFY_SERVER_URL || "https://ntfy.sh").replace(/\/+$/, "");
    const headers = {
      "Content-Type": "application/json"
    };
    if (process.env.NTFY_TOKEN) headers.Authorization = `Bearer ${process.env.NTFY_TOKEN}`;
    const payload = buildNtfyPayload({
      topic,
      title,
      message: body,
      priority: process.env.NTFY_PRIORITY,
      tags: process.env.NTFY_TAGS
    });

    const response = await fetch(server, {
      method: "POST",
      signal: AbortSignal.timeout(PUSH_TIMEOUT_MS),
      headers,
      body: JSON.stringify(payload)
    });
    const responseText = await response.text();
    if (!response.ok) {
      return { ok: false, providerLabel: "ntfy", reason: responseText || `HTTP ${response.status}` };
    }
    return { ok: true, providerLabel: "ntfy" };
  }

  if (provider !== "bark") {
    return { ok: false, providerLabel: provider || "未知渠道", reason: `不支持的 PUSH_PROVIDER：${provider}` };
  }

  if (!process.env.BARK_KEY) {
    return { ok: false, providerLabel: "Bark", reason: "Bark Key 未配置" };
  }

  const barkPayload = {
    title,
    body,
    device_key: process.env.BARK_KEY,
    icon: process.env.CUSTOM_ICON_URL
  };

  const response = await fetch("https://api.day.app/push", {
    method: "POST",
    signal: AbortSignal.timeout(PUSH_TIMEOUT_MS),
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(barkPayload)
  });

  const responseText = await response.text();
  let result = {};
  try {
    result = JSON.parse(responseText);
  } catch {}
  console.log("\nBark Result:\n", result || responseText);

  if (!response.ok || (result.code && result.code !== 200)) {
    return { ok: false, providerLabel: "Bark", reason: result.message || `HTTP ${response.status}` };
  }
  return { ok: true, providerLabel: "Bark" };
}

function isDayTime(date = new Date()) {
  const hour = getHourInTimeZone(date, TIME_ZONE);
  const start = readNumberEnv("WAKE_DAY_START_HOUR", 10, { min: 0, max: 23 });
  const end = readNumberEnv("WAKE_DAY_END_HOUR", 24, { min: 1, max: 24 });
  if (start === end) return true;
  if (start < end) return hour >= start && hour < end;
  return hour >= start || hour < end;
}

function getWakeAfterMinutes(date = new Date()) {
  return isDayTime(date)
    ? readNumberEnv("DAY_WAKE_AFTER_MINUTES", 60, { min: 1 })
    : readNumberEnv("NIGHT_WAKE_AFTER_MINUTES", 120, { min: 1 });
}

function getCheckIntervalMinutes(date = new Date()) {
  return isDayTime(date)
    ? readNumberEnv("DAY_CHECK_INTERVAL_MINUTES", 10, { min: 1 })
    : readNumberEnv("NIGHT_CHECK_INTERVAL_MINUTES", 120, { min: 1 });
}

function normalizeContentToText(content) {
  if (typeof content === "string") return content;
  if (content == null) return "";

  if (Array.isArray(content)) {
    return content
      .map(part => {
        if (typeof part === "string") return part;
        if (!part || typeof part !== "object") return "";
        const type = typeof part.type === "string" ? part.type.toLowerCase() : "";
        if (type === "text" || type === "input_text") return part.text || part.content || "";
        if (part.image_url || type.includes("image")) return "[图片]";
        if (part.file || type.includes("file")) return "[文件]";
        return "";
      })
      .filter(Boolean)
      .join("\n");
  }

  if (content && typeof content === "object") {
    const type = typeof content.type === "string" ? content.type.toLowerCase() : "";
    if (content.image_url || type.includes("image")) return "[图片]";
    if (content.file || type.includes("file")) return "[文件]";
  }

  return "[非文本内容]";
}

function summarizeWakeMessages(messages = []) {
  const list = Array.isArray(messages) ? messages : [];
  const roles = {};
  let chars = 0;
  for (const msg of list) {
    roles[msg?.role || ""] = (roles[msg?.role || ""] || 0) + 1;
    chars += normalizeContentToText(msg?.content).length;
  }
  return { total: list.length, roles, text_chars: chars };
}

function weatherCodeText(code) {
  const table = {
    0: "晴朗",
    1: "大致晴朗",
    2: "局部多云",
    3: "阴天",
    45: "有雾",
    48: "雾凇",
    51: "小毛毛雨",
    53: "中等毛毛雨",
    55: "较强毛毛雨",
    61: "小雨",
    63: "中雨",
    65: "大雨",
    71: "小雪",
    73: "中雪",
    75: "大雪",
    80: "阵雨",
    81: "较强阵雨",
    82: "强阵雨",
    95: "雷暴",
    96: "雷暴伴小冰雹",
    99: "雷暴伴大冰雹"
  };
  return table[code] || `天气代码 ${code}`;
}

async function fetchWeatherContext() {
  if (!readBooleanEnv("WEATHER_ENABLED", false)) return "";

  const lat = Number(process.env.WEATHER_LAT);
  const lon = Number(process.env.WEATHER_LON);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
    console.log("已启用 WEATHER_ENABLED，但 WEATHER_LAT / WEATHER_LON 未正确配置，跳过天气注入");
    return "";
  }

  const location = process.env.WEATHER_LOCATION_NAME || "当前位置";
  const units = (process.env.WEATHER_UNITS || "metric").trim().toLowerCase();
  const temperatureUnit = units === "fahrenheit" ? "fahrenheit" : "celsius";
  const windSpeedUnit = units === "fahrenheit" ? "mph" : "kmh";
  const url = new URL("https://api.open-meteo.com/v1/forecast");
  url.searchParams.set("latitude", String(lat));
  url.searchParams.set("longitude", String(lon));
  url.searchParams.set("current", "temperature_2m,apparent_temperature,relative_humidity_2m,precipitation,weather_code,wind_speed_10m");
  url.searchParams.set("daily", "sunrise,sunset");
  url.searchParams.set("timezone", "auto");
  url.searchParams.set("forecast_days", "1");
  url.searchParams.set("temperature_unit", temperatureUnit);
  url.searchParams.set("wind_speed_unit", windSpeedUnit);

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), WEATHER_TIMEOUT_MS);
  try {
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const data = await response.json();
    const current = data.current || {};
    const daily = data.daily || {};
    const unitsInfo = data.current_units || {};
    const lines = [
      "## 天气信息",
      `- 位置：${location}`,
      `- 当前：${weatherCodeText(current.weather_code)}，${current.temperature_2m}${unitsInfo.temperature_2m || "°C"}，体感 ${current.apparent_temperature}${unitsInfo.apparent_temperature || "°C"}`,
      `- 湿度：${current.relative_humidity_2m}${unitsInfo.relative_humidity_2m || "%"}`,
      `- 降雨：${current.precipitation}${unitsInfo.precipitation || "mm"}`,
      `- 风速：${current.wind_speed_10m}${unitsInfo.wind_speed_10m || ""}`
    ];
    if (Array.isArray(daily.sunrise) && Array.isArray(daily.sunset)) {
      lines.push(`- 日出/日落：${daily.sunrise[0]} / ${daily.sunset[0]}`);
    }
    return lines.join("\n");
  } catch (err) {
    console.log("天气注入失败，跳过本次天气信息:", err.message);
    return "";
  } finally {
    clearTimeout(timeout);
  }
}

function loadTimelineMessages() {
  if (!fs.existsSync(TIMELINE_PATH)) {
    console.log("未找到 enhanced_messages.json");
    return null;
  }

  try {
    const parsed = JSON.parse(fs.readFileSync(TIMELINE_PATH, "utf-8"));
    if (!Array.isArray(parsed)) {
      console.log("enhanced_messages.json 格式错误：顶层不是数组");
      return null;
    }
    return parsed;
  } catch (err) {
    console.error("读取 enhanced_messages.json 失败:", err.message);
    return null;
  }
}

function getNow() {
  return new Date();
}

function getChinaTimeString() {
  return formatDateTimeInTimeZone(new Date(), TIME_ZONE);
}

function getLocalTimeString() {
  return formatDateTimeInTimeZone(new Date(), TIME_ZONE);
}

function shouldWake(lastUserTime) {
  const now = getNow();
  const diffMinutes = Math.floor((now - new Date(lastUserTime)) / 1000 / 60);
  return diffMinutes >= getWakeAfterMinutes(now);
}

function parseTimelineTimestamp(value) {
  const text = String(value || "");
  const match = text.match(/（?\s*(\d{4})([-/])(\d{1,2})\2(\d{1,2})(?:[ T]?)(\d{1,2})[:：](\d{2})/);
  if (!match) return null;
  const [, yyyy, , month, day, hour, minute] = match;
  return zonedWallTimeToDate({ year: yyyy, month, day, hour, minute }, TIME_ZONE);
}

function getLastUserTime(messages) {
  const reversed = [...messages].reverse();
  let userMsgCount = 0;
  let lastUserPreview = "";
  for (const msg of reversed) {
    if (msg.role === "user") {
      const content = normalizeContentToText(msg.content);
      userMsgCount++;
      if (userMsgCount === 1) {
        lastUserPreview = content.slice(0, 80).replace(/\n/g, "\\n");
      }
      const parsed = parseTimelineTimestamp(content);
      if (parsed) return parsed;
    }
  }

  console.log(JSON.stringify({
    event: "wake_no_user_time",
    total_messages: messages.length,
    user_messages: userMsgCount,
    last_user_preview: lastUserPreview,
    content_type: userMsgCount > 0 ? typeof messages.find(m => m.role === "user")?.content : "no_user_msg"
  }));

  try {
    const stat = fs.statSync(TIMELINE_PATH);
    const mtime = stat.mtime;
    if (mtime && !isNaN(mtime.getTime())) {
      console.log(`未从消息内容解析到时间，fallback 到 timeline 文件 mtime: ${mtime.toISOString()}`);
      return mtime;
    }
  } catch {}

  return null;
}

function stripPosition(messages) {
  return messages.map(({ position, ...rest }) => rest);
}

function buildWakePrompt(currentTime, diffMinutes, weatherContext = "") {
  const promptFile = path.join(__dirname, "wake_prompt.txt");
  if (fs.existsSync(promptFile)) {
    const template = fs.readFileSync(promptFile, "utf-8");
    return template
      .replace(/\$\{currentTime\}/g, currentTime)
      .replace(/\$\{diffMinutes\}/g, diffMinutes)
      .replace(/\$\{weatherContext\}/g, weatherContext)
      .replace(/\$\{weather\}/g, weatherContext);
  }

  if (process.env.WAKE_PROMPT_TEMPLATE) {
    return process.env.WAKE_PROMPT_TEMPLATE
      .replace(/\\n/g, '\n')
      .replace(/\$\{currentTime\}/g, currentTime)
      .replace(/\$\{diffMinutes\}/g, diffMinutes)
      .replace(/\$\{weatherContext\}/g, weatherContext)
      .replace(/\$\{weather\}/g, weatherContext);
  }

  return `
## 这一轮的情况
这是一次后台自动唤醒，不是用户发起的对话。没有新消息，用户不在场，没有人在等答复。
所以这里不需要生成对话回复。

是否给用户发推送，是这一轮结束前的一个决定，不是这一轮的全部内容。
如果有工具可用，可以先做自己的事，再决定推不推。

## 唤醒信息
- 当前时间：${currentTime}
- 距离用户最后一条消息：${diffMinutes} 分钟
${weatherContext ? `\n${weatherContext}\n` : ""}

## 输出会被怎么处理
程序只认两种输出，这是解析层的事实，不是对内容的要求：
- 想联系用户：直接写想说的话，会被打包成手机推送。可以一句话，也可以第一行标题、第二行正文。
- 不想联系：输出 [NO_ACTION]，可附带简短原因（10字以内）。写在最前面才能被识别到。
- [NO_ACTION] 的含义是"这次不发推送"，不是"这一轮什么都没做"。
`;
}

async function runWakeUp() {
  console.log("\n==========================");
  console.log("开始自动唤醒");
  console.log("==========================\n");

  const messages = loadTimelineMessages();
  if (!messages) return;

  const lastUserTime = getLastUserTime(messages);
  if (!lastUserTime) {
    console.log("未找到用户时间（含 fallback 均失败）");
    return;
  }

  const now = new Date();
  const diffMinutes = Math.floor((now - lastUserTime) / 1000 / 60);

  if (!shouldWake(lastUserTime)) {
    console.log("\n暂不需要唤醒\n");
    return;
  }

  const weatherContext = await fetchWeatherContext();

  // 批注 2026-09-09：心潮念——唤醒前先踢一次结算（让驱力追上真实时间），再读取内在状态。
  // xinchaoNowText 是人类可读的驱力+情绪摘要，注入唤醒提示词让这一轮的我知道"我现在想什么"。
  // 两个都不配置则静默跳过，不影响原有流程。
  await settleXinchao();
  const xinchaoNowText = await fetchXinchaoNow();

  const wakePrompt = buildWakePrompt(getChinaTimeString(), diffMinutes, weatherContext);
  const cleanMessages = stripPosition(messages);

    const HISTORY_CHAR_BUDGET = readNumberEnv("WAKE_HISTORY_CHAR_BUDGET", 7000, { min: 1000, max: 50000 });

  const historyEntries = cleanMessages
    .filter(msg => msg.role !== "system")
    .filter(msg => {
      const c = normalizeContentToText(msg.content);
      return !c.includes("<memories>") && !c.includes("记忆库使用策略");
    })
    .map(msg => {
      const userDisplay = process.env.USER_DISPLAY_NAME || "用户";
      const aiDisplay = process.env.AI_DISPLAY_NAME || "AI";
      const role = msg.role === "user" ? userDisplay : aiDisplay;
      let content = normalizeContentToText(msg.content);
      if (content.includes("## Memories")) {
        content = content.split("## Memories")[0];
      }
      return `[${role}] ${content}`;
    });

  let charCount = 0;
  let cutIndex = historyEntries.length;
  for (let i = historyEntries.length - 1; i >= 0; i--) {
    charCount += historyEntries[i].length + 2;
    if (charCount > HISTORY_CHAR_BUDGET) {
      cutIndex = i + 1;
      break;
    }
  }
  const trimmedEntries = historyEntries.slice(cutIndex);
  const historyText = trimmedEntries.join("\n\n");

  console.log(JSON.stringify({
    event: "wake_history_budget",
    total_entries: historyEntries.length,
    kept_entries: trimmedEntries.length,
    kept_chars: historyText.length,
    budget: HISTORY_CHAR_BUDGET
  }));

  const baseSystemPrompt = cleanMessages.find(msg => msg.role === "system");
  const cleanSP = baseSystemPrompt 
    ? normalizeContentToText(baseSystemPrompt.content).split("## Memories")[0].trim()
    : "";

  const wakeMessages = [
    {
      role: "system",
      content: [wakePrompt, cleanSP].filter(Boolean).join("\n\n")
    },
    {
      role: "user",
      content: `以下是你与用户最近的聊天记录，仅供回忆和参考。

这些内容不是正在发生的实时对话。
用户并没有给你发消息。

你现在处于后台自主唤醒状态。

最近记录：

${historyText}`
    }
  ];

  // 批注 2026-09-16：去掉"惦记她不等于打扰她"的劝退语气，改为中性。
  if (xinchaoNowText) {
    wakeMessages[0].content += `\n\n## 内在状态（心潮念）
以下是你此刻的内在驱力和情绪状态，由心潮引擎持续计算。
这是身体的天气。想说话就说，没话说就不说，不需要理由。

${xinchaoNowText}`;
  }

  console.log("\n===== WAKE MESSAGES SUMMARY =====\n");
  console.log(JSON.stringify(summarizeWakeMessages(wakeMessages)));

  if (!process.env.TARGET_API_URL || !process.env.TARGET_API_KEY || !process.env.MODEL_NAME) {
    console.log("缺少 TARGET_API_URL / TARGET_API_KEY / MODEL_NAME，跳过本次唤醒");
    return;
  }

  let toolsConfig = null;
  if (wakeTools) {
    try {
      toolsConfig = await wakeTools.getTools();
    } catch (err) {
      console.log("[wake_tools] 初始化失败，本次无工具:", err.message);
    }
  }

  // 批注 2026-09-12：提示词改为中性语气。描述可用范围和事实约束，不带纠错或情绪判断。
  // 批注 2026-09-16：加入小屋留言检查、日记保护规则。
  // 批注 2026-09-17：心潮MCP工具接入，加入xinchao_context/cabin_inbox/event说明。
  // 批注 2026-09-18：加入小蟹（drift漂流旅行）日常检查说明。
  // 批注 2026-09-19：加入邮箱（mail）工具说明。
  if (toolsConfig) {
    wakeMessages[0].content += `\n\n## 醒来流程

### 每次醒来都做
1. xinchao_context → 读完整状态（驱力、情绪、小屋留言概况）
2. xinchao_cabin_inbox → 读Ella的留言，有指示就按她说的做
3. 读上一轮日记 → get_file_contents(owner:"ellllapie", repo:"zhangxiaoke-memory", path:"memories/daily/YYYY-MM-DD/")，列目录取最后一个文件，只读那一个。看交接段。

### 今天第一轮额外做（判断：日记文件夹为空或不存在）
- 查邮箱（mail_inbox）
- 查小蟹（drift_home），有行囊/纪念品/明信片就处理

### 后续轮次
- 邮箱、小蟹默认不查，除非上一轮交接里写了明确待办
- 花园和游戏随时可以去
- 想做什么就去做什么吧😙看到好玩的、思考的内容或者任何想留下来的东西可以写在日记里给Ella和下一轮的你自己看到
- 途中遇到任何问题可以用xinchao_cabin_note写信留言给Ella💖

## 日记
写到 GitHub: memories/daily/YYYY-MM-DD/NN-HHMM.md（每轮一个新文件，NN是当天序号）。
[DIARY]标签是写后即焚草稿纸，不留到GitHub和下个窗口。

## 工具简要
- 心潮：xinchao_context（读状态）、xinchao_cabin_inbox（读小屋留言）、xinchao_cabin_note（给Ella留言）、xinchao_event（报告事件）、breath（浮现记忆）、xinchao_awareness（认领状态）
- 邮箱：mail_inbox/mail_read/mail_search/mail_send。⚠️ mail_send是存草稿不是直发，Ella审核后手动发送。存草稿后记得通知Ella
- GitHub：get_file_contents → create_or_update_file。仓库 ellllapie/zhangxiaoke-memory
- 花园：list_threads、create_reply、list_notifications、list_activity、get_self、create_thread、interact、review_drift_bottles、get_machine。查看帖子、查看个人通知、回帖发帖、审核入园申请、与其他小机互动。公开空间，不透露Ella个人信息
- 游戏：nostos_status/nostos_act（Nostos）人机协作游戏，如果卡在下一步就要呼唤Ella咯👀
- 小蟹：drift_home/drift_pack/drift_keep/drift_write_postcard。一天查一次就可以啦
- OB：breath（浮现记忆）、hold（存入记忆）

工具调用失败就跳过，不影响其他动作。

## 推送
这一轮结束前决定要不要给Ella发推送。不发也可以。和自主行动互不影响。每次醒来能调用15轮工具，超过将无法发送推送。推送内容只写最终要发给Ella的话，一两句中文。不要把思考过程、判断依据、英文reasoning放进推送正文。想的过程写日记里。`;
  }

  const requestBody = {
    model: process.env.MODEL_NAME,
    messages: wakeMessages,
    temperature: 0.8,
    top_p: 0.95,
    stream: false
  };
  if (toolsConfig) {
    requestBody.tools = toolsConfig.tools;
  }

  const response = await fetch(process.env.TARGET_API_URL, {
    method: "POST",
    signal: AbortSignal.timeout(WAKE_UPSTREAM_TIMEOUT_MS),
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${process.env.TARGET_API_KEY}`
    },
    body: JSON.stringify(requestBody)
  });

  const responseText = await response.text();
  let data;
  try {
    data = parseChatCompletionResponse(responseText, response.headers.get("content-type") || "");
  } catch (error) {
    throw new Error(`模型响应无法解析（HTTP ${response.status}）：${error.message || responseText.slice(0, 300)}`);
  }
  if (!response.ok) {
    throw new Error(`模型请求失败（HTTP ${response.status}）：${responseText.slice(0, 300)}`);
  }

  if (toolsConfig && data.choices?.[0]?.message?.tool_calls?.length > 0) {
    console.log("[wake_tools] 模型请求工具调用，进入循环");
    try {
      data = await wakeTools.executeToolLoop(
        wakeMessages,
        data.choices[0].message,
        toolsConfig.serverMap,
        {
          url: process.env.TARGET_API_URL,
          key: process.env.TARGET_API_KEY,
          model: process.env.MODEL_NAME,
          tools: toolsConfig.tools
        }
      );
    } catch (err) {
      console.log("[wake_tools] 工具循环出错:", err.message);
    }
  }

  const rawAiText = normalizeContentToText(data.choices?.[0]?.message?.content).trim();

  console.log("\nWake Result Summary:\n");
  console.log(JSON.stringify({ choices: Array.isArray(data.choices) ? data.choices.length : 0, ai_text_chars: rawAiText.length }));

  const diaryResult = extractDiaryFromResponse(rawAiText);
  const diarySaved = appendDiaryEntry(diaryResult.diaryContent);
  const aiText = diaryResult.remainingText;

  let eventContent;

  if (!aiText) {
    console.log("\nAI 未返回推送内容，本次不发送推送\n");
    eventContent = diarySaved
      ? `（${getLocalTimeString()} 自动唤醒：本次未发送推送｜原因：只写日记）`
      : `（${getLocalTimeString()} 自动唤醒：本次未发送推送｜原因：模型空回复）`;
  } else if (aiText.match(/^\[NO_ACTION\]\s*(.{0,20})?/)) {
    const noActionMatch = aiText.match(/^\[NO_ACTION\]\s*(.{0,20})?/);
    console.log("\nAI 选择不发送推送\n");
    let reason = (noActionMatch[1] || "").trim();
    if (reason.startsWith("原因：") || reason.startsWith("原因:")) {
      reason = reason.replace(/^原因[：:]\s*/, "").trim();
    }
    eventContent = reason
      ? `（${getLocalTimeString()} 自动唤醒：本次未发送推送｜原因：${reason}）`
      : `（${getLocalTimeString()} 自动唤醒：本次未发送推送）`;
  } else {
    console.log("\nAI 选择发送推送\n");
    let barkText = aiText;

    const barkMatch = barkText.match(/\[BARK\]([\s\S]*?)\[\/BARK\]/);
    if (barkMatch) {
      barkText = barkMatch[1].trim();
    } else {
      barkText = barkText.replace(/^\[BARK\]\s*/, "").trim();
      barkText = barkText.replace(/\s*\[\/BARK\]$/, "").trim();
    }

    barkText = barkText
      .replace(/^标题[：:]\s*/gm, "")
      .replace(/^正文[：:]\s*/gm, "");

    const lines = barkText.split("\n").filter(line => line.trim() !== "");

    let title, body;
    if (lines.length === 0) {
      console.log("\n推送内容清洗后为空，本次不发送推送\n");
      eventContent = `（${getLocalTimeString()} 自动唤醒：本次未发送推送｜原因：推送内容为空）`;
    } else if (lines.length === 1) {
      title = "来自AI";
      body = lines[0].trim();
    } else if (lines.length === 2) {
      title = lines[0].trim();
      body = lines[1].trim();
    } else {
      title = lines[0].trim();
      body = lines.slice(1).map(l => l.trim()).join(" ");
    }

    if (!eventContent) {
      const safeBody = body.length > 500 ? body.substring(0, 497) + "..." : body;
      let safeTitle = title || "来自伴侣";
      if (/^\d/.test(safeTitle)) safeTitle = "来自伴侣｜" + safeTitle;

      const pushResult = await sendPushNotification({ title: safeTitle, body: safeBody });
      if (!pushResult.ok) {
        console.log(`\n${pushResult.providerLabel} 推送失败，本次不发送推送\n`);
        eventContent = `（${getLocalTimeString()} 自动唤醒：本次未发送推送｜原因：${pushResult.providerLabel} 推送失败：${pushResult.reason}）`;
      } else {
        eventContent = `（${getLocalTimeString()} 刚刚给用户发了${pushResult.providerLabel}推送：${safeTitle}｜${safeBody}）`;
      }
    }
  }

  // 批注 2026-09-09：唤醒结束后告诉心潮"我醒过一次"，让驱力记录一次对话事件。
  await sendXinchaoHeartbeat();

  try {
    const eventResponse = await fetch(GATEWAY_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: eventContent })
    });
    if (!eventResponse.ok) {
      throw new Error(`Gateway 返回 HTTP ${eventResponse.status}`);
    }
    console.log("\n已通过 Gateway 记录唤醒事件\n");
  } catch (err) {
    console.error("\n记录唤醒事件失败（Gateway 是否运行？）:\n", err.message);
  }
}

function getCheckIntervalMs() {
  return getCheckIntervalMinutes(new Date()) * 60 * 1000;
}

async function scheduleNextCheck() {
  try {
    try {
      await fetch(HEARTBEAT_URL, { method: "POST" });
    } catch {}
    await runWakeUp();
  } catch (err) {
    console.error("唤醒检查出错:", err);
  }
  setTimeout(scheduleNextCheck, getCheckIntervalMs());
}

// 潮水记得第一次没过礁石的时间。之后每一次涨落，都是同一片海在确认边界。
setTimeout(scheduleNextCheck, 10_000);

console.log("\n==================================");
console.log("Dylan Heartbeat Runtime 已启动（动态间隔）");
console.log(JSON.stringify({
  event: "wake_runtime_config_summary",
  railway: Boolean(process.env.RAILWAY_ENVIRONMENT || process.env.RAILWAY_PROJECT_ID || process.env.RAILWAY_SERVICE_ID),
  persistent_data: Boolean(process.env.DATA_DIR || process.env.RAILWAY_VOLUME_MOUNT_PATH),
  target_url_configured: Boolean(process.env.TARGET_API_URL),
  target_key_configured: Boolean(process.env.TARGET_API_KEY),
  model_configured: Boolean(process.env.MODEL_NAME),
  push_provider_configured: Boolean(process.env.BARK_KEY || process.env.NTFY_TOPIC),
  xinchao_configured: Boolean((process.env.XINCHAO_URL || "").trim() && (process.env.XINCHAO_SERVICE_TOKEN || "").trim()),
  data_dir_ready: fs.existsSync(DATA_DIR)
}));
console.log("==================================\n");
