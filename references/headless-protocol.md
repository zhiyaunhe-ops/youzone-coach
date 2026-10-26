# Exceptional headless channel and protocol

Read only for explicitly requested headless-channel or protocol implementation work. The headless channel is disabled by default because it signs the desktop client out. Preserve the explicit --kick-ok opt-in; normal questions use the desktop-backed service. Commands below are relative to the installed skill root. Allow at least 420 seconds per coach.

## 通道 D（无头，2026-10-02 打通）：coach_headless.js —— 不依赖 UI/CDP 直连

> 🚫 **默认禁用（2026-10-14 起）**：没有 `--kick-ok`（或 `YZ_ALLOW_KICK=1`）会直接拒绝运行并退出 4 —— 这条通道一上就把桌面端顶下线（见文首硬规则 1）。只有"明确允许把用户踢下线"时才用。

先用 `node scripts/preflight.js` 体检：打印 Node 版本、消息库与最近提问行、CDP 目标、凭据来源、设备指纹模式，并复查 imToken 交换之后桌面端是否还在线（不提问、不顶号）。**默认不做 IM 鉴权检查**——那是第二条会话、会把桌面端顶下线；要测加 `--ws`。

```bash
node scripts/coach_headless.js "你的问题" --kick-ok --timeout 420000 [--json] [--peer ipa_<uuid>] [--file q.txt]
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

## Related documents

- [Skill entrypoint](../SKILL.md)
- [Protocol map](protocol-map.md)
- [Desktop and history](desktop-and-history.md)
- [Project overview](../README.md)
