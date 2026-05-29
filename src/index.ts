export { SERVICE } from './types.js'
export type {
  AnyService,
  Boot,
  BootConfig,
  ErrorHook,
  ErrorInfo,
  LoggerConfig,
  Runtime,
  RuntimeHookInfo,
  RuntimeHooks,
  RuntimeOptions,
  Service,
  ServiceDef,
  ServiceHookInfo,
  ServiceManager,
  ServiceStatus,
} from './types.js'
export { Boot0 } from './boot.js'

import { Boot0 } from './boot.js'

// A ready-to-use instance with default config, for zero-ceremony use.
const boot = Boot0.create()

export const createService = boot.createService
export const createRuntime = boot.createRuntime
export const startService = boot.startService
export const stopService = boot.stopService
export const restartService = boot.restartService
export const isServiceStarted = boot.isServiceStarted
export const stop = boot.stop
export const shutdown = boot.shutdown
export const onShutdown = boot.onShutdown
