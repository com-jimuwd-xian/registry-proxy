import {load} from "js-yaml";
import {join, resolve} from "path";
import {homedir} from "os";
import {existsSync, promises as fsPromises} from 'node:fs';
import {YarnConfig} from "../models.js";
import logger from "./logger.js";

const {readFile} = fsPromises;

/**
 * 读取yml配置文件为yml对象
 * @note 如果配置文件不存在，那么返回空对象，不抛异常。
 * @param path yml文件路径
 */
async function readYarnConfig(path: string): Promise<YarnConfig> {
    try {
        if (existsSync(path)) {
            const content = await readFile(resolvePath(path), 'utf8');
            return load(content) as YarnConfig;
        } else {
            logger.info(`Skip reading ${path}, because it does not exist.`)
            return {};
        }
    } catch (e) {
        logger.warn(`Failed to load Yarn config from ${path}:`, e);
        return {};
    }
}

/**
 * 标准化处理路径值
 * @param path
 */
function resolvePath(path: string): string {
    return path.startsWith('~/') ? join(homedir(), path.slice(2)) : resolve(path);
}

export {
    readYarnConfig,
    resolvePath,
}