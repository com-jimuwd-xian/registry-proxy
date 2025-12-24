#!/usr/bin/env -S node --no-warnings --loader ts-node/esm
// The above shebang allows direct execution with ts-node (install ts-node and typescript first)

import fs from 'node:fs/promises';
import path from 'node:path';
import {execa} from 'execa';
import findProjectRoot from "../utils/findProjectRoot.js";
import {isPortConnectable} from "../utils/portTester.js";
import {readYarnConfig} from "../utils/configFileReader.js";

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
        throw new Error(`Invalid port number ${port} in ${filePath}`);
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
    console.log("Process exited with exitCode", exitCode);
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
        await startLocalRegistryProxyServerAndYarnInstallWithoutCleanup();
        await cleanup(0);
    } catch (err) {
        console.error('Error:', err instanceof Error ? err.message : String(err));
        await cleanup(1);
    }
}

async function startLocalRegistryProxyServerAndYarnInstallWithoutCleanup() {
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
        } catch (err) {//cleanup程序不要抛出任何异常
            console.error(`Failed to delete lock file: ${LOCK_FILE}`, err)
        }
    });

    // Change to project root
    process.chdir(INSTALLATION_ROOT);

    // Start registry proxy
    console.log(`Starting registry-proxy@${REGISTRY_PROXY_VERSION} local server in the background...`);
    // 提示：这里借助了execa调用"yarn dlx"后台运行registry proxy server的功能，没有直接使用本地ts函数调用的方式启动本地代理服务器，因为后者不太容易达到后台运行的效果。
    proxyProcess = execa('yarn', [
        'dlx', '-p', `com.jimuwd.xian.registry-proxy@${REGISTRY_PROXY_VERSION}`, 'registry-proxy',
        /*是不是可以传空，让server使用默认值？*/'.registry-proxy.yml',
        /*是不是可以传空，让server使用默认值？*/'.yarnrc.yml',
        /*是不是可以传空，让server使用默认值？*/path.join(process.env.HOME || '', '.yarnrc.yml'),
        /*之前是写死的静态端口40061，它有个缺点就是本地无法为多个项目工程并发执行yarn-install，现改为使用随机可用端口作为本地代理服务器端口，传'0'/''空串即可*/'0'
    ], {
        detached: true,
        stdio: 'inherit'
    });

    registerCleanup(async (_exitCode) => {
        if (proxyProcess && !proxyProcess.killed) {
            console.log('Stopping registry-proxy local server...');
            try {
                proxyProcess.kill('SIGTERM');
                await proxyProcess;
                console.log('Registry-proxy local server stopped.');
            } catch (err) {// cleanup程序不要抛出异常
                console.error('Registry-proxy local server stopping with error', err)
            }
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
    const {exitCode, stdout} = await execa('yarn', ['config', 'get', 'npmRegistryServer']);
    const npmRegistryServer = (exitCode === 0 && stdout) ? stdout.trim() : undefined;
    const localNpmRegistryServer = (await readYarnConfig('.yarnrc.yml')).npmRegistryServer?.trim();
    if (localNpmRegistryServer && localNpmRegistryServer === npmRegistryServer) console.log(`NpmRegistryServer value in project local .yarnrc.yml: ${localNpmRegistryServer}`);
    else console.log(`NpmRegistryServer value in ${path.join(process.env.HOME || '', '.yarnrc.yml')}: ${npmRegistryServer}`);
    await execa('yarn', ['config', 'set', 'npmRegistryServer', `http://127.0.0.1:${PROXY_PORT}`]);
    console.log(`Set npmRegistryServer config value to http://127.0.0.1:${PROXY_PORT}`);
    console.log('Read npmRegistryServer after set using yarn config get cmd:', (await execa('yarn', ['config', 'get', 'npmRegistryServer'])).stdout);
    console.log('Read npmRegistryServer after set using reading .yarnrc.yml file:', (await readYarnConfig('.yarnrc.yml')).npmRegistryServer?.trim());
    registerCleanup(async () => {
        try {
            //if (npmRegistryServer) {//不能用这个变量来恢复为原来的 npmRegistryServer，因为它可能是全局配置~/.yarnrc.yml内的配置值或yarn工具官方默认值，而非本地.yarnrc.yml配置值。
            if (localNpmRegistryServer) {//恢复为本地配置文件原来的 npmRegistryServer 配置值
                await execa('yarn', ['config', 'set', 'npmRegistryServer', localNpmRegistryServer]);
                console.log(`Recover npmRegistryServer to ${localNpmRegistryServer} in local '.yarnrc.yml'.`);
            } else {//原来本地配置文件中没有npmRegistryServer，则重置npmRegistryServer
                await execa('yarn', ['config', 'unset', 'npmRegistryServer']);
                console.log(`Unset npmRegistryServer value in local '.yarnrc.yml'.`);
            }
        } catch (err) {//cleanup程序不要抛出异常
            console.error('Recover yarn config npmRegistryServer error.', err);
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
    console.info("Yarn install with local registry-proxy server success.");
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
    await main()
}
