import {load} from "js-yaml";
import {promises as nodeFsPromises} from 'node:fs';
import {ProxyConfig} from "../models.js";
import {gracefulShutdown} from "./gracefullShutdown.js";
import {resolvePath} from "../utils/configFileReader.js";
import logger from "../utils/logger.js";

/**
 * 读取yml配置文件得到配置值对象{@link ProxyConfig}
 * @note 本读取操作不会解析环境变量值
 * @param proxyConfigPath 配置文件路径
 */
async function readProxyConfig(proxyConfigPath = './.registry-proxy.yml'): Promise<ProxyConfig> {
    let config: ProxyConfig | undefined = undefined;
    const resolvedPath = resolvePath(proxyConfigPath);
    try {
        const content = await nodeFsPromises.readFile(resolvedPath, 'utf8');
        config = load(content) as ProxyConfig;
    } catch (e) {
        logger.error(`Failed to load proxy config from ${resolvedPath}:`, e);
        await gracefulShutdown();
    }
    if (!config?.registries) {
        logger.error('Missing required "registries" field in config');
        await gracefulShutdown();
    }
    return config as ProxyConfig;
}

export {readProxyConfig}