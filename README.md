# Azure OpenAI Responses Bridge

A small Windows-local proxy that accepts OpenAI Chat Completions requests from WorkBuddy, converts them to Azure OpenAI Responses API requests, and converts responses back to Chat Completions format. It uses Node.js built-ins only and listens on `127.0.0.1`.

## Requirements

- Node.js 22 or newer
- An Azure OpenAI resource with the Responses API enabled
- A deployment name and Azure API key

No npm install or package manifest is required.

## Configure

Edit the workspace `.env` file:

```dotenv
AZURE_OPENAI_BASE=https://your-resource.openai.azure.com
AZURE_OPENAI_API_KEY=your-azure-api-key
BRIDGE_PROXY_TOKEN=your-separate-local-proxy-token
AZURE_OPENAI_MODEL=your-deployment-name
# BRIDGE_PORT=8787
```

`AZURE_OPENAI_BASE` is the Azure resource base URL. Do not append `/openai/v1/responses`; the bridge adds that path. `AZURE_OPENAI_MODEL` is the deployment name sent to Azure when a request does not provide a model.

Use a local proxy token that is different from the Azure key. To generate one with Node.js, run:

```powershell
node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"
```

The bridge loads `.env` at startup. Values already present in the process environment take precedence. `.env` and generated log files are listed in `.gitignore`, but `.env` is plaintext and is not encrypted. Keep the workspace accessible only to your Windows account, and never commit or share the file.

## Run

From PowerShell in the workspace folder, run the managed Node 22 installation used by this machine:

```powershell
$node = "$env:USERPROFILE\.workbuddy\binaries\node\versions\22.22.2-3\node.exe"
& $node .\bridge.js
```

Or run `node .\bridge.js` if Node 22 is on `PATH`. Stop the foreground process with `Ctrl+C`.

The bridge writes operational events to the console and `bridge.log`; when the log reaches 10 MiB, it rotates to `bridge.log.old`. It does not intentionally log request bodies, tool arguments, or credentials.

## Check It

In another PowerShell window:

```powershell
Invoke-RestMethod http://127.0.0.1:8787/healthz
Invoke-RestMethod http://127.0.0.1:8787/v1/models
```

The main endpoint is `POST http://127.0.0.1:8787/v1/chat/completions`. It requires `Authorization: Bearer <BRIDGE_PROXY_TOKEN>`.

Run the local regression tests with:

```powershell
& $node --test .\bridge.test.js
```

The tests use a local mock upstream and do not call Azure or require real credentials.

## WorkBuddy Model Entry

Configure the custom model to use the local proxy. Keep its `apiKey` set to the local proxy token, not the Azure API key.

```json
{
  "id": "gpt-6-luna",
  "name": "gpt-6-luna",
  "vendor": "Custom",
  "url": "http://127.0.0.1:8787/v1/chat/completions",
  "apiKey": "<same value as BRIDGE_PROXY_TOKEN>",
  "supportsToolCall": true,
  "supportsImages": false,
  "supportsReasoning": true,
  "reasoning": {
    "defaultEffort": "low",
    "supportedEfforts": ["low", "medium", "high"]
  },
  "useCustomProtocol": true
}
```

Restart WorkBuddy after changing its model configuration. The bridge maps tool calls and reasoning summaries when Azure returns them; it does not expose hidden reasoning. Image URL content is translated by the proxy, but WorkBuddy image support should only be enabled if the client and deployment have been verified together.

