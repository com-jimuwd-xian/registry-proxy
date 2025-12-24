// utils/logger.ts
const COLORS = {
    reset: '\x1b[0m',
    proxy: '\x1b[36m',     // 青色
    success: '\x1b[32m',   // 绿色
    error: '\x1b[31m',     // 红色
    warn: '\x1b[33m',      // 黄色
    debug: '\x1b[35m'      // 紫色
};

const PREFIX = {
    proxy: `${COLORS.proxy}[PROXY]${COLORS.reset}`,
    error: `${COLORS.error}[ERROR]${COLORS.reset}`,
    warn: `${COLORS.warn}[WARN]${COLORS.reset}`,
    debug: `${COLORS.debug}[DEBUG]${COLORS.reset}`
};

// 代理服务器专用日志
const logger = {
    info: (...args: any[]) =>
        /*console.log(`${PREFIX.proxy}`, ...args),*/
    {},

    success: (...args: any[]) =>
        /*console.log(`${PREFIX.proxy} ${COLORS.success}✓${COLORS.reset}`, ...args),*/
    {},

    error: (...args: any[]) =>
        console.error(`${PREFIX.error}`, ...args),

    warn: (...args: any[]) =>
        /*console.warn(`${PREFIX.warn}`, ...args),*/
    {},

    debug: (...args: any[]) =>
        process.env.DEBUG && console.debug(`${PREFIX.debug}`, ...args)
};

export default logger;