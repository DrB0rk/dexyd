export type ParsedDiffLineType =
  | 'addition'
  | 'deletion'
  | 'hunk'
  | 'meta'
  | 'context';

export type ParsedDiffLine = {
  id: string;
  type: ParsedDiffLineType;
  text: string;
};

export type ParsedDiffFile = {
  id: string;
  path: string;
  oldPath: string | null;
  newPath: string | null;
  additions: number;
  deletions: number;
  lines: ParsedDiffLine[];
};

export function parseUnifiedDiff(
  diffText: string,
  statText = '',
): ParsedDiffFile[] {
  const files: ParsedDiffFile[] = [];
  let current: ParsedDiffFile | null = null;
  let lineIndex = 0;

  const pushCurrent = () => {
    if (!current) return;
    const path = bestPath(current.oldPath, current.newPath, current.path);
    files.push({ ...current, path });
    current = null;
  };

  for (const rawLine of diffText.replace(/\r\n/g, '\n').split('\n')) {
    if (rawLine.startsWith('diff --git ')) {
      pushCurrent();
      const parsed = parseGitDiffHeader(rawLine);
      current = {
        id: `${files.length}-${parsed.path}`,
        path: parsed.path,
        oldPath: parsed.oldPath,
        newPath: parsed.newPath,
        additions: 0,
        deletions: 0,
        lines: [diffLine(rawLine, 'meta', lineIndex++)],
      };
      continue;
    }

    if (!current) {
      if (!rawLine.trim()) continue;
      current = {
        id: `standalone-${files.length}`,
        path: 'Workspace diff',
        oldPath: null,
        newPath: null,
        additions: 0,
        deletions: 0,
        lines: [],
      };
    }

    if (rawLine.startsWith('--- ')) {
      current.oldPath = cleanDiffPath(rawLine.slice(4).trim());
    } else if (rawLine.startsWith('+++ ')) {
      current.newPath = cleanDiffPath(rawLine.slice(4).trim());
    }

    const type = classifyDiffLine(rawLine);
    if (type === 'addition') current.additions += 1;
    if (type === 'deletion') current.deletions += 1;
    current.lines.push(diffLine(rawLine, type, lineIndex++));
  }

  pushCurrent();
  if (files.length > 0) return files;

  const statLines = statText
    .replace(/\r\n/g, '\n')
    .split('\n')
    .map(item => item.trimEnd())
    .filter(Boolean);
  if (!statLines.length) return [];

  return [
    {
      id: 'stat-only',
      path: 'Changed files',
      oldPath: null,
      newPath: null,
      additions: 0,
      deletions: 0,
      lines: statLines.map((text, index) => diffLine(text, 'meta', index)),
    },
  ];
}

function parseGitDiffHeader(line: string): {
  path: string;
  oldPath: string | null;
  newPath: string | null;
} {
  const match = line.match(/^diff --git a\/(.+?) b\/(.+)$/);
  if (!match) return { path: 'Changed file', oldPath: null, newPath: null };
  const oldPath = cleanDiffPath(`a/${match[1]}`);
  const newPath = cleanDiffPath(`b/${match[2]}`);
  return {
    path: bestPath(oldPath, newPath, 'Changed file'),
    oldPath,
    newPath,
  };
}

function cleanDiffPath(path: string): string | null {
  const withoutTimestamp = path.split(/\t|\s{2,}/)[0] ?? path;
  if (withoutTimestamp === '/dev/null') return null;
  return withoutTimestamp.replace(/^[ab]\//, '') || null;
}

function bestPath(
  oldPath: string | null,
  newPath: string | null,
  fallback: string,
): string {
  return newPath ?? oldPath ?? fallback;
}

function classifyDiffLine(line: string): ParsedDiffLineType {
  if (line.startsWith('@@')) return 'hunk';
  if (line.startsWith('+') && !line.startsWith('+++')) return 'addition';
  if (line.startsWith('-') && !line.startsWith('---')) return 'deletion';
  if (
    line.startsWith('diff --git ') ||
    line.startsWith('index ') ||
    line.startsWith('--- ') ||
    line.startsWith('+++ ') ||
    line.startsWith('new file mode ') ||
    line.startsWith('deleted file mode ') ||
    line.startsWith('similarity index ') ||
    line.startsWith('rename from ') ||
    line.startsWith('rename to ')
  ) {
    return 'meta';
  }
  return 'context';
}

function diffLine(
  text: string,
  type: ParsedDiffLineType,
  index: number,
): ParsedDiffLine {
  return { id: `${index}-${type}`, type, text };
}
