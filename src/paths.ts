import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** 项目根目录及其下路径的唯一解析入口。 */
const projectRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
);

export function projectPath(...segments: string[]): string {
  return path.join(projectRoot, ...segments);
}
