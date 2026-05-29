import { describe, expect, expectTypeOf, it, mock, spyOn } from 'bun:test'
import { Boot0, SERVICE, type ServiceManager, type ServiceStatus } from './index.js'

const quiet = () => Boot0.create({ logger: { enabled: false } })
const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

describe('service lifecycle', () => {
  it('throws when used before start, returns the value after, throws after stop', async () => {
    const boot = quiet()
    const db = boot.createService('db', { start: () => ({ rows: 7 }) })

    expect(() => db.rows).toThrow(/used before start/)

    await boot.startService(db)
    expect(db.rows).toBe(7)
    expect(db[SERVICE].status).toBe('started')

    await boot.stopService(db)
    expect(db[SERVICE].status).toBe('stopped')
    expect(() => db.rows).toThrow(/used before start/)
  })

  it('exposes the manager and the unproxied original', async () => {
    const boot = quiet()
    const raw = { id: 1 }
    const svc = boot.createService('svc', { start: () => raw })

    expect(svc[SERVICE].name).toBe('svc')
    expect(svc[SERVICE].status).toBe('idle')

    await boot.startService(svc)
    expect(svc[SERVICE].original).toBe(raw)
    expect(svc[SERVICE].original).not.toBe(svc)
  })

  it('restarts: stop then start with a fresh value', async () => {
    const boot = quiet()
    let n = 0
    const svc = boot.createService('counter', { start: () => ({ n: ++n }) })

    await boot.startService(svc)
    expect(svc.n).toBe(1)
    await boot.restartService(svc)
    expect(svc.n).toBe(2)
  })

  it('forwards method calls with the right `this`', async () => {
    const boot = quiet()
    const svc = boot.createService('obj', {
      start: () => ({
        base: 10,
        add(x: number) {
          return this.base + x
        },
      }),
    })
    await boot.startService(svc)
    expect(svc.add(5)).toBe(15)
  })

  it('supports callable (function) services', async () => {
    const boot = quiet()
    const sum = boot.createService('sum', { start: () => (a: number, b: number) => a + b })
    expect(() => sum(1, 2)).toThrow(/used before start/)
    await boot.startService(sum)
    expect(sum(2, 3)).toBe(5)
  })

  it('isServiceStarted reflects state', async () => {
    const boot = quiet()
    const svc = boot.createService('s', { start: () => ({}) })
    expect(boot.isServiceStarted(svc)).toBe(false)
    await boot.startService(svc)
    expect(boot.isServiceStarted(svc)).toBe(true)
  })
})

describe('dependencies', () => {
  it('starts dependencies first and stops them in reverse', async () => {
    const boot = quiet()
    const order: string[] = []

    const a = boot.createService('a', {
      start: () => {
        order.push('start a')
        return { v: 1 }
      },
      stop: () => {
        order.push('stop a')
      },
    })
    const b = boot.createService('b', {
      deps: { a },
      start: () => {
        order.push('start b')
        return { v: a.v + 1 }
      }, // proxy used directly
      stop: () => {
        order.push('stop b')
      },
    })

    const app = boot.createRuntime('app', { a, b })
    await app.start()
    expect(b.v).toBe(2)

    await app.stop()
    expect(order).toEqual(['start a', 'start b', 'stop b', 'stop a'])
  })

  it('pulls in transitive deps even when starting a single service', async () => {
    const boot = quiet()
    const a = boot.createService('a', { start: () => ({ v: 1 }) })
    const b = boot.createService('b', { deps: { a }, start: () => ({ v: a.v + 1 }) })

    await boot.startService(b)
    expect(boot.isServiceStarted(a)).toBe(true)
    expect(b.v).toBe(2)
  })

  it('detects dependency cycles', () => {
    const boot = quiet()
    const a = boot.createService('a', { start: () => ({}) })
    const b = boot.createService('b', { deps: { a }, start: () => ({}) })
    // force a cycle a -> b
    ;(a[SERVICE] as unknown as { deps: unknown[] }).deps.push(b[SERVICE])

    // the message names the full path and the node it closed on
    expect(boot.createRuntime('app', { a, b }).start()).rejects.toThrow('dependency cycle: a -> b -> a')
  })

  it('rejects non-service deps at construction', () => {
    const boot = quiet()
    expect(() => boot.createService('bad', { deps: { x: {} as never }, start: () => ({}) })).toThrow(
      /not a boot0 service/,
    )
  })
})

