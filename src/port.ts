import {basename, join} from "node:path";
import {promises as nodeFsPromises} from 'node:fs';
import logger from "./utils/logger.js";
import {PORT_FILE_NAME} from "./models.js";

const {unlink, writeFile, readFile} = nodeFsPromises;

export {PORT_FILE_NAME};

export const portFile = join(process.env.PROJECT_ROOT || process.cwd(), PORT_FILE_NAME);

/**
 * 读取约定的端口文件内容
 * @param filePath 由server端启动时生成的端口文件路径
 */
export async function readPortFile(filePath: string): Promise<number> {
    const content = await readFile(filePath, 'utf-8');
    const port = parseInt(content.trim(), 10);
    if (isNaN(port) || port < 1 || port > 65535) {
        throw new Error(`Invalid port number ${port} in ${filePath}`);
    }
    return port;
}

export async function writePortFile(port: number) {
    await writeFile(portFile, port.toString()).catch(e => logger.error(`Failed to write port file: ${portFile}`, e));
}

export const deletePortFile = async () => {
    await deleteFile(portFile);
}


async function deleteFile(filePath: string) {
    try {
        await unlink(filePath);
        logger.info(`端口文件 ${basename(filePath)} 已删除`);
    } catch (err: any) {
        if (err.code === 'ENOENT') {
            logger.warn(`端口文件 ${filePath} 不存在`);
        } else {
            logger.error(`端口文件 ${filePath} 删除失败:`, err.message);
        }
    }
}