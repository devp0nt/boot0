# boot0 — PLAN (v0.1)

Working doc, not published. Awaiting approval before scaffold/code.

## Name

- Package: `@devp0nt/boot0` (npm name free).
- Status stage on creation: `dev` (private, no CI/CD).

## Pitch

Minimal dependency injector that is also a lifecycle manager — bring your whole
system up and down in order. Pure functions, no classes. A service is ultimately
a function or an object, but what you export is a **proxy** with a stable
identity you can import everywhere _before_ anything is started. Using it before
start throws; after `start()` the real value lives behind the proxy. Its
lifecycle manager rides along at `[SERVICE]`.

The one thing it does that the obvious alternatives don't: a stable, typed
reference you import before start, so a dependency restart is transparent to its
dependents (they hold the proxy, not the value).

## Core model

1. **Boot instance** — `Boot0.create(config)` carries shared config (logger,
   hooks, error/exit policy) and produces everything bound to it.
2. **Service** — a unit with a lifecycle that produces a function or object.
3. **Proxy-ref** — what you export. Typed as the value `T`. Throws on use before
   start. Manager at `[SERVICE]`, raw value at `[SERVICE].original`.
4. **Runtime** — orchestrates a set of services: topological start, reverse
   stop, subset selection, cycle detection, rollback.

Ownership: **the service owns its manager** (so `startService(x)` /
`x[SERVICE].start()` work standalone); **the runtime orchestrates** groups.

## The instance + config

```ts
const boot = Boot0.create({
  logger: { log: console.log, enabled: true }, // log = your logger fn
  // global hooks (service vs runtime distinguished at this level):
  onServiceStarting,
  onServiceStarted,
  onServiceStopping,
  onServiceStopped,
  onRuntimeStarting,
  onRuntimeStarted,
  onRuntimeStopping,
  onRuntimeStopped,
  onError,
  shutdownOnError: true, // unrecoverable error → boot.shutdown(1)
  shutdownOnSignals: true, // SIGINT/SIGTERM/beforeExit → boot.shutdown()
})
```

- **Logger:** `log` is your function (plug your own logger); `enabled` toggles.
  All internal messages flow through it.
- **Hooks naming:** global config distinguishes `onService*` / `onRuntime*`;
  local hooks (on a service/runtime) are just
  `onStarting/onStarted/onStopping/ onStopped` — context is already clear.
  **Local hooks extend the global ones, they don't replace them.**
- **Default instance:** besides `Boot0.create(...)`, ship ready
  `createService`/`createRuntime`/`startService`/`isServiceStarted` as named
  exports (a default boot with default config) for zero-ceremony use.

## Instance-level teardown

Naming principle: `stop` tears down the level below; `shutdown` = stop
everything

- exit the process. The instance **registers every service and runtime it
  creates**, so teardown catches them all — including services started
  standalone.

* `boot.stop()` — stop **all runtimes** of this instance, then **any service
  still started outside a runtime** (via `startService` / `x[SERVICE].start()`).
  Process stays alive.
* `boot.shutdown(code?)` — `boot.stop()` + run `onShutdown` callbacks +
  `process.exit(code)` (default `0`).
* `boot.onShutdown(cb)` — register an ad-hoc teardown callback (not a service).
  Runs on **any** teardown — both `stop()` and `shutdown()`.

Teardown order: stop runtimes (reverse) → sweep remaining `started` services
(orphans) in reverse topo order → run `onShutdown` callbacks (LIFO) → if
`shutdown`, exit. Config `shutdownOnError` / `shutdownOnSignals` fire
`boot.shutdown()` automatically.

## Lifecycle — `start` / `stop` only

`start` builds + connects and returns the value; `stop` tears it down. No
`create` in v0.1.

| Phase                  | Behind the proxy     |
| ---------------------- | -------------------- |
| `idle` (before start)  | nothing → **throws** |
| `started`              | result of `start()`  |
| `stopped` (after stop) | nothing → **throws** |

States: `idle → starting → started → stopping → stopped`.

## Dependencies — for ordering, not access

`deps` declared in `createService({ deps })` define **graph edges** — topo order
for start (reverse for stop) and the dep validation below. That's their only
job.

They are **not needed for access**: inside `start` / `stop` you reference the
dep **proxies directly** — they're stable proxies, which is the whole point. So
the injected-deps form is equivalent to using the proxy directly:

```ts
start: ({ prisma }) => runMigrations(prisma) // injected — redundant
start: () => runMigrations(prisma) // proxy used directly — idiomatic
```

v0.1 decision: callbacks take **no deps arg** (`start()`, `stop(value)`). The
injected-deps arg is redundant today; it returns only with **override** (dep
substitution for tests/mocks) — parked. Because you use proxies directly, a
dependency restart is transparent to dependents.

## Errors — no custom error class

Split by kind. Plain `Error` with clear messages — no custom class, no `error0`.

- **Setup / programmer errors throw** (fail fast, before anything runs):
  - **use-before-start** — `prisma.user.findMany()` before start: no value
    exists, logging is pointless.
  - **bad deps** — a value in `deps` / `createRuntime(services)` that is not a
    boot0 service (no `[SERVICE]`): caught at construction time.
  - **dependency cycle** — detected when building the graph.
- **Runtime errors log** — the thing is "unbreakable": start/stop failures are
  **caught → logged → `onError` → policy** (`exitOnError` decides exit;
  otherwise rollback already-started).

## Hero example

