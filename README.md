# dsh-surfcore-adapter（SurfCore 边缘适配器）

把只读的 SurfCore 子模块接到 Superagent 的编排内核上：QQ 与 B站的事件作为输入进入内核，模型的回信只从本插件发出。
适配器是独立的 DSH 插件，`plugins/surfcore` 目录里没有任何本插件的代码。

## 入站

SurfCore 桥接在收到一条已经过白名单、模式与拉黑检查，并且不是挂起提问的回答、也不是静默模式下群友消息的事件后，
通过本机回环接口
`POST /dsh-surfcore-adapter/internal/ingest`（`x-component-token` 认证，发现文件
`<DSH_HOME>/surfcore-adapter/runtime.json`）把它交给本插件。本插件把它整理成 InputEnvelope
（`sourceId: 'surfcore'`、`layer: 'platform'`、真人消息 `human: true`、`dedupeKey` 取会话与消息 id）再提交给
`POST /orchestrator/api/inputs`。去重由内核的 `KV.input.records(triggerId)` 负责，跨重启也只产生一个 Trigger。

适配器停用或 DSH 未启动时，桥接读不到发现文件，只按 30 秒节流记一条警告后继续运行；事件不再进入 Superagent，
但 SurfCore 自身照常启动。

## 出站

`surfcore` SourceKind 是模型唯一的出口：

- QQ 走 SnowLuma 的 OneBot HTTP 接口（`send_group_msg` / `send_private_msg`），判据与桥接一致（`status === 'ok' && retcode === 0`），
  成功时把返回的 `message_id` 写进 Receipt 的 `external_id`。
- B站私信走 `api.vc.bilibili.com/web_im/v1/web_im/send_msg`，cookie 只读桥接已有的
  `<DSH_HOME>/surfcore/bili/credentials.json`；默认关闭，需在该 Source 的设置里打开 `biliSend`。

出站账本在 `<DSH_HOME>/surfcore-adapter/ledger/`（每条消息一个文件，0o700 目录、0o600 文件，临时文件 + rename 写入）。
一条回信在 POST 之前先记 `attempting`：明确被拒（连不上、鉴权失败、网关判错）时删除记录，可以安全重试；结果不明
（超时、连接中断、响应读不出）时记为 `uncertain`。之后同一条消息再被投递时不会盲目重发——先向会话核对
（`get_group_msg_history` / `get_friend_msg_history` 里找同一条本账号发出的正文）：核对到就按已送达收敛，历史明确
证明没有才重发，核对不了（接口不支持、B站、身份未知）就一直保持未确认，宁可让 Effect 停在待对账也不发出第二条消息。

## 配置

优先级：`surfcore` Source 的设置 > 本插件在 bundle 里的 config > SurfCore 的 `config.json`（`snowluma.httpUrl` /
`snowluma.accessToken`）> 默认 `http://127.0.0.1:3000`。超时、单条字数上限、核对读取条数、账本条数都在该 Source 的
设置里调整（默认值按真实任务量级设定，没有额外隐藏的硬上限）。token 不会写进日志、健康信息或本仓库文件。

入站消息的回复目标来自 InputEnvelope 的 `channel`（`{ source: 'surfcore', thread, address }`，`address` 里放
`platform` / `kind` / `target`），内核只按 `channel.source` 找到本 kind，不解释 `address` 的字段。

## 本波未覆盖

- SurfCore 控制台自身的 QQ 自发回复没有被拦截：若同时开启桥接应答与本插件，同一条提问可能收到两条回复（收口在 E5-S3）。
- B站出站的结果不明时无法远程核对，只能保持未确认。
- 语音、桌宠等其它副作用仍由 SurfCore 自己执行，未进入 Effect/Receipt 链。

## 来源与许可

本仓库原为 `dsh-superagent-template` 工作区中的一个模块，现拆出来独立建仓维护。

- **来源**：本项目原创。适配器代码全部在本仓库；`plugins/surfcore` 目录里没有本模块的任何代码。
- **相关上游**：[Mieksido/surfcore](https://github.com/Mieksido/surfcore) —— 作为只读子模块被接入，
  本仓库不复制其代码。原作者：Derpyu520 and qq-bridge / QSH contributors，许可：MIT。
