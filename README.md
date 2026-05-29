# @devp0nt/boot0

> Tiny dependency injector and lifecycle manager.

[![CI](https://github.com/devp0nt/boot0/actions/workflows/ci.yml/badge.svg)](https://github.com/devp0nt/boot0/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/@devp0nt/boot0.svg)](https://www.npmjs.com/package/@devp0nt/boot0)
[![license](https://img.shields.io/npm/l/@devp0nt/boot0.svg)](./LICENSE)

<!-- docs:start -->

Declare your services as plain functions. boot0 hands back a stable, typed proxy
you can import anywhere — before anything starts. Call `start`, and the real
value appears behind the proxy, in dependency order. No classes, no decorators.

The trick: the exported reference never changes identity. So a service uses its
dependencies directly, and restarting one is invisible to the others.

```ts
import { Boot0 } from '@devp0nt/boot0'

const boot = Boot0.create()

// A service is a function that returns a value. Export the proxy.
export const db = boot.createService('db', {
  start: async () => {
    const client = new Client(process.env.DATABASE_URL)
    await client.connect()
    return client
  },
  stop: (client) => client.end(),
})

// `db` is typed as Client. Touch it before start and it throws — on purpose.
db.query('select 1') // throws: db used before start

// Other services depend on it. deps set the order; use the proxy directly.
export const users = boot.createService('users', {
  deps: { db },
  start: () => ({ all: () => db.query('select * from users') }),
})

// A runtime starts a group in order and stops it in reverse.
const app = boot.createRuntime('app', { db, users })
await app.start() // db, then users
await app.stop() //  users, then db
```

## Install

```sh
bun add @devp0nt/boot0
# or: npm install / pnpm add / yarn add
```

Bun 1+ or Node.js 20+. ESM only.

## Import the proxy anywhere

The value you export is a proxy with a fixed identity. Import it across your
codebase before anything is running — no init order to juggle, no
circular-import dance.

```ts
import { db } from './services/db.js'

// Before start: any use throws with a clear message.
db.query('...') // throws: service "db" used before start (status: "idle")
```

Once started, the proxy forwards everything to the real value — properties,
method calls, even calling the service if it is a function.

```ts
const greet = boot.createService('greet', {
  start: () => (name: string) => `hi, ${name}`,
})

await boot.startService(greet)
greet('Sergei') // 'hi, Sergei'
```

## Wire dependencies

`deps` declares the start order — that is its only job. It is **not** injection.
Inside `start` and `stop`, reach for the proxies directly.

```ts
const migrate = boot.createService('migrate', {
  deps: { db }, // edge: run after db is up
  start: () => runMigrations(db), // db used directly — it's already started here
})
```

A side effect with no value (a migration, a cache warm-up) is just a service
that returns nothing. It joins the same graph.

Need a service only inside a method, not at start? Skip `deps` and use its proxy
directly — `deps` sets start order, while method calls run later, when
everything is up. Two services can use each other this way, as long as the
`deps` edges don't form a cycle.

## Return any shape

A service returns whatever you want — the raw client, or an object that holds it
next to your own helpers. That object becomes the service's API.

```ts
const db = boot.createService('db', {
  start: async () => {
    const client = new Client(process.env.DATABASE_URL)
    await client.connect()
    return {
      client, // the real instance, reached as db.client
      ping: () => client.query('select 1'),
    }
  },
  stop: (db) => db.client.end(),
})

await db.ping()
db.client.query('...') // the genuine Client — full identity, no proxy edges
```

## Run a group

A runtime starts a set of services in dependency order and stops them in
reverse. The services are also on the runtime, so `app.db` works too.

```ts
const app = boot.createRuntime('app', { db, users, migrate })

await app.start() //          db → migrate → users
await app.start(['users']) // start one service plus its deps
await app.stop() //           reverse order
await app.restart()

app.db // the db proxy
app.status // { db: 'started', users: 'started', migrate: 'started' }
```

## Control one service

Each service carries its own lifecycle, so you can drive it without a runtime.

```ts
await boot.startService(db)
await boot.restartService(db) // dependents keep their proxy — they don't notice
boot.isServiceStarted(db) // true
boot.getStatus(db) // 'started'
boot.getOriginal<Client>(db) // the real Client, unproxied

// Or through the manager on the symbol:
import { SERVICE } from '@devp0nt/boot0'
db[SERVICE].status // 'started'
db[SERVICE].original // same as boot.getOriginal(db)
await db[SERVICE].stop()
```

`getStatus`, `getOriginal`, and the `*Service` functions take the proxy and read
the manager for you — so they also work for
[hidden](#hide-the-manager-from-the-type) services, where `service[SERVICE]`
isn't on the type.

## Shut down cleanly

`stop` tears down the level below; `shutdown` stops everything and exits. The
instance tracks every service and runtime it made, so teardown catches them all
— even services you started outside a runtime.

```ts
await boot.stop() // stop all runtimes, then any leftover services
await boot.shutdown() // stop everything, run onShutdown callbacks, then exit

// Register cleanup that isn't a service:
boot.onShutdown(() => clearTempDir())

// Or wire it to signals at create time:
const boot = Boot0.create({ shutdownOnSignals: true }) // SIGINT / SIGTERM → shutdown()
```

## Hide the manager from the type

By default the proxy type is `T & { [SERVICE]: ... }`. Pass `hidden: true` and
the type becomes exactly `T` — a drop-in replacement for the value. The manager
still lives at runtime; drive it through the instance functions.

```ts
export const cache = boot.createService('cache', {
  hidden: true,
  start: () => new Map<string, unknown>(),
})

cache.set('k', 1) // typed as a plain Map<string, unknown>
await boot.restartService(cache) // lifecycle still works
```

## Errors

boot0 splits errors in two:

- **Setup mistakes throw** — using a service before start, passing a non-service
  as a dependency, or a dependency cycle. These fail fast, before anything runs.
- **Runtime failures are logged** — a `start` or `stop` that throws is caught,
  passed through `transformError`, logged, and handed to `onError`. A failed
  group start rolls back what it already started.

```ts
const boot = Boot0.create({
  // Normalize any thrown value into your own error type — runs first.
  transformError: (error, info) => new AppError(error, info),
  onError: (error, info) => report(error, info), // info: { scope, name, phase }
  shutdownOnError: true, // an unrecoverable start error → shutdown(1)
})
```

The result of `transformError` is what gets logged, sent to `onError`, and
rethrown — so a `start` caller rejects with your error type.

## Logging

boot0 logs its own lifecycle — `service "db" started`, `runtime "app" stopped`,
a failure — each as one entry: `{ level, message, error?, meta? }`. Route it
into any logger.

```ts
const boot = Boot0.create({
  // enabled by default; pass enabled: false to silence
  logger: {
    log: ({ level, message, error, meta }) =>
      pino()[level]({ ...meta, err: error }, message),
  },
})
```

`meta` carries structured context like `{ scope, name, phase }`. Levels: `debug`
for starting/stopping, `info` for started/stopped, `warn` for a hook that threw,
`error` for a start/stop failure.

## Hooks

For your own observability, add hooks. Global hooks live on the instance; local
hooks live on a service or runtime and run after the global ones.

```ts
const boot = Boot0.create({
  onServiceStarted: ({ name }) => metrics.up(name),
})

boot.createService('db', {
  start: () => connect(),
  onStarted: () => console.log('db ready'), // runs after the global hook
})
```

## Where it fits

Wiring two services by hand is fine. But once you have a few stateful ones — db,
queue, http, workers — that must start in order, restart, and shut down cleanly,
hand-wiring gets fiddly, and a decorator container (tsyringe, Inversify) or
Effect is more than you wanted.

boot0 is the middle: plain functions, typed proxies, ordered start and stop, and
graceful shutdown — no decorators, no `reflect-metadata`, nothing new to adopt.
If that's your app, it's the right size.

## API reference

### `Boot0.create(config?)`

| Config field                                   | Type                       | What it does                               |
| ---------------------------------------------- | -------------------------- | ------------------------------------------ |
| `logger`                                       | `{ log, enabled }`         | Your log function and an on/off switch.    |
| `onService{Starting,Started,Stopping,Stopped}` | `({ name }) => void`       | Global service lifecycle hooks.            |
| `onRuntime{Starting,Started,Stopping,Stopped}` | `({ name }) => void`       | Global runtime lifecycle hooks.            |
| `onError`                                      | `(error, info) => void`    | Called on any runtime failure.             |
| `transformError`                               | `(error, info) => unknown` | Normalize a thrown value (runs first).     |
| `shutdownOnError`                              | `boolean`                  | Unrecoverable start error → `shutdown(1)`. |
| `shutdownOnSignals`                            | `boolean`                  | SIGINT / SIGTERM → `shutdown()`.           |

### Instance

| Call                                  | Result                                                         |
| ------------------------------------- | -------------------------------------------------------------- |
| `createService(name, def)`            | A typed proxy for the service.                                 |
| `createRuntime(name, services, opts)` | A runtime: `start` / `stop` / `restart` / `status` + services. |
| `startService(x)` / `stopService(x)`  | Start / stop one service.                                      |
| `restartService(x)`                   | Stop then start one service.                                   |
| `isServiceStarted(x)`                 | `boolean`.                                                     |
| `getStatus(x)`                        | The service's `ServiceStatus`.                                 |
| `getOriginal<T>(x)`                   | The started value, unproxied (throws before start).            |
| `stop()`                              | Stop all runtimes, then leftover services.                     |
| `shutdown(code?)`                     | `stop()` + run `onShutdown` callbacks + `process.exit`.        |
| `onShutdown(cb)`                      | Register a teardown callback. Returns an unregister function.  |

### `createService(name, def)`

| `def` field                             | Type                    | What it does                             |
| --------------------------------------- | ----------------------- | ---------------------------------------- |
| `start`                                 | `() => T`               | Build the value. Its return is the type. |
| `stop`                                  | `(value) => void`       | Tear the value down.                     |
| `deps`                                  | `Record<string, _>`     | Services to start first (order only).    |
| `hidden`                                | `boolean`               | Hide the manager from the type.          |
| `on{Starting,Started,Stopping,Stopped}` | `() => void`            | Local lifecycle hooks.                   |
| `onError`                               | `(error, info) => void` | Called when this service fails.          |

### Service manager — `service[SERVICE]`

| Member                             | Result                                                    |
| ---------------------------------- | --------------------------------------------------------- |
| `name`                             | The service name.                                         |
| `status`                           | `idle` → `starting` → `started` → `stopping` → `stopped`. |
| `original`                         | The started value, unproxied (throws before start).       |
| `start()` / `stop()` / `restart()` | Drive this service.                                       |

## Good to know

boot0 is a `Proxy` over your value — that's what gives you the stable reference.
For the everyday case (read a property, call a method) it forwards to the real
value and you never notice. Methods keep the right `this`, so private fields
work.

One thing worth knowing: if you return a class instance **directly** and some
code checks its identity — `instanceof`, a `WeakMap` keyed by it, an internal
brand check — that code sees the proxy, not the instance. The fix is the pattern
from [Return any shape](#return-any-shape): return `{ client }` and reach the
real instance as `service.client`. One extra property, every edge gone.

Two small notes: `typeof service` is always `'function'` (the proxy target is a
function), and proxy access has a tiny cost — in a hot loop, grab
`boot.getOriginal(service)` once. That's the whole list.

## Requirements

- **Bun 1+** or **Node.js 20+** (ESM only)
- **TypeScript 5+** (optional — works in plain JS too)

<!-- docs:end -->

## Community

Questions, bugs, or want to hang with other builders? Join the devp0nt community
— one hub for all our open-source projects, this one included. Get help, share
what you built, or just say hi: [p0nt.dev/community](https://p0nt.dev/community)

## Contributing

Issues and PRs welcome. See [CONTRIBUTING.md](./CONTRIBUTING.md) and the
[Code of Conduct](./CODE_OF_CONDUCT.md). Commits follow
[Conventional Commits](https://www.conventionalcommits.org/). Security reports:
[SECURITY.md](./SECURITY.md).

## License

[MIT](./LICENSE)

---

```text
Building open-source software for the glory of the Lord Jesus Christ ☦️
With love for developers of all backgrounds around the world ❤️
Sergei Dmitriev, 2026 😎
```