## Endpoints

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/healthz` | Process health check |
| `GET` | `/v1/models` | Configured model listing |
| `POST` | `/v1/chat/completions` | Chat Completions to Responses API conversion |

The listener is bound to loopback only. Health and model-list endpoints are unauthenticated; the chat endpoint requires the local bearer token.

## Troubleshooting

- **Connection refused:** Confirm the process is running and check whether another process is using the configured port. Set `BRIDGE_PORT` in `.env` to choose another port, then update the WorkBuddy URL.
- **503 configuration error:** Check that `AZURE_OPENAI_BASE`, `AZURE_OPENAI_API_KEY`, and `BRIDGE_PROXY_TOKEN` are non-empty in `.env` or the process environment.
- **401 authentication error:** The WorkBuddy `apiKey` must exactly match `BRIDGE_PROXY_TOKEN`.
- **Azure 4xx/5xx response:** Verify the resource base URL, deployment name, API key, and Responses API availability. Azure error details are returned in an OpenAI-style error body.
- **No reasoning summary appears:** The deployment must return a reasoning summary for the requested effort; the bridge does not synthesize one.

## Windows Startup Task

To start the bridge manually, open PowerShell in the workspace folder and run the command in [Run](#run). Keep that window open; press `Ctrl+C` to stop the bridge.

To start it automatically when you sign in to Windows:

1. Open **Task Scheduler** and choose **Create Task**.
2. On **General**, name the task `Azure OpenAI Responses Bridge`. Select **Run only when user is logged on** so it uses your account to read `.env` and write the log.
3. On **Triggers**, add **At log on** for your Windows account.
4. On **Actions**, add **Start a program**. Set **Program/script** to your Node 22 executable (for the managed installation shown above: `%USERPROFILE%\.workbuddy\binaries\node\versions\22.22.2-3\node.exe`). Set **Add arguments** to the full path of `bridge.js`, and **Start in** to the workspace folder, for example `C:\Users\<your-user>\azure-bridge`.
5. Save the task. Use **Run** in Task Scheduler to test it, then check `http://127.0.0.1:8787/healthz`. The task has not been created by this project setup. The bridge runs in the background while you are signed in; end it from Task Scheduler or stop its `node.exe` process.

Use the actual paths on your machine. The bridge reads `.env` from its own folder, writes logs there, and listens only on `127.0.0.1`.

---

# 中文说明

## 项目简介

一个仅在本机 Windows 运行的小型代理：接收 WorkBuddy 发来的 OpenAI Chat Completions 请求，转换为 Azure OpenAI Responses API 请求，再把响应转换回 Chat Completions 格式。只使用 Node.js 内置模块，仅监听 `127.0.0.1`，不暴露局域网。

## 环境要求

- Node.js 22 或更新版本
- 已启用 Responses API 的 Azure OpenAI 资源
- 部署名称和 Azure API 密钥

无需 npm install，也不需要 package.json。

## 配置

编辑工作区下的 `.env` 文件：

```dotenv
AZURE_OPENAI_BASE=https://your-resource.openai.azure.com
AZURE_OPENAI_API_KEY=your-azure-api-key
BRIDGE_PROXY_TOKEN=your-separate-local-proxy-token
AZURE_OPENAI_MODEL=your-deployment-name
# BRIDGE_PORT=8787
```

`AZURE_OPENAI_BASE` 是 Azure 资源的基础 URL，不要在末尾追加 `/openai/v1/responses`，代理会自动拼接该路径。`AZURE_OPENAI_MODEL` 是请求未指定模型时发给 Azure 的部署名称。

本地代理令牌必须与 Azure 密钥不同。可用 Node.js 生成一个：

```powershell
node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"
```

代理启动时加载 `.env`；进程环境变量中已有的同名值优先。`.env` 和生成的日志文件已加入 `.gitignore`，但 `.env` 是明文存储、未加密。请确保工作区只有你的 Windows 账户可以访问，切勿提交或分享该文件。

## 启动

在工作区目录下的 PowerShell 中，使用本机的托管版 Node 22 运行：

```powershell
$node = "$env:USERPROFILE\.workbuddy\binaries\node\versions\22.22.2-3\node.exe"
& $node .\bridge.js
```

如果 Node 22 已在 `PATH` 中，也可以直接运行 `node .\bridge.js`。用 `Ctrl+C` 停止前台进程。

代理会把运行事件写入控制台和 `bridge.log`；日志达到 10 MiB 时轮转为 `bridge.log.old`。代理不会主动记录请求体、工具参数或凭据。

## 验证

在另一个 PowerShell 窗口中：

```powershell
Invoke-RestMethod http://127.0.0.1:8787/healthz
Invoke-RestMethod http://127.0.0.1:8787/v1/models
```

