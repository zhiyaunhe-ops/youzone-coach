# youzone-coach

友空间（YonZone Electron 客户端）里**两个** AI 教练的接入工具链。

| peer 别名 | 显示名（运行时按标题发现） | 强项 |
| --- | --- | --- |
| `impl`（默认） | 高级版实施总教练（多智能验证版） | 实施/配置/字段/节点 |
| `delivery` | 交付赋能总教练 | 交付物/培训/知识库检索 |

教练是服务端多智能体，**没有公开 API**，本仓库是实测逆向出来的四条通道 + 问答记录。
两者由不同的智能体图驱动，会答不上来也会互相矛盾 —— **同一个问题请一次问两个**（`ask_both.js`）。

**换机器/换账号不用改代码**：教练 id 由 `coach-discover.js` 从客户端左侧「智能体」目录实时解析（精确名优先）。
目录列的是**所有已授权智能体**，点一行就能开新会话 —— 所以**从没和这两个教练说过话的新机器也能直接用**。

> Start with [SKILL.md](SKILL.md). Read [desktop/history setup](references/desktop-and-history.md) only when needed, [the ask API](references/ask-api.md) for integrations, and [maintenance notes](references/maintenance-and-packaging.md) for changes or packaging. Protocol work uses the separate [headless reference](references/headless-protocol.md).

## 环境要求

- Node.js **>= 22.5**（用到内置 `node:sqlite` 与内置 `fetch`），**零 npm 依赖**。
- 通道 A（读历史）只要本机装过 YonZone 即可；通道 D（无头提问）需要有效的 `yht_access_token`；
  通道 C（ask API）需要 YonZone 在运行且 CDP 已打开。

## 快速开始

Allow at least 420 seconds per coach, plus queue wait. Questions run serially in one shared webview; check the existing task and coach history before retrying after a timeout.

```bash
npm test                                   # 离线自检，不联网、不碰数据库
npm run test:queue                         # 队列集成测试（stub 服务，验证 FIFO/位置/SSE）

# 首次/换账号：确认这台机器解析到哪两个教练（--all / --json / --resolve delivery）
node scripts/discover_coaches.js

# 首选：一次问两个教练（按别名，不写死 id），产出合并markdown
node scripts/bg.js coach_ask_server.js          # 通道 C 前置（后台起、无窗口；只需一次）
node scripts/bg.js ask_both.js "你的问题" --timeout 420000 --out . --tag mytag
node scripts/bg.js --tail ask_both              # 看进度（日志在 logs/）

# 通道 D：无头提问（默认禁用：一 AUTH 就把桌面端顶到扫码登录页 -> 见 SKILL.md 硬规则 1）
# 只有在“明确允许把用户踢下线”时才加 --kick-ok（或设 YZ_ALLOW_KICK=1）
node scripts/coach_headless.js --kick-ok "用一句话说明库存调拨单和转库单的区别" --timeout 420000
node scripts/coach_headless.js "问题" --timeout 420000 --json     # 结构化输出给脚本用
node scripts/coach_headless.js --kick-ok --file question.txt --timeout 420000                # 中文从 UTF-8 文件读，避开命令行编码

npm run preflight                          # 体检：库/CDP/凭据/WS 鉴权（只握手，不提问）

# 通道 A：导出问答记录（--peer 选教练）
node scripts/dump_chat.js --out refs.md --limit 200
node scripts/dump_chat.js --peer delivery --out delivery.md

# 通道 C：本地 ask API（需 YonZone + CDP）
node scripts/bg.js coach_ask_server.js    # 后台起、无窗口
node scripts/ask.js "你好，请用一句话介绍你自己" --timeout 420000
node scripts/ask.js "问题" --peer delivery --timeout 420000

# 不知道某个 ipa_ 是谁？
node scripts/discover_coaches.js --all     # 实时目录：当前登录可见的全部 ipa_ 智能体（推荐）
node scripts/list_peers.js                 # 只读本地库：你聊过的机器人会话
node scripts/identify_peers.js ipa_xxx     # 看它最近答了什么，判定身份
```

## 四条通道

| 通道 | 脚本 | 依赖 | 用途 |
| --- | --- | --- | --- |
| A 只读消息库 | `dump_chat.js` | 无（共享读复制 + GBK 解码） | 读历史问答、不打断用户 |
| B CDP 驱动 | `youzone_cdp.js` | YonZone 开 CDP `127.0.0.1:8089` | 探页面、填框发送、DOM 取证 |
| C 本地 ask API | `coach_ask_server.js` | B | 把教练变成 `POST /ask`（默认异步 taskId，`/result`/`/stream` 取终稿并带排队位置/阶段；`/queue` 看全局；`mode:"sync"` 兼容旧行为） |
| D 无头直连 | `coach_headless.js` | 有效 token | **默认禁用**（需 `--kick-ok`）：会上第二个 IM 会话，把桌面端顶到登录页 |
| 发现教练 | `discover_coaches.js` + `coach-discover.js` | B（客户端在跑） | 从「智能体」目录实时解析 impl/delivery，不写死 id、不要求聊过 |
| 后台启动 | `bg.js` | — | detached + `windowsHide` 跑任何脚本、零窗口；日志落 `logs/`（`--list`/`--tail`/`--kill`） |
| 双问 | `ask_both.js` | C | 按别名问两个教练，落合并 markdown |
| 体检 | `preflight.js` | — | 逐项检查前置条件并说明当前哪条通道可用 |

## 凭据来源（通道 D）

