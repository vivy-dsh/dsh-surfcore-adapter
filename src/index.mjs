/**
 * SurfCore edge adapter. It mounts the `surfcore` Source kind — the only way a reply leaves for QQ or Bilibili — and
 * opens a loopback endpoint the SurfCore bridge hands its incoming events to, which this plugin forwards to the
 * orchestrator as InputEnvelopes. SurfCore itself stays read-only.
 */
import { join } from 'node:path'
import { registerComponentInternal } from '../../_shared/ipc.mjs'
import { prepareStateDir, projectHome } from '../../_shared/paths.mjs'
import { createSurfcoreEgress, SOURCE } from './egress.mjs'
import { createSurfcoreIngress } from './ingress.mjs'

export const name = 'dsh-surfcore-adapter'
export const inject = ['orchestrator', 'webServer']

const HEALTH_ENTRY = 'surfcore'
/** The component name the bridge hooks look up in `<DSH_HOME>/surfcore-adapter/runtime.json`; the plugin id is longer. */
const COMPONENT = 'surfcore-adapter'

export function apply(ctx, pluginConfig = {}) {
  const home = projectHome(process.env)
  const stateDir = prepareStateDir(join(home, COMPONENT), 'SurfCore 适配器状态目录')
  const logger = ctx.logger ?? console
  // The Source context captures the health entries claimed when it is built, so it only exists after registration and
  // the egress reads its configuration through this binding.
  let context
  const egress = createSurfcoreEgress({
    home,
    dir: join(stateDir, 'ledger'),
    pluginConfig,
    logger,
    instanceConfig: () => context?.config(SOURCE),
  })
  const ingress = createSurfcoreIngress({ port: ctx.webServer?.port, pluginConfig, logger })

  ctx.effect(() => {
    const dispose = ctx.orchestrator.sources.register(egress.kind)
    context = ctx.orchestrator.context({ kind: SOURCE, health: [HEALTH_ENTRY] })
    egress.attach(context)
    egress.report('ready', `出站指向 ${egress.settings().httpUrl}`)
    return () => { dispose(); context = undefined; egress.detach() }
  }, 'surfcore-adapter: source kind')

  ctx.effect(() => registerComponentInternal(ctx, { home, name: COMPONENT, handle: ingress.handle }),
    'surfcore-adapter: ingest endpoint')
}

export default { name, inject, apply }