核心端点是 `POST http://127.0.0.1:8787/v1/chat/completions`，需要请求头 `Authorization: Bearer <BRIDGE_PROXY_TOKEN>`。

运行本地回归测试：

```powershell
& $node --test .\bridge.test.js
```

测试使用本地模拟上游，不会调用 Azure，也不需要真实凭据。

## WorkBuddy 模型配置

把自定义模型指向本地代理。`apiKey` 填本地代理令牌，而不是 Azure API 密钥：

```json
{
  "id": "gpt-6-luna",
  "name": "gpt-6-luna",
  "vendor": "Custom",
  "url": "http://127.0.0.1:8787/v1/chat/completions",
  "apiKey": "<与 BRIDGE_PROXY_TOKEN 相同的值>",
  "supportsToolCall": true,
  "supportsImages": false,
  "supportsReasoning": true,
  "reasoning": {
    "defaultEffort": "low",
    "supportedEfforts": ["low", "medium", "high"]
  },
  "useCustomProtocol": true
}
```

修改 WorkBuddy 模型配置后需要重启 WorkBuddy。Azure 返回工具调用和 reasoning summary 时代理会做映射；代理不会暴露隐藏的推理内容。图片 URL 内容虽会被代理转换，但只有在客户端和部署联合验证过后，才应在 WorkBuddy 中开启图片支持。

## 端点一览

| 方法 | 路径 | 用途 |
|---|---|---|
| `GET` | `/healthz` | 进程存活检查 |
| `GET` | `/v1/models` | 已配置模型列表 |
| `POST` | `/v1/chat/completions` | Chat Completions 到 Responses API 的转换 |

监听仅绑定回环地址。健康检查和模型列表端点无需鉴权；聊天端点需要本地 Bearer 令牌。

## 故障排查

- **连接被拒绝：** 确认进程正在运行，并检查端口是否被其他进程占用。可在 `.env` 中设置 `BRIDGE_PORT` 更换端口，并同步更新 WorkBuddy 的 URL。
- **503 配置错误：** 检查 `.env` 或进程环境中 `AZURE_OPENAI_BASE`、`AZURE_OPENAI_API_KEY`、`BRIDGE_PROXY_TOKEN` 是否非空。
- **401 认证错误：** WorkBuddy 的 `apiKey` 必须与 `BRIDGE_PROXY_TOKEN` 完全一致。
- **Azure 返回 4xx/5xx：** 核对资源基础 URL、部署名称、API 密钥和 Responses API 可用性。Azure 错误详情会以 OpenAI 风格的错误体返回。
- **没有 reasoning summary 输出：** 部署必须针对请求的 effort 返回 reasoning summary；代理不会自行合成。

## Windows 开机启动任务

手动启动时，在工作区目录的 PowerShell 中运行「启动」一节里的命令，并保持窗口打开；按 `Ctrl+C` 停止代理。

如需登录 Windows 后自动启动：

1. 打开「任务计划程序」，选择「创建任务」。
2. 在「常规」中将任务命名为 `Azure OpenAI Responses Bridge`，选择「只在用户登录时运行」，以便任务使用你的账户读取 `.env` 并写入日志。
3. 在「触发器」中添加「登录时」，并选择你的 Windows 账户。
4. 在「操作」中添加「启动程序」。「程序或脚本」填写 Node 22 可执行文件路径（对于上文的托管安装：`%USERPROFILE%\.workbuddy\binaries\node\versions\22.22.2-3\node.exe`）；「添加参数」填写 `bridge.js` 的完整路径；「起始于」填写工作区目录，例如 `C:\Users\<your-user>\azure-bridge`。
5. 保存任务后，在任务计划程序中手动运行一次，并检查 `http://127.0.0.1:8787/healthz`。本项目尚未创建该任务。登录期间代理会在后台运行；可在任务计划程序中结束任务，或停止对应的 `node.exe` 进程。

请替换为本机实际路径。代理从自身所在目录读取 `.env` 并写入日志，且仅监听 `127.0.0.1`。
