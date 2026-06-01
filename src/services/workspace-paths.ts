import { lstatSync, realpathSync } from 'node:fs';
import { isAbsolute, relative, resolve, sep } from 'node:path';

export function resolveWorkspacePath(workspacePath: string, requestedPath = ''): { rootPath: string; absolutePath: string; relativePath: string } {
  if (requestedPath.includes('\0')) {
    throw new Error('invalid_path');
  }

  const rootPath = resolve(workspacePath);
  const absolutePath = resolve(rootPath, requestedPath || '.');
  const relativePath = relative(rootPath, absolutePath);

  if (isOutside(relativePath)) {
    throw new Error('path_outside_workspace');
  }

  return {
    rootPath,
    absolutePath,
    relativePath: relativePath === '' ? '' : relativePath
  };
}

export function assertRealPathInside(rootPath: string, targetPath: string): void {
  const realRoot = realpathSync(rootPath);
  const realTarget = realpathSync(targetPath);
  if (isOutside(relative(realRoot, realTarget))) {
    throw new Error('path_outside_workspace');
  }
}

export function resolveAllowedWorkspace(workspaceRoot: string, requestedPath = '.'): string {
  if (requestedPath.includes('\0')) {
    throw new Error('invalid_workspace_path');
  }

  const rootPath = resolve(workspaceRoot);
  const absolutePath = isAbsolute(requestedPath)
    ? resolve(requestedPath)
    : resolve(rootPath, requestedPath || '.');

  if (isOutside(relative(rootPath, absolutePath))) {
    throw new Error('workspace_outside_allowed_root');
  }

  const stat = lstatSync(absolutePath);
  if (!stat.isDirectory()) {
    throw new Error('workspace_not_directory');
  }

  assertRealPathInside(rootPath, absolutePath);
  return realpathSync(absolutePath);
}

function isOutside(relativePath: string): boolean {
  return relativePath === '..' || relativePath.startsWith(`..${sep}`) || resolve(relativePath) === relativePath;
}
