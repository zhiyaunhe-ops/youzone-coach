# Asynchronous ask API

Read when direct API integration, task IDs, queue status, or late-answer recovery is needed. Commands are relative to the installed skill root. Use timeoutMs >= 420000 for each coach, excluding queue wait; ask serially and do not switch the shared webview during a response. A caller timeout does not prove that a question was unsent: retrieve its result and inspect the coach history before asking again. Preserve ask and answer timestamps in HKT.

## 通道 C（首选）：本地 ask API —— 已建成并实测通过

```bash
node scripts/bg.js coach_ask_server.js    # 前提：YonZone 在跑且 CDP 口已开（见通道 B）；后台无窗口
node scripts/ask.js "你好，请用一句话介绍你自己" --timeout 420000  # CLI 同步等终稿，约 30-90s
node scripts/ask.js "问题" --peer delivery --timeout 420000  # 换教练（别名 | 标题片段 | ipa_<uuid>）
node scripts/ask_both.js "问题" --out . --tag x --timeout 420000  # 一次问两个（按别名，不写死 id）
curl 127.0.0.1:8765/health           # 发现结果/默认教练/CDP/webview
curl 127.0.0.1:8765/discover         # 当前登录可见的全部 ipa_ 智能体 {id,title}
curl "127.0.0.1:8765/history?n=20&peer=delivery"
POST /ask {"q":"...", "peer":"delivery", "timeoutMs":420000}
# 默认异步 → 202 + {taskId}；老行为加 {"mode":"sync"} → {ok, answer, steps[], traceId, elapsedMs}
```

### 🚀 异步模式（派子 Agent / 短超时调用方必看）

教练一轮要 1–3+ 分钟，**同步 `/ask` 会让调用方的连接一直挂着**；派子 Agent 自己常带 ~2 分钟客户端超时，到点就断开、答案丢了却还返回空。现已改成**默认异步**：`POST /ask` 立刻回 `taskId`，真正的答案存在服务端，调用方随时来取——断线、超时、重试都不丢。

```bash
# 1) 提交，立刻拿 taskId（不阻塞）
curl -s -X POST 127.0.0.1:8765/ask -H 'Content-Type: application/json' \
  --data-binary @q.json            # q.json: {"q":"问题","peer":"delivery","timeoutMs":420000}
# → {"ok":true,"async":true,"taskId":"<uuid>","phase":"queued","position":1,"ahead":0,
#     "queueLength":3,"poll":"GET /result?taskId=<uuid>","stream":"GET /stream?taskId=<uuid>",
#     "queue":"GET /queue"}

# 2a) 轮询终态（最简单）：pending 反复查，done/error 取 result
curl 127.0.0.1:8765/result?taskId=<uuid>
# queued:  {"ok":true,"state":"pending","phase":"queued","position":2,"ahead":1,
#            "queueLength":3,"active":{...},"queuedMs":1234,"progress":null}
# running: {"ok":true,"state":"pending","phase":"running","runningMs":42000,
#            "progress":{"step":"streaming","answers":2,"partialChars":1234}}
# done:    {"ok":true,"state":"done","result":{ok,answer,steps,traceId,...}}
# error:   {"ok":false,"state":"error","result":{...}}

# 2b) 流式（SSE）：连上就收到当前态，结束后自动关闭
curl -N 127.0.0.1:8765/stream?taskId=<uuid>
# event: status / event: done，done 带完整 result

# 2c) 队列总览：谁在跑、后面排了谁
curl 127.0.0.1:8765/queue
# {"active":{taskId,peerName,elapsedMs,qPreview,progress},"waiting":[{position,...}],"count":3}
```

