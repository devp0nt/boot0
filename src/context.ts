import type {
  BootConfig,
  ErrorHook,
  ErrorInfo,
  InternalManager,
  InternalRuntime,
  LogEntry,
  LoggerConfig,
} from './types.js'

/** Shared state every service and runtime of one boot instance runs against. */
export interface BootContext {
  config: BootConfig
  logger: LoggerConfig
  services: Set<InternalManager>
  runtimes: Set<InternalRuntime>
  log: (entry: LogEntry) => void
  reportError: (error: unknown, info: ErrorInfo, localHook?: ErrorHook) => unknown
  shutdown: (code?: number) => Promise<void>
}

const consoleLog: LoggerConfig['log'] = ({ level, message, error, meta }) => {
  const line = `[boot0] ${message}`
  const extra: unknown[] = []
  if (meta) {
    extra.push(meta)
  }
  if (error !== undefined) {
    extra.push(error)
  }
  if (level === 'error') {
    console.error(line, ...extra)
  } else if (level === 'warn') {
    console.warn(line, ...extra)
  } else {
    console.log(line, ...extra)
  }
}

const callHook = (ctx: BootContext, hook: () => unknown): void => {
  try {
    void hook()
  } catch (error) {
    ctx.log({ level: 'warn', message: 'an error hook threw', error })
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
    log: (entry) => {
      if (logger.enabled) {
        logger.log(entry)
      }
    },
    reportError: (error, info, localHook) => {
      let reported = error
      if (config.transformError) {
        try {
          reported = config.transformError(error, info)
        } catch (hookError) {
          ctx.log({ level: 'warn', message: 'transformError threw', error: hookError })
        }
      }
      ctx.log({
        level: 'error',
        message: `${info.scope} "${info.name}" failed during ${info.phase}`,
        error: reported,
        meta: { ...info },
      })
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
