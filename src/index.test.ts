import { describe, expect, it, mock } from 'bun:test'
import { Boot0, SERVICE } from './index.js'

const quiet = () => Boot0.create({ logger: { enabled: false } })

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

    expect(boot.createRuntime('app', { a, b }).start()).rejects.toThrow(/dependency cycle/)
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
})

describe('instance teardown', () => {
  it('stops orphan services and runs onShutdown callbacks (LIFO)', async () => {
    const boot = quiet()
    const order: string[] = []
    const svc = boot.createService('orphan', {
      start: () => ({}),
      stop: () => {
        order.push('stop orphan')
      },
    })
    await boot.startService(svc) // started outside any runtime

    boot.onShutdown(() => {
      order.push('cb 1')
    })
    boot.onShutdown(() => {
      order.push('cb 2')
    })

    await boot.stop()
    expect(boot.isServiceStarted(svc)).toBe(false)
    expect(order).toEqual(['stop orphan', 'cb 2', 'cb 1'])
  })

  it('onShutdown returns an unregister function', async () => {
    const boot = quiet()
    const cb = mock(() => {})
    const off = boot.onShutdown(cb)
    off()
    await boot.stop()
    expect(cb).not.toHaveBeenCalled()
  })
})
