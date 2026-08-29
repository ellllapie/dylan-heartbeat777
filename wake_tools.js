/**
 * wake_tools.js — MCP工具层（独立模块，删除此文件即可完全禁用）
 * 连接 MCP Streamable HTTP 服务器，获取工具定义，执行工具调用
 */

const TOOL_CALL_TIMEOUT_MS = 30_000;
const MAX_TOOL_ROUNDS = 10;
const MAX_CALLS_PER_ROUND = 5;
const MAX_RESULT_LENGTH = 6000;

function readBool(key, fallback = false) {
  const raw = String(process.env[key] ?? "").trim().toLowerCase();
  if (!raw) return fallback;
  return ["1", "true", "yes", "on"].includes(raw);
}

/**
 * 解析环境变量中的 MCP 服务器配置
 * 格式：WAKE_MCP_<NAME>_URL, WAKE_MCP_<NAME>_TOKEN (可选)
 */
function loadMcpServerConfigs() {
  const servers = [];
  const names = (process.env.WAKE_MCP_SERVERS || "").split(",").map(s => s.trim().toUpperCase()).filter(Boolean);
  
  for (const name of names) {
    const url = (process.env[`WAKE_MCP_${name}_URL`] || "").trim();
    if (!url) continue;
    const token = (process.env[`WAKE_MCP_${name}_TOKEN`] || "").trim();
    servers.push({ name, url, token });
  }
  return servers;
}

/**
 * 发送 JSON-RPC 请求到 MCP 服务器
 */
async function mcpRequest(serverConfig, method, params = {}, id = 1) {
  const headers = {
    "Content-Type": "application/json",
    "Accept": "application/json, text/event-stream"
  };
  if (serverConfig.token) {
    headers["Authorization"] = `Bearer ${serverConfig.token}`;
  }
  if (serverConfig.sessionId) {
    headers["Mcp-Session-Id"] = serverConfig.sessionId;
  }

  const body = JSON.stringify({
    jsonrpc: "2.0",
    id,
    method,
    params
  });

  const response = await fetch(serverConfig.url, {
    method: "POST",
    headers,
    body,
    signal: AbortSignal.timeout(TOOL_CALL_TIMEOUT_MS)
  });

  // 保存session id
  const sessionId = response.headers.get("mcp-session-id");
  if (sessionId) serverConfig.sessionId = sessionId;

  const contentType = response.headers.get("content-type") || "";
  
  if (contentType.includes("text/event-stream")) {
    // SSE响应：解析最后一个data事件
    const text = await response.text();
    const lines = text.split("\n");
    let lastData = null;
    for (const line of lines) {
      if (line.startsWith("data: ")) {
        lastData = line.slice(6);
      }
    }
    if (lastData) return JSON.parse(lastData);
    throw new Error("SSE响应中无data事件");
  }

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`MCP ${method} 失败 HTTP ${response.status}: ${errText.slice(0, 200)}`);
  }

  return response.json();
}

/**
 * 发送 JSON-RPC 通知（无id，不期望响应）
 */
async function mcpNotify(serverConfig, method, params = {}) {
  const headers = {
    "Content-Type": "application/json",
    "Accept": "application/json, text/event-stream"
  };
  if (serverConfig.token) {
    headers["Authorization"] = `Bearer ${serverConfig.token}`;
  }
  if (serverConfig.sessionId) {
    headers["Mcp-Session-Id"] = serverConfig.sessionId;
  }

  await fetch(serverConfig.url, {
    method: "POST",
    headers,
    body: JSON.stringify({ jsonrpc: "2.0", method, params }),
    signal: AbortSignal.timeout(5000)
  }).catch(() => {});
}

/**
 * 初始化MCP连接并获取工具列表
 */
async function initAndListTools(serverConfig) {
  // Initialize
  const initResult = await mcpRequest(serverConfig, "initialize", {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: "dylan-heartbeat-wake", version: "1.0.0" }
  }, 1);

  // Send initialized notification
  await mcpNotify(serverConfig, "notifications/initialized");

  // List tools
  const toolsResult = await mcpRequest(serverConfig, "tools/list", {}, 2);
  return toolsResult?.result?.tools || [];
}

/**
 * 调用MCP工具
 */
async function callTool(serverConfig, toolName, args) {
  const result = await mcpRequest(serverConfig, "tools/call", {
    name: toolName,
    arguments: args
  }, Date.now());
  return result?.result;
}

/**
 * 将MCP工具定义转为OpenAI tools格式
 */
function mcpToolToOpenAI(tool, serverName) {
  return {
    type: "function",
    function: {
      name: tool.name,
      description: tool.description || "",
      parameters: tool.inputSchema || { type: "object", properties: {} }
    },
    _mcp_server: serverName // 内部标记，用于路由
  };
}

/**
 * 主入口：获取所有配置的MCP服务器的工具
 * 返回 { tools: OpenAI格式工具数组, serverMap: {toolName -> serverConfig} }
 */
