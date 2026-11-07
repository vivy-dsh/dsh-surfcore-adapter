/**
 * Turns the events the SurfCore bridge already accepted into InputEnvelopes for the orchestrator.
 * The bridge owns QQ authorization (mode, deny lists, session gating) and calls in only after those checks,
 * so this module normalizes and forwards; it never decides whether a person may talk to the agent.
 */
import { createHash } from 'node:crypto'
import { resolveSubject } from '../../_shared/subject.mjs'

const INPUT_PATH = '/orchestrator/api/inputs'
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const clean = value => (typeof value === 'string' ? value.trim() : '')
const digits = value => (value === undefined || value === null || value === '' ? '' : String(value).trim())
const clamp = (value, fallback, min, max) => Math.max(min, Math.min(max, Number(value) || fallback))

/** Keeps the bridge's own delivery retries from costing a POST each; the orchestrator's dedupe key stays authoritative. */
function createRecentKeys(maxEntries) {
  const seen = new Set()
  const order = []
  return {
    has: key => seen.has(key),
    add(key) {
      if (seen.has(key)) return
      seen.add(key)
      order.push(key)
      while (order.length > maxEntries) seen.delete(order.shift())
    },
  }
}

export function qqEnvelope(raw, { maxTextChars }) {
  const event = raw?.event && typeof raw.event === 'object' ? raw.event : {}
  const kind = clean(raw?.kind) === 'private' ? 'private' : clean(raw?.kind) === 'group' ? 'group' : ''
  if (!kind) return undefined
  const senderId = digits(event.sender?.user_id ?? event.user_id)
  if (!senderId || senderId === digits(event.self_id)) return undefined
  if (event.sender?.is_bot === true || event.sender?.is_bot === 'true') return undefined
  const body = clean(raw?.text) || clean(raw?.plain)
  if (!body || clean(raw?.plain).startsWith('/')) return undefined
  const messageRef = digits(event.message_id ?? event.msg_id)
  const seqRef = digits(event.message_seq)
  const fingerprint = hash([event.time ?? null, senderId, clean(raw?.key), body])
  const conversation = clean(raw?.key) || `${kind}:${digits(raw?.id) || senderId}`
  const truncated = body.length > maxTextChars ? `${body.slice(0, maxTextChars)}\n…（比这还长的 ${body.length - maxTextChars} 字被截断了）` : body
  const senderName = clean(event.sender?.card) || clean(event.sender?.nickname) || senderId
  const at = Number(event.time) > 0 ? new Date(Number(event.time) * 1000).toISOString() : ''
  return {
    subjectId: '',
    sourceId: 'surfcore',
    externalEventId: (messageRef || seqRef || fingerprint).slice(0, 200),
    dedupeKey: `${conversation}:${messageRef || seqRef || `h${fingerprint}`}`.slice(0, 200),
    layer: 'platform',
    human: true,
    payload: { text: truncated },
    provenance: { actor: senderName.slice(0, 200), ...(at ? { note: `平台时间 ${at}` } : {}) },
    channel: { source: 'surfcore', thread: `qq:${conversation}`.slice(0, 200),
      address: { platform: 'qq', kind, target: digits(raw?.id) || senderId, user: senderId } },
  }
}

/**
 * A Bilibili private message the bridge already read. Comments and mentions are not ingested yet because the
 * egress has no reply path for them, and an event the agent cannot answer would only produce a failed Effect.
 */
export function biliEnvelope(item, { maxTextChars }) {
  const target = digits(item?.mid)
  const body = clean(item?.text)
  if (!target || !body) return undefined
  const ts = Number(item?.ts) > 0 ? Number(item.ts) : 0
  const fingerprint = hash(['bili', target, ts, body])
  const truncated = body.length > maxTextChars ? `${body.slice(0, maxTextChars)}\n…（比这还长的 ${body.length - maxTextChars} 字被截断了）` : body
  const senderName = clean(item?.name) || target
  return {
    subjectId: '',
    sourceId: 'surfcore',
    externalEventId: fingerprint,
    dedupeKey: `bili:dm:${target}:${ts || fingerprint}`.slice(0, 200),
    layer: 'platform',
    human: true,
    payload: { text: truncated },
    provenance: { actor: senderName.slice(0, 200), ...(ts ? { note: `平台时间 ${new Date(ts * 1000).toISOString()}` } : {}) },
    channel: { source: 'surfcore', thread: `bili:dm:${target}`.slice(0, 200), address: { platform: 'bili', kind: 'dm', target } },
  }
}

