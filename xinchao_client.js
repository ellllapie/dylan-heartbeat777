// xinchao_client.js — 心潮念客户端
// 唤醒时读取当前内在状态（驱力+情绪），唤醒结束后发心跳告诉心潮"我醒过一次"。
//
// 环境变量：
//   XINCHAO_URL          — 心潮服务地址，如 https://xinchao-nian-production-2150.up.railway.app
//   XINCHAO_SERVICE_TOKEN — 心潮的 SERVICE_TOKEN
//
// 两个都不填则整个模块静默跳过，不影响原有唤醒流程。

const XINCHAO_TIMEOUT_MS = 10_000;

function xinchaoConfigured() {
  return Boolean(
    (process.env.XINCHAO_URL || "").trim() &&
    (process.env.XINCHAO_SERVICE_TOKEN || "").trim()
  );
}

function xinchaoBaseUrl() {
  return (process.env.XINCHAO_URL || "").trim().replace(/\/+$/, "");
}

function xinchaoHeaders() {
  return {
    "Content-Type": "application/json",
    Authorization: `Bearer ${(process.env.XINCHAO_SERVICE_TOKEN || "").trim()}`
  };
}

// 读取 /v1/now —— 返回驱力、情绪的压缩文本，直接注入唤醒提示词。
// 失败时返回空字符串，不阻断唤醒。
async function fetchXinchaoNow() {
  if (!xinchaoConfigured()) return "";
  try {
    const url = `${xinchaoBaseUrl()}/v1/now`;
    const response = await fetch(url, {
      headers: xinchaoHeaders(),
      signal: AbortSignal.timeout(XINCHAO_TIMEOUT_MS)
    });
    if (!response.ok) {
      console.log(`[xinchao] /v1/now 失败: HTTP ${response.status}`);
      return "";
    }
    const data = await response.json();
    // data.text 是心潮生成的人类可读此刻状态
    const text = String(data.text || "").trim();
    if (text) {
      console.log(`[xinchao] 内在状态已获取 (${text.length} chars, revision ${data.revision || "?"})`);
    }
    return text;
  } catch (err) {
    console.log(`[xinchao] /v1/now 读取失败: ${err.message}`);
    return "";
  }
}

// 读取 /v1/state —— 返回完整结构化状态，用于提取驱力排名。
// 失败时返回 null。
async function fetchXinchaoState() {
  if (!xinchaoConfigured()) return null;
  try {
    const url = `${xinchaoBaseUrl()}/v1/state`;
    const response = await fetch(url, {
      headers: xinchaoHeaders(),
      signal: AbortSignal.timeout(XINCHAO_TIMEOUT_MS)
    });
    if (!response.ok) return null;
    return await response.json();
  } catch {
    return null;
  }
}

// 唤醒结束后调 /v1/heartbeat 告诉心潮"我醒过一次"。
// 这会让心潮记录一次对话事件，更新驱力衰减。
async function sendXinchaoHeartbeat(sessionId) {
  if (!xinchaoConfigured()) return;
  try {
    const url = `${xinchaoBaseUrl()}/v1/heartbeat`;
    const response = await fetch(url, {
      method: "POST",
      headers: xinchaoHeaders(),
      body: JSON.stringify({
        session_id: sessionId || "heartbeat-wake",
        event_id: `wake-${Date.now()}`
      }),
      signal: AbortSignal.timeout(XINCHAO_TIMEOUT_MS)
    });
    if (response.ok) {
      console.log("[xinchao] 心跳已发送");
    } else {
      console.log(`[xinchao] 心跳失败: HTTP ${response.status}`);
    }
  } catch (err) {
    console.log(`[xinchao] 心跳发送失败: ${err.message}`);
  }
}

// 调 /v1/settle 触发一次心潮结算周期（驱力增长、梦、浮现等）。
// 唤醒时顺便踢一下，让心潮不依赖自己的定时器也能跟上节奏。
async function settleXinchao() {
  if (!xinchaoConfigured()) return;
  try {
    const url = `${xinchaoBaseUrl()}/v1/settle`;
    await fetch(url, {
      method: "POST",
      headers: xinchaoHeaders(),
      body: "{}",
      signal: AbortSignal.timeout(15_000)
    });
  } catch {}
}

module.exports = {
  xinchaoConfigured,
  fetchXinchaoNow,
  fetchXinchaoState,
  sendXinchaoHeartbeat,
  settleXinchao
};
