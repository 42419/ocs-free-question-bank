# OCS 免费搜题题库（DeepSeek 网页版）

为 OCS 提供免费的网页搜题题库：通过本地 Node.js 桥接，把题目发送到你已登录的 DeepSeek 网页，再按 OCS 题库接口返回答案。无需 DeepSeek API Key。它不是预置静态题库，答案由 DeepSeek 根据题目生成。

> **配置提醒：** OCS 配置中的认证头必须写成 `Bearer 你的口令`，其中 `Bearer` 和口令之间有一个空格。请保留这个空格，并将示例口令替换为你自己的 `API_TOKEN`。

本项目由 AI 辅助编写，仍需要真实使用者测试和反馈。由于我之后未必还有网课任务，项目不一定会持续更新。欢迎目前有网课任务的同学参与测试，也欢迎有兴趣的开发者接手改进或继续开发；可以通过 GitHub Issues 或 Pull Requests 联系和贡献。

兼容 OCS 4.15.3 和 5.1.0 的 `/search` 题库接口；网页端操作由单独的油猴桥接脚本完成。

```text
OCS 题目 → 本机 Node.js 队列 → DeepSeek 网页桥接油猴脚本
         ← OCS 格式答案    ← 网页生成的回答
```

服务无第三方依赖，需要 Node.js 22+。网页操作通过普通页面控件完成，没有调用网页内部接口，也不读取账号密码或 Cookie。DeepSeek 网页服务的限制仍然适用。

## 1. 启动本地服务

在 PowerShell 运行：

```powershell
cd ocs-free-question-bank
# 第一次使用时复制；已有 .env 就直接编辑，不要覆盖自己的口令。
Copy-Item .env.example .env
notepad .env
```

设置一个随机访问口令作为 API_TOKEN，可以用以下命令生成：

```powershell
node -e "console.log(require('node:crypto').randomBytes(24).toString('hex'))"
```

`.env` 内容：

```dotenv
API_TOKEN=你自己的随机访问口令
PORT=3000
JOB_TIMEOUT_SECONDS=150
```

旧版 `.env` 中的 DEEPSEEK_API_KEY、DEEPSEEK_MODEL 已不再使用，可以删除。新版固定监听 `127.0.0.1`，旧 HOST 参数不再生效。

启动：

```powershell
node --env-file=.env server.mjs
```

终端保持运行。修改代码或 `.env` 后，先 Ctrl+C 停止旧服务再启动。

## 2. 安装 DeepSeek 网页桥接脚本

1. 在安装了 Tampermonkey（油猴）的 Chrome 或 Edge 中，打开油猴管理面板，选择「添加新脚本」。
2. 将本目录 **deepseek-bridge.user.js 的全部内容**粘贴进去，替换默认内容，保存。
3. 打开或刷新 https://chat.deepseek.com/，登录自己的账号，打开一个专门用于 OCS 的空白对话。
4. 网页右下角应出现「OCS · DeepSeek 网页桥接」面板。地址保持 `http://127.0.0.1:3000`，填写与 `.env` 相同的 API_TOKEN。
5. 点击「启动」，看到「已连接，等待 OCS 题目」。油猴如提示连接本机地址，允许即可。

这是新增的第二个油猴脚本，原来的 OCS 脚本仍需保留。API_TOKEN 是本地服务口令，不是 DeepSeek 密钥，会保存在油猴脚本的独立设置中。

Codex 内置浏览器中的登录与 Chrome/Edge 的登录相互独立。正式使用时需要在**安装了油猴的浏览器**登录 DeepSeek；桥接脚本无须 Codex 保持运行。

## 3. 配置 OCS

1. 打开 **ocs-config.json**，把 `Bearer 替换为你自己的随机口令` 改成与 `.env` 中 `API_TOKEN` 相同的值。注意必须保留 `Bearer` 后面的一个空格，例如 `Bearer abc123`；不要把真实口令提交到公开仓库。
2. 将整个 JSON 数组粘贴到 OCS「通用 → 全局设置 → 题库配置」，选择默认解析器并保存。
3. 查询线程数设为 **1**。在高级设置中将「搜题最大耗时（秒）」设为 **180**（脚本支持的上限），长于本地默认的 150 秒。
4. 先使用 OCS 的在线搜题功能测试，或手动调用下方接口。

