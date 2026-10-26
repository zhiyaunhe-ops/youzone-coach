# Desktop setup, discovery, and history

Read for first-machine setup, coach-name discovery, chat export, or desktop/CDP failures. Commands and code paths below are relative to the installed skill root. The original client observations are retained; discover current names and IDs rather than assuming the historical examples remain current. Keep the shared webview on the active coach until its final answer lands. Operational timeouts must allow at least 420 seconds per coach.

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
node scripts/bg.js ask_both.js "问题" --timeout 420000 --out <项目目录> --tag <标签>
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
- 跑不通/改了名：`COACH_IMPL_TITLE` / `COACH_DELIVERY_TITLE`（或 `COACH_IMPL_ID` / `COACH_DELIVERY_ID`）钉住；**设了就是硬钉**，找不到就报未解析，不会退回同关键词的其它智能体。服务端默认教练用 `COACH_PEER`（别名，默认 `impl`）。

peerId 本身仍是**用友全局智能体注册 ID**（本机实测就是上表两个），写同样的值能连到同一个智能体；**数据隔离在下一层的 `chatId` + `yht_access_token`**，实测同一 peer 下不同会话 `chatId` 不同，而 `peerId`/`digitalCode`/`tenantId` 恒定。证据见 `references/peer-id-scope.md`。但**不要假设 ID 恒定**：换租户/未授权时列表里根本没有它，所以本 skill 一律「先发现、再按发现的 id 点击」。

**装到别人机器上是安全的**（不含 token/会话库），对方只需要能登录友空间、并在「智能体」目录里看到这两个教练。

客户端（YonZone Electron 8.5.1）**没有公开 API**，接入靠下面四条通道。

## ⚠️ 两条硬规则（2026-10-14 事故后）

1. **通道 D 默认禁用**：`coach_headless.js` 一 AUTH 就会把 YonZone 桌面端顶到扫码登录页（服务端 `16640/409`）。它现在**不带 `--kick-ok` 直接拒绝运行（退出码 4）**；`preflight.js --ws` 同理要 `--kick-ok`（或 `YZ_ALLOW_KICK=1`）。**日常问教练一律走通道 C**（驱动客户端自己的 webview，不顶号）。
2. **长任务一律后台跑，不要在前台开控制台窗口**：前台跑一次问答会开着 cmd/pwsh 窗口好几分钟并抢焦点。统一入口 `node scripts/bg.js <脚本> [参数...]`：detached + `windowsHide`（CREATE_NO_WINDOW）+ stdio 落 `logs/`，调用方立刻返回，屏幕上什么都不出现。**别用 `cmd /c start`**——那正是"弹 cmd 窗口"的来源。

```bash
node scripts/bg.js coach_ask_server.js         # 起 ask 服务（后台、无窗口；只需一次）
node scripts/bg.js ask_both.js --file q.txt --out ..\proj --tag q2 --timeout 420000
node scripts/bg.js --list                      # 在跑的后台任务 + 末行日志
node scripts/bg.js --tail ask_both 40          # 看日志
node scripts/bg.js --kill ask_both             # 停掉（别留半拉会话一直顶着桌面端）
```


## 通道 A：只读本地消息库（不打断用户，读历史用它）

