import { createContext } from './context.js'
import { getManager, makeService, stopManagers } from './service.js'
import { makeRuntime } from './runtime.js'
import type { Boot, BootConfig } from './types.js'

export const Boot0 = {
  create(config: BootConfig = {}): Boot {
    const ctx = createContext(config)
    let shuttingDown = false

    const instance: Boot = {
      createService: (name, def) => makeService(ctx, name, def),
      createRuntime: (name, services, options) => makeRuntime(ctx, name, services, options),
      startService: (service) => getManager(service).start(),
      stopService: (service) => getManager(service).stop(),
      restartService: (service) => getManager(service).restart(),
      isServiceStarted: (service) => getManager(service).status === 'started',
      getStatus: (service) => getManager(service).status,
      getOriginal: (service) => getManager(service).original,
      stop: async () => {
        for (const runtime of [...ctx.runtimes].reverse()) {
          try {
            await runtime.stop()
          } catch (error) {
            ctx.log('error', `runtime "${runtime.name}" stop failed`, error)
          }
        }
        const started = [...ctx.services].filter((manager) => manager.status === 'started')
        await stopManagers(ctx, started)
        for (const callback of [...ctx.shutdownCallbacks].reverse()) {
          try {
            await callback()
          } catch (error) {
            ctx.log('warn', 'an onShutdown callback threw', error)
          }
        }
      },
      shutdown: async (code = 0) => {
        if (shuttingDown) {
          return
        }
        shuttingDown = true
        await instance.stop()
        process.exit(code)
      },
      onShutdown: (callback) => {
        ctx.shutdownCallbacks.push(callback)
        return () => {
          const index = ctx.shutdownCallbacks.indexOf(callback)
          if (index >= 0) {
            ctx.shutdownCallbacks.splice(index, 1)
          }
        }
      },
    }

    ctx.shutdown = instance.shutdown

    if (config.shutdownOnSignals) {
      const onSignal = (): void => {
        void instance.shutdown(0)
      }
      process.once('SIGINT', onSignal)
      process.once('SIGTERM', onSignal)
    }

    return instance
  },
}
