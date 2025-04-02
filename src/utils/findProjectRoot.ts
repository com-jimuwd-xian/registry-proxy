import fs from "node:fs/promises";
import path from "node:path";

/**
 * 获取以package.json为基准的工程路径
 * @param startDir 起点路径，由此向上逐级搜索package.json文件直到找到其路径作为工程基础路径值返回
 */
export default async function findProjectRoot(startDir: string = process.cwd()): Promise<string> {
    let dir = startDir;
    while (dir !== '/') {
        try {
            await fs.access(path.join(dir, 'package.json'));
            return dir;
        } catch {
            dir = path.dirname(dir);
        }
    }
    throw new Error('Could not find project root (package.json not found)');
}