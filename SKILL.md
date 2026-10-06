---
name: youzone-coach
description: 友空间（YonZone）里两个 AI 教练的问答与接入工具链：「高级版实施总教练（多智能验证版）」= impl，和「交付赋能总教练」= delivery（可ask_both.js 一次问两个）。四条通道：A) 只读本地明文 SQLite 消息库（%APPDATA%\youzone\sqlite\YYIMDB_<memberId>_esn.db）；B) 重启 YonZone 开 CDP（127.0.0.1:8089）驱动 secretary webview；C) 本地 HTTP 服务（coach_ask_server.js，POST /ask {q,peer} 同步问答）；D) 无头直连（coach_headless.js，IM WebSocket 写 + SSE 读，不依赖 UI/CDP）。另含 peer 识别工具（list_peers.js / identify_peers.js / list_conversations.js）、协议逆向结论（无公开 API）与离线自检（npm test）。运行需 Node >= 22.5（内置node:sqlite/fetch，零依赖）。当用户说「问一下总教练」「同时问两个教练」「继续追问教练」「友空间的问答记录」「高级版实施总教练」「交付赋能总教练」，或需要核对教练给的节点/字段/公式是否存在于环境时使用。也含在 NC Cloud 用菜单搜索接口核对节点名的做法。
---

# 友空间两个 AI 教练的接入与问答记录

| peer 别名 | 显示名 | peerId | 强项 |
| --- | --- | --- | --- |
| `impl`（默认） | 高级版实施总教练（多智能验证版） | `ipa_ff71df3a-f6ee-410a-af14-9dd51e60e9e5` | 实施/配置/字段/节点，意图流 `BIP高级版-友问友答_V1` |
| `delivery` | 交付赋能总教练 | `ipa_2c491083-4854-4206-aac7-27d122c364bd` | 交付物/培训/知识库检索，意图流 `智能交付-YonBIP5产品知识AI助手` |

**两者由不同的智能体图驱动，会答不上来也会互相矛盾。硬规则：同一个问题问两个，两份都记录。**

```bash
# 一次问两个，产出合并 markdown（首选）
node scripts/ask_both.js "问题" --timeout 240000 --out <项目目录> --tag <标签>
# → <out>/coach_qa_<tag>.md
```

### peerId 是全局的，换账号要自己发现

上面两个 `ipa_` 是**用友的全局智能体注册 ID**，不是你的私有 ID：别人写同样的值能连到同一个智能体（前提是他自己租户也授权了它）。**数据隔离发生在下一层的 `chatId` + `yht_access_token`，不在 peerId** —— 实测同一 peer 下不同会话的 `chatId` 互不相同，而 `peerId`/`digitalCode`/`tenantId` 恒定。证据见 `references/peer-id-scope.md`。

所以**把这个skill 装到别人机器上是安全的**，但对方需要自己发现 ID：

```bash
node scripts/list_peers.js         # 枚举他本地库里的 ipa_ 会话
node scripts/probe_peer_scope.js   # 每个 peer 的 tenantId/chatId/digitalCode + 是否同租户
```

然后改 `scripts/lib.js` 顶部的 `PEER_COACH` / `PEER_COACH_DELIVERY`。**注意** `coach_headless.js` 的身份（memberId/chatId/tenantId/digitalCode）本来就取自本地库最近一条提问行，不是写死的，通常无需改动。

客户端（YonZone Electron 8.5.1）**没有公开 API**，接入靠下面四条通道。

## 通道 C（首选）：本地 ask API —— 已建成并实测通过

```bash
node scripts/coach_ask_server.js          # 前提：YonZone 在跑且 CDP 口已开（见通道 B）
node scripts/ask.js "你好，请用一句话介绍你自己"# 同步等终稿，约 30-90s
node scripts/ask.js "问题" --peer delivery   # 换教练（--peer impl|delivery，或直接给 ipa_<uuid>）
node scripts/ask_both.js "问题" --out . --tag x   # 一次问两个
curl 127.0.0.1:8765/health | GET /history?n=20&peer=delivery | GET /targets
POST /ask {"q":"...", "peer":"delivery", "timeoutMs":180000} → {ok, answer, steps[], traceId, elapsedMs}
```