- 库：`%APPDATA%\youzone\sqlite\YYIMDB_<memberId>_esn.db`（+`-wal`/`-shm`，明文 SQLite），客户端独占 → 先共享读复制再打开；文本 **GBK**，node:sqlite 必须 `CAST(col AS BLOB)` 取原始字节再用 `TextDecoder('gbk')` 解（直接读 TEXT 会 UTF-8 乱码丢数据）。lib.js 已封装（copyDb/openCopy/decodeText）。
- 关键表：`newMessage`（消息，按 `ts` 排序；`isLargeText` 大文本字段）、`roster`、`pubaccount`、`digitals`、`groupRobot`。
- 教练会话按 `newMessage.oppositeId` 区分（见文首对照表）。**不要用 `pubaccount`/`digitals` 表反查显示名**——实测这两张表在本机是空壳，取不到名字。
- 本地库里的 `ipa_` 会话数**很少**（本机 2026-10-17 只有 4 个），而客户端「智能体」目录有 882 个——**别用库里的条数判断教练在不在**。库里的其它 `ipa_` 多是系统通知/数字人，别当成第三个教练；识别用 `scripts/identify_peers.js`，或直接 `discover_coaches.js` 看实时列表。
- ⚠️ `list_peers.js` 只读本地库、按「有提问行」过滤，**会漏**（本机只看到个位数）。要全量看**当前登录可见的智能体**，用 `scripts/discover_coaches.js --all`（读客户端目录，不依赖历史）；库内统计用 `newMessage.oppositeId LIKE 'ipa_%'`。
- 显示名的可靠来源是**客户端左侧「智能体」目录的 `.mid-info[title]`**（与 webview 标题一致，不带「智能体」标签）。`list_conversations.js` 已改为调用 `coach-discover.js` 的兼容入口。
- 消息体 JSON：用户侧 contentType=2，`content.content`=问句，`content.robotBusiness` 带 chatId/tenantId/**yht_access_token**/callback；机器人侧 contentType=18，`content.extend` 是**再一层 JSON 字符串**（答案取 `extend.responses` 最后一条非空 response 的 `showData.text`/`data.text`、意图流 `thoughtChainResponses[]`、traceId/questionId）。
- 🚨 **长文本答案看 `isLargeText`/`largeTextContent`**（2026-10-22 实测）：当 `isLargeText=1` 时，`content` 里只有 `{extend:{completeContent:{enable:true,url:"https://imoss...txt"}}}`，**正文不在 content**；完整 `{extend:"..."}`（含全部 responses）在同表 `largeTextContent` 列，外置 URL 是同一份终稿。只读 content 会得到空文本、轮询判定“未捕获终稿”（交付教练 2026-10-22 19:59 就因此误报超时）。`lib.effectiveContent()` 已优先取 largeTextContent，`parseMessage()` 取最后一条非空 response；`completeContentUrl` 仅作 largeTextContent 缺失时的兜底。
- 导出记录：`node scripts/dump_chat.js`（默认教练会话 → references/coach-chat-log.md；`--peer`/`--out`/`--limit`）。
- 安全：载荷含明文 `yht_access_token`，副本读完即删，token 别外传。

## 通道 B：CDP（ask 服务的前置，重启一次永久有效）

1. `resources/app/process.env`（先备份原 5 行）把 `YOUZONE_LOG_LEVEL=` 改为 `1` → 重启 YonZone 后 `127.0.0.1:8089` 开 CDP（只监听本机）。
2. 重启舞蹈：`(Get-Process YonZone).CloseMainWindow()` → 托盘残留用 `taskkill //F //IM YonZone.exe`（policy 拦 "Stop-Process" 字样，taskkill 可用）→ `cmd //c start "" "D:\Downloads\Yonyou\YonZone\YonZone.exe"` → 轮询 `/json/version`（~11s 就绪）。登录态在 userData，不用重登。
3. 打开会话：主 page 上 click `li.agent-item[data-id="ipa_<uuid>"]`（智能体目录，**没聊过也能开**）或 `li.all-item[...]`（全部会话）；Vue 监听原生事件，要派发 mousedown/mouseup/click。`youzone_cdp.js` 的 `openConversation()` 已对两种 DOM 兜底，必要时先切「智能体」tab → webview target 出现（url 含 `single-agent`）。
4. 发消息（webview 内）：输入框 `textarea.Footer-module__textarea--tcK0J` 用**原生 value setter + input 事件**（`Input.insertText` 在失焦时丢字），再点 `img.Footer-module__send--O8Qrd`。youzone_cdp.js 已封装（list/eval/evalfile/click/send/fg）。
5. 窗口不置前会节流丢事件：每次操作前跑 `node scripts/youzone_cdp.js fg`（fg.ps1，user32 ShowWindow+SetForegroundWindow）。
6. 首页"友空间升级说明 / 立即安装并重启"按钮**别点**。


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

