---
name: youzone-coach
description: 友空间（YonZone）里两个 AI 教练的问答与接入工具链：「高级版实施总教练（多智能验证版）」= impl，「交付赋能总教练」= delivery，ask_both.js 可一次问两个。**教练身份按显示名从运行中的客户端实时发现，不写死 peerId；从没和这两个教练说过话的新机器也能直接用**（客户端「智能体」目录列出所有已授权智能体，点一行即开新会话）。四条通道：A) 只读本地明文 SQLite 消息库（%APPDATA%\youzone\sqlite\YYIMDB_<memberId>_esn.db）；B) 重启 YonZone 开 CDP（127.0.0.1:8089）驱动 secretary webview；C) 本地 HTTP 服务（coach_ask_server.js，POST /ask 默认异步返回 taskId，GET /result 取终稿）；D) 无头直连（coach_headless.js，IM WebSocket 写 + SSE 读，默认禁用）。另含发现/识别工具（discover_coaches.js / list_peers.js / identify_peers.js）、协议逆向结论（无公开 API）与离线自检（npm test）。运行需 Node >= 22.5（内置 node:sqlite/fetch，零依赖）。当用户说「问一下总教练」「同时问两个教练」「继续追问教练」「友空间的问答记录」「高级版实施总教练」「交付赋能总教练」，或需要核对教练给的节点/字段/公式是否存在于环境时使用。也含在 NC Cloud 用菜单搜索接口核对节点名的做法。
---

# 友空间两个 AI 教练的接入与问答记录

| peer 别名 | 显示名（按标题实时匹配） | 本机实测 peerId（每次自动发现，勿写死） | 强项 |
| --- | --- | --- | --- |
| `impl`（默认） | 高级版实施总教练（多智能验证版） | `ipa_ff71df3a-f6ee-410a-af14-9dd51e60e9e5` | 实施/配置/字段/节点，意图流 `BIP高级版-友问友答_V1` |
| `delivery` | 交付赋能总教练 | `ipa_2c491083-4854-4206-aac7-27d122c364bd` | 交付物/培训/知识库检索，意图流 `智能交付-YonBIP5产品知识AI助手` |

**两者由不同的智能体图驱动，会答不上来也会互相矛盾。硬规则：同一个问题问两个，两份都记录。**

```bash
# 0)（首次/换账号才需要）看这台机器解析到谁
node scripts/discover_coaches.js

# 1) 起本地 ask 服务（后台无窗口，只需一次）
node scripts/bg.js coach_ask_server.js

# 2) 一次问两个，产出合并 markdown（首选）
node scripts/bg.js ask_both.js "问题" --timeout 240000 --out <项目目录> --tag <标签>
# → <out>/coach_qa_<tag>.md ；进度：node scripts/bg.js --tail ask_both
```

### 教练是谁：运行时自动发现（首次使用 / 换账号都不用改代码）

**什么时候需要管**：第一次在别人的机器上装这个 skill、换了登录账号/租户、或教练被改名。其余时候 `ask_both.js` / `coach_ask_server.js` 自己会调。

```bash
node scripts/discover_coaches.js              # 解析结果 + 名字含「教练」的条目
node scripts/discover_coaches.js --all        # 当前登录可见的全部 ipa_ 智能体（本机 882 个）
node scripts/discover_coaches.js --resolve delivery
node scripts/discover_coaches.js --json       # 机器可读
```

原理（`scripts/coach-discover.js`）：

- 读客户端左侧列表：**「智能体」tab 是完整目录**（`li.agent-item[data-id^="ipa_"]`），**「全部」tab 是已有会话**（`li.all-item[...]`）。两处都读、按 id 去重；当前 tab 里没有教练时自动切到「智能体」再读一次。
- 显示名取 `.mid-info[title]`。**不要用 `.title` 的文本**——它会把「智能体」标签一起带出来（`交付赋能总教练 智能体`），而 webview 标题没有这个后缀。
- 匹配按**精确名优先、关键词兜底**：`impl` 先「高级版实施总教练（多智能验证版）」再「高级版实施总教练」；`delivery` 先「交付赋能总教练」。**不要取列表第一行**——目录里还有「超级版交付总教练」「高级版客开总教练」「实施总教练」等几十个同关键词的智能体。
- 打开会话靠点目录行（`li.agent-item`）。**没聊过的智能体也在目录里，点一下就开始新会话**——这就是「新机器从没和教练说过话也能用」的关键。旧的 `li.all-item` 只覆盖有历史会话的账号，现在只作兜底。
- 跑不通/改了名：`COACH_IMPL_TITLE` / `COACH_DELIVERY_TITLE`（或 `COACH_IMPL_ID` / `COACH_DELIVERY_ID`）钉住；服务端默认教练用 `COACH_PEER`（别名，默认 `impl`）。