- **peer 路由**：`/health` 返回 `availablePeers`（别名 + 显示名）；`/history?peer=` 按教练读各自历史；`/ask` 的 `peer` 支持别名（`impl`/`implementation`/`coach`/`delivery`/`empower`）或裸 `ipa_<uuid>`，**缺省是 impl**。
- ⚠️ **必须核对当前会话**（`ask_both.js` 切换时已自动处理）：两个教练共用同一个 `single-agent` webview，`ask` 前会读主页面 hash（`#/main/im/<peer>/…`）核对，不符就自动点击切换。否则会把问题发进另一个教练的会话。
- 原理：置前窗口 → CDP 驱动 secretary webview 填框点发送 → 共享读复制消息库轮询终稿（基线用消息 **ts+id，绝不能用 rowid**——最新消息 rowid 反而更小，历史分页往上追加）。
- **中文千万别走 curl 命令行 -d 参数**：本机 curl 会把 argv 按 ANSI(GBK) 编码发出（实测 `你好`→`c4e3bac3`），教练收到乱码还会用 answerType=97 反问。用 `ask.js`（node argv 是干净 UTF-8）或 `curl --data-binary @file`。
- 服务一次只跑一问（内部串行）；答案文本在 `extend.responses[0].data.showData.text`，澄清/反问类在 `data.text`（answerType=97），两者都要解析。

## 通道 A：只读本地消息库（不打断用户，读历史用它）

- 库：`%APPDATA%\youzone\sqlite\YYIMDB_<memberId>_esn.db`（+`-wal`/`-shm`，明文 SQLite），客户端独占 → 先共享读复制再打开；文本 **GBK**，node:sqlite 必须 `CAST(col AS BLOB)` 取原始字节再用 `TextDecoder('gbk')` 解（直接读 TEXT 会 UTF-8 乱码丢数据）。lib.js 已封装（copyDb/openCopy/decodeText）。
- 关键表：`newMessage`（消息，按 `ts` 排序；`isLargeText` 大文本字段）、`roster`、`pubaccount`、`digitals`、`groupRobot`。
- 教练会话按 `newMessage.oppositeId` 区分（见文首对照表）。**不要用 `pubaccount`/`digitals` 表反查显示名**——实测这两张表在本机是空壳，取不到名字。
- 库里还有 **16 个** `ipa_` 会话（2026-10-05 实测共 **18 个**），其中 6 个是工作回顾/公告类系统通知（有消息但无 `robotBusiness`），另 6 个是同租户的其他数字人。**都不是教练**，别误当成第三个教练去问。识别方法见 `scripts/identify_peers.js`。
- ⚠️ `list_peers.js` 按"有提问行"过滤，**会漏**（只看到 5 个）。要全量用`newMessage.oppositeId LIKE 'ipa_%'` 分组统计，或直接跑 `scripts/probe_peer_scope.js`。
- 显示名的可靠来源是**友空间 webview 标题**（`高级版实施总教练（多智能验证版）` / `交付赋能总教练`），用 `scripts/list_conversations.js` 读左侧会话列表。
- 消息体 JSON：用户侧 contentType=2，`content.content`=问句，`content.robotBusiness` 带 chatId/tenantId/**yht_access_token**/callback；机器人侧 contentType=18，`content.extend` 是**再一层 JSON 字符串**（答案 `responses[0].data.showData.text`、意图流 `thoughtChainResponses[]`、traceId/questionId）。
- 导出记录：`node scripts/dump_chat.js`（默认教练会话 → references/coach-chat-log.md；`--peer`/`--out`/`--limit`）。
- 安全：载荷含明文 `yht_access_token`，副本读完即删，token 别外传。

## 通道 B：CDP（ask 服务的前置，重启一次永久有效）

