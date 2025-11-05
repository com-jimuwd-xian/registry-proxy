#!/usr/bin/env -S node --no-warnings --loader ts-node/esm
// The above shebang allows direct execution with ts-node (install ts-node and typescript first)

import fs from 'node:fs/promises';
import path from 'node:path';
import {execa} from 'execa';
import findProjectRoot from "../utils/findProjectRoot.js";
import {isPortConnectable} from "../utils/portTester.js";

// Type definitions
type CleanupHandler = (exitCode: number) => Promise<void>;
type SignalHandler = () => Promise<void>;

// Constants
const REGISTRY_PROXY_VERSION = process.env.REGISTRY_PROXY_VERSION || 'latest';
const LOCK_FILE_NAME = '.registry-proxy-install.lock';
const PORT_FILE_NAME = '.registry-proxy-port';
const MAX_WAIT_TIME_MS = 30000; // 30 seconds
const CHECK_INTERVAL_MS = 100;  // 0.1 seconds

// Global state
let proxyProcess: ReturnType<typeof execa> | null = null;
let cleanupHandlers: CleanupHandler[] = [];
let signalHandlers: SignalHandler[] = [];


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

/**
 * 读取约定的端口文件内容
 * @param filePath 由server端启动时生成的端口文件路径
 */
async function readPortFile(filePath: string): Promise<number> {
    const content = await fs.readFile(filePath, 'utf-8');
    const port = parseInt(content.trim(), 10);
    if (isNaN(port) || port < 1 || port > 65535) {
        throw new Error(`Invalid port number in ${filePath}`);
    }
    return port;
}

// Cleanup management
async function cleanup(exitCode: number = 1): Promise<never> {
    // Run all cleanup handlers in reverse order
    for (const handler of [...cleanupHandlers].reverse()) {
        try {
            await handler(exitCode);
        } catch (err) {
            console.error('Cleanup handler error:', err);
        }
    }

    process.exit(exitCode);
}

function registerCleanup(handler: CleanupHandler): void {
    cleanupHandlers.push(handler);
}

function registerSignalHandler(handler: SignalHandler): void {
    signalHandlers.push(handler);
}

// Main implementation
async function main() {
    try {
        // Find project root as base dir to get config file and other tmp files.
        const INSTALLATION_ROOT = await findProjectRoot();
        const LOCK_FILE = path.join(INSTALLATION_ROOT, LOCK_FILE_NAME);
        const PORT_FILE = path.join(INSTALLATION_ROOT, PORT_FILE_NAME);

        // Check for existing lock file
        try {
            await fs.access(LOCK_FILE);
            console.log(`Custom install script is already running (lock file ${LOCK_FILE} exists).`);
            console.log(`If this is unexpected, please remove ${LOCK_FILE} and try again.`);
            return cleanup(0);
        } catch {
        }

        // Create lock file
        await fs.writeFile(LOCK_FILE, process.pid.toString());
        registerCleanup(async () => {
            try {
                await fs.unlink(LOCK_FILE);
            } catch {
            }
        });

        // Change to project root
        process.chdir(INSTALLATION_ROOT);

        // Start registry proxy
        console.log(`Starting registry-proxy@${REGISTRY_PROXY_VERSION} in the background...`);
        proxyProcess = execa('yarn', [
            'dlx', '-p', `com.jimuwd.xian.registry-proxy@${REGISTRY_PROXY_VERSION}`,
            'registry-proxy',
            '.registry-proxy.yml',
            '.yarnrc.yml',
            path.join(process.env.HOME || '', '.yarnrc.yml'),
            '40061'
        ], {
            detached: true,
            stdio: 'inherit'
        });

        registerCleanup(async (exitCode) => {
            if (proxyProcess && !proxyProcess.killed) {
                console.log('Stopping proxy server...');
                try {
                    proxyProcess.kill('SIGTERM');
                    await proxyProcess;
                } catch {
                    // Ignore errors
                }
                console.log('Proxy server stopped.');
            }
        });

        // Wait for proxy to start
        console.log('Waiting for proxy server to start (up to 30 seconds)...');
        const fileExists = await waitForFile(PORT_FILE, MAX_WAIT_TIME_MS);
        if (!fileExists) {
            throw new Error(`Proxy server failed to create port file after ${MAX_WAIT_TIME_MS / 1000} seconds`);
        }

        const PROXY_PORT = await readPortFile(PORT_FILE);
        const portConnectable = await isPortConnectable(PROXY_PORT);
        if (!portConnectable) {
            throw new Error(`Proxy server not listening on port ${PROXY_PORT}`);
        }

        // Configure yarn
        await execa('yarn', ['config', 'set', 'npmRegistryServer', `http://127.0.0.1:${PROXY_PORT}`]);
        console.log(`Set npmRegistryServer to http://127.0.0.1:${PROXY_PORT}`);
        registerCleanup(async () => {
            try {
                await execa('yarn', ['config', 'unset', 'npmRegistryServer']);//fixme：这里使用unset，有个缺点就是如果工程中.yarnrc.yml原本配置的只读registryServer没有恢复而是被清空了！国内的网络再执行任何拉取操作或yarn dlx命令容易超时！
                console.log('Cleared npmRegistryServer configuration');
            } catch {
            }
        });

        // Run yarn install
        console.log('Running yarn install...');
        try {
            await execa('yarn', ['install'], {stdio: 'inherit'});
        } catch (err) {
            throw new Error('yarn install failed');
        }

        // Success
        await cleanup(0);
    } catch (err) {
        console.error('Error:', err instanceof Error ? err.message : String(err));
        await cleanup(1);
    }
}

// 当前模块是否是直接运行的入口文件，而不是被其他模块导入的
if (import.meta.url === `file://${process.argv[1]}`) {
    // Signal handling
    ['SIGINT', 'SIGTERM', 'SIGHUP'].forEach(signal => {
        process.on(signal, async () => {
            console.log(`Received ${signal}, cleaning up...`);
            for (const handler of signalHandlers) {
                try {
                    await handler();
                } catch (err) {
                    console.error('Signal handler error:', err);
                }
            }
            await cleanup(1);
        });
    });

    // Start the program
    main().catch(err => {
        console.error('Unhandled error:', err);
        cleanup(1);
    });
}