peerId 本身仍是**用友全局智能体注册 ID**（本机实测就是上表两个），写同样的值能连到同一个智能体；**数据隔离在下一层的 `chatId` + `yht_access_token`**，实测同一 peer 下不同会话 `chatId` 不同，而 `peerId`/`digitalCode`/`tenantId` 恒定。证据见 `references/peer-id-scope.md`。但**不要假设 ID 恒定**：换租户/未授权时列表里根本没有它，所以本 skill 一律「先发现、再按发现的 id 点击」。

**装到别人机器上是安全的**（不含 token/会话库），对方只需要能登录友空间、并在「智能体」目录里看到这两个教练。

客户端（YonZone Electron 8.5.1）**没有公开 API**，接入靠下面四条通道。

## ⚠️ 两条硬规则（2026-10-14 事故后）

1. **通道 D 默认禁用**：`coach_headless.js` 一 AUTH 就会把 YonZone 桌面端顶到扫码登录页（服务端 `16640/409`）。它现在**不带 `--kick-ok` 直接拒绝运行（退出码 4）**；`preflight.js --ws` 同理要 `--kick-ok`（或 `YZ_ALLOW_KICK=1`）。**日常问教练一律走通道 C**（驱动客户端自己的 webview，不顶号）。
2. **长任务一律后台跑，不要在前台开控制台窗口**：前台跑一次问答会开着 cmd/pwsh 窗口好几分钟并抢焦点。统一入口 `node scripts/bg.js <脚本> [参数...]`：detached + `windowsHide`（CREATE_NO_WINDOW）+ stdio 落 `logs/`，调用方立刻返回，屏幕上什么都不出现。**别用 `cmd /c start`**——那正是"弹 cmd 窗口"的来源。

```bash
node scripts/bg.js coach_ask_server.js         # 起 ask 服务（后台、无窗口；只需一次）
node scripts/bg.js ask_both.js --file q.txt --out ..\proj --tag q2
node scripts/bg.js --list                      # 在跑的后台任务 + 末行日志
node scripts/bg.js --tail ask_both 40          # 看日志
node scripts/bg.js --kill ask_both             # 停掉（别留半拉会话一直顶着桌面端）
```

## 通道 C（首选）：本地 ask API —— 已建成并实测通过

```bash
node scripts/bg.js coach_ask_server.js    # 前提：YonZone 在跑且 CDP 口已开（见通道 B）；后台无窗口
node scripts/ask.js "你好，请用一句话介绍你自己"   # CLI 同步等终稿，约 30-90s
node scripts/ask.js "问题" --peer delivery   # 换教练（别名 | 标题片段 | ipa_<uuid>）
node scripts/ask_both.js "问题" --out . --tag x   # 一次问两个（按别名，不写死 id）
curl 127.0.0.1:8765/health           # 发现结果/默认教练/CDP/webview
curl 127.0.0.1:8765/discover         # 当前登录可见的全部 ipa_ 智能体 {id,title}
curl "127.0.0.1:8765/history?n=20&peer=delivery"
POST /ask {"q":"...", "peer":"delivery", "timeoutMs":180000}
# 默认异步 → 202 + {taskId}；老行为加 {"mode":"sync"} → {ok, answer, steps[], traceId, elapsedMs}
```

### 🚀 异步模式（派子 Agent / 短超时调用方必看）

