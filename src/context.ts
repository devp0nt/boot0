import type { BootConfig, ErrorHook, ErrorInfo, InternalManager, InternalRuntime, LoggerConfig } from './types.js'

/** Shared state every service and runtime of one boot instance runs against. */
export interface BootContext {
  config: BootConfig
  logger: LoggerConfig
  services: Set<InternalManager>
  runtimes: Set<InternalRuntime>
  shutdownCallbacks: Array<() => unknown>
  log: (...args: unknown[]) => void
  reportError: (error: unknown, info: ErrorInfo, localHook?: ErrorHook) => void
  shutdown: (code?: number) => Promise<void>
}

const callHook = (ctx: BootContext, hook: () => unknown): void => {
  try {
    void hook()
  } catch (error) {
    ctx.log('boot0: an error hook threw:', error)
  }
}

export const createContext = (config: BootConfig): BootContext => {
  const logger: LoggerConfig = {
    log:
      config.logger?.log ??
      ((...args: unknown[]) => {
        console.error(...args)
      }),
    enabled: config.logger?.enabled ?? true,
  }

  const ctx: BootContext = {
    config,
    logger,
    services: new Set(),
    runtimes: new Set(),
    shutdownCallbacks: [],
    log: (...args) => {
      if (logger.enabled) {
        logger.log(...args)
      }
    },
    reportError: (error, info, localHook) => {
      ctx.log(`boot0: ${info.scope} "${info.name}" failed during ${info.phase}:`, error)
      if (config.onError) {
        callHook(ctx, () => config.onError?.(error, info))
      }
      if (localHook) {
        callHook(ctx, () => localHook(error, info))
      }
    },
    shutdown: async () => {
      // Replaced by the boot instance in Boot0.create.
    },
  }
  return ctx
}
