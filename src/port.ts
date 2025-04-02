import {basename, join} from "node:path";
import {promises as nodeFsPromises} from 'node:fs';
import logger from "./utils/logger.js";

const {unlink, writeFile,} = nodeFsPromises;
export const PORT_FILE_NAME = '.registry-proxy-port';

export const portFile = join(process.env.PROJECT_ROOT || process.cwd(), PORT_FILE_NAME);

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