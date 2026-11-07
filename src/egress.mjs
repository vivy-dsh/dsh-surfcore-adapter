/**
 * The only path a reply has out to QQ or Bilibili. QQ goes to the SnowLuma OneBot HTTP endpoint the SurfCore bridge
 * itself uses; Bilibili goes to `web_im/send_msg` with the same account cookies the Bilibili tools already keep.
 * Every attempt is written to the ledger before it leaves, so an attempt whose result never came back is reconciled
 * against the remote conversation instead of being sent again.
 */
import { existsSync, readFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { z } from 'zod'
import { createLedger } from './cursor.mjs'

export const SOURCE = 'surfcore'
const QQ_TARGET = /^\d{5,12}$/
const BILI_TARGET = /^\d{1,20}$/
const DEFAULT_HTTP_URL = 'http://127.0.0.1:3000'
const RETRYABLE_CODES = /^(?:ECONNREFUSED|ENOTFOUND|EAI_AGAIN|EHOSTDOWN|EHOSTUNREACH|ENETUNREACH)$/
/** The remote says this conversation can never take the message, so the Receipt settles as dropped instead of retrying. */
const GONE_WORDING = /invalid\s*(?:user|group)|not\s*found|dismissed|withdrawn|deleted|不存在|已退出|黑名单|已解散/i
const BILI_USER_AGENT = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'

export const SurfcoreConfigSchema = z.object({
  httpUrl: z.string().trim().max(300).optional(),
  accessToken: z.string().trim().max(600).optional(),
  botUserId: z.string().trim().regex(QQ_TARGET).optional(),
  requestTimeoutMs: z.number().int().min(1000).max(120000).default(15000),
  maxTextChars: z.number().int().min(200).max(8000).default(4000),
  reconcileCount: z.number().int().min(10).max(200).default(50),
  ledgerMaxEntries: z.number().int().min(1000).max(200000).default(20000),
  biliSend: z.boolean().default(false),
  biliCredentialsFile: z.string().trim().max(500).optional(),
}).strict()

/** Mirrors the bridge's guard so a reply that looks like a CQ code stays plain text. */
export const escapeCqText = text => String(text ?? '').replace(/\[CQ:/gi, '[CQ：')

/** Reads the QQ endpoint and token the bridge keeps, so the adapter does not need a second place to configure them. */
export function readSurfcoreEndpoint(home) {
  try {
    const snowluma = JSON.parse(readFileSync(process.env.SURFCORE_CONFIG_FILE || join(home, 'surfcore', 'config.json'), 'utf8'))?.snowluma
    if (!snowluma || typeof snowluma !== 'object') return {}
    const text = value => (typeof value === 'string' && value.trim() ? value.trim() : undefined)
    return { ...(text(snowluma.httpUrl) ? { httpUrl: text(snowluma.httpUrl) } : {}),
      ...(text(snowluma.accessToken) ? { accessToken: text(snowluma.accessToken) } : {}) }
  } catch { return {} }
}

/** The Channel address a reply is going to; anything the adapter cannot write to is `undefined`. */
export function parseAddress(address = {}) {
  const platform = String(address.platform ?? '')
  const target = String(address.target ?? '').trim()
  const kind = String(address.kind ?? '')
  if (platform === 'qq') return QQ_TARGET.test(target) && (kind === 'group' || kind === 'private') ? { platform, kind, target } : undefined
  if (platform === 'bili') return BILI_TARGET.test(target) && kind === 'dm' ? { platform, kind, target } : undefined
  return undefined
}

/** `definite` proves the message did not leave; `gone` proves the conversation can never take it. Neither means unknown. */
class EgressError extends Error {
  constructor(message, { definite = false, gone = false } = {}) { super(message); this.definite = definite; this.gone = gone }
}

export function createSurfcoreEgress({ home, dir, pluginConfig = {}, instanceConfig = () => undefined,
  logger = console, fetchImpl = fetch }) {
  let context
  const trim = value => (typeof value === 'string' && value.trim() ? value.trim() : undefined)

  function settings() {
    const parsed = SurfcoreConfigSchema.safeParse(instanceConfig() ?? {})
    const source = parsed.success ? parsed.data : SurfcoreConfigSchema.parse({})
    const endpoint = readSurfcoreEndpoint(home)
    return {
      ...source,
      httpUrl: trim(source.httpUrl) ?? trim(pluginConfig.httpUrl) ?? trim(endpoint.httpUrl) ?? DEFAULT_HTTP_URL,
      accessToken: trim(source.accessToken) ?? trim(pluginConfig.accessToken) ?? trim(endpoint.accessToken) ?? '',
      biliCredentialsFile: trim(source.biliCredentialsFile) ?? trim(pluginConfig.biliCredentialsFile)
        ?? join(home, 'surfcore', 'bili', 'credentials.json'),
    }
  }
  const ledger = createLedger({ dir, maxEntries: settings().ledgerMaxEntries, logger })
  let selfId = ''

  function report(state, detail) {
    try { context?.report('surfcore', { state, detail, at: new Date().toISOString() }) }
    catch (error) { logger.warn(`dsh-surfcore-adapter: health report failed: ${error?.message ?? error}`) }
  }

  /** One POST to the loopback OneBot gateway; the response decides success, rejection, gone, or an unknown result. */
  async function oneBot(action, params, config) {
    const url = `${config.httpUrl.replace(/\/+$/, '')}/${action}`
    let response
    try {
      response = await fetchImpl(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...(config.accessToken ? { authorization: `Bearer ${config.accessToken}` } : {}) },
        body: JSON.stringify(params), signal: AbortSignal.timeout(config.requestTimeoutMs),
      })
    } catch (error) {
      const code = String(error?.cause?.code ?? error?.code ?? '')
      if (RETRYABLE_CODES.test(code)) throw new EgressError(`SnowLuma is not reachable at ${url} (${code})`, { definite: true })
      throw new EgressError(`SnowLuma ${action} did not complete: ${error?.message ?? error}`)
    }
    let body
    try { body = await response.json() }
    catch { throw new EgressError(`SnowLuma ${action} answered HTTP ${response.status} with an unreadable body`) }
    if (response.status === 401 || response.status === 403) {
      throw new EgressError(`SnowLuma refused ${action}: HTTP ${response.status}（检查 snowluma.accessToken）`, { definite: true })
    }
    if (body?.status === 'ok' && body?.retcode === 0) return body.data ?? {}
    const wording = String(body?.wording ?? body?.message ?? `retcode ${body?.retcode ?? 'unknown'} / HTTP ${response.status}`)
    if (GONE_WORDING.test(wording)) throw new EgressError(`SnowLuma ${action}: ${wording}`, { gone: true })
    if (!response.ok) throw new EgressError(`SnowLuma ${action} answered HTTP ${response.status}: ${wording}`)
    throw new EgressError(`SnowLuma ${action} rejected the message: ${wording}`, { definite: true })
  }

  async function sendQq(target, text, config) {
    const segments = [{ type: 'text', data: { text: escapeCqText(text) } }]
    const params = target.kind === 'private' ? { user_id: Number(target.target), message: segments }
      : { group_id: Number(target.target), message: segments }
    const data = await oneBot(target.kind === 'private' ? 'send_private_msg' : 'send_group_msg', params, config)
    return data?.message_id === undefined || data?.message_id === null ? '' : String(data.message_id)
  }

  /** The Bilibili private-message call, with the account cookies the Bilibili tools already keep. */
  async function sendBili(target, text, config) {
    let credentials
    try { credentials = JSON.parse(readFileSync(config.biliCredentialsFile, 'utf8')) }
    catch (error) { throw new EgressError(`Bilibili cookies are unreadable: ${error?.message ?? error}`, { definite: true }) }
    if (!credentials?.sessdata || !credentials?.bili_jct) {
      throw new EgressError('Bilibili cookies are missing sessdata or bili_jct', { definite: true })
    }
    const body = new URLSearchParams({
      'msg[sender_uid]': String(credentials.mid ?? ''), 'msg[receiver_id]': target.target, 'msg[receiver_type]': '1',
      'msg[msg_type]': '1', 'msg[msg_status]': '0', 'msg[timestamp]': String(Math.floor(Date.now() / 1000)),
      'msg[dev_id]': `WEB-${randomUUID().toUpperCase()}`, 'msg[content]': JSON.stringify({ content: text }),
      csrf: String(credentials.bili_jct),
    })
    let response
    try {
      response = await fetchImpl('https://api.vc.bilibili.com/web_im/v1/web_im/send_msg', {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded', 'user-agent': BILI_USER_AGENT,
          referer: 'https://www.bilibili.com/', origin: 'https://www.bilibili.com',
          cookie: `SESSDATA=${credentials.sessdata}; bili_jct=${credentials.bili_jct}; buvid3=${credentials.buvid3 ?? ''}` },
        body: body.toString(), signal: AbortSignal.timeout(config.requestTimeoutMs),
      })
    } catch (error) { throw new EgressError(`Bilibili send_msg did not complete: ${error?.message ?? error}`) }
    let answer
    try { answer = await response.json() } catch { throw new EgressError(`Bilibili send_msg answered HTTP ${response.status} unreadably`) }
    if (answer?.code !== 0) {
      const wording = String(answer?.message ?? `code ${answer?.code ?? 'unknown'}`)
      if (GONE_WORDING.test(wording)) throw new EgressError(`Bilibili send_msg: ${wording}`, { gone: true })
      if (!response.ok) throw new EgressError(`Bilibili send_msg answered HTTP ${response.status}: ${wording}`)
      throw new EgressError(`Bilibili send_msg rejected the message: ${wording}`, { definite: true })
    }
    const id = answer?.data?.message_id ?? answer?.data?.msg_source?.message_id
    return id === undefined || id === null ? '' : String(id)
  }

  const textOf = raw => Array.isArray(raw?.message)
    ? raw.message.filter(segment => segment?.type === 'text').map(segment => String(segment?.data?.text ?? '')).join('')
    : typeof raw?.message === 'string' ? raw.message : ''

  /** The ID of the account this gateway sends as, so reconciliation only counts messages we could have sent. */
  async function selfUserId(config) {
    if (config.botUserId) return config.botUserId
    if (selfId) return selfId
    try { selfId = String((await oneBot('get_login_info', {}, config))?.user_id ?? '') } catch { selfId = '' }
    return selfId
  }

  /**
   * Asks the conversation whether a message we could not confirm is actually there.
   * @returns the external ID when found, `null` when the history proves it absent, `undefined` when nothing is known.
   */
  async function reconcile(record, config) {
    const target = parseAddress(record.address ?? {})
    if (!target || target.platform !== 'qq') return undefined
    const wanted = escapeCqText(String(record.text ?? '')).trim()
    const notBefore = Date.parse(record.at ?? '') - 300_000
    if (!wanted || !Number.isFinite(notBefore)) return undefined
    const senderId = await selfUserId(config)
    if (!senderId) return undefined
    const count = config.reconcileCount
    let messages
    try {
      const params = target.kind === 'private' ? { user_id: Number(target.target), count } : { group_id: Number(target.target), count }
      messages = (await oneBot(target.kind === 'private' ? 'get_friend_msg_history' : 'get_group_msg_history', params, config))?.messages
    } catch { return undefined }
    if (!Array.isArray(messages)) return undefined
    const found = messages.filter(raw => String(raw?.sender?.user_id ?? '') === senderId
      && Number(raw?.time ?? 0) * 1000 >= notBefore && textOf(raw).trim() === wanted).at(-1)
    if (!found) return null
    const id = found.message_id ?? found.real_id ?? found.message_seq
    return id === undefined || id === null ? '' : String(id)
  }

  async function send(_host, message) {
    const config = settings()
    const target = parseAddress(message.channel?.address ?? {})
    if (!target) return { outcome: 'gone' }
    if (String(message.text ?? '').length > config.maxTextChars) {
      logger.warn(`dsh-surfcore-adapter: a ${String(message.text).length}-character reply is past maxTextChars ${config.maxTextChars} and was dropped`)
      return { outcome: 'gone' }
    }
    const record = ledger.read(message.id)
    if (record?.state === 'sent') return { outcome: 'sent', ...(record.externalId ? { externalId: record.externalId } : {}) }
    if (record) {
      const found = await reconcile(record, config)
      if (typeof found === 'string') {
        ledger.settle(message.id, found)
        return { outcome: 'sent', ...(found ? { externalId: found } : {}) }
      }
      if (found === null) ledger.clear(message.id)
      else throw new Error(`An earlier attempt to send ${message.id} has an unknown result and ${target.platform} cannot confirm it`)
    }
    ledger.attempt(message.id, { text: message.text, address: message.channel.address, at: new Date().toISOString() })
    try {
      const externalId = target.platform === 'bili'
        ? await sendBili(target, message.text, config)
        : await sendQq(target, message.text, config)
      ledger.settle(message.id, externalId)
      report('ready', `QQ/B站 出站正常（${target.platform} ${target.kind}:${target.target}）`)
      return { outcome: 'sent', ...(externalId ? { externalId } : {}) }
    } catch (error) {
      if (error instanceof EgressError && error.gone) {
        ledger.clear(message.id)
        report('error', `出站目标已失效：${error.message}`)
        return { outcome: 'gone' }
      }
      if (error instanceof EgressError && error.definite) ledger.clear(message.id)
      else ledger.markUncertain(message.id, error?.message ?? error)
      report('error', String(error?.message ?? error))
      throw error
    }
  }

  async function query(_host, message, externalId) {
    const config = settings()
    const record = ledger.read(message.id)
    if (!record) return { outcome: 'absent' }
    if (record.state === 'sent') return { outcome: 'sent', externalId: record.externalId ?? externalId }
    const found = await reconcile(record, config)
    if (typeof found === 'string') {
      ledger.settle(message.id, found)
      return { outcome: 'sent', ...(found ? { externalId: found } : {}) }
    }
    if (found === null) { ledger.clear(message.id); return { outcome: 'absent' } }
    return { outcome: 'unsupported' }
  }

  function link(address) {
    const target = parseAddress(address)
    if (target?.platform === 'bili') return { url: `https://space.bilibili.com/${target.target}`, label: { zh: 'B站 私信', en: 'Bilibili DM' } }
    if (target?.platform === 'qq') return target.kind === 'group'
      ? { url: '', label: { zh: `QQ 群 ${target.target}`, en: `QQ group ${target.target}` } }
      : { url: '', label: { zh: `QQ 私聊 ${target.target}`, en: `QQ direct ${target.target}` } }
    return { url: '', label: { zh: 'SurfCore 会话', en: 'SurfCore conversation' } }
  }

  const kind = {
    kind: SOURCE,
    title: { zh: 'SurfCore（QQ / B站）', en: 'SurfCore (QQ / Bilibili)' },
    description: {
      zh: '接收 SurfCore 桥接转来的 QQ 与 B站消息；模型的回信也只从这里发出，结果不明时先向会话核对再重试。',
      en: 'Receives QQ and Bilibili events handed over by the SurfCore bridge, and is the only way a reply leaves; '
        + 'an unknown result is reconciled with the conversation before any retry.',
    },
    /** Its inputs arrive from inside the trust boundary, so the Policy admits them without a sender list. */
    trusted: true,
    schema: SurfcoreConfigSchema,
    fields: [
      { key: 'httpUrl', type: 'text', label: { zh: 'SnowLuma HTTP 地址', en: 'SnowLuma HTTP URL' },
        hint: { zh: '留空则读 SurfCore 的 config.json 里 snowluma.httpUrl，再退回 http://127.0.0.1:3000。',
          en: 'Empty falls back to snowluma.httpUrl in SurfCore’s config.json, then to http://127.0.0.1:3000.' } },
      { key: 'botUserId', type: 'text', label: { zh: '机器人 QQ 号', en: 'Bot QQ number' },
        hint: { zh: '核对结果不明的出站消息时，用来确认那条消息确实出自本机。',
          en: 'Confirms which messages in a conversation this machine sent when reconciling an unknown result.' } },
      { key: 'requestTimeoutMs', type: 'number', advanced: true, min: 1000, max: 120000,
        label: { zh: '发送时限 / 毫秒', en: 'Send time limit / ms' } },
      { key: 'maxTextChars', type: 'number', advanced: true, min: 200, max: 8000, label: { zh: '单条消息字数上限', en: 'Maximum characters per message' },
        hint: { zh: '超过上限的回信直接判为送达不了并丢弃，不会反复重试。', en: 'A reply past this size is settled as undeliverable instead of retried.' } },
      { key: 'reconcileCount', type: 'number', advanced: true, min: 10, max: 200,
        label: { zh: '核对读取的历史条数', en: 'History messages read when reconciling' } },
      { key: 'ledgerMaxEntries', type: 'number', advanced: true, min: 1000, max: 200000,
        label: { zh: '出站账本条数上限', en: 'Egress ledger size limit' } },
      { key: 'biliSend', type: 'switch', advanced: true, label: { zh: '允许 B站 私信出站', en: 'Allow Bilibili DM egress' },
        hint: { zh: '结果不明的 B站 私信无法远程核对，开启前请确认账号风险可接受。',
          en: 'An unknown Bilibili send cannot be reconciled remotely; enable it only when the account risk is acceptable.' } },
      { key: 'biliCredentialsFile', type: 'text', advanced: true, label: { zh: 'B站 cookie 文件', en: 'Bilibili credentials file' },
        hint: { zh: '默认读桥接自己的 <DSH_HOME>/surfcore/bili/credentials.json，只读不改。',
          en: 'Defaults to the bridge’s <DSH_HOME>/surfcore/bili/credentials.json, read-only.' } },
    ],
    health: ['surfcore'],
    channel: {
      allowed: address => {
        const target = parseAddress(address)
        if (!target) return false
        if (target.platform !== 'bili') return true
        const config = settings()
        return config.biliSend && existsSync(config.biliCredentialsFile)
      },
      send, query, link,
    },
  }

  return { kind, settings, ledger, report, attach: host => { context = host }, detach: () => { context = undefined } }
}
