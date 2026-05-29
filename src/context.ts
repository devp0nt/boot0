import type {
  BootConfig,
  ErrorHook,
  ErrorInfo,
  InternalManager,
  InternalRuntime,
  LoggerConfig,
  LogLevel,
} from './types.js'

/** Shared state every service and runtime of one boot instance runs against. */
export interface BootContext {
  config: BootConfig
  logger: LoggerConfig
  services: Set<InternalManager>
  runtimes: Set<InternalRuntime>
  shutdownCallbacks: Array<() => unknown>
  log: (level: LogLevel, message: string, ...details: unknown[]) => void
  reportError: (error: unknown, info: ErrorInfo, localHook?: ErrorHook) => unknown
  shutdown: (code?: number) => Promise<void>
}

const consoleLog: LoggerConfig['log'] = (level, message, ...details) => {
  const line = `[boot0] ${message}`
  if (level === 'error') {
    console.error(line, ...details)
  } else if (level === 'warn') {
    console.warn(line, ...details)
  } else {
    console.log(line, ...details)
  }
}

const callHook = (ctx: BootContext, hook: () => unknown): void => {
  try {
    void hook()
  } catch (error) {
    ctx.log('warn', 'an error hook threw', error)
  }
}

export const createContext = (config: BootConfig): BootContext => {
  const logger: LoggerConfig = {
    log: config.logger?.log ?? consoleLog,
    enabled: config.logger?.enabled ?? true,
  }

  const ctx: BootContext = {
    config,
    logger,
    services: new Set(),
    runtimes: new Set(),
    shutdownCallbacks: [],
    log: (level, message, ...details) => {
      if (logger.enabled) {
        logger.log(level, message, ...details)
      }
    },
    reportError: (error, info, localHook) => {
      let reported = error
      if (config.transformError) {
        try {
          reported = config.transformError(error, info)
        } catch (hookError) {
          ctx.log('warn', 'transformError threw', hookError)
        }
      }
      ctx.log('error', `${info.scope} "${info.name}" failed during ${info.phase}`, reported)
      if (config.onError) {
        callHook(ctx, () => config.onError?.(reported, info))
      }
      if (localHook) {
        callHook(ctx, () => localHook(reported, info))
      }
      return reported
    },
    shutdown: async () => {
      // Replaced by the boot instance in Boot0.create.
    },
  }
  return ctx
}
