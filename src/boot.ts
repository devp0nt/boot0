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
            ctx.log({
              level: 'error',
              message: `runtime "${runtime.name}" stop failed`,
              error,
              meta: { name: runtime.name },
            })
          }
        }
        const started = [...ctx.services].filter((manager) => manager.status === 'started')
        await stopManagers(ctx, started)
        for (const callback of [...ctx.shutdownCallbacks].reverse()) {
          try {
            await callback()
          } catch (error) {
            ctx.log({ level: 'warn', message: 'an onShutdown callback threw', error })
          }
        }
      },
      shutdown: async (code = 0) => {
        if (shuttingDown) {
          return
        }
        shuttingDown = true
        const timeoutMs = config.shutdownTimeoutMs
        if (timeoutMs !== undefined && timeoutMs > 0) {
          let timer: ReturnType<typeof setTimeout> | undefined
          const timedOut = new Promise<void>((resolve) => {
            timer = setTimeout(() => {
              ctx.log({ level: 'warn', message: `shutdown timed out after ${timeoutMs}ms` })
              resolve()
            }, timeoutMs)
          })
          await Promise.race([instance.stop(), timedOut])
          if (timer) {
            clearTimeout(timer)
          }
        } else {
          await instance.stop()
        }
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
      process.once('SIGINT', () => {
        void instance.shutdown(130)
      })
      process.once('SIGTERM', () => {
        void instance.shutdown(0)
      })
    }

    if (config.shutdownOnUncaught) {
      process.once('uncaughtException', (error) => {
        ctx.log({ level: 'error', message: 'uncaught exception, shutting down', error })
        void instance.shutdown(1)
      })
      process.once('unhandledRejection', (reason) => {
        ctx.log({ level: 'error', message: 'unhandled rejection, shutting down', error: reason })
        void instance.shutdown(1)
      })
    }

    return instance
  },
}
