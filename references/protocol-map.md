# 教练接入协议逆向笔记（2026-10-01/02 实测，无头客户端已打通）

目标：YonZone 8.5.1 客户端里的「高级版实施总教练（多智能验证版）」，无公开 API。
结论：**协议已完整复刻，`scripts/coach_headless.js` 可脱离 UI 直连**（实测 32s 出答案）。

## 认证链（两级 token）

```
yht_access_token （会话根凭证，~7天有效）
  ├─ 来源A：YonZone 运行中 → CDP :8089 Network.getAllCookies → .yonyoucloud.com 的 yht_access_token
  ├─ 来源B：消息库问题行 content.robotBusiness.yht_access_token（落库快照，**可能已过期**）
  │    coach_headless 取用时打印来源；被服务端拒绝时报错并提示启动 YonZone 刷新
  └─ 换票：GET https://c2.yonyoucloud.com/yonbip-ec-base/user/pc/imToken
            ?accessToken=<yht>   头：yht_access_token: <yht>
   → {"code":200,"data":{"token":"<uuid>","expiration":<epoch_ms>}}   （~24h，幂等）
```
注意：只放 query 不带头 → 401 101000000001；imToken 才是 WS 的 atk。

## WebSocket 层

- 地址 `wss://imws.yonyoucloud.com:5225`，子协议 `Sec-WebSocket-Protocol: xmpp`，**握手无 Cookie**。
- 握手头（复刻自 CDP 抓包）：`Origin: file://` + YonZone UA + `Sec-WebSocket-Extensions: permessage-deflate; client_max_window_bits`。
- 应用帧 = 13 字节头 + payload（PACKET_STRUCT，大端）：
  `[0]sFrame(0) [1..3)opcode u16 [3..7)packetLen u32（字节数） [7..9)version=0x0100 [9..13)seqId u32`
- opcode 表（im-libs OPCODE_MAP）：1=auth（收发同码：客户端 AUTH.SEND / 服务端 AUTH.KEY）、2=ping、4=streamend、
  4098=receipts、4112=userMessage、4117=inputState、4176=pubaccountMessage、12289=presence。
  另观测到 recv 12816（presence 回执）、4434（多端在线列表）。

## 一轮问答时序（已实测复刻）

```
1. 连接后客户端即发 AUTH 帧（opcode 1）:
   {"usr":"<memberId>.esn.upesn","atk":"<imToken>","br":"pc-v2.8",
    "appType":8,"clientIdentify":"<40位hex设备指纹>"}
   → 服务端回 {"conflictStrategy":-1,"jid":"<usr>@im.yyuap.com/pc-v2.8","code":200,...}
   （usr 是 jid 的 local part，不是裸 memberId；clientIdentify 为安装级设备指纹，复用本机捕获值可用）
2. 发 presence（12289，payload "{}"）
3. 发问（4176 pubaccountMessage）:
   {"id":"<GUID>","type":"pubaccount","contentType":2,"dateline":<ms>,
    "content":"<inner JSON>", "to":"ipa_<uuid>.esn.upesn@pubaccount.im.yyuap.com",
    "oppositeId":"<memberId>","from":"<memberId>","senderId":"<memberId>.esn.upsen"(sic 客户端拼写如此)}
   inner = {"content":"<问句>","robotBusiness":{chatId, atRobotId, digitalCode, tenantId, yhtUserId,
            yht_access_token, callback:".../im/message/chat", deviceType:"pc", chatSource:2004,
            streamConfig:{scene:"secretary"}, staffId, ...}}
4. 服务端回执 receipts（4098）{"id":"<GUID>","state":1,...}
5. 服务端推元数据消息（4176, ct=18, extend 里只有 streamConfig）:
   extend.data.callbackStreamUrl = https://c1.yonyoucloud.com/iuap-aip-vpa/apiregister/im/message/stream/chat/<GUID>?tenantId=<租户>
6. 【必要步骤】POST 该 URL（头 yht_access_token，无 body，响应 text/event-stream）:
   data:{"result":"<增量文本>","thoughtChainResponses":[...],"finishReason":false,...}
   → finishReason:true 结束
   ⚠ 实测：没人读 SSE 时，终稿永远不会生成/推送（ unanswered 那轮在库里永远停在元数据态）
7. 终稿同时经 WS 推回（4176, ct=18, 同 msg id 的 repeated 更新，extend.responses[0].data.showData.text）
   并落库 newMessage。
```

## 无头客户端实测记录（2026-10-02）

- `node scripts/coach_headless.js "用一句话说明库存调拨单和转库单的区别"` → 32s 出答案，
  SSE 与 WS 推送双通道一致，意图流 规划分析→调度子智能体→BIP高级版-友问友答_V1。
- 副作用：无头发出的**问题行（ct=2）不落本地库**（YonZone 不把别处发的自己消息当出站消息落库），
  客户端聊天窗口只见回答不见提问；服务端会话历史里有完整问答。
- 同账号多连接并存无冲突（conflictStrategy:-1，双方都能收到消息）。