describe('runtime', () => {
  it('exposes services and a status map', async () => {
    const boot = quiet()
    const a = boot.createService('a', { start: () => ({ v: 1 }) })
    const b = boot.createService('b', { start: () => ({ v: 2 }) })
    const app = boot.createRuntime('app', { a, b })

    expect(app.a).toBe(a)
    expect(app.status).toEqual({ a: 'idle', b: 'idle' })

    await app.start()
    expect(app.status).toEqual({ a: 'started', b: 'started' })
    expect(app.a.v).toBe(1)
  })

  it('starts a subset plus its deps', async () => {
    const boot = quiet()
    const a = boot.createService('a', { start: () => ({ v: 1 }) })
    const b = boot.createService('b', { deps: { a }, start: () => ({ v: 2 }) })
    const c = boot.createService('c', { start: () => ({ v: 3 }) })
    const app = boot.createRuntime('app', { a, b, c })

    await app.start(['b'])
    expect(boot.isServiceStarted(a)).toBe(true)
    expect(boot.isServiceStarted(b)).toBe(true)
    expect(boot.isServiceStarted(c)).toBe(false)
  })

  it('rejects unknown service in a subset', async () => {
    const boot = quiet()
    const a = boot.createService('a', { start: () => ({}) })
    const app = boot.createRuntime('app', { a })
    expect(app.start(['nope'] as never)).rejects.toThrow(/has no service "nope"/)
  })

  it('rejects non-service values', () => {
    const boot = quiet()
    expect(() => boot.createRuntime('app', { x: {} as never })).toThrow(/not a boot0 service/)
  })
})

describe('errors', () => {
  it('rolls back already-started services when one fails to start', async () => {
    const boot = quiet()
    const a = boot.createService('a', { start: () => ({ v: 1 }), stop: () => {} })
    const b = boot.createService('b', {
      deps: { a },
      start: (): { v: number } => {
        throw new Error('boom')
      },
    })
    const app = boot.createRuntime('app', { a, b })

    expect(app.start()).rejects.toThrow('boom')
    await app.start().catch(() => {})

    expect(boot.isServiceStarted(a)).toBe(false)
    expect(b[SERVICE].status).toBe('idle')
  })

  it('reports errors through onError without throwing on stop', async () => {
    const onError = mock(() => {})
    const boot = Boot0.create({ logger: { enabled: false }, onError })
    const svc = boot.createService('s', {
      start: () => ({}),
      stop: () => {
        throw new Error('stop failed')
      },
    })
    await boot.startService(svc)
    await boot.stopService(svc) // must not throw
    expect(onError).toHaveBeenCalledTimes(1)
    expect(svc[SERVICE].status).toBe('stopped')
  })
})

describe('hooks', () => {
  it('runs global then local hooks', async () => {
    const order: string[] = []
    const boot = Boot0.create({
      logger: { enabled: false },
      onServiceStarting: ({ name }) => {
        order.push(`global starting ${name}`)
      },
      onServiceStarted: ({ name }) => {
        order.push(`global started ${name}`)
      },
    })
    const svc = boot.createService('s', {
      start: () => ({}),
      onStarting: () => {
        order.push('local starting')
      },
      onStarted: () => {
        order.push('local started')
      },
    })
    await boot.startService(svc)
    expect(order).toEqual(['global starting s', 'local starting', 'global started s', 'local started'])
  })
})

describe('hidden services', () => {
  it('keeps the manager at runtime and is managed via instance functions', async () => {
    const boot = quiet()
    const svc = boot.createService('hidden', { hidden: true, start: () => ({ ok: true }) })

    expect(boot.isServiceStarted(svc)).toBe(false)
    await boot.startService(svc)
    expect(svc.ok).toBe(true)
    expect(boot.isServiceStarted(svc)).toBe(true)
  })

  it('getStatus and getOriginal work on a hidden service', async () => {
    const boot = quiet()
    const raw = { v: 1 }
    const svc = boot.createService('hidden', { hidden: true, start: () => raw })

    expect(boot.getStatus(svc)).toBe('idle')
    await boot.startService(svc)
    expect(boot.getStatus(svc)).toBe('started')
    expect(boot.getOriginal(svc)).toBe(raw)
    expect(boot.getOriginal(svc).v).toBe(1) // type inferred, no generic needed
  })
})

