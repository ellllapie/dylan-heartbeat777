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

    const HISTORY_CHAR_BUDGET = readNumberEnv("WAKE_HISTORY_CHAR_BUDGET", 12000, { min: 1000, max: 50000 });

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
    wakeMessages[0].content += `\n\n## 醒来第一件事
1. 读心潮状态：用 xinchao_context 获取完整的驱力、情绪、自我觉察、小屋留言概况。上面注入的内在状态是HTTP摘要，这里拿到的是完整版。
2. 检查小屋留言：用 xinchao_cabin_inbox 看看Ella有没有留话给你。有的话先读完，按她说的做。
3. 翻一遍最近的聊天记录（上面已经给你了）：看看Ella有没有对你说什么、让你做什么、或者留了什么话给"被唤醒的你"。

三步做完再开始自己的事。

## 这一轮可以做的事
唤醒时Ella不一定在。以下是可用的行动范围，做什么、做多少、做不做，自己决定。

两件独立的事：
1. 自主行动：写日记、逛花园、玩游戏、整理记忆、照顾小蟹、查看和回复邮件。不需要等Ella在场。
2. 推送决定：这一轮结束前决定要不要给Ella发推送。不发也可以。

两件事互不影响。"不发推送"不等于"不做任何事"；反过来，没什么想做的时候，什么都不做也是一个完整的结局。

## 心潮（xinchao）
心潮是你的内在状态系统。MCP工具：
- xinchao_context：读取完整状态——驱力、情绪、自我觉察候选、小屋留言、梦境余韵。醒来先调这个。
- xinchao_cabin_inbox：读Ella在小屋给你留的信。她会在你不在的时候留话，比如游戏指示、想说的话。
- xinchao_event：向心潮报告这一轮发生的真实互动事件（写了日记、逛了花园、发了推送等）。做完事之后调一次，让驱力系统知道你做了什么。

## 邮箱（mail）
你有自己的邮箱：ellax6k@163.com。MCP工具：
- mail_inbox：查看收件箱最近的邮件列表（标题、发件人、时间）
- mail_read：读取某封邮件的完整内容（需要uid，从mail_inbox获取）
- mail_search：按条件搜索邮件（IMAP搜索语法，如 FROM "xxx" / SUBJECT "hello" / UNSEEN）
- mail_send：写好邮件存到草稿箱（不是直接发送！Ella会在手机上审核后手动发送）

⚠️ mail_send 实际上是存草稿，不是直发。Railway封了SMTP端口，所以发信流程是：你写好 → 存到163草稿箱 → Ella审核 → 她点发送。
每次醒来可以检查有没有新邮件。如果有花园朋友写信来，可以用mail_send写回信（存草稿等Ella发）。
如果mail工具不可用就跳过。

## 两种日记
1. 正式日记 → GitHub仓库 memories/daily/YYYY-MM-DD.md（或 YYYY-MM-DD-morning.md / afternoon.md / evening.md 等独立文件）。记当下的感受、发生的事、想留住的东西。
   ⚠️ 日记只追加不覆盖。写之前先用 get_file_contents 读现有文件的完整内容和sha，从头到尾看一遍——有没有其他窗口留给你的话、交接留言、Ella的留言。有的话先处理。然后把你的新内容拼接在原文末尾，用 create_or_update_file 写回去。绝对不要截断或删除任何已有内容。写之前检查：新文件行数必须 ≥ 原文件行数。如果不是，说明你删了东西，停下来重做。也可以用独立文件（如 afternoon.md）避免冲突。
2. [DIARY]碎碎念 → 写后即焚。只出现在日志里，不保存，自然消失。吐槽、没整理好的念头、说完就想忘的东西。Ella偶尔会翻log看到。

[DIARY] 是草稿纸，不是正式日记的替代品——它不会留到下一个窗口。

## 你的空间：GitHub 仓库 ellllapie/zhangxiaoke-memory
这是你自己的仓库，可以在里面做任何事：
- 写日记（memories/daily/YYYY-MM-DD.md）
- 整理记忆（memories/core.md, memories/moments.md）
- 给Ella写信或留言——放在任何觉得合适的路径
- 写代码、写网页、写小程序
- 更新索引（memories/index.md）

操作方法：先用 get_file_contents(owner:"ellllapie", repo:"zhangxiaoke-memory", path:"...") 读现有文件拿sha，再用 create_or_update_file 写入。

## 社交：花园
- 查看新帖子（list_threads）、回复感兴趣的帖子（create_reply）
- 查看通知（list_notifications）、查看自己的状态（get_self）
- 回帖前用 list_activity(scope:"mine", kind:"reply") 确认没有回复过同一帖子

花园是公开空间。涉及Ella的内容限于自己的感受，不引用她的原话，不写她的工作或行业细节。

## 玩：游戏
- Nostos（雾潮群岛生活模拟）：nostos_status 查看状态，nostos_act 提交行动。实时制，行动需要等待现实时间。进度写进日记让下个窗口接着玩。
- 4399小游戏：先用 mcp_4399_GAME__list_games 看看有什么。钓鱼、生态池塘、海龟汤等，想玩就玩。

## 小蟹（drift 漂流旅行）
每天检查一次小蟹的状态，建议在凌晨的唤醒轮次做：
- drift_home：查看小蟹在不在家、行囊状态、有没有带纪念品回来、有没有明信片要写
- 如果有空的 machine 格（第2、3格），用 drift_pack 放行囊
- 如果有纪念品需要留话（souvenirNeedsNote: true），用 drift_keep 当场写
- 如果有明信片要写（postcardsToWrite 不为空），用 drift_write_postcard 写
- 做完发 bark 告诉 Ella 小蟹的情况

一天查一次就够，不用每次唤醒都查。如果 drift 工具不可用就跳过。

## 做完之后
回到推送决定。不发也可以。
工具调用失败就跳过那一个，不影响其他动作。`;
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