## 无头客户端实现修订（2026-10-02）

- **CLI 参数解析 bug**：`coach_headless.js "问题"`（不带 --timeout）时，正则把 `args[0]` 当超时值过滤掉，
  单段问句直接 usage 退出、多段问句静默吞掉第一个词。已修（`parseArgs`，`npm test` 有回归用例）。
- **凭据回落**：原先读 `references/ws-question-content.json`（gitignore 文件，新克隆必然不存在）→ 改为读本地库
  最近提问行的 `robotBusiness.yht_access_token`；同时打印来源（`yonzone-cdp` / `db-snapshot@<ISO>`）。
- **身份来源**：memberId 取 `YYIMDB_<memberId>_esn.db` 文件名，chatId/tenantId/atRobotId/staffId/digitalCode/
  callback/deviceType/chatSource 取最近提问行；不再使用个人身份常量兜底；库里没有提问行时直接提示先在本机打开一次教练会话。
- **报文两种形态**：DB 的 content 列已经是内层消息（`{extend:"<json>"}`），WS 4176 载荷是外层信封
  （`{contentType:18, content:"<内层 json>"}`）；`lib.parseMessage` 两种都吃（原先 headless 与 dump/ask 各写一套）。
- **token 内嵌时间戳的语义**：同一 token 被 6 条消息连续复用（14:58→18:24），内嵌时间戳恒为 14:33:29.649Z，
  即**早于所有使用它的消息** → 它是签发/会话起点，不是过期时间。过期判断只认服务端是否接受。

## 单会话顶号：通道 D 必然让桌面端掉线（2026-10-02 受控实测）

现象：无头提问/体检之后，桌面端掉到 `renderer/index.html#/login`，CDP 里 `yht_access_token` 消失。

受控实验（在桌面端自己的 WS 上被动抓帧，全程只观察不改动）：

1. 基线：150s 什么都不做 → 会话存活；桌面端 WS 每 ~10s 一次 `opcode 2` ping/pong。
2. 只做 `imToken` 交换 → 再观察 150s：**会话存活**（imToken 交换不是原因，「45s 后掉线」是巧合）。
3. 我们的第二条 WS 连接发 AUTH：用抓包里的桌面端 `clientIdentify`、用自生成指纹、或额外带 `auxiliaryDevice:true` —— 都会让服务端立刻给桌面端推
   `opcode 16640 {"code":409,"message":"The current account logged in at 08:00 on pc. ..."}` + `opcode 4434 clients:[{device:"pc",count:0}]` + `opcode 4`，
   桌面端随即 `WS CLOSED`、清 cookie、跳登录页；15s 后复查 cookie 已消失。`AUTH.KEY` 仍回 `code:200`，但 `auxiliaryDevice:false`（我们塞的 true 被忽略）。

结论：**服务端按「账号 + 设备组(pc)」只保留一个会话，第二条 IM 会话 AUTH = 顶号**，客户端侧没有开关能避免（已试：指纹、`auxiliaryDevice`）。
影响与对策：
- 通道 D：适合无人值守/桌面端不需要在线的场景（顶号是代价）。
- 通道 C（`coach_ask_server.js`）：通过 CDP 驱动客户端自己的 webview 提问，用客户端自己的会话，**不顶号**。
- 未验证但值得一试：AUTH 帧里 `conflictStrategy` 取其他值；或先从桌面端 WS 抓一份它自己的 AUTH 帧、复用其 `atk`。
- 另：Electron 分区目录 `%APPDATA%\youzone\Partitions\<partition>\Network\Cookies`（main/browserwindow/navigation/example-tenant 等）；登录态 cookie 常驻内存、不常落盘，所以「文件里没有」不代表当时没有。

## 扩展协商（permessage-deflate）

- 真实渲染进程握手会带 `Sec-WebSocket-Extensions: permessage-deflate; client_max_window_bits`，但实测 IM 服务端未协商该扩展。
- 无头客户端**不再主动声明**该扩展；`ws_client.js` 遇到 101 响应里出现 `Sec-WebSocket-Extensions`、
  或数据帧带 RSV 位时**明确报错**（原先会静默误解析、一直等到超时）。

## 早期错误结论（修正记录）

- ❌ "token 内嵌 13 位时间戳 = 过期时间" → 实测为签发/会话起点（见上），别用它判断过期。

- ❌ "握手靠 Cookie 认证" → 实际握手无 Cookie，认证在 opcode=1 的 AUTH 帧（imToken）。
- ❌ "帧头 [3..4]seqId [5..6]packetLen u16" → 实际 [3..7)packetLen u32、[9..13)seqId u32。
- ❌ "AIP POST 是触发端" → AIP 读端必须等 WS 写；本次 WS 写也已复刻，双腿齐了。
- 抓包素材：`references/ws-handshake-capture.json`（真实握手头+AUTH 帧字节）、
  `references/ws-send-question.json`、`references/capture-2026-10-01T15-02-41-641Z.json`。
  含明文 token，勿外传（已 gitignore）。