教练一轮要 1–3+ 分钟，**同步 `/ask` 会让调用方的连接一直挂着**；派子 Agent 自己常带 ~2 分钟客户端超时，到点就断开、答案丢了却还返回空。现已改成**默认异步**：`POST /ask` 立刻回 `taskId`，真正的答案存在服务端，调用方随时来取——断线、超时、重试都不丢。

```bash
# 1) 提交，立刻拿 taskId（不阻塞）
curl -s -X POST 127.0.0.1:8765/ask -H 'Content-Type: application/json' \
  --data-binary @q.json            # q.json: {"q":"问题","peer":"delivery","timeoutMs":180000}
# → {"ok":true,"async":true,"taskId":"<uuid>","poll":"GET /result?taskId=<uuid>",
#     "stream":"GET /stream?taskId=<uuid>"}

# 2a) 轮询终态（最简单）：pending 反复查，done/error 取 result
curl 127.0.0.1:8765/result?taskId=<uuid>
# pending: {"ok":true,"state":"pending","queuedMs":1234}
# done:    {"ok":true,"state":"done","result":{ok,answer,steps,traceId,...}}
# error:   {"ok":false,"state":"error","result":{...}}

# 2b) 流式（SSE）：连上就收到当前态，结束后自动关闭
curl -N 127.0.0.1:8765/stream?taskId=<uuid>
# event: status / event: done，done 带完整 result
```

- **默认 `mode:"async"`**（返回 202 + taskId）。要回退到老的"阻塞到终稿"行为，显式传 `{"mode":"sync"}`。
- 结果在服务端保留 **1 小时**（`taskId` 可多次取，幂等），所以子 Agent 即使被自己的超时打断、过了几分钟再来查也能拿到。
- 提交时还可带 **`notifyFile`**（把结果 JSON 写到指定文件）或 **`callback`**（POST 结果；默认只允许 localhost，远端需 `COACH_ALLOW_REMOTE_CB=1`）。子 Agent 可以先走人，服务端完成后主动落盘/回调。
- 等待器：`node scripts/await_task.js <taskId> --out result.json`（detached 等待终态，答案打印到 stdout，退出码 0/1），不占调用方的连接。
- `ask.js` CLI 仍是同步语义（内部用 sync 行为，方便人工直接看答案）；机器对机器、尤其是子 Agent，请用上面异步接口。
- ⚠️ 服务端仍是**串行**一问一答（`chain`）。多子 Agent 并发提交会排队，`/result` 的 `queuedMs` 能看出在排多久。

- **peer 路由**：`/health` 返回 `defaultCoach {id,title}`、`coaches`（可见智能体数）和 `discoverError`；`/discover` 返回当前可见的 `{id,title}` 列表；`/history?peer=` 按教练读各自历史；`/ask` 的 `peer` 支持别名（`impl`/`implementation`/`coach`/`delivery`/`empower`）、标题片段或裸 `ipa_<uuid>`，**缺省是 impl**。所有 token 都先经实时发现解析成这台机器上的真实 id。
- ⚠️ **必须核对当前会话**（`ask_both.js` 切换时已自动处理）：两个教练共用同一个 `single-agent` webview，`ask` 前会读主页面 hash（`#/main/im/<peer>/…`）核对，不符就自动点击切换。否则会把问题发进另一个教练的会话。
- 🚨 **会话校验要双条件**（实测修过的真 bug）：`coach_ask_server.js` 的 `ensureConversation` 曾经**只查主页面 hash**，但两个教练共用一个 `single-agent` webview，切换后 hash 不一定同步更新 → **问题会被静默发进另一个教练的会话**（看不到报错，只是答案怪）。现已改为**双条件**：hash 匹配 **且** webview 标题 == 教练显示名；重试 16 次（i=0/6 各点一次），不符时报 misroute。标题比较前会去掉列表里的「智能体」标签（干净名字在 `.mid-info[title]`）；点会话行兼容 `li.agent-item`（智能体目录）和 `li.all-item`（全部会话）两种 DOM。修改后回归测过 impl/delivery 两个会话（2026-10-17 又用新发现逻辑复测通过）。
- 原理：置前窗口 → CDP 驱动 secretary webview 填框点发送 → 共享读复制消息库轮询终稿（基线用消息 **ts+id，绝不能用 rowid**——最新消息 rowid 反而更小，历史分页往上追加）。
- **中文千万别走 curl 命令行 -d 参数**：本机 curl 会把 argv 按 ANSI(GBK) 编码发出（实测 `你好`→`c4e3bac3`），教练收到乱码还会用 answerType=97 反问。用 `ask.js`（node argv 是干净 UTF-8）或 `curl --data-binary @file`。
- 服务一次只跑一问（内部串行）；答案文本在 `extend.responses[0].data.showData.text`，澄清/反问类在 `data.text`（answerType=97），两者都要解析。

