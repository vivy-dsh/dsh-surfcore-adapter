/**
 * Per-message egress ledger: one file per outgoing message ID, so an attempt whose result never reached us is
 * reconciled against the remote before anything is sent again. A corrupt or unreadable entry fails closed: the
 * adapter would rather stop a reply than risk a second copy of it in front of a person.
 */
import { createHash, randomUUID } from 'node:crypto'
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/** `attempting` = an attempt was started, `uncertain` = its result did not reach us, `sent` = the remote has it. */
export const LEDGER_STATES = ['attempting', 'uncertain', 'sent']

export function createLedger({ dir, maxEntries = 20_000, logger = console }) {
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  const path = key => join(dir, `${createHash('sha1').update(String(key)).digest('hex')}.json`)
  // A sweep every 200 writes is cheap at 20 000 entries, but a small configured cap has to be honoured at once.
  const sweepEvery = Math.max(1, Math.min(200, Math.floor(maxEntries / 2)))
  let writes = 0

  function read(key) {
    const file = path(key)
    if (!existsSync(file)) return undefined
    if (!lstatSync(file).isFile()) throw new Error(`The egress ledger entry ${file} is not a regular file`)
    let record
    try { record = JSON.parse(readFileSync(file, 'utf8')) }
    catch (error) { throw new Error(`The egress ledger entry for ${key} cannot be read: ${error?.message ?? error}`) }
    if (!record || typeof record !== 'object' || !LEDGER_STATES.includes(record.state)) {
      throw new Error(`The egress ledger entry for ${key} has no known state`)
    }
    return record
  }

  function write(key, record) {
    const file = path(key), temp = `${file}.${randomUUID()}.tmp`
    writeFileSync(temp, `${JSON.stringify(record)}\n`, { flag: 'wx', mode: 0o600 })
    renameSync(temp, file)
    if (++writes % sweepEvery === 0) prune()
    return record
  }

  /** Keeps only confirmed sends, oldest first, when the ledger grows past its configured size. */
  function prune() {
    let names
    try { names = readdirSync(dir).filter(name => name.endsWith('.json')) } catch { return }
    const excess = names.length - maxEntries
    if (excess <= 0) return
    const settled = []
    for (const name of names) {
      let record
      try { record = JSON.parse(readFileSync(join(dir, name), 'utf8')) } catch { continue }
      if (record?.state !== 'sent') continue
      settled.push([name, String(record.settledAt ?? record.at ?? '')])
    }
    // The recorded timestamps order the sweep; a file's mtime is too coarse to tell two replies apart.
    settled.sort((a, b) => (a[1] === b[1] ? (a[0] < b[0] ? -1 : 1) : a[1] < b[1] ? -1 : 1))
    let removed = 0
    for (const [name] of settled) {
      if (removed >= excess) break
      try { rmSync(join(dir, name), { force: true }) } catch { continue }
      removed++
    }
    if (removed < excess)
      logger.warn(`dsh-surfcore-adapter: ${excess - removed} ledger entries over ${maxEntries} are still unresolved and were kept`)
  }

  return {
    read,
    /** Records that an attempt is about to be made; `text` is kept only while the result is still unknown. */
    attempt(key, { text, address, at }) {
      return write(key, { key, state: 'attempting', text, address, at: at ?? new Date().toISOString() })
    },
    /** The remote confirmed the message; the body is dropped and only its external ID is kept. */
    settle(key, externalId) {
      const before = read(key)
      return write(key, { key, state: 'sent', at: before?.at, settledAt: new Date().toISOString(),
        ...(externalId ? { externalId: String(externalId) } : {}) })
    },
    /** The attempt may or may not have landed; the body is kept so a later lookup can match it remotely. */
    markUncertain(key, reason) {
      const before = read(key)
      return write(key, { ...before, key, state: 'uncertain', reason: String(reason).slice(0, 500) })
    },
    /** The remote proves the message is not there, so the next attempt may POST again. */
    clear(key) {
      try { rmSync(path(key)) } catch {}
    },
  }
}
