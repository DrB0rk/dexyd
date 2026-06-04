import { parseUnifiedDiff } from '../src/utils/diff-view';

describe('parseUnifiedDiff', () => {
  it('groups unified diff lines by changed file with counts', () => {
    const files = parseUnifiedDiff(`diff --git a/src/a.ts b/src/a.ts
index 111..222 100644
--- a/src/a.ts
+++ b/src/a.ts
@@ -1,2 +1,2 @@
-old
+new
 same
diff --git a/src/b.ts b/src/b.ts
--- a/src/b.ts
+++ b/src/b.ts
@@ -0,0 +1 @@
+added
`);

    expect(files).toHaveLength(2);
    expect(files[0]).toMatchObject({
      path: 'src/a.ts',
      additions: 1,
      deletions: 1,
    });
    expect(files[1]).toMatchObject({
      path: 'src/b.ts',
      additions: 1,
      deletions: 0,
    });
    expect(files[0]?.lines.map(line => line.type)).toContain('hunk');
  });

  it('falls back to stat-only content when no unified diff exists', () => {
    const files = parseUnifiedDiff('', ' src/a.ts | 2 +-\n 1 file changed');

    expect(files).toHaveLength(1);
    expect(files[0]?.path).toBe('Changed files');
    expect(files[0]?.lines[0]?.text).toContain('src/a.ts');
  });
});
