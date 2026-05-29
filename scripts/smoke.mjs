// Post-build smoke test: verifies the published artifact loads under plain Node
// and that the package "exports" map resolves.
import { Boot0, SERVICE } from '../dist/index.js'

const assert = (cond, msg) => {
  if (!cond) {
    console.error('smoke test failed:', msg)
    process.exit(1)
  }
}

const boot = Boot0.create({ logger: { enabled: false } })

const config = boot.createService('config', { start: () => ({ port: 3000 }) })
const server = boot.createService('server', {
  deps: { config },
  start: () => ({ url: `http://localhost:${config.port}` }),
})

let threw = false
try {
  void server.url
} catch {
  threw = true
}
assert(threw, 'using a service before start should throw')

const app = boot.createRuntime('app', { config, server })
await app.start()

assert(server.url === 'http://localhost:3000', 'service should resolve deps after start')
assert(boot.isServiceStarted(server), 'isServiceStarted should be true after start')
assert(server[SERVICE].status === 'started', 'manager status should be "started"')

await app.stop()
assert(server[SERVICE].status === 'stopped', 'manager status should be "stopped" after stop')

console.log('smoke ok')
