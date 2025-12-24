import path from "node:path";
import {promises as nodeFsPromises} from 'node:fs';
import logger from "./utils/logger.js";
import {PORT_FILE_NAME} from "./models.js";
import fs from "node:fs/promises";

const MAX_WAIT_TIME_MS = 30000; // 30 seconds
const CHECK_INTERVAL_MS = 100;  // 0.1 seconds

export {PORT_FILE_NAME};

export const portFile = path.join(process.env.PROJECT_ROOT || process.cwd(), PORT_FILE_NAME);

/**
 * 读取约定的端口文件内容
 * @param filePath 由server端启动时生成的端口文件路径
 */
export async function readPortFile(filePath: string): Promise<number> {
    const content = await nodeFsPromises.readFile(filePath, 'utf-8');
    const port = parseInt(content.trim(), 10);
    if (isNaN(port) || port < 1 || port > 65535) {
        throw new Error(`Invalid port number ${port} in ${filePath}`);
    }
    return port;
}

export async function writePortFile(port: number) {
    await nodeFsPromises.writeFile(portFile, port.toString()).catch(e => logger.error(`Failed to write port file: ${portFile}`, e));
}

export const deletePortFile = async () => {
    await deleteFile(portFile);
}

/**
 * 等待端口文件就绪
 * @param INSTALLATION_ROOT 项目工程根路径，即package.json所在路径
 */
export async function waitForPortFile(INSTALLATION_ROOT: string): Promise<void> {
    // Wait for proxy server to start
    const PORT_FILE = path.join(INSTALLATION_ROOT, PORT_FILE_NAME);
    console.log('Waiting for proxy server to start (up to 30 seconds)...');
    const fileExists = await waitForFile(PORT_FILE, MAX_WAIT_TIME_MS);
    if (!fileExists) {
        throw new Error(`Proxy server failed to create port file after ${MAX_WAIT_TIME_MS / 1000} seconds`);
    }
}


async function deleteFile(filePath: string) {
    try {
        await nodeFsPromises.unlink(filePath);
        logger.info(`端口文件 ${path.basename(filePath)} 已删除`);
    } catch (err: any) {
        if (err.code === 'ENOENT') {
            logger.warn(`端口文件 ${filePath} 不存在`);
        } else {
            logger.error(`端口文件 ${filePath} 删除失败:`, err.message);
        }
    }
}

async function waitForFile(filePath: string, timeoutMs: number): Promise<boolean> {
    const startTime = Date.now();
    while (Date.now() - startTime < timeoutMs) {
        try {
            await fs.access(filePath);
            return true;
        } catch {
            await new Promise(r => setTimeout(r, CHECK_INTERVAL_MS));
        }
    }
    return false;
}