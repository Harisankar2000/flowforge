export interface DagNode {
  key: string;
  dependsOn: readonly string[];
}

export type DagValidationResult = { ok: true; order: string[] } | { ok: false; errors: string[] };

/**
 * Validates step references and returns a topological order (Kahn's algorithm).
 * Declaration order is preserved among steps that are ready at the same time.
 */
export function validateDag(nodes: readonly DagNode[]): DagValidationResult {
  const errors: string[] = [];
  const keys = new Set<string>();

  for (const node of nodes) {
    if (keys.has(node.key)) errors.push(`Duplicate step key '${node.key}'`);
    keys.add(node.key);
  }

  for (const node of nodes) {
    for (const dependency of node.dependsOn) {
      if (dependency === node.key) {
        errors.push(`Step '${node.key}' cannot depend on itself`);
      } else if (!keys.has(dependency)) {
        errors.push(`Step '${node.key}' depends on unknown step '${dependency}'`);
      }
    }
  }

  if (errors.length > 0) return { ok: false, errors };

  const inDegree = new Map<string, number>();
  const dependents = new Map<string, string[]>();
  for (const node of nodes) {
    inDegree.set(node.key, new Set(node.dependsOn).size);
    for (const dependency of new Set(node.dependsOn)) {
      dependents.set(dependency, [...(dependents.get(dependency) ?? []), node.key]);
    }
  }

  const queue = nodes.filter((node) => inDegree.get(node.key) === 0).map((node) => node.key);
  const order: string[] = [];

  while (queue.length > 0) {
    const key = queue.shift() as string;
    order.push(key);
    for (const dependent of dependents.get(key) ?? []) {
      const remaining = (inDegree.get(dependent) ?? 0) - 1;
      inDegree.set(dependent, remaining);
      if (remaining === 0) queue.push(dependent);
    }
  }

  if (order.length !== nodes.length) {
    const cyclic = nodes.map((node) => node.key).filter((key) => !order.includes(key));
    return { ok: false, errors: [`Cycle detected between steps: ${cyclic.join(', ')}`] };
  }

  return { ok: true, order };
}

/** Steps that are still PENDING and whose dependencies have all SUCCEEDED. */
export function findReadySteps(
  nodes: readonly DagNode[],
  statusOf: (key: string) => string | undefined,
): string[] {
  return nodes
    .filter(
      (node) =>
        statusOf(node.key) === 'PENDING' &&
        node.dependsOn.every((dependency) => statusOf(dependency) === 'SUCCEEDED'),
    )
    .map((node) => node.key);
}

/** Steps that no other step depends on; their outputs form the run output. */
export function findLeafSteps(nodes: readonly DagNode[]): string[] {
  const referenced = new Set(nodes.flatMap((node) => node.dependsOn));
  return nodes.filter((node) => !referenced.has(node.key)).map((node) => node.key);
}
