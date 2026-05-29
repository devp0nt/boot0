import type { InternalManager } from './types.js'

/**
 * Transitive, dependencies-first order for the given targets. Stop is the reverse. Throws on a dependency cycle.
 */
export const orderForStart = (targets: InternalManager[]): InternalManager[] => {
  const ordered: InternalManager[] = []
  const done = new Set<InternalManager>()
  const onStack = new Set<InternalManager>()

  const visit = (manager: InternalManager, trail: string[]): void => {
    if (done.has(manager)) {
      return
    }
    if (onStack.has(manager)) {
      throw new Error(`boot0: dependency cycle: ${[...trail, manager.name].join(' -> ')}`)
    }
    onStack.add(manager)
    for (const dep of manager.deps) {
      visit(dep, [...trail, manager.name])
    }
    onStack.delete(manager)
    done.add(manager)
    ordered.push(manager)
  }

  for (const manager of targets) {
    visit(manager, [])
  }
  return ordered
}
