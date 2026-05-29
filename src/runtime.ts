import type { AnyService, InternalManager, InternalRuntime, RuntimeOptions, ServiceStatus } from './types.js'
import type { BootContext } from './context.js'
import { getManager, isService, startManagers, stopManagers } from './service.js'

export const makeRuntime = (
  ctx: BootContext,
  name: string,
  services: Record<string, AnyService>,
  options: RuntimeOptions = {},
): any => {
  const managersByKey = new Map<string, InternalManager>()
  for (const [key, service] of Object.entries(services)) {
    if (!isService(service)) {
      throw new Error(`boot0: runtime "${name}" service "${key}" is not a boot0 service`)
    }
    managersByKey.set(key, getManager(service))
  }
  const allManagers = [...managersByKey.values()]

  const resolveTargets = (subset?: string[]): InternalManager[] => {
    if (!subset) {
      return allManagers
    }
    return subset.map((key) => {
      const manager = managersByKey.get(key)
      if (!manager) {
        throw new Error(`boot0: runtime "${name}" has no service "${key}"`)
      }
      return manager
    })
  }

  const fireRuntime = async (hooks: Array<(() => unknown) | undefined>): Promise<void> => {
    for (const hook of hooks) {
      if (!hook) {
        continue
      }
      try {
        await hook()
      } catch (error) {
        ctx.log('warn', `a lifecycle hook for runtime "${name}" threw`, error)
      }
    }
  }

  const runtime = {
    ...services,
    start: async (subset?: string[]): Promise<void> => {
      ctx.log('debug', `runtime "${name}" starting`)
      await fireRuntime([() => ctx.config.onRuntimeStarting?.({ name }), options.onStarting])
      try {
        await startManagers(ctx, resolveTargets(subset))
      } catch (error) {
        if (options.onError) {
          try {
            options.onError(error, { scope: 'runtime', name, phase: 'start' })
          } catch (hookError) {
            ctx.log('warn', `onError hook for runtime "${name}" threw`, hookError)
          }
        }
        throw error
      }
      ctx.log('info', `runtime "${name}" started`)
      await fireRuntime([() => ctx.config.onRuntimeStarted?.({ name }), options.onStarted])
    },
    stop: async (subset?: string[]): Promise<void> => {
      ctx.log('debug', `runtime "${name}" stopping`)
      await fireRuntime([() => ctx.config.onRuntimeStopping?.({ name }), options.onStopping])
      await stopManagers(ctx, resolveTargets(subset))
      ctx.log('info', `runtime "${name}" stopped`)
      await fireRuntime([() => ctx.config.onRuntimeStopped?.({ name }), options.onStopped])
    },
    restart: async (subset?: string[]): Promise<void> => {
      const targets = resolveTargets(subset)
      await stopManagers(ctx, targets)
      await startManagers(ctx, targets)
    },
    get status(): Record<string, ServiceStatus> {
      const out: Record<string, ServiceStatus> = {}
      for (const [key, manager] of managersByKey) {
        out[key] = manager.status
      }
      return out
    },
  }

  const internal: InternalRuntime = {
    name,
    stop: () => runtime.stop(),
  }
  ctx.runtimes.add(internal)

  return runtime
}