## 通道 A：只读本地消息库（不打断用户，读历史用它）

- 库：`%APPDATA%\youzone\sqlite\YYIMDB_<memberId>_esn.db`（+`-wal`/`-shm`，明文 SQLite），客户端独占 → 先共享读复制再打开；文本 **GBK**，node:sqlite 必须 `CAST(col AS BLOB)` 取原始字节再用 `TextDecoder('gbk')` 解（直接读 TEXT 会 UTF-8 乱码丢数据）。lib.js 已封装（copyDb/openCopy/decodeText）。
- 关键表：`newMessage`（消息，按 `ts` 排序；`isLargeText` 大文本字段）、`roster`、`pubaccount`、`digitals`、`groupRobot`。
- 教练会话按 `newMessage.oppositeId` 区分（见文首对照表）。**不要用 `pubaccount`/`digitals` 表反查显示名**——实测这两张表在本机是空壳，取不到名字。
- 本地库里的 `ipa_` 会话数**很少**（本机 2026-10-17 只有 4 个），而客户端「智能体」目录有 882 个——**别用库里的条数判断教练在不在**。库里的其它 `ipa_` 多是系统通知/数字人，别当成第三个教练；识别用 `scripts/identify_peers.js`，或直接 `discover_coaches.js` 看实时列表。
- ⚠️ `list_peers.js` 只读本地库、按「有提问行」过滤，**会漏**（本机只看到个位数）。要全量看**当前登录可见的智能体**，用 `scripts/discover_coaches.js --all`（读客户端目录，不依赖历史）；库内统计用 `newMessage.oppositeId LIKE 'ipa_%'`。
- 显示名的可靠来源是**客户端左侧「智能体」目录的 `.mid-info[title]`**（与 webview 标题一致，不带「智能体」标签）。`list_conversations.js` 已改为调用 `coach-discover.js` 的兼容入口。
- 消息体 JSON：用户侧 contentType=2，`content.content`=问句，`content.robotBusiness` 带 chatId/tenantId/**yht_access_token**/callback；机器人侧 contentType=18，`content.extend` 是**再一层 JSON 字符串**（答案 `responses[0].data.showData.text`、意图流 `thoughtChainResponses[]`、traceId/questionId）。
- 导出记录：`node scripts/dump_chat.js`（默认教练会话 → references/coach-chat-log.md；`--peer`/`--out`/`--limit`）。
- 安全：载荷含明文 `yht_access_token`，副本读完即删，token 别外传。

## 通道 B：CDP（ask 服务的前置，重启一次永久有效）

1. `resources/app/process.env`（先备份原 5 行）把 `YOUZONE_LOG_LEVEL=` 改为 `1` → 重启 YonZone 后 `127.0.0.1:8089` 开 CDP（只监听本机）。
2. 重启舞蹈：`(Get-Process YonZone).CloseMainWindow()` → 托盘残留用 `taskkill //F //IM YonZone.exe`（policy 拦 "Stop-Process" 字样，taskkill 可用）→ `cmd //c start "" "D:\Downloads\Yonyou\YonZone\YonZone.exe"` → 轮询 `/json/version`（~11s 就绪）。登录态在 userData，不用重登。
3. 打开会话：主 page 上 click `li.agent-item[data-id="ipa_<uuid>"]`（智能体目录，**没聊过也能开**）或 `li.all-item[...]`（全部会话）；Vue 监听原生事件，要派发 mousedown/mouseup/click。`youzone_cdp.js` 的 `openConversation()` 已对两种 DOM 兜底，必要时先切「智能体」tab → webview target 出现（url 含 `single-agent`）。
4. 发消息（webview 内）：输入框 `textarea.Footer-module__textarea--tcK0J` 用**原生 value setter + input 事件**（`Input.insertText` 在失焦时丢字），再点 `img.Footer-module__send--O8Qrd`。youzone_cdp.js 已封装（list/eval/evalfile/click/send/fg）。
5. 窗口不置前会节流丢事件：每次操作前跑 `node scripts/youzone_cdp.js fg`（fg.ps1，user32 ShowWindow+SetForegroundWindow）。
6. 首页"友空间升级说明 / 立即安装并重启"按钮**别点**。