- **默认 `mode:"async"`**（返回 202 + taskId）。要回退到老的"阻塞到终稿"行为，显式传 `{"mode":"sync"}`。
- 结果在服务端保留 **1 小时**（`taskId` 可多次取，幂等），所以子 Agent 即使被自己的超时打断、过了几分钟再来查也能拿到。
- 提交时还可带 **`notifyFile`**（把结果 JSON 写到指定文件）或 **`callback`**（POST 结果；默认只允许 localhost，远端需 `COACH_ALLOW_REMOTE_CB=1`）。子 Agent 可以先走人，服务端完成后主动落盘/回调。
- 等待器：`node scripts/await_task.js <taskId> --out result.json`（detached 等待终态，答案打印到 stdout，退出码 0/1；stderr 会打印 `queued #N / running / step`），不占调用方的连接。
- `ask.js` CLI 仍是同步语义（内部用 sync 行为，方便人工直接看答案；若服务端只回 taskId，会轮询并打印排队位置/阶段）；机器对机器、尤其是子 Agent，请用上面异步接口。
- ⚠️ 服务端**串行**一问一答（单个 webview，必须如此）：并发提交按 **FIFO** 排队，**不会并行**。排队信息：`/result`、`/stream` 的 `phase`（`queued`/`running`）、`position`（含正在跑的那个，所以下一顺位是 #2）、`ahead`、`queueLength`、`active`、`progress.step`；**`queuedMs` 是提交至今的总时长（含已运行时间），`runningMs` 才是真正开始后的耗时**。`timeoutMs` 从**出队开始**计时，排队等待不消耗它。`node scripts/queue.js` 一眼看全局。

- **peer 路由**：`/health` 返回 `defaultCoach {id,title}`、`coaches`（可见智能体数）和 `discoverError`；`/discover` 返回当前可见的 `{id,title}` 列表；`/history?peer=` 按教练读各自历史；`/ask` 的 `peer` 支持别名（`impl`/`implementation`/`coach`/`delivery`/`empower`）、标题片段或裸 `ipa_<uuid>`，**缺省是 impl**。所有 token 都先经实时发现解析成这台机器上的真实 id。
- ⚠️ **必须核对当前会话**（`ask_both.js` 切换时已自动处理）：两个教练共用同一个 `single-agent` webview，`ask` 前会读主页面 hash（`#/main/im/<peer>/…`）核对，不符就自动点击切换。否则会把问题发进另一个教练的会话。
- 🚨 **会话校验要双条件**（实测修过的真 bug）：`coach_ask_server.js` 的 `ensureConversation` 曾经**只查主页面 hash**，但两个教练共用一个 `single-agent` webview，切换后 hash 不一定同步更新 → **问题会被静默发进另一个教练的会话**（看不到报错，只是答案怪）。现已改为**双条件**：hash 匹配 **且** webview 标题 == 教练显示名；重试 16 次（i=0/6 各点一次），不符时报 misroute。标题比较前会去掉列表里的「智能体」标签（干净名字在 `.mid-info[title]`）；点会话行兼容 `li.agent-item`（智能体目录）和 `li.all-item`（全部会话）两种 DOM。修改后回归测过 impl/delivery 两个会话（2026-10-17 又用新发现逻辑复测通过）。
- 原理：置前窗口 → CDP 驱动 secretary webview 填框点发送 → 共享读复制消息库轮询终稿（基线用消息 **ts+id，绝不能用 rowid**——最新消息 rowid 反而更小，历史分页往上追加）。
- **中文千万别走 curl 命令行 -d 参数**：本机 curl 会把 argv 按 ANSI(GBK) 编码发出（实测 `你好`→`c4e3bac3`），教练收到乱码还会用 answerType=97 反问。用 `ask.js`（node argv 是干净 UTF-8）或 `curl --data-binary @file`。
- 服务一次只跑一问（**FIFO 队列**，`/queue` 可见位置/阶段）；答案文本取 `extend.responses` 中**最后一条非空 response**（不是 `responses[0]`——外置大文本行会累积 ack→卡片→终稿多条）；普通答案在 `showData.text`，澄清/反问类在 `data.text`（answerType=97），两者都要解析。

## Related documents

- [Skill entrypoint](../SKILL.md)
- [Desktop and history](desktop-and-history.md)
- [Project overview](../README.md)