/** A proactive candidate the bridge selected; the orchestrator's Policy decides whether it becomes work. */
export function proactiveEnvelope(raw, { maxTextChars }) {
  const kind = clean(raw?.kind).toLowerCase()
  if (!/^[a-z][a-z0-9-]{0,31}$/.test(kind)) return undefined
  const key = clean(raw?.key)
  const match = /^(group|private):([0-9]+)$/.exec(key)
  if (!match) return undefined
  const body = clean(raw?.text)
  if (!body) return undefined
  const slot = digits(raw?.slot) || String(Date.now())
  const truncated = body.length > maxTextChars ? `${body.slice(0, maxTextChars)}\n…（比这还长的 ${body.length - maxTextChars} 字被截断了）` : body
  return { subjectId: '', sourceId: 'surfcore',
    externalEventId: `proactive:${kind}:${key}:${slot}`.slice(0, 200),
    dedupeKey: `proactive:${kind}:${key}:${slot}:${hash([kind, key, slot, body]).slice(0, 16)}`.slice(0, 200),
    layer: 'wake', human: false, payload: { text: truncated },
    provenance: { actor: 'surfcore', note: `主动机会 ${kind}` },
    channel: { source: 'surfcore', thread: `qq:${key}`.slice(0, 200),
      address: { platform: 'qq', kind: match[1], target: match[2] } } }
}

/** Forwarding is best effort: an unreachable orchestrator costs a throttled warning, never a thrown error in the bridge. */
export function createSurfcoreIngress({ port, pluginConfig = {}, logger = console, fetchImpl = fetch,
  resolveSubjectImpl = resolveSubject } = {}) {
  const maxTextChars = clamp(pluginConfig.maxIngestChars, 20_000, 1000, 100_000)
  const timeoutMs = clamp(pluginConfig.ingressTimeoutMs, 8000, 1000, 30_000)
  const recent = createRecentKeys(clamp(pluginConfig.recentKeyCount, 5000, 100, 50_000))
  let lastWarning = 0
  const warn = message => {
    if (Date.now() - lastWarning < 30_000) return
    lastWarning = Date.now()
    logger.warn(`dsh-surfcore-adapter: ${message}`)
  }

  async function submit(envelope) {
    if (!envelope) return { ok: true, outcome: 'ignored' }
    if (recent.has(envelope.dedupeKey)) return { ok: true, outcome: 'remembered', dedupeKey: envelope.dedupeKey }
    const number = Number(port)
    if (!Number.isInteger(number) || number < 1 || number > 65535) {
      warn('读不到 Superagent 面板端口，事件没有进入编排器')
      return { ok: true, outcome: 'unavailable' }
    }
    let subjectId
    try { subjectId = await resolveSubjectImpl({ webServer: { port: number }, fetchImpl, timeoutMs }) }
    catch (error) {
      warn(`读不到本安装的 subject，事件没有进入编排器：${String(error?.message ?? error)}`)
      return { ok: true, outcome: 'unavailable', dedupeKey: envelope.dedupeKey }
    }
    let response
    try {
      response = await fetchImpl(`http://127.0.0.1:${number}${INPUT_PATH}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-orchestrator-request': '1' },
        body: JSON.stringify({ ...envelope, subjectId }),
        signal: AbortSignal.timeout(timeoutMs),
      })
    } catch (error) {
      warn(`提交入站事件失败：${String(error?.message ?? error)}`)
      return { ok: true, outcome: 'unavailable', dedupeKey: envelope.dedupeKey }
    }
    const answer = await response.json().catch(() => null)
    if (!response.ok || typeof answer?.triggerId !== 'string') {
      warn(`Superagent 拒绝了入站事件（HTTP ${response.status}）：${String(answer?.error ?? '响应体无法读取')}`)
      return { ok: true, outcome: 'rejected', dedupeKey: envelope.dedupeKey }
    }
    recent.add(envelope.dedupeKey)
    return { ok: true, outcome: answer.outcome === 'duplicate' ? 'duplicate' : 'submitted',
      dedupeKey: envelope.dedupeKey, triggerId: answer.triggerId }
  }

  async function ingestQq(raw) { return submit(qqEnvelope(raw, { maxTextChars })) }
  async function ingestProactive(raw) { return submit(proactiveEnvelope(raw, { maxTextChars })) }
  async function ingestBili(items) {
    const results = []
    for (const item of Array.isArray(items) ? items : []) results.push(await submit(biliEnvelope(item, { maxTextChars })))
    return { ok: true, count: results.length, results }
  }

  return {
    ingestQq, ingestProactive, ingestBili,
    handle: async ({ method, path, body }) => {
      if (method !== 'POST') throw Object.assign(new Error('入站接口只接受 POST'), { code: 'SURFCORE_ADAPTER_METHOD' })
      if (path === '/ingest') return ingestQq(body)
      if (path === '/proactive') return ingestProactive(body)
      if (path === '/events') return ingestBili(body?.items)
      if (path === '/health') return { ok: true, ingress: true, maxTextChars, timeoutMs }
      throw Object.assign(new Error(`未知接口 ${path}`), { code: 'SURFCORE_ADAPTER_NOT_FOUND' })
    },
  }
}