1. **YonZone 在运行**：CDP `Network.getAllCookies` 取 `.yonyoucloud.com` 的 `yht_access_token`（最新）。
   无头会话默认使用**自生成设备指纹**（`--identify <40hex>` 可覆盖）。注意：**服务端同账号同一 pc 设备组只保留一个会话**，所以通道 D（从 2026-10-14 起默认禁用，需 `--kick-ok`）一 AUTH 就会把桌面客户端顶到登录页（服务端推 `16640/409`）；要边用客户端边提问请走通道 C（`coach_ask_server.js`）。只做 imToken 交换不影响客户端。
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

白名单收 `SKILL.md` / `README.md` / `package.json` / `LICENSE` 与 `scripts/`、`references/`，
黑名单排掉 `*.db` / `*payload*.json` / `ws-*.json` / `.git/` / `node_modules/`，
产物**不含** `yht_access_token`与会话库。`references/coach-chat-log.md` 含问答正文，外发前人工过一遍。

zip 由脚本**纯 Node 写出**（自带 CRC-32），不 spawn 外部工具 —— `Compress-Archive` / `bsdtar` / GNU `tar`
在本机分别因扩展名限制、`EBUSY`、路径误判全部不可用。打包后建议独立校验：

```bash
python -c "import zipfile; z=zipfile.ZipFile('dist/youzone-coach.skill'); print(z.testzip() or 'CRC OK', len(z.namelist()))"
```

改过任何 Markdown 后跑 `npm run docs:check`（CI 同款检查；本地会按 `.gitignore` 跳过 `dist/`、`logs/` 等生成物）。

## 教练怎么发现（换账号 / 换机器）

教练 id 是**用友全局智能体注册 ID**，但不同租户/账号可见的列表不一定一样，所以仓库不把 id 写死：

```bash
node scripts/discover_coaches.js              # 解析 impl/delivery 并打印 id
node scripts/discover_coaches.js --all        # 当前登录可见的全部 ipa_ 智能体
node scripts/discover_coaches.js --json       # 机器可读
node scripts/discover_coaches.js --resolve "某个标题片段"
```

解析规则：**精确名优先**（`高级版实施总教练（多智能验证版）` / `交付赋能总教练`），其次关键词；
目录里「超级版交付总教练」「高级版客开总教练」「实施总教练」等几十个近名智能体不会被误选。
名字真的不同就设 `COACH_IMPL_TITLE` / `COACH_DELIVERY_TITLE`（或 `_ID`）；服务端默认教练用 `COACH_PEER`。

为什么新机器也能用：客户端「智能体」tab 是**完整目录**（本机 882 个），不是「聊过的会话」；
点击目录行即开始新会话，所以**从没和教练说过话**也可以直接问。旧的 `li.all-item` 只有历史会话，现在只作兜底。
隔离仍发生在 `chatId` + `yht_access_token`（peerId 只是全局注册 id），**把本 skill 装给别人是安全的**。
实测证据见 `references/peer-id-scope.md`。

## 安全

- 消息库载荷含**明文 `yht_access_token`**；脚本只对副本操作、读完即删，token 不要外传。
- `references/*payload*.json`、`ws-*.json`、`*.db` 等抓包与库文件已在 `.gitignore` 中排除。

## 已知限制

- **发现依赖运行中的客户端**：`discover_coaches.js` / 通道 C 需要 YonZone 已登录且 CDP 已开；租户没授权这两个教练时列表里就没有它们，会明确报 `no coach matching ...`。
- 无头发出的提问**不落本地消息库**（客户端只显示回答），服务端历史是完整的。
- 客户端掉到扫码登录页时 CDP 里没有 cookie、库里的 token 也已过期，必须先扫码登录（`preflight.js` 会明确指出）。
- ask 服务是**串行**的（单个 webview，必须如此）：多个调用方/子 Agent 并发提交按 FIFO 排队。排队信息：`/result`、`/stream` 的 `phase`（queued/running）、`position`、`ahead`、`queueLength`、`active`、`progress.step`；`/queue` 看全局，`node scripts/queue.js` 直接打印。`queuedMs` 含运行时间，`runningMs` 才是真正生成耗时；`timeoutMs` 从出队开始计时。
- 教练同一问题多轮答案可能不一致，取到的节点/字段/公式必须回环境复核。
- 未实现 `permessage-deflate`：若服务端协商该扩展，客户端会**明确报错**而不是静默卡死。

## 许可证

本项目采用 [Apache License 2.0](LICENSE) 开源。

```
Copyright 2026 Zhiyuanhe

Licensed under the Apache License, Version 2.0 (the "License");
you may not use this file except in compliance with the License.
You may obtain a copy of the License at

    http://www.apache.org/licenses/LICENSE-2.0

Unless required by applicable law or agreed to in writing, software
distributed under the License is distributed on an "AS IS" BASIS,
WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
See the License for the specific language governing permissions and
limitations under the License.
```

## Related documents

Agent 按任务从下列入口跳转，不要逐篇加载文档；协议和历史记录只在需要时打开。

- [友空间两个 AI 教练的接入与问答记录](SKILL.md)
- [两个教练的 peerId 在别人机器上能不能用](references/peer-id-scope.md)
- [教练接入协议逆向笔记（2026-10-01/02 实测，无头客户端已打通）](references/protocol-map.md)
- [历史问答记录（按需读取）](references/coach-chat-log.md)

## Skill authoring

See the [skill authoring policy](docs/skill-authoring.md) for progressive disclosure, discovery metadata and the CI guardrails.
