import { FolderTree } from './folder-tree';

// a → b → c, d at the root.
const tree = new FolderTree([
  { id: 'a', parentId: null },
  { id: 'b', parentId: 'a' },
  { id: 'c', parentId: 'b' },
  { id: 'd', parentId: null },
]);

describe('FolderTree', () => {
  it('should know its folders', () => {
    expect(tree.has('c')).toBe(true);
    expect(tree.has('x')).toBe(false);
  });

  it('should count depth from the root', () => {
    expect([tree.depth('a'), tree.depth('b'), tree.depth('c'), tree.depth('d')]).toEqual([
      1, 2, 3, 1,
    ]);
  });

  it('should count the levels of a subtree', () => {
    expect([tree.height('a'), tree.height('b'), tree.height('c'), tree.height('d')]).toEqual([
      3, 2, 1, 1,
    ]);
  });

  it('should tell whether a folder is the given one or below it', () => {
    expect(tree.isWithin('c', 'a')).toBe(true);
    expect(tree.isWithin('a', 'a')).toBe(true);
    expect(tree.isWithin('a', 'c')).toBe(false);
    expect(tree.isWithin('d', 'a')).toBe(false);
  });

  it('should stop on a corrupt cyclic tree instead of looping', () => {
    const cyclic = new FolderTree([
      { id: 'x', parentId: 'y' },
      { id: 'y', parentId: 'x' },
    ]);
    expect(cyclic.depth('x')).toBe(3);
    expect(cyclic.height('x')).toBe(3);
    expect(cyclic.isWithin('x', 'z')).toBe(false);
  });
});