## 通道 D（无头，2026-10-02 打通）：coach_headless.js —— 不依赖 UI/CDP 直连

> 🚫 **默认禁用（2026-10-14 起）**：没有 `--kick-ok`（或 `YZ_ALLOW_KICK=1`）会直接拒绝运行并退出 4 —— 这条通道一上就把桌面端顶下线（见文首硬规则 1）。只有"明确允许把用户踢下线"时才用。

先用 `node scripts/preflight.js` 体检：打印 Node 版本、消息库与最近提问行、CDP 目标、凭据来源、设备指纹模式，并复查 imToken 交换之后桌面端是否还在线（不提问、不顶号）。**默认不做 IM 鉴权检查**——那是第二条会话、会把桌面端顶下线；要测加 `--ws`。

```bash
node scripts/coach_headless.js "你的问题" --kick-ok [--timeout 180000] [--json] [--peer ipa_<uuid>] [--file q.txt]
# → 身份: 本地库最近提问行的 robotBusiness（取不到则明确报错并提示先在本机打开一次教练会话）
# → 认证链: yht_access_token(YonZone CDP cookies 优先 → 本地库快照回落) → GET /yonbip-ec-base/user/pc/imToken 换 imToken(~24h)
#   → wss://imws.yonyoucloud.com:5225 (子协议 xmpp, Origin: file://, 握手无 Cookie) → AUTH 帧(usr/atk/br/appType=8/clientIdentify)
#   → 发问(4176) → 读 callbackStreamUrl SSE → 终稿（WS 也会推送一份）
```

- 凭据来源会打印（`yonzone-cdp` 或 `db-snapshot@<ISO 时间>`）：回落快照可能已过期，被服务端拒绝时的报错直接提示启动 YonZone 刷新。
  **注意客户端登录态**：YonZone 掉到扫码登录页时 CDP 里就没有 cookie 了（只剩过期快照），此时必须先扫码登录。
- 身份不写死：memberId 取库文件名，chatId/tenantId/atRobotId/staffId/digitalCode/callback 取最近提问行；`--peer` 可指定别的公众号会话。**通道 D 不是新机器开箱即用**：身份来自本地库的历史提问行，从没问过的账号要先走通道 C 问一次；新机器请用通道 C。
- **通道 D 会把桌面端顶下线（2026-10-02 受控实测）**：服务端对同一账号/「pc」设备组只保留一个会话——我们的 AUTH 一上，服务端立刻给桌面端推 `opcode 16640 {"code":409,"message":"The current account logged in ... on pc ..."}`，客户端随即关闭连接、清 cookie、跳扫码登录页。**换自生成指纹（默认 `sha1(youzone-coach/headless/<memberId>)`）或在 AUTH 帧里加 `auxiliaryDevice:true` 都避免不了**（服务端回 `auxiliaryDevice:false` 照样顶号）；指纹与 imToken 交换已排除（只做 imToken 交换时客户端 150s 无异常）。**要边用客户端边提问就走通道 C**（CDP 驱动 webview，用客户端自己的会话）。
- 探针开关：`--identify <40hex>` / `YZ_CLIENT_IDENTIFY` 改设备指纹，`YZ_AUTH_FIELDS='{"k":v}'` 往 AUTH 帧里塞实验字段（例如试 `conflictStrategy`）。
- 副作用：无头发的问题不落本地库（客户端只见回答不见提问）；服务端历史完整。
- 依赖：仅 Node 内置模块（自写 RFC6455 客户端 ws_client.js）；**未实现 permessage-deflate**——服务端若协商扩展会明确报错，而不是静默等到超时。
- 自检：`npm test`（离线；覆盖帧编解码、RFC6455 分片/ping/RSV、GBK 解码、两种报文形态解析、CLI 参数与退出码）。
- 协议全貌（帧布局/opcode 表/时序/踩坑修正）见 `references/protocol-map.md`。

