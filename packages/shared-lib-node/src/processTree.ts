export function buildChildrenByParentMap(psOutput: string): Map<number, number[]> {
  const childrenByParent = new Map<number, number[]>();
  for (const line of psOutput.split('\n')) {
    const matched = /^\s*(\d+)\s+(\d+)\s*$/.exec(line);
    if (!matched) {
      continue;
    }

    const childPid = Number(matched[1]);
    const parentPid = Number(matched[2]);
    const children = childrenByParent.get(parentPid);
    if (children) {
      children.push(childPid);
    } else {
      childrenByParent.set(parentPid, [childPid]);
    }
  }
  return childrenByParent;
}

export function collectDescendantPids(rootPid: number, childrenByParent: Map<number, number[]>): number[] {
  const descendants: number[] = [];
  const queue = [...(childrenByParent.get(rootPid) ?? [])];
  let head = 0;
  while (head < queue.length) {
    const pid = queue[head];
    head++;
    if (pid === undefined) {
      continue;
    }

    descendants.push(pid);
    for (const childPid of childrenByParent.get(pid) ?? []) {
      queue.push(childPid);
    }
  }
  return descendants;
}