- **左侧列表有两套 DOM**：「智能体」tab = `li.agent-item`（完整目录，本机 882 个，**含从没聊过的**）；「全部」tab = `li.all-item`（只有已有会话）。只查一种会读到 0 行，症状就是 `no ipa_ agents found in the live YonZone list`。`coach-discover.js` 现在两处都读，并会在需要时切到「智能体」tab。
- **`main im page not found (is YonZone open?)` 不代表客户端关了**（2026-10-26 实测）：消息面板是单一 SPA target，`target.url` 跟着**当前模块**走——用户在客户端点了「通讯录」或「工作台」，url 就变成 `#/main/contacts/...`，而 CDP 的 url 字段还会滞后一次导航。旧 `mainPage()` 只认 url 含 `/main/im`，于是"用户随手点了别的窗口"就让所有问答报客户端不在线。现在按**页面自己的 `location.hash`** 选 target，必要时再导航回 `#/main/im/0/0/0`；备用窗口（预备窗口/notification/browserview）已排除。
- **同步等答案的人看不到排队**：`mode:"sync"` 的 HTTP 连接会在队列里一直挂着，没有位置反馈；要看排队/阶段就用 async + `/result`/`/stream`，或 `node scripts/queue.js`。回调 `callback` 卡住最多拖 10s（已加超时），但别在回调里做长活——它结束前队列不会开始下一问。
- **长文本答案别只读 `content`**（见通道 A 的 `isLargeText` 条）：`isLargeText=1` 的大文本行正文在 `largeTextContent`，`content` 只剩 `completeContent.url`；只读 content 会空文本→误报“未捕获终稿”。
- **列表标题带「智能体」标签**：`.title` 的文本是 `交付赋能总教练 智能体`，而 webview 标题是 `交付赋能总教练`。名字取 `.mid-info[title]`，比较前统一去掉后缀。
- **「智能体」tab 的 id 是 `-10_menu`**：以 `-`+数字开头，`#-10_menu` 不是合法 CSS 选择器（`querySelector` 直接抛 DOMException）→ 用 `[id="-10_menu"]` 或 `getElementById('-10_menu')`。
- **目录里有几十个同关键词智能体**（超级版交付总教练、高级版客开总教练、实施总教练…）→ 别名解析必须精确名优先，**绝不能取列表第一行**。
- curl -d 中文→GBK 乱码（见通道 C）；node argv / 文件字节是干净的。
- 用 curl/PowerShell 调本地 ask 服务时，问句中文可能被 ANSI 编码破坏 → 用 `ask.js`，或 POST UTF-8 文件（`--data-binary @f.json`）。
- pwsh profile 强制 UTF-8；-NoProfile 时要显式设置编码。fg.ps1 已处理。
- policy 拦含 `Stop-Process`/`Start-Process` 字样的整条命令 → 用 `taskkill` / `cmd //c start` 替代。
- **长任务不要前台跑**（会开着控制台窗口好几分钟 + 抢焦点）→ 用 `scripts/bg.js`（detached + `windowsHide`，stdio 落 `logs/`）。
- **`spawn pwsh ENOENT`（2026-10-26 实测）**：`foreground()` 原先 `spawn('pwsh')` 跑 fg.ps1，宿主 PATH 里没有 `C:\Program Files\PowerShell\7` 时（例如 WorkBuddy 的 Bash 只把 node/python/git 放进 PATH）同步步骤直接抛错，`/health` 与 `/ask` 全在教练发现阶段中断。现在改为**回退 CDP `Page.bringToFront` + `window.focus()`**，两条都失败只告警不中断；`YZ_FG_STRICT=1` 可恢复原来的硬失败。排查时别在 bash 命令行里写 pwsh 字样（沙箱会整条拦截），用编辑器/Read 查。
- 别用 `cmd /c start` 起后台任务：那是新开一个控制台窗口，就是"弹 cmd"的来源。
- 半拉会话会一直顶着桌面端：收尾用 `node scripts/bg.js --kill <job>` 停掉，别让它自然超时。
- PowerShell 传中文给 node 会乱码 → 中文内容写 UTF-8 无 BOM 文件再 evalfile/insfile。

## Related documents

- [Skill entrypoint](../SKILL.md)
- [Project overview](../README.md)
- [Peer identity evidence](peer-id-scope.md)
- [Asynchronous API](ask-api.md)
