/** Pure checks on one file's folder tree (D-119): depth limit and moves that would make a cycle. */

/** Root folders are at depth 1; a folder can be at most this deep. */
export const MAX_FOLDER_DEPTH = 5;

export interface TreeNode {
  readonly id: string;
  readonly parentId: string | null;
}

export class FolderTree {
  private readonly parents = new Map<string, string | null>();

  constructor(nodes: readonly TreeNode[]) {
    for (const node of nodes) this.parents.set(node.id, node.parentId);
  }

  has(id: string): boolean {
    return this.parents.has(id);
  }

  /** 1 for a root folder. The walk is bounded, so a corrupt (cyclic) tree cannot hang the request. */
  depth(id: string): number {
    let depth = 0;
    for (let at: string | null | undefined = id; at; at = this.parents.get(at)) {
      depth += 1;
      if (depth > this.parents.size) break;
    }
    return depth;
  }

  /** Levels of the subtree rooted at `id`, itself included (1 for a leaf). */
  height(id: string, budget = this.parents.size): number {
    let height = 1;
    if (budget <= 0) return height;
    for (const [child, parent] of this.parents) {
      if (parent === id) height = Math.max(height, 1 + this.height(child, budget - 1));
    }
    return height;
  }

  /** Whether `candidate` is `id` or below it. */
  isWithin(candidate: string, id: string): boolean {
    let steps = 0;
    for (let at: string | null | undefined = candidate; at; at = this.parents.get(at)) {
      if (at === id) return true;
      if ((steps += 1) > this.parents.size) break;
    }
    return false;
  }
}
