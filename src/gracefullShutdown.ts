import {deletePortFile} from "./port.js";
import logger from "./utils/logger.js";

/**
 * 优雅退出
 * 本函数是对process.exit的封装，同时执行资源释放动作，程序必须统一调用本方法退出，决不允许直接调用{@link process.exit}来退出。
 */
export async function gracefulShutdown() {
    try {
        logger.info('Shutdown...');
        await doCleanup();
        logger.info('Shutdown completed.');
        process.exit(0);
    } catch (err) {
        logger.error('Failed to clean:', err);
        process.exit(1);
    }
}

async function doCleanup() {
    await deletePortFile();
}

// 捕获信号或异常
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