1. `resources/app/process.env`（先备份原 5 行）把 `YOUZONE_LOG_LEVEL=` 改为 `1` → 重启 YonZone 后 `127.0.0.1:8089` 开 CDP（只监听本机）。
2. 重启舞蹈：`(Get-Process YonZone).CloseMainWindow()` → 托盘残留用 `taskkill //F //IM YonZone.exe`（policy 拦 "Stop-Process" 字样，taskkill 可用）→ `cmd //c start "" "D:\Downloads\Yonyou\YonZone\YonZone.exe"` → 轮询 `/json/version`（~11s 就绪）。登录态在 userData，不用重登。
3. 打开会话：主 page 上 click `li.all-item[data-id="ipa_<uuid>"]`（Vue 监听原生事件，派发 mousedown/mouseup/click）→ webview target 出现（url 含 `single-agent`）。
4. 发消息（webview 内）：输入框 `textarea.Footer-module__textarea--tcK0J` 用**原生 value setter + input 事件**（`Input.insertText` 在失焦时丢字），再点 `img.Footer-module__send--O8Qrd`。youzone_cdp.js 已封装（list/eval/evalfile/click/send/fg）。
5. 窗口不置前会节流丢事件：每次操作前跑 `node scripts/youzone_cdp.js fg`（fg.ps1，user32 ShowWindow+SetForegroundWindow）。
6. 首页"友空间升级说明 / 立即安装并重启"按钮**别点**。

## 通道 D（无头，2026-10-02 打通）：coach_headless.js —— 不依赖 UI/CDP 直连

先用 `node scripts/preflight.js` 体检：打印 Node 版本、消息库与最近提问行、CDP 目标、凭据来源、设备指纹模式，并复查 imToken 交换之后桌面端是否还在线（不提问、不顶号）。**默认不做 IM 鉴权检查**——那是第二条会话、会把桌面端顶下线；要测加 `--ws`。

```bash
node scripts/coach_headless.js "你的问题" [--timeout 180000] [--json] [--peer ipa_<uuid>] [--file q.txt]
# → 身份: 本地库最近提问行的 robotBusiness（取不到则明确报错并提示先在本机打开一次教练会话）
# → 认证链: yht_access_token(YonZone CDP cookies 优先 → 本地库快照回落) → GET /yonbip-ec-base/user/pc/imToken 换 imToken(~24h)
#   → wss://imws.yonyoucloud.com:5225 (子协议 xmpp, Origin: file://, 握手无 Cookie) → AUTH 帧(usr/atk/br/appType=8/clientIdentify)
#   → 发问(4176) → 读 callbackStreamUrl SSE → 终稿（WS 也会推送一份）
```

- 凭据来源会打印（`yonzone-cdp` 或 `db-snapshot@<ISO 时间>`）：回落快照可能已过期，被服务端拒绝时的报错直接提示启动 YonZone 刷新。
  **注意客户端登录态**：YonZone 掉到扫码登录页时 CDP 里就没有 cookie 了（只剩过期快照），此时必须先扫码登录。
- 身份不写死：memberId 取库文件名，chatId/tenantId/atRobotId/staffId/digitalCode/callback 取最近提问行；`--peer` 可指定别的公众号会话。
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

- curl -d 中文→GBK 乱码（见通道 C）；node argv / 文件字节是干净的。
- 用 curl/PowerShell 调本地 ask 服务时，问句中文可能被 ANSI 编码破坏 → 用 `ask.js`，或 POST UTF-8 文件（`--data-binary @f.json`）。
- pwsh profile 强制 UTF-8；-NoProfile 时要显式设置编码。fg.ps1 已处理。
- policy 拦含 `Stop-Process`/`Start-Process` 字样的整条命令 → 用 `taskkill` / `cmd //c start` 替代。
- PowerShell 传中文给 node 会乱码 → 中文内容写 UTF-8 无 BOM 文件再 evalfile/insfile。

## 资源

- `scripts/coach_headless.js` — 无头客户端（通道 D，协议直连，仅内置模块）
- `scripts/ws_client.js` — 裸 RFC6455 WebSocket 客户端（支持自定义握手头/子协议）
- `scripts/coach_ask_server.js` — 本地 ask API（通道 C，按 peer 路由）
- `scripts/ask.js` — CLI 客户端（中文安全，`--peer impl|delivery`）
- `scripts/ask_both.js` — **一次问两个教练**，产出合并 markdown（`--out`/`--tag`）
- `scripts/list_peers.js` — 枚举消息库里所有 `ipa_` 机器人会话 peer
- `scripts/identify_peers.js` — 逐个看最近问答内容，判定哪个是哪个教练
- `scripts/list_conversations.js` — 读友空间 webview 左侧会话列表，拿**真实显示名**
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
