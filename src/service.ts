import { SERVICE } from './types.js'
import type { AnyService, InternalManager, ServiceDef, ServiceManager, ServiceStatus } from './types.js'
import type { BootContext } from './context.js'
import { orderForStart } from './graph.js'

export const isService = (value: unknown): value is AnyService =>
  value != null && (typeof value === 'object' || typeof value === 'function') && SERVICE in value

export const getManager = (value: unknown): InternalManager & ServiceManager<any> => {
  if (!isService(value)) {
    throw new Error('boot0: value is not a boot0 service')
  }
  return value[SERVICE] as InternalManager & ServiceManager<any>
}

const fire = async (ctx: BootContext, label: string, hooks: Array<(() => unknown) | undefined>): Promise<void> => {
  for (const hook of hooks) {
    if (!hook) {
      continue
    }
    try {
      await hook()
    } catch (error) {
      ctx.log({ level: 'warn', message: `a lifecycle hook for ${label} threw`, error })
    }
  }
}

const makeProxy = (manager: InternalManager & ServiceManager<any>, get: () => any): any => {
  // An arrow function as target: callable (for function services) and free of a
  // non-configurable `prototype` key, which keeps the proxy invariants simple.
  const target = (() => undefined) as object
  return new Proxy(target, {
    get(_target, key) {
      if (key === SERVICE) {
        return manager
      }
      const value = get()
      const got = Reflect.get(value, key, value)
      return typeof got === 'function' ? got.bind(value) : got
    },
    set(_target, key, next) {
      if (key === SERVICE) {
        return false
      }
      return Reflect.set(get(), key, next)
    },
    has(_target, key) {
      if (key === SERVICE) {
        return true
      }
      return Reflect.has(get(), key)
    },
    apply(_target, thisArg, args) {
      return Reflect.apply(get(), thisArg, args)
    },
    ownKeys() {
      return Reflect.ownKeys(get())
    },
    getOwnPropertyDescriptor(_target, key) {
      const descriptor = Reflect.getOwnPropertyDescriptor(get(), key)
      if (descriptor) {
        // The empty target lacks the key, so the proxy must report it configurable.
        descriptor.configurable = true
      }
      return descriptor
    },
    getPrototypeOf() {
      return Reflect.getPrototypeOf(get())
    },
  })
}

export const makeService = (ctx: BootContext, name: string, def: ServiceDef<any, any>): any => {
  const deps = def.deps ?? {}
  const depManagers: InternalManager[] = []
  for (const [key, dep] of Object.entries(deps)) {
    if (!isService(dep)) {
      throw new Error(`boot0: service "${name}" dependency "${key}" is not a boot0 service`)
    }
    depManagers.push(getManager(dep))
  }

  let status: ServiceStatus = 'idle'
  let value: any

  const requireStarted = (): any => {
    if (status !== 'started') {
      throw new Error(`boot0: service "${name}" used before start (status: "${status}")`)
    }
    return value
  }

  const label = `service "${name}"`

  const startSelf = async (): Promise<void> => {
    if (status === 'started') {
      return
    }
    status = 'starting'
    ctx.log({ level: 'debug', message: `service "${name}" starting`, meta: { name } })
    await fire(ctx, label, [() => ctx.config.onServiceStarting?.({ name }), def.onStarting])
    try {
      value = await def.start()
    } catch (error) {
      status = 'idle'
      throw ctx.reportError(error, { scope: 'service', name, phase: 'start' }, def.onError)
    }
    status = 'started'
    ctx.log({ level: 'info', message: `service "${name}" started`, meta: { name } })
    await fire(ctx, label, [() => ctx.config.onServiceStarted?.({ name }), () => def.onStarted?.(value)])
  }

  const stopSelf = async (): Promise<void> => {
    if (status !== 'started') {
      return
    }
    const current = value
    status = 'stopping'
    ctx.log({ level: 'debug', message: `service "${name}" stopping`, meta: { name } })
    await fire(ctx, label, [() => ctx.config.onServiceStopping?.({ name }), () => def.onStopping?.(current)])
    try {
      await def.stop?.(current)
    } catch (error) {
      ctx.reportError(error, { scope: 'service', name, phase: 'stop' }, def.onError)
    }
    value = undefined
    status = 'stopped'
    ctx.log({ level: 'info', message: `service "${name}" stopped`, meta: { name } })
    await fire(ctx, label, [() => ctx.config.onServiceStopped?.({ name }), def.onStopped])
  }

  const manager: InternalManager & ServiceManager<any> = {
    name,
    deps: depManagers,
    get status() {
      return status
    },
    get original() {
      return requireStarted()
    },
    startSelf,
    stopSelf,
    start: async () => {
      await startManagers(ctx, [manager])
      return requireStarted()
    },
    stop: async () => {
      await stopSelf()
    },
    restart: async () => {
      await stopSelf()
      await startManagers(ctx, [manager])
      return requireStarted()
    },
  }

  ctx.services.add(manager)
  return makeProxy(manager, requireStarted)
}

/** Start the targets and their transitive deps in order. Rolls back on failure. */
export const startManagers = async (ctx: BootContext, targets: InternalManager[]): Promise<void> => {
  const ordered = orderForStart(targets)
  const startedNow: InternalManager[] = []
  try {
    for (const manager of ordered) {
      if (manager.status !== 'started') {
        await manager.startSelf()
        startedNow.push(manager)
      }
    }
  } catch (error) {
    for (const manager of startedNow.reverse()) {
      try {
        await manager.stopSelf()
      } catch (rollbackError) {
        ctx.log({
          level: 'error',
          message: `rollback stop of "${manager.name}" failed`,
          error: rollbackError,
          meta: { name: manager.name },
        })
      }
    }
    if (ctx.config.shutdownOnError) {
      await ctx.shutdown(1)
      return
    }
    throw error
  }
}

/** Stop exactly the given targets in reverse dependency order. Best effort. */
export const stopManagers = async (ctx: BootContext, targets: InternalManager[]): Promise<void> => {
  const targetSet = new Set(targets)
  const ordered = orderForStart(targets)
    .filter((manager) => targetSet.has(manager))
    .reverse()
  for (const manager of ordered) {
    if (manager.status === 'started') {
      await manager.stopSelf()
    }
  }
}
