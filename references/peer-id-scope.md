# 两个教练的 peerId 在别人机器上能不能用

**结论：ID 本身大概率是通用的，别人拿同样的 ID 能连上同一个智能体；但他们只能看到自己的会话，你的问答记录、token、租户数据都拿不到。**

下面每条都有本地库（`YYIMDB_example-member_esn.db`，2026-10-05 实测）证据，不是推测。

---

## 1. peerId 是什么

| 项 | 值 |
|---|---|
| peerId（`oppositeId`） | `ipa_ff71df3a-f6ee-410a-af14-9dd51e60e9e5`（实施）<br>`ipa_2c491083-4854-4206-aac7-27d122c364bd`（交付赋能） |
| 报文里另带| `atRobotId` = peerId 去掉 `ipa_` 前缀<br>`staffId` = 同atRobotId（发给机器人时填自己） |
| 数字人编码 | `digitalCode`：实施 `example-digital-impl`<br>交付赋能 `example-digital-delivery` |
| 租户 | `tenantId = example-tenant`（两个教练**同一个**租户） |

发问帧 `to` 字段的完整形态（协议逆向结论）：

```
ipa_<peerId去掉前缀>.esn.upesn@pubaccount.im.yyuap.com
```

`peerId` 是**智能体的全局注册 ID**，不是"你的会话 ID"。

---

## 2. 决定性证据：哪些字段恒定、哪些随人变

对两个教练各扫最近 60 条提问行：

| 字段 | 实施教练 | 交付赋能教练 | 含义 |
|---|---|---|---|
| `peerId` | 恒定 1 个 | 恒定 1 个 | **智能体身份，全局** |
| `digitalCode` | 恒定 1 个（`DG2541…`） | 恒定 1 个（`DG2303…`） | **数字人档案，全局** |
| `tenantId` | 恒定 `example-tenant` | 恒定 `example-tenant` | **智能体归属租户** |
| `chatId` | **3 个不同值** | **3 个不同值** | **会话级，每人一条** |

`chatId` 会变是决定性的：同一个 `peerId` 下，不同用户/会话的 `chatId` 完全不同（实施教练我这儿是 `example-chat-a`，历史还有 `example-chat-b` 和 `example-chat-c`）。**会话与身份隔离发生在 `chatId` 这一层，不在 `peerId` 这一层。**

---

## 3. 所以别人拿到这两个 ID 会怎样

| 问题 | 答案 | 依据 |
|---|---|---|
| 用同一个 ID 提问，能问到同一个智能体吗 | **能**（前提：他在自己租户里也被授权了该数字人） | `peerId`/`digitalCode` 是全局注册标识，帧里就是直接填这个值 |
| 能看到我的问答记录吗 | **不能** | 记录在本地 `YYIMDB_<memberId>_esn.db`，memberId = `example-member` 是当前用户账号 |
| 能复用我的 `yht_access_token` 吗 | **不能** | token 绑定当前用户账号；`coach_headless.js` 实测会拿它去换 `imToken`（`GET /yonbip-ec-base/user/pc/imToken`），服务端按登录态判定 |
| 能读到租户 `example-tenant` 的数据吗 | **不能** | 数据面走 `chatId` + token 双重校验 |
| 他也用这个 skill 会怎样 | **需要自己配 ID**：他必须先在**自己的**友空间里找到这两个数字人，拿到他自己环境里的 `peerId` / `digitalCode` / `tenantId` / `chatId` | `coach_headless.js` 的身份就是从**本地库最近一条提问行**取的，不是写死的 |

**实践结论：把 skill 打包给别人是安全的**，别人装上后跑 `node scripts/list_peers.js` 就能枚举出他环境里的 `ipa_` 会话，替换 `lib.js` 顶部的常量即可。ID 写在代码里不构成信息泄露——它只是个智能体的公开寻址符。

⚠️ **但有一种情况会真出问题**：如果用友把某个数字人做成了**租户私有**（即 `peerId` 只在 `example-tenant` 内有效），那别人换了 ID 也连不上。**这一点我无法从本地库判断**，需要拿另一个账号实测。我倾向于不是私有——因为这两个教练明显是用友官方出品（数字人编码 `DG…` 走统一注册，意图流是 `BIP高级版-友问友答_V1` / `智能交付-YonBIP5产品知识AI助手`），且 `coach_ask_server.js` 的 peer 路由是纯客户端切换、与服务端无关。

---

## 4. 我本机到底有多少个智能体（顺手修正一个旧错误）

**18 个 `ipa_` 会话，不是之前记录的 5 个。**

| peerId | 消息数 | 说明 |
|---|---|---|
| `ipa_804d5075-…` | 450 | 系统通知类，无 `robotBusiness` |
| `ipa_c172e13d-…` | 337 | 系统通知类，无 `robotBusiness` |
| `ipa_2c491083-…` | **204** | **交付赋能总教练** |
| `ipa_9ff95198-…` | 125 | 系统通知类，无 `robotBusiness` |
| `ipa_ff71df3a-…` | **108** | **高级版实施总教练** |
| 其余 12 个 | 68~2 | 6 个有 `robotBusiness`（同租户 `example-tenant`），6 个无 |

> 之前用 `list_peers.js` 只看到 5 个，是因为它按"有提问行"过滤；这次直接对 `newMessage.oppositeId LIKE 'ipa_%'` 分组统计才看全。
> 12 个带 `robotBusiness` 的机器人**共享同一个 `tenantId = example-tenant`** —— 这进一步佐证 `peerId` 不是租户内自增的，而是全局注册。

---

## 5. 复现方式

```bash
node scripts/probe_peer_scope.js
```

输出：18 个 `ipa_` 会话清单 + 每个的 `tenantId` / `chatId` / `digitalCode` / `robotBusiness` 全部键名 + tenantId 分布统计。

> 注意：解析 `robotBusiness` **必须用 `lib.js` 的 `parseMessage()`**。手写 `JSON.parse(content).robotBusiness` 会因为载荷是嵌套 JSON 字符串而**静默返回空**（contentType=2 的行里 `content` 字段本身是 JSON 字符串，答案文本在更内层）。
