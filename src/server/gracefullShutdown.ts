import {deletePortFile} from "../port.js";
import logger from "../utils/logger.js";

/**
 * 优雅退出
 * 本函数是对process.exit的封装，同时执行资源释放动作，程序必须统一调用本方法退出，决不允许直接调用{@link process.exit}来退出。
 */
export async function gracefulShutdown() {
    try {
        logger.info('Shutdown...');
        await deletePortFile();
        logger.info('Shutdown completed.');
        process.exit(0);
    } catch (err) {
        logger.error('Failed to clean:', err);
        process.exit(1);
    }
}

/**
 * 注册进程shutdown hook程序
 * @note 本shutdown hook程序不支持KILL -9强制杀进程命令
 */
export function registerProcessShutdownHook() {
    process.on('SIGINT', async () => {
        logger.info('收到 SIGINT（Ctrl+C）');
        await gracefulShutdown();
    });

    process.on('SIGTERM', async () => {
        logger.info('收到 SIGTERM');
        await gracefulShutdown();
    });

    process.on('uncaughtException', async (err) => {
        logger.info('uncaughtException:', err);
        await gracefulShutdown();
    });
}