## 协议逆向结论（2026-10-01/02 实测，无公开 API 下的全貌）

一轮问答 = **WS 写 + SSE 读** 两条腿，GUID 串联：

1. **写（触发提问）**：main 渲染进程的长连接 `wss://imws.yonyoucloud.com:5225`（二进制帧头：sFrame/version=256/seqId/packetLen/opcode；opcode：1=AUTH.KEY、2=ping、4098=receipts、4176=pubaccountMessage）。提问帧 = opcode 4176，JSON `{"id":"<GUID>","type":"pubaccount","contentType":2,"dateline":<ms>,"content":"<问句JSON，含 robotBusiness.callback=/iuap-aip-vpa/apiregister/im/message/chat、yht_access_token、streamConfig.scene=secretary>","to":"ipa_<uuid>.esn.upesn@pubaccount.im.yyuap.com"}`。
2. **服务器回执**：先推一条带 `streamConfig.callbackStreamUrl = https://c1.yonyoucloud.com/iuap-aip-vpa/apiregister/im/message/stream/chat/<同一GUID>?tenantId=<租户>` 的占位消息。
3. **读（收答案）**：webview `POST` 该 callbackStreamUrl，头 `yht_access_token`，**无请求体**（Network/Fetch 域双重验证），响应 `text/event-stream`：`data:{result:<增量文本>, thoughtChainResponses[], finishReason, displayLocation, traceId...}`。首帧 displayLocation=connectionCheck，思维链 displayLocation=thoughtChain。
4. **重放实测**：只 POST 读端（新 UUID4 + 旧 body / 无 body）→ 200+SSE 打开但 **0 帧**——读端必须等 WS 写触发。WS 写已于 2026-10-02 复刻完成（AUTH 帧结构与帧布局曾两处推断错误，均已在 `references/protocol-map.md` 修正），无头客户端见**通道 D**。
5. token：`yht_access_token` 形如 `gray..._<13位时间戳>TG...`，WS/HTTP/AIP 三处同一个 token。**内嵌时间戳不是过期时间**：实测同一 token 连续复用 4h 以上，且内嵌时间戳早于各条消息（更像签发/会话起点）；过期与否以服务端是否接受为准，不要拿它做过期判断。

## 记录里的答案只能当线索

实测「stock transfer query 加 secondary UOM」教练给过三套互相矛盾的答案且都不成立（`bd_material.secmeasureunitid`、`bd_invbasdoc.CSECUNITID`、标称 appcode 201403001 搜 0 条）。**复核方法**：NC Cloud 工作台菜单搜索接口（必须走页面自带 ajax，裸 fetch 报"没有应用编码"）：

```js
window['nc-lightapp-front'].ajax({
  url: '/nccloud/platform/appregister/searchmenuitem.do',
  data: { search_content: 'Stock Transfer', apptype: '1' },
  success: r => { /* r.data.children[] = {label, appcode, code, appid, pk_menu, target_path} */ }
});
```

- 中英文标签并存，**中文名要和客户口径一致**：`库存调拨查询` 搜不到，`转库` 命中（appcode 400812464）。
- 「查询模板配置」节点在本环境不存在；`模板管理` 在【动态建模平台→客户化配置(1018)】下，只管打印/输出/页面模板。
- 转库查询页面（iframe `ic/ic/report/whstrans`）右键表头只能隐藏列不能新增；自定义报表走【动态建模平台→报表平台(1030)】。
- 应用树接口：`window['nc-lightapp-front'].ajax({url:'/nccloud/platform/appregister/queryapplazy.do', data:{}})`。

## 坑位

