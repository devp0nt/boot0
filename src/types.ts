// The symbol that carries a service's lifecycle manager on its proxy.
export const SERVICE: unique symbol = Symbol('boot0')

export type ServiceStatus = 'idle' | 'starting' | 'started' | 'stopping' | 'stopped'

/** The lifecycle handle for one service, reachable at `service[SERVICE]`. */
export interface ServiceManager<T> {
  readonly name: string
  readonly status: ServiceStatus
  /** The started value, unproxied. Throws if the service is not started. */
  readonly original: T
  start: () => Promise<T>
  stop: () => Promise<void>
  restart: () => Promise<T>
}

/** Any boot0 service, regardless of its value type. */
export type AnyService = { readonly [SERVICE]: ServiceManager<any> }

/**
 * What `createService` returns. The proxy is typed as the value `T`. With `hidden: true` the manager is removed from
 * the type (it stays at runtime).
 */
export type Service<T, Hidden extends boolean = false> = Hidden extends true
  ? T
  : T & { readonly [SERVICE]: ServiceManager<T> }

/**
 * The value behind a service proxy: unwraps the manager marker for a normal service, or the value itself for a hidden
 * one. Lets helpers infer the type from the service, so you don't pass a generic.
 */
export type ServiceValue<S> = S extends { [SERVICE]: ServiceManager<infer U> } ? U : S

export interface ErrorInfo {
  scope: 'service' | 'runtime'
  name: string
  phase: 'start' | 'stop'
}

export type ErrorHook = (error: unknown, info: ErrorInfo) => unknown

export interface ServiceDef<TReturn, Hidden extends boolean> {
  /** Other services this one needs. Declares start order — not injected. */
  deps?: Record<string, AnyService>
  /** Build and connect the value. Its return type becomes the service type. */
  start: () => TReturn
  /** Tear the value down. */
  stop?: (value: Awaited<TReturn>) => unknown
  /** Hide the manager from the output type (type-only). */
  hidden?: Hidden
  onStarting?: () => unknown
  onStarted?: (value: Awaited<TReturn>) => unknown
  onStopping?: (value: Awaited<TReturn>) => unknown
  onStopped?: () => unknown
  onError?: ErrorHook
}

export type LogLevel = 'debug' | 'info' | 'warn' | 'error'

export interface LogEntry {
  level: LogLevel
  message: string
  /** The thrown value, on a failure log. */
  error?: unknown
  /** Structured context about the event, e.g. `{ scope, name, phase }`. */
  meta?: Record<string, unknown>
}

export interface LoggerConfig {
  log: (entry: LogEntry) => void
  enabled: boolean
}

export interface ServiceHookInfo {
  name: string
}

export interface RuntimeHookInfo {
  name: string
}

export interface BootConfig {
  logger?: Partial<LoggerConfig>
  onServiceStarting?: (info: ServiceHookInfo) => unknown
  onServiceStarted?: (info: ServiceHookInfo) => unknown
  onServiceStopping?: (info: ServiceHookInfo) => unknown
  onServiceStopped?: (info: ServiceHookInfo) => unknown
  onRuntimeStarting?: (info: RuntimeHookInfo) => unknown
  onRuntimeStarted?: (info: RuntimeHookInfo) => unknown
  onRuntimeStopping?: (info: RuntimeHookInfo) => unknown
  onRuntimeStopped?: (info: RuntimeHookInfo) => unknown
  onError?: ErrorHook
  /** Normalize a thrown value before it is logged, sent to `onError`, and rethrown. */
  transformError?: (error: unknown, info: ErrorInfo) => unknown
  /** On an unrecoverable start error, run `shutdown(1)`. */
  shutdownOnError?: boolean
  /** On SIGINT (exit 130) / SIGTERM (exit 0), run `shutdown()`. */
  shutdownOnSignals?: boolean
  /** On `uncaughtException` / `unhandledRejection`, log and run `shutdown(1)`. */
  shutdownOnUncaught?: boolean
  /** Max time for `shutdown` teardown before it forces `process.exit`, in ms. */
  shutdownTimeoutMs?: number
}

export interface RuntimeHooks {
  onStarting?: () => unknown
  onStarted?: () => unknown
  onStopping?: () => unknown
  onStopped?: () => unknown
  onError?: ErrorHook
}

export type RuntimeOptions = RuntimeHooks

export type Runtime<S extends Record<string, AnyService>> = S & {
  start: (subset?: (keyof S)[]) => Promise<void>
  stop: (subset?: (keyof S)[]) => Promise<void>
  restart: (subset?: (keyof S)[]) => Promise<void>
  readonly status: Record<keyof S, ServiceStatus>
}

export interface Boot {
  createService: <TReturn, const Hidden extends boolean = false>(
    name: string,
    def: ServiceDef<TReturn, Hidden>,
  ) => Service<Awaited<TReturn>, Hidden>
  createRuntime: <S extends Record<string, AnyService>>(
    name: string,
    services: S,
    options?: RuntimeOptions,
  ) => Runtime<S>
  startService: <S extends object>(service: S) => Promise<ServiceValue<S>>
  stopService: (service: object) => Promise<void>
  restartService: <S extends object>(service: S) => Promise<ServiceValue<S>>
  isServiceStarted: (service: object) => boolean
  getStatus: (service: object) => ServiceStatus
  getOriginal: <S extends object>(service: S) => ServiceValue<S>
  stop: () => Promise<void>
  /** Stop everything, then `process.exit(code)`. Accepts what `process.exit` does. */
  shutdown: (code?: number | string | null) => Promise<void>
  /**
   * Register a named teardown hook. It is a service born already started with no value, whose `stop` is your callback —
   * so it's logged by name and torn down with everything else. Returns the hook service.
   */
  onShutdown: (name: string, callback: () => unknown) => AnyService
}

// Internal: the minimal handle ordering and orchestration work against.
export interface InternalManager {
  readonly name: string
  readonly status: ServiceStatus
  readonly deps: InternalManager[]
  startSelf: () => Promise<void>
  stopSelf: () => Promise<void>
}

export interface InternalRuntime {
  name: string
  stop: () => Promise<void>
}