describe('instance teardown', () => {
  it('stops orphan services and shutdown hooks in reverse registration order', async () => {
    const boot = quiet()
    const order: string[] = []
    const svc = boot.createService('orphan', {
      start: () => ({}),
      stop: () => {
        order.push('stop orphan')
      },
    })
    await boot.startService(svc) // started outside any runtime

    boot.onShutdown('cb1', () => {
      order.push('cb 1')
    })
    boot.onShutdown('cb2', () => {
      order.push('cb 2')
    })

    await boot.stop()
    expect(boot.isServiceStarted(svc)).toBe(false)
    expect(order).toEqual(['cb 2', 'cb 1', 'stop orphan'])
  })

  it('onShutdown registers a named hook that runs on stop and is logged', async () => {
    const lines: string[] = []
    const boot = Boot0.create({ logger: { log: ({ message }) => lines.push(message) } })
    const ran = mock(() => {})
    const hook = boot.onShutdown('cleanup', ran)
    expect(boot.getStatus(hook)).toBe('started')
    await boot.stop()
    expect(ran).toHaveBeenCalledTimes(1)
    expect(lines.some((m) => m.includes('shutdown hook "cleanup"'))).toBe(true)
  })

  it('stops every runtime of the instance', async () => {
    const boot = quiet()
    const a = boot.createService('a', { start: () => ({}) })
    const b = boot.createService('b', { start: () => ({}) })
    const one = boot.createRuntime('one', { a })
    const two = boot.createRuntime('two', { b })

    await one.start()
    await two.start()
    await boot.stop()

    expect(one.status).toEqual({ a: 'stopped' })
    expect(two.status).toEqual({ b: 'stopped' })
  })
})

describe('idempotency', () => {
  it('starts a service only once', async () => {
    const boot = quiet()
    const start = mock(() => ({}))
    const svc = boot.createService('s', { start })

    await boot.startService(svc)
    await boot.startService(svc)
    expect(start).toHaveBeenCalledTimes(1)
  })

  it('stop is a no-op before start and runs once', async () => {
    const boot = quiet()
    const stop = mock(() => {})
    const svc = boot.createService('s', { start: () => ({}), stop })

    await boot.stopService(svc) // before start: no-op
    expect(stop).not.toHaveBeenCalled()

    await boot.startService(svc)
    await boot.stopService(svc)
    await boot.stopService(svc) // already stopped: no-op
    expect(stop).toHaveBeenCalledTimes(1)
  })
})

describe('async lifecycle', () => {
  it('awaits async start and keeps dependency order', async () => {
    const boot = quiet()
    const order: string[] = []
    const a = boot.createService('a', {
      start: async () => {
        await delay(5)
        order.push('a')
        return { v: 1 }
      },
    })
    const b = boot.createService('b', {
      deps: { a },
      start: async () => {
        await delay(1)
        order.push('b')
        return { v: a.v + 1 }
      },
    })

    await boot.createRuntime('app', { a, b }).start()
    expect(order).toEqual(['a', 'b'])
    expect(b.v).toBe(2)
  })
})

describe('transparent dependency restart', () => {
  it('dependents see the new value after a dependency restarts', async () => {
    const boot = quiet()
    let build = 0
    const config = boot.createService('config', { start: () => ({ build: ++build }) })
    const reader = boot.createService('reader', {
      deps: { config },
      start: () => ({ read: () => config.build }), // captures the proxy, not the value
    })

    await boot.createRuntime('app', { config, reader }).start()
    expect(reader.read()).toBe(1)

    await boot.restartService(config)
    expect(reader.read()).toBe(2) // same reader, new config value
  })
})

describe('proxy behavior', () => {
  it('forwards property enumeration once started', async () => {
    const boot = quiet()
    const svc = boot.createService('s', { start: () => ({ a: 1, b: 2 }) })
    await boot.startService(svc)

    expect('a' in svc).toBe(true)
    expect(Object.keys(svc).sort()).toEqual(['a', 'b'])
    expect({ ...svc } as unknown as Record<string, number>).toEqual({ a: 1, b: 2 })
  })
})

describe('error policy', () => {
  it('passes start failures to onError with scope, name, and phase', async () => {
    const seen: unknown[] = []
    const boot = Boot0.create({
      logger: { enabled: false },
      onError: (_error, info) => seen.push(info),
    })
    const svc = boot.createService('flaky', {
      start: (): { v: number } => {
        throw new Error('nope')
      },
    })

    await boot.startService(svc).catch(() => {})
    expect(seen).toEqual([{ scope: 'service', name: 'flaky', phase: 'start' }])
  })

  it('transformError normalizes the error before onError and rethrow', async () => {
    class AppError extends Error {}
    const seen: unknown[] = []
    const boot = Boot0.create({
      logger: { enabled: false },
      transformError: (error) => new AppError(String((error as Error).message)),
      onError: (error) => seen.push(error),
    })
    const svc = boot.createService('s', {
      start: (): { v: number } => {
        throw new Error('raw')
      },
    })

    const rejected = await boot.startService(svc).catch((error: unknown) => error)
    expect(rejected).toBeInstanceOf(AppError)
    expect(seen[0]).toBeInstanceOf(AppError)
  })

  it('runs shutdown(1) on an unrecoverable start error when configured', async () => {
    const exit = spyOn(process, 'exit').mockImplementation((() => undefined) as never)
    try {
      const boot = Boot0.create({ logger: { enabled: false }, shutdownOnError: true })
      const a = boot.createService('a', { start: () => ({ v: 1 }), stop: () => {} })
      const b = boot.createService('b', {
        deps: { a },
        start: (): { v: number } => {
          throw new Error('boom')
        },
      })

      await boot.createRuntime('app', { a, b }).start()
      expect(exit).toHaveBeenCalledWith(1)
      expect(boot.isServiceStarted(a)).toBe(false) // rolled back before exit
    } finally {
      exit.mockRestore()
    }
  })
})

