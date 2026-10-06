# youzone-coach

友空间（YonZone Electron 客户端）里**两个** AI 教练的接入工具链。

| peer 别名 | 显示名 | 强项 |
| --- | --- | --- |
| `impl`（默认） | 高级版实施总教练（多智能验证版） | 实施/配置/字段/节点 |
| `delivery` | 交付赋能总教练 | 交付物/培训/知识库检索 |

教练是服务端多智能体，**没有公开 API**，本仓库是实测逆向出来的四条通道 + 问答记录。
两者由不同的智能体图驱动，会答不上来也会互相矛盾 —— **同一个问题请一次问两个**（`ask_both.js`）。

> 面向 AI agent 的完整操作说明在 `SKILL.md`，协议细节在 `references/protocol-map.md`。

## 环境要求

- Node.js **>= 22.5**（用到内置 `node:sqlite` 与内置 `fetch`），**零 npm 依赖**。
- 通道 A（读历史）只要本机装过 YonZone 即可；通道 D（无头提问）需要有效的 `yht_access_token`；
  通道 C（ask API）需要 YonZone 在运行且 CDP 已打开。

## 快速开始

```bash
npm test                                   # 离线自检，不联网、不碰数据库

# 首选：一次问两个教练，产出合并markdown
node scripts/coach_ask_server.js &        # 通道 C 前置
node scripts/ask_both.js "你的问题" --timeout 240000 --out . --tag mytag

# 通道 D：无头提问（不依赖 UI）
node scripts/coach_headless.js "用一句话说明库存调拨单和转库单的区别"
node scripts/coach_headless.js "问题" --timeout 180000 --json     # 结构化输出给脚本用
node scripts/coach_headless.js --file question.txt                # 中文从 UTF-8 文件读，避开命令行编码

npm run preflight                          # 体检：库/CDP/凭据/WS 鉴权（只握手，不提问）

# 通道 A：导出问答记录（--peer 选教练）
node scripts/dump_chat.js --out refs.md --limit 200
node scripts/dump_chat.js --peer delivery --out delivery.md

# 通道 C：本地 ask API（需 YonZone + CDP）
node scripts/coach_ask_server.js
node scripts/ask.js "你好，请用一句话介绍你自己"
node scripts/ask.js "问题" --peer delivery

# 不知道某个 ipa_ 是谁？
node scripts/list_peers.js                 # 枚举库里所有机器人会话
node scripts/identify_peers.js ipa_xxx     # 看它最近答了什么，判定身份
node scripts/list_conversations.js         # 读 webview 会话列表拿真实显示名
```

## 四条通道

| 通道 | 脚本 | 依赖 | 用途 |
| --- | --- | --- | --- |
| A 只读消息库 | `dump_chat.js` | 无（共享读复制 + GBK 解码） | 读历史问答、不打断用户 |
| B CDP 驱动 | `youzone_cdp.js` | YonZone 开 CDP `127.0.0.1:8089` | 探页面、填框发送、DOM 取证 |
| C 本地 ask API | `coach_ask_server.js` | B | 把教练变成 `POST /ask {q,peer}` 的同步接口 |
| D 无头直连 | `coach_headless.js` | 有效 token | 不上 UI，IM WebSocket 写 + SSE 读 |
| 双问 | `ask_both.js` | C | 同一问题问两个教练，落合并 markdown |
| 体检 | `preflight.js` | — | 逐项检查前置条件并说明当前哪条通道可用 |

## 凭据来源（通道 D）

1. **YonZone 在运行**：CDP `Network.getAllCookies` 取 `.yonyoucloud.com` 的 `yht_access_token`（最新）。
   无头会话默认使用**自生成设备指纹**（`--identify <40hex>` 可覆盖）。注意：**服务端同账号同一 pc 设备组只保留一个会话**，所以通道 D 一 AUTH 就会把桌面客户端顶到登录页（服务端推 `16640/409`）；要边用客户端边提问请走通道 C（`coach_ask_server.js`）。只做 imToken 交换不影响客户端。
2. **YonZone 没跑**：回落到本地消息库里最近一条提问行的 `robotBusiness.yht_access_token` 快照——
   **可能已过期**，脚本会打印来源与时间；被服务端拒绝时直接报错并提示启动 YonZone。
3. `imToken` 每次现换（`GET /yonbip-ec-base/user/pc/imToken`，约 24h）。

身份（memberId / chatId / tenantId / atRobotId / staffId / digitalCode / callback）优先取本地库里的
提问行，取不到则明确报错并提示先在本机打开一次教练会话，所以换机器/重装客户端不会被写死的值卡住。

## 打包分发

```bash
npm run pack                # -> dist/youzone-coach-<ver>.zip
                            #    dist/youzone-coach.skill   （单顶层目录，供 skill 导入）
                            #    dist/MANIFEST.md           （逐文件 sha256 + 安装步骤）
node scripts/pack.js --out D:\somewhere --no-skill
```

白名单收`SKILL.md`/`README.md`/`package.json` 与 `scripts/`、`references/`，
黑名单排掉 `*.db` / `*payload*.json` / `ws-*.json` / `.git/` / `node_modules/`，
产物**不含** `yht_access_token`与会话库。`references/coach-chat-log.md` 含问答正文，外发前人工过一遍。

zip 由脚本**纯 Node 写出**（自带 CRC-32），不 spawn 外部工具 —— `Compress-Archive` / `bsdtar` / GNU `tar`
在本机分别因扩展名限制、`EBUSY`、路径误判全部不可用。打包后建议独立校验：

```bash
python -c "import zipfile; z=zipfile.ZipFile('dist/youzone-coach.skill'); print(z.testzip() or 'CRC OK', len(z.namelist()))"
```

## peerId 换账号怎么办

`lib.js` 里两个 `ipa_` 是**用友全局智能体注册 ID**，别人写同样的值能连到同一个智能体；隔离发生在下一层的 `chatId` + `yht_access_token`，所以**把本skill 装给别人是安全的**。

对方需要自己发现 ID：

```bash
node scripts/list_peers.js# 枚举他本地库里的 ipa_ 会话
node scripts/probe_peer_scope.js         # 每peer's tenantId/chatId/digitalCode + 是否同租户
```

然后改 `scripts/lib.js` 顶部的 `PEER_COACH` / `PEER_COACH_DELIVERY`。实测证据见 `references/peer-id-scope.md`。

## 安全

- 消息库载荷含**明文 `yht_access_token`**；脚本只对副本操作、读完即删，token 不要外传。
- `references/*payload*.json`、`ws-*.json`、`*.db` 等抓包与库文件已在 `.gitignore` 中排除。

## 已知限制

- 无头发出的提问**不落本地消息库**（客户端只显示回答），服务端历史是完整的。
- 客户端掉到扫码登录页时 CDP 里没有 cookie、库里的 token 也已过期，必须先扫码登录（`preflight.js` 会明确指出）。
- 教练同一问题多轮答案可能不一致，取到的节点/字段/公式必须回环境复核。
- 未实现 `permessage-deflate`：若服务端协商该扩展，客户端会**明确报错**而不是静默卡死。