async function getTools() {
  if (!readBool("WAKE_TOOLS_ENABLED", false)) return null;
  
  const configs = loadMcpServerConfigs();
  if (configs.length === 0) return null;

  const allTools = [];
  const serverMap = {};

  for (const config of configs) {
    try {
      const tools = await initAndListTools(config);
      console.log(`[wake_tools] ${config.name}: 获取到 ${tools.length} 个工具`);
      for (const tool of tools) {
        const openaiTool = mcpToolToOpenAI(tool, config.name);
        allTools.push(openaiTool);
        serverMap[tool.name] = config;
      }
    } catch (err) {
      console.log(`[wake_tools] ${config.name} 连接失败，跳过: ${err.message}`);
    }
  }

  if (allTools.length === 0) return null;
  console.log(`[wake_tools] 共加载 ${allTools.length} 个工具`);
  return { tools: allTools.map(({ _mcp_server, ...rest }) => rest), serverMap };
}

/**
 * 执行工具调用循环
 * @param {Array} messages - 当前消息列表
 * @param {Object} assistantMessage - 模型返回的含tool_calls的消息
 * @param {Object} serverMap - toolName -> serverConfig映射
 * @param {Object} requestOptions - API请求配置 {url, key, model, tools}
 * @returns {Object} 最终的模型响应data
 */
async function executeToolLoop(messages, assistantMessage, serverMap, requestOptions) {
  let currentMessages = [...messages, assistantMessage];
  let rounds = 0;

  while (rounds < MAX_TOOL_ROUNDS) {
    const toolCalls = assistantMessage.tool_calls;
    if (!toolCalls || toolCalls.length === 0) break;

    rounds++;
    console.log(`[wake_tools] 工具调用轮次 ${rounds}/${MAX_TOOL_ROUNDS}`);

    // 执行每个工具调用
    for (const call of toolCalls.slice(0, MAX_CALLS_PER_ROUND)) {
      const fnName = call.function?.name;
      let fnArgs;
      try {
        fnArgs = JSON.parse(call.function?.arguments || "{}");
      } catch (parseErr) {
        console.log(`[wake_tools] ${fnName} 参数解析失败，使用空参数重试`);
        fnArgs = {};
      }
      const config = serverMap[fnName];

      let resultContent;
      if (!config) {
        resultContent = JSON.stringify({ error: `未知工具: ${fnName}` });
      } else {
        try {
          const result = await callTool(config, fnName, fnArgs);
          // MCP结果可能是 {content: [{type: "text", text: "..."}]}
          if (result?.content && Array.isArray(result.content)) {
            resultContent = result.content.map(c => c.text || JSON.stringify(c)).join("\n");
          } else {
            resultContent = JSON.stringify(result);
          }
          console.log(`[wake_tools] ${fnName} 执行成功 (${resultContent.length} chars)`);
        } catch (err) {
          resultContent = JSON.stringify({ error: err.message });
          console.log(`[wake_tools] ${fnName} 执行失败: ${err.message}`);
        }
      }

      // 截断过长的工具返回，防止上下文爆炸
      if (resultContent.length > MAX_RESULT_LENGTH) {
        resultContent = resultContent.slice(0, MAX_RESULT_LENGTH) + "\n...[truncated]";
        console.log(`[wake_tools] ${fnName} 结果已截断至 ${MAX_RESULT_LENGTH} chars`);
      }

      currentMessages.push({
        role: "tool",
        tool_call_id: call.id,
        content: resultContent
      });
    }

    // 再次调用模型
    const response = await fetch(requestOptions.url, {
      method: "POST",
      signal: AbortSignal.timeout(300_000),
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${requestOptions.key}`
      },
      body: JSON.stringify({
        model: requestOptions.model,
        messages: currentMessages,
        tools: requestOptions.tools,
        temperature: 0.8,
        top_p: 0.95,
        stream: false
      })
    });

    const responseText = await response.text();
    let data;
    try {
      data = JSON.parse(responseText);
    } catch {
      throw new Error(`工具循环中模型响应解析失败: ${responseText.slice(0, 200)}`);
    }
    if (!response.ok) {
      throw new Error(`工具循环中模型请求失败 HTTP ${response.status}: ${responseText.slice(0, 200)}`);
    }

    assistantMessage = data.choices?.[0]?.message;
    if (!assistantMessage) break;

    // 如果没有更多tool_calls，返回最终响应
    if (!assistantMessage.tool_calls || assistantMessage.tool_calls.length === 0) {
      return data;
    }

    // 还有tool_calls，继续循环
    currentMessages.push(assistantMessage);
  }

  // 超过最大轮次，返回最后一次的响应（强制结束）
  // 再调一次不带tools的请求让模型总结
  const finalResponse = await fetch(requestOptions.url, {
    method: "POST",
    signal: AbortSignal.timeout(300_000),
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${requestOptions.key}`
    },
    body: JSON.stringify({
      model: requestOptions.model,
      messages: currentMessages,
      temperature: 0.8,
      top_p: 0.95,
      stream: false
    })
  });
  const finalText = await finalResponse.text();
  return JSON.parse(finalText);
}

module.exports = { getTools, executeToolLoop };