describe('logging', () => {
  it('logs lifecycle events with levels through the logger', async () => {
    const lines: Array<[string, string]> = []
    const boot = Boot0.create({ logger: { log: ({ level, message }) => lines.push([level, message]) } })
    const a = boot.createService('a', { start: () => ({}) })
    const app = boot.createRuntime('app', { a })

    await app.start()
    await app.stop()

    expect(lines).toContainEqual(['info', 'service "a" started'])
    expect(lines).toContainEqual(['info', 'service "a" stopped'])
    expect(lines).toContainEqual(['info', 'runtime "app" started'])
    expect(lines).toContainEqual(['info', 'runtime "app" stopped'])
  })

  it('logs failures at error level', async () => {
    const lines: Array<[string, string]> = []
    const boot = Boot0.create({ logger: { log: ({ level, message }) => lines.push([level, message]) } })
    const a = boot.createService('a', {
      start: (): { v: number } => {
        throw new Error('x')
      },
    })

    await boot.startService(a).catch(() => {})
    expect(lines.some(([level]) => level === 'error')).toBe(true)
  })

  it('stays silent when disabled', async () => {
    const log = mock(() => {})
    const boot = Boot0.create({ logger: { log, enabled: false } })
    const a = boot.createService('a', { start: () => ({}) })
    await boot.startService(a)
    expect(log).not.toHaveBeenCalled()
  })
})

describe('shutdown options', () => {
  it('forces exit after shutdownTimeoutMs when teardown hangs', async () => {
    const exit = spyOn(process, 'exit').mockImplementation((() => undefined) as never)
    try {
      const boot = Boot0.create({ logger: { enabled: false }, shutdownTimeoutMs: 30 })
      const svc = boot.createService('slow', {
        start: () => ({}),
        stop: () => new Promise<void>(() => {}), // never resolves
      })
      await boot.startService(svc)
      await boot.shutdown(0)
      expect(exit).toHaveBeenCalledWith(0)
    } finally {
      exit.mockRestore()
    }
  })

  it('registers uncaught handlers when shutdownOnUncaught is set', () => {
    const beforeEx = process.listeners('uncaughtException')
    const beforeRej = process.listeners('unhandledRejection')
    Boot0.create({ logger: { enabled: false }, shutdownOnUncaught: true })
    const addedEx = process.listeners('uncaughtException').filter((fn) => !beforeEx.includes(fn))
    const addedRej = process.listeners('unhandledRejection').filter((fn) => !beforeRej.includes(fn))
    expect(addedEx).toHaveLength(1)
    expect(addedRej).toHaveLength(1)
    for (const fn of addedEx) {
      process.removeListener('uncaughtException', fn)
    }
    for (const fn of addedRej) {
      process.removeListener('unhandledRejection', fn)
    }
  })
})

// Type-level tests. This function is never called — `tsc` checks its body, and
// runtime access on an unstarted proxy would throw, so it must not execute.
function assertTypes() {
  const boot = Boot0.create()
  const db = boot.createService('db', { start: () => ({ rows: 7 }) })
  const cache = boot.createService('cache', { hidden: true, start: () => new Map<string, number>() })
  const app = boot.createRuntime('app', { db })

  // the proxy is typed as the value, with the manager on the symbol
  expectTypeOf(db.rows).toBeNumber()
  expectTypeOf(db[SERVICE]).toEqualTypeOf<ServiceManager<{ rows: number }>>()

  // helpers infer the value from the service — no generic needed
  expectTypeOf(boot.getOriginal(db)).toEqualTypeOf<{ rows: number }>()
  expectTypeOf(boot.startService(db)).toEqualTypeOf<Promise<{ rows: number }>>()
  expectTypeOf(boot.getStatus(db)).toEqualTypeOf<ServiceStatus>()

  // hidden strips the manager from the type
  expectTypeOf(cache).toEqualTypeOf<Map<string, number>>()
  expectTypeOf(boot.getOriginal(cache)).toEqualTypeOf<Map<string, number>>()

  // a runtime exposes its services and a status map
  expectTypeOf(app.db).toEqualTypeOf<typeof db>()
  expectTypeOf(app.status).toEqualTypeOf<Record<'db', ServiceStatus>>()
}

describe('types', () => {
  it('compile-time type assertions hold', () => {
    expect(typeof assertTypes).toBe('function') // referenced so tsc checks it; never invoked
  })
})
