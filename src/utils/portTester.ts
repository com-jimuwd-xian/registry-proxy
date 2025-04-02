import net from "node:net";

export async function isPortFree(port: number): Promise<boolean> {
    return new Promise(resolve => {
        const server = net.createServer();
        server.unref();
        server.on('error', () => resolve(false));
        server.listen({port}, () => {
            server.close(() => resolve(true));
        });
    });
}

/**
 * 检查指定端口是否可连接（有服务正在监听）
 * @param port 要检查的端口号
 * @param host 目标主机（默认本地IPv6 ::1）
 * @param timeout 超时时间（毫秒，默认1000ms）
 */
export async function isPortConnectable(
    port: number,
    host: string = '::1',
    timeout: number = 1000
): Promise<boolean> {
    return new Promise((resolve) => {
        const socket = new net.Socket();

        // 设置超时
        socket.setTimeout(timeout);

        socket.on('connect', () => {
            socket.destroy();
            resolve(true);
        });

        socket.on('timeout', () => {
            socket.destroy();
            resolve(false);
        });

        socket.on('error', () => {
            socket.destroy();
            resolve(false);
        });

        socket.connect(port, host);
    });
}

/**
 * 简单的检查，若需要更高级的检查，请使用{@link isPortConnectable}
 */
async function checkPortListening(port: number): Promise<boolean> {
    return new Promise(resolve => {
        const socket = new net.Socket();
        socket.on('error', () => resolve(false));
        socket.on('connect', () => {
            socket.destroy();
            resolve(true);
        });
        socket.connect({port, host: '::1'});
    });
}

export default {isPortFree, isPortConnectable,checkPortListening}