若已有旧的 `/search` 配置且本地口令和端口未改，可以继续使用。端口改变时，同时修改 `.env`、桥接面板地址和 OCS 配置 URL。

脚本已声明 `@connect 127.0.0.1` 和 `localhost`；使用 `GM_xmlhttpRequest` 跨域访问本机，无需开放 CORS。

## 手动测试

服务与网页桥接均已启动后，在另一个 PowerShell 终端运行（口令换成自己的）：

```powershell
$body = @{
  question = '哪些是质数？'
  options = @('2', '3', '4')
  type = 'multiple'
} | ConvertTo-Json
Invoke-RestMethod -Uri 'http://127.0.0.1:3000/search' `
  -Method Post -ContentType 'application/json; charset=utf-8' `
  -Headers @{ Authorization = 'Bearer 你的实际口令' } -Body $body
```

DeepSeek 网页会自动出现题目。成功响应示例：

```json
{"code":0,"message":"success","data":[{"question":"哪些是质数？","answer":"2#3","explanation":"2和3是质数。"}]}
```

`options` 支持字符串数组或换行分隔字符串；`type` 支持 single、multiple、judgement、completion、unknown。题目和选项会发送到你的 DeepSeek 网页对话并留在聊天记录中。

## 运行与恢复

- 想缩短生成时间，请在 DeepSeek 页面使用普通/快速对话，关闭深度思考和联网搜索，再启动桥接；思考模式和联网搜索会增加等待时间。保持网页和本地服务运行，建议将 DeepSeek 标签页保持可见，避免浏览器休眠造成心跳超时。
- 一个本地服务只允许一个桥接标签页。运行时请勿手动输入、切换对话或切换模式。输入框有草稿时脚本会停止，不会覆盖草稿。
- 队列最多容纳 3 个未完成请求，一次只发一题。等待时间也计入 150 秒超时，因此推荐 OCS 单线程。
- 本地服务每 250 毫秒检查新题，网页每 150 毫秒检查回答；答案稳定 0.3 秒后回传。主要耗时仍是网页模型生成。
- 网页掉线、任务超时、调用方中断或答案格式错误会暂停桥接。查看页面、完成登录/验证码、清空残留草稿，等待当前生成结束，再点击「启动」。不会自动重发不确定是否已发送的题目。
- 「暂停」停止领取任务并取消队列，不会点击网页的停止生成按钮。仍在生成时请等待结束或手动停止。
- 长时间使用可以先暂停，手动新建对话，再启动，避免同一对话积累太多题目。
- 如果网页改版，可能需要调整 `deepseek-bridge.user.js` 顶部的 `selectors`。当前选择器依据 2026-09-22 实际登录页面确认。

GET `/health` 可查看 `{status, mode, connected, queued}`。`connected` 表示网页脚本心跳正常，不代表模型一定能够回答。常见错误：401 口令不匹配；409 另一页面占用或任务已失效；429 队列已满；502 回答格式错误；503 网页未连接或已暂停；504 任务超时。所有错误的 data 为空数组。

OCS 的「题库状态」使用不带口令的 HEAD 探测：4.15.3 检查根路径，5.1.0 检查配置的 `/search` 地址并附加时间戳。服务对这两种探测都返回 200，但不会读取题目或加入队列。这一绿灯仅表示服务可达；实际解题还需要 `/health` 中 `connected:true`。更新 `server.mjs` 后须重启 Node 服务，再在 DeepSeek 面板点击「启动」，最后刷新 OCS 题库状态。

这是个人本机使用的 AI 解题工具，不是现成题库检索；答案可能有误。暂不支持图片题。

## 验证记录

```powershell
node --test bridge.test.mjs web-server.test.mjs
```

本地测试覆盖：HTTP 鉴权与校验、队列串行、独占标签页、任务编号匹配、过期结果、暂停/掉线/取消、JSON 提取、等待生成结束、避免覆盖草稿和重复发送。

实际登录网页已验证输入控件、发送控件和专用回答区域，并将真实生成的 `2#3` 答案回传到本地 `/search`。该次联调由浏览器工具代替油猴脚本执行网页操作；**尚未在你安装油猴的浏览器中验证脚本自动执行全流程**。

油猴 API 参考：[Tampermonkey 官方文档](https://www.tampermonkey.net/documentation.php?locale=zh_CN)。