```ts
import { Boot0 } from '@devp0nt/boot0'

const boot = Boot0.create({ logger: { log: console.log, enabled: true } })

// Declare. Pure functions; deps wired once, injected into start/stop.
export const prisma = boot.createService('prisma', {
  start: async () => {
    const p = new PrismaClient()
    await p.$connect()
    return p
  },
  stop: (p) => p.$disconnect(),
})

export const pgboss = boot.createService('pgboss', {
  deps: { prisma }, // edge: start prisma first (ordering, not injection)
  start: async () => {
    // reference any proxy directly inside
    const b = new PgBoss(process.env.DATABASE_URL!)
    await b.start()
    return b
  },
  stop: (b) => b.stop(),
  onStarted: () => {
    /* local hook, runs after the global one */
  },
})

// Import the proxy anywhere — typed as PrismaClient. Throws before start.
await prisma.user.findMany()

// Orchestrate.
const ctx = boot.createRuntime('main', { prisma, pgboss })
await ctx.start() // topo: prisma → pgboss
await ctx.start(['pgboss']) // subset (+ its deps)
await ctx.stop() // reverse: pgboss → prisma
ctx.prisma // services are exposed on the runtime too

// Per-service control.
await boot.restartService(prisma) // = prisma[SERVICE].restart()
boot.isServiceStarted(prisma) // boolean
prisma[SERVICE].status // 'started'
prisma[SERVICE].original // raw PrismaClient, unproxied
```

### onInit / onShutdown = a service that returns void

```ts
export const migrate = boot.createService('migrate', {
  deps: { prisma }, // edge only: run after prisma
  start: () => runMigrations(prisma), // proxy used directly
})
```

## Public API (v0.1)

- `Boot0.create(config)` → boot instance.
- `boot.createService(name, { deps?, start, stop?, hidden?, onStarting?, onStarted?, onStopping?, onStopped?, onError? })`
  → `Service<T, Hidden>` =
  `Hidden extends true ? T : T & { [SERVICE]: Manager<T> }`.
- `boot.createRuntime(name, services, { onStarting?, onStarted?, onStopping?, onStopped?, onError? }?)`
  → `S & { start, stop, restart, status }` — control methods (each accepting an
  optional subset) **plus the services themselves**, so `ctx.prisma` works.
  Validates at construction that every value in `services`/their `deps` is a
  boot0 service. Reserved names: `start` / `stop` / `restart` / `status`.
- `boot.startService(x)`, `boot.stopService(x)`, `boot.restartService(x)`,
  `boot.isServiceStarted(x)`.
- `boot.stop()`, `boot.shutdown(code?)`, `boot.onShutdown(cb)` — instance-level
  teardown (stop all runtimes **+ orphan services** / + exit / register
  cleanup).
- `x[SERVICE]` — manager:
  `{ name, status, start(), stop(), restart(), original }`.
- `SERVICE` symbol + default-instance named exports (`createService`, …).

Name is the **first positional arg** for both `createService` / `createRuntime`
— mandatory and identifying; a runtime's services map can't safely carry a
`name` key, so positional keeps the two consistent.

Type inference: `T` from `start`'s (awaited) return. Proxy target is a function
so both `apply` (callable services) and `get` (object services) traps work.

## Hiding the manager from the type (`hidden`)

`hidden: true` removes the manager from the **type** — `createService` returns
exactly `T`, no `& { [SERVICE]: Manager<T> }`. The proxy becomes a
pixel-identical drop-in for the underlying value. The symbol is **still attached
at runtime** (type-only hiding). Resolved with a conditional return type:

```ts
type Service<T, Hidden extends boolean> = Hidden extends true
  ? T
  : T & { readonly [SERVICE]: Manager<T> }

function createService<T, const Hidden extends boolean = false>(def: {
  name: string
  hidden?: Hidden
  // ...
}): Service<Awaited<T>, Hidden>
```

Consequence: under `hidden: true`, `prisma[SERVICE]` no longer typechecks —
manage lifecycle via the instance functions (`boot.restartService(prisma)`,
`boot.isServiceStarted(prisma)`), which accept `T` and read the symbol
internally. Type escape hatch: `(prisma as any)[SERVICE]`. Default is
`hidden: false`.

## Scope

**In (v0.1):** `Boot0.create` + config (logger, global/local hooks, onError,
exitOnError, stopOnExit); createService (start/stop, deps as ordering edges);
proxy ref + manager + `original`; optional `hidden` (type-only manager hiding);
control methods incl. `isServiceStarted`; createRuntime (topo start, reverse
stop, subset, cycle detection, start rollback, status map, services exposed as
props); construction-time validation (deps/services are boot0 services);
instance-level `stop`/`shutdown`/`onShutdown` +
`shutdownOnError`/`shutdownOnSignals`; default-instance exports; async
lifecycle; setup errors throw / runtime errors log.

**Out (parked):** separate `create`; deps override at start; `split` runtime
tuple `[proxy, manager]` / `policy` return-shape (runtime always returns the
full proxy; `hidden` is type-only); hook sugar — covered by void services.

## Infra

- **Dependencies:** zero runtime deps. Peer: none.
- **Sub-path exports:** none for v0.1 (single `src/index.ts`).
- **Beyond standard stack:** nothing — blank0 infra is enough.
- **Keywords:** `dependency-injection`, `di`, `ioc`, `lifecycle`, `service`,
  `runtime`, `bootstrap`, `supervisor`, `graceful-shutdown`, `typescript`.

## Open questions

1. **Status names** — `idle / starting / started / stopping / stopped` ok?
2. **Symbol** — module-private `Symbol('boot0')` exported as `SERVICE`
   (recommended) vs global `Symbol.for(...)`. Export name `SERVICE` vs `BOOT`?
3. **`onError` signature** —
   `onError(err, { scope: 'service'|'runtime', name, phase })`?