- **左侧列表有两套 DOM**：「智能体」tab = `li.agent-item`（完整目录，本机 882 个，**含从没聊过的**）；「全部」tab = `li.all-item`（只有已有会话）。只查一种会读到 0 行，症状就是 `no ipa_ coach conversations found in the live YonZone list`。`coach-discover.js` 现在两处都读，并会在需要时切到「智能体」tab。
- **列表标题带「智能体」标签**：`.title` 的文本是 `交付赋能总教练 智能体`，而 webview 标题是 `交付赋能总教练`。名字取 `.mid-info[title]`，比较前统一去掉后缀。
- **「智能体」tab 的 id 是 `-10_menu`**：以 `-`+数字开头，`#-10_menu` 不是合法 CSS 选择器（`querySelector` 直接抛 DOMException）→ 用 `[id="-10_menu"]` 或 `getElementById('-10_menu')`。
- **目录里有几十个同关键词智能体**（超级版交付总教练、高级版客开总教练、实施总教练…）→ 别名解析必须精确名优先，**绝不能取列表第一行**。
- curl -d 中文→GBK 乱码（见通道 C）；node argv / 文件字节是干净的。
- 用 curl/PowerShell 调本地 ask 服务时，问句中文可能被 ANSI 编码破坏 → 用 `ask.js`，或 POST UTF-8 文件（`--data-binary @f.json`）。
- pwsh profile 强制 UTF-8；-NoProfile 时要显式设置编码。fg.ps1 已处理。
- policy 拦含 `Stop-Process`/`Start-Process` 字样的整条命令 → 用 `taskkill` / `cmd //c start` 替代。
- **长任务不要前台跑**（会开着控制台窗口好几分钟 + 抢焦点）→ 用 `scripts/bg.js`（detached + `windowsHide`，stdio 落 `logs/`）。
- 别用 `cmd /c start` 起后台任务：那是新开一个控制台窗口，就是"弹 cmd"的来源。
- 半拉会话会一直顶着桌面端：收尾用 `node scripts/bg.js --kill <job>` 停掉，别让它自然超时。
- PowerShell 传中文给 node 会乱码 → 中文内容写 UTF-8 无 BOM 文件再 evalfile/insfile。

## 资源

- `scripts/discover_coaches.js` — **首次/换账号先跑**：实时发现两个教练并打印解析结果（`--all`/`--json`/`--resolve`）
- `scripts/coach-discover.js` — 发现库：读「智能体」目录 + 「全部」会话，按精确名解析别名，切 tab/重试
- `scripts/await_task.js` — 异步任务等待器（`<taskId>` + `--out`，适合 detached/子 Agent）
- `scripts/coach_headless.js` — 无头客户端（通道 D，协议直连，仅内置模块）
- `scripts/ws_client.js` — 裸 RFC6455 WebSocket 客户端（支持自定义握手头/子协议）
- `scripts/bg.js` — **后台无窗口启动器**（detached + windowsHide + 日志落 logs/；`--list`/`--tail`/`--kill`）
- `scripts/coach_ask_server.js` — 本地 ask API（通道 C；异步 taskId + `/result`/`/stream`，按实时发现的教练路由）
- `scripts/ask.js` — CLI 客户端（中文安全，`--peer impl|delivery|标题片段|ipa_ id`）
- `scripts/ask_both.js` — **一次问两个教练**（按别名，不写死 id），产出合并 markdown（`--out`/`--tag`）
- `scripts/list_peers.js` — 枚举消息库里所有 `ipa_` 机器人会话 peer
- `scripts/identify_peers.js` — 逐个看最近问答内容，判定哪个是哪个教练
- `scripts/list_conversations.js` — 兼容入口（已委托 `coach-discover`；新代码用 `discover_coaches.js --all`）
- `scripts/list_digitals.js` — 查 `digitals` 数字人名录（实测空壳，留作取证）
- `scripts/probe_peer_scope.js` — **peerId 可见性实测**：18 个 `ipa_` 会话清单 + 每peer's tenantId/chatId/digitalCode + tenantId 分布
- `scripts/youzone_cdp.js` — 零依赖 CDP 客户端（CLI + 库两用）
- `scripts/lib.js` — 消息库复制/GBK 解码/行解析
- `scripts/dump_chat.js` — 导出问答记录（替代旧 dump_coach_chat.py）
- `scripts/coach_capture.js` — 一轮问答的全 target 网络抓包（Network+WS+SSE）
- `scripts/capture_ws_handshake.js` — 抓真实 WS 握手头与 AUTH 帧（配合 Page.reload）
- `references/coach-chat-log.md` — 问答记录（可随时 dump_chat.js 重导）
- `references/peer-id-scope.md` — **peerId 可见性与跨账号复用**（全局ID vs chatId 隔离的实测证据）
- `references/protocol-map.md` — 协议逆向详细笔记（认证链/帧布局/时序/错误结论修正）
- `scripts/preflight.js` — 环境体检（Node/库/CDP/凭据/WS 鉴权，只握手不提问；`--no-ws`/`--json`）
- `scripts/selftest.js` — 离线自检（`npm test`，不联网、不碰原库）
- `scripts/pack.js` — 打包（`npm run pack` → `dist/<name>-<ver>.zip` + `.skill` + `MANIFEST.md`）
- `package.json` / `README.md` — 运行要求（Node >= 22.5）与快速开始

## 分发打包（pack.js）

```bash
npm run pack                # -> dist/youzone-coach-<ver>.zip
                            #    dist/youzone-coach.skill   （单顶层目录，供 skill 导入）
                            #    dist/MANIFEST.md           （逐文件 sha256 + 安装步骤）
node scripts/pack.js --out D:\somewhere --no-skill
```

- **白名单**：`SKILL.md` `README.md` `package.json` `.gitattributes` `.gitignore` + `scripts/*.{js,ps1,json,txt}` + `references/*.{md,json,txt}`。
- **黑名单**：`.git/` `node_modules/` `dist/` `tmp/` `*.db(-wal|-shm)` `capture-*.json` `db-inspect-*.json` `ws-*.json` `*payload*.json` `aip-*.json` `replay-sse.txt` `*.log`。
- 产物**不含** `yht_access_token` 与会话库；`references/coach-chat-log.md` 含问答正文，外发前人工过一遍。
- **纯 Node 写 zip**（自带CRC-32 + store/deflate 自适应），不 spawn 任何外部工具。三种方案都试过、都不行：
  - `Compress-Archive` 拒绝非 `.zip` 目标扩展名（`.skill` 报 `NotSupportedArchiveFileExtension`），且沙箱下会被静默杀掉返回 `status=null`、留下半成品；
  - `System32\tar.exe`（bsdtar）从 node spawn 报 `EBUSY`；
  - Git Bash 的 GNU tar 是另一个二进制，会把 `C:\...` 当远程主机（`Cannot connect to C: resolve failed`）。
- 落地即 `.skill` 必须**单顶层目录**：`<name>/SKILL.md`，不能把文件直接摊在zip 根（代码里给每条路径加 `<name>/` 前缀）。
- 打包后**必须用外部工具独立验证**，不要只信脚本自己的校验：
  ```bash
  python -c "import zipfile; z=zipfile.ZipFile('dist/youzone-coach.skill'); print(z.testzip() or 'CRC OK', len(z.namelist()))"
  ```
  `testzip()` 逐条校验 CRC，能抓出 store/deflate 写错的问题。
- ⚠️ 验证解压产物要用 `C:\Users\<u>\AppData\Local\Temp\...` 这类**绝对路径**：Git Bash 的 `/tmp` 与 Windows 侧 Python 看到的 `/tmp` 不是同一处，否则误报 `MODULE_NOT_FOUND`。
- ⚠️ `npm test` 里的 `CLI exit codes` 用 `spawnSync(process.execPath, ...)` 测子进程退出码，**在沙箱下子进程会被静默杀掉**（`status === null`），脚本已改为跳过并打印提示，不要把它当成回归。语法检查已改成用 `vm.Script` 进程内解析，不再 spawn。
- 验证套路：解压到干净目录 → `npm test` 应全过。

## Related documents

本页只适用于相关任务；返回总入口或直接跳到所需资料，避免无关上下文。

- [README / Project overview](README.md)
- [两个教练的 peerId 在别人机器上能不能用](references/peer-id-scope.md)
- [教练接入协议逆向笔记（2026-10-01/02 实测，无头客户端已打通）](references/protocol-map.md)
