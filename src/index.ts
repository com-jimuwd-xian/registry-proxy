#!/usr/bin/env node
import { createServer, Server } from 'http';
import { AddressInfo } from 'net'; // 导入 AddressInfo 类型
import { readFile } from 'fs/promises';
import { load } from 'js-yaml';
import fetch, { Response } from 'node-fetch';
import { homedir } from 'os';
import { join, resolve } from 'path';
import { writeFileSync } from 'fs';

interface RegistryConfig { npmAuthToken?: string; }
interface ProxyConfig { registries: Record<string, RegistryConfig | null>; }
interface YarnConfig { npmRegistries?: Record<string, RegistryConfig | null>; }

function normalizeUrl(url: string): string {
    return url.endsWith('/') ? url.slice(0, -1) : url;
}

function resolvePath(path: string): string {
    return path.startsWith('~/') ? join(homedir(), path.slice(2)) : resolve(path);
}

async function loadRegistries(proxyConfigPath = './.registry-proxy.yml', localYarnConfigPath = './.yarnrc.yml', globalYarnConfigPath = join(homedir(), '.yarnrc.yml')): Promise<{ url: string; token?: string }[]> {
    const resolvedProxyPath = resolvePath(proxyConfigPath);
    const resolvedLocalYarnPath = resolvePath(localYarnConfigPath);
    const resolvedGlobalYarnPath = resolvePath(globalYarnConfigPath);

    let proxyConfig: ProxyConfig = { registries: {} };
    try {
        const proxyYamlContent = await readFile(resolvedProxyPath, 'utf8');
        proxyConfig = load(proxyYamlContent) as ProxyConfig;
        console.log(`Loaded proxy config from ${resolvedProxyPath}`);
    } catch (e) {
        console.error(`Failed to load ${resolvedProxyPath}: ${(e as Error).message}`);
        process.exit(1);
    }

    if (!proxyConfig.registries || !Object.keys(proxyConfig.registries).length) {
        console.error(`No registries found in ${resolvedProxyPath}`);
        process.exit(1);
    }

    let localYarnConfig: YarnConfig = { npmRegistries: {} };
    try {
        const localYamlContent = await readFile(resolvedLocalYarnPath, 'utf8');
        localYarnConfig = load(localYamlContent) as YarnConfig;
        console.log(`Loaded local Yarn config from ${resolvedLocalYarnPath}`);
    } catch (e) {
        console.warn(`Failed to load ${resolvedLocalYarnPath}: ${(e as Error).message}`);
    }

    let globalYarnConfig: YarnConfig = { npmRegistries: {} };
    try {
        const globalYamlContent = await readFile(resolvedGlobalYarnPath, 'utf8');
        globalYarnConfig = load(globalYamlContent) as YarnConfig;
        console.log(`Loaded global Yarn config from ${resolvedGlobalYarnPath}`);
    } catch (e) {
        console.warn(`Failed to load ${resolvedGlobalYarnPath}: ${(e as Error).message}`);
    }

    const registryMap = new Map<string, RegistryConfig | null>();
    for (const [url, regConfig] of Object.entries(proxyConfig.registries)) {
        const normalizedUrl = normalizeUrl(url);
        registryMap.set(normalizedUrl, regConfig);
    }

    const registries = Array.from(registryMap.entries()).map(([url, regConfig]) => {
        let token: string | undefined;

        if (regConfig && 'npmAuthToken' in regConfig) {
            token = regConfig.npmAuthToken?.replace(/\${(.+)}/, (_, key) => process.env[key] || '') || regConfig.npmAuthToken;
        }

        const normalizedUrl = normalizeUrl(url);
        if (!token && localYarnConfig.npmRegistries?.[normalizedUrl] && 'npmAuthToken' in localYarnConfig.npmRegistries[normalizedUrl]) {
            token = localYarnConfig.npmRegistries[normalizedUrl]!.npmAuthToken?.replace(/\${(.+)}/, (_, key) => process.env[key] || '') || localYarnConfig.npmRegistries[normalizedUrl]!.npmAuthToken;
            console.log(`Token for ${url} not found in ${resolvedProxyPath}, using local Yarn config`);
        }

        if (!token && globalYarnConfig.npmRegistries?.[normalizedUrl] && 'npmAuthToken' in globalYarnConfig.npmRegistries[normalizedUrl]) {
            token = globalYarnConfig.npmRegistries[normalizedUrl]!.npmAuthToken?.replace(/\${(.+)}/, (_, key) => process.env[key] || '') || globalYarnConfig.npmRegistries[normalizedUrl]!.npmAuthToken;
            console.log(`Token for ${url} not found in local Yarn config, using global Yarn config`);
        }

        console.log(`Registry ${url}: token=${token ? 'present' : 'missing'}`);
        return { url, token };
    });

    return registries;
}

export async function startProxyServer(proxyConfigPath?: string, localYarnConfigPath?: string, globalYarnConfigPath?: string, port: number = 0): Promise<Server> {
    console.log('Starting proxy server...');
    const registries = await loadRegistries(proxyConfigPath, localYarnConfigPath, globalYarnConfigPath);

    const server = createServer(async (req, res) => {
        if (!req.url || req.method !== 'GET') {
            res.writeHead(400);
            res.end('Bad Request');
            return;
        }

        const pathname = new URL(req.url, `http://${req.headers.host}`).pathname;

        const fetchPromises = registries.map(async ({ url: registry, token }) => {
            const targetUrl = `${registry}${pathname}`;
            try {
                const response = await fetch(targetUrl, {
                    headers: token ? { Authorization: `Bearer ${token}` } : undefined,
                });
                if (response.ok) return response;
                throw new Error(`Failed: ${response.status}`);
            } catch (e) {
                console.error(`Fetch failed for ${targetUrl}: ${(e as Error).message}`);
                return null;
            }
        });

        const responses = await Promise.all(fetchPromises);
        const successResponse = responses.find((r: Response | null) => r !== null);

        if (successResponse) {
            res.writeHead(successResponse.status, {
                'Content-Type': successResponse.headers.get('Content-Type') || 'application/octet-stream',
            });
            successResponse.body?.pipe(res);
        } else {
            res.writeHead(404);
            res.end('Package not found');
        }
    });

    return new Promise((resolve, reject) => {
        server.listen(port, () => {
            const address: AddressInfo | string | null = server.address();
            if (!address) {
                console.error('Failed to get server address: address is null');
                reject(new Error('Failed to get server address: address is null'));
                return;
            }

            if (typeof address === 'string') {
                console.error('Server bound to a path (e.g., Unix socket), which is not supported');
                reject(new Error('Server bound to a path, expected a TCP port'));
                return;
            }

            const addressInfo: AddressInfo = address;
            const actualPort: number = addressInfo.port;

            // 从环境变量获取项目根目录，写入端口文件
            const projectRoot = process.env.PROJECT_ROOT || process.cwd();
            const portFilePath = join(projectRoot, '.registry-proxy-port');
            console.log(`Proxy server started at http://localhost:${actualPort}`);
            writeFileSync(portFilePath, actualPort.toString(), 'utf8');
            resolve(server);
        });

        process.on('SIGTERM', () => {
            console.log('Received SIGTERM, shutting down...');
            server.close((err) => {
                if (err) {
                    console.error('Error closing server:', err.message);
                    process.exit(1);
                }
                console.log('Server closed.');
                process.exit(0);
            });

            setTimeout(() => {
                console.error('Server did not close in time, forcing exit...');
                process.exit(1);
            }, 5000);
        });
    });
}

if (import.meta.url === `file://${process.argv[1]}`) {
    const proxyConfigPath = process.argv[2];
    const localYarnConfigPath = process.argv[3];
    const globalYarnConfigPath = process.argv[4];
    const port = parseInt(process.argv[5], 10) || 0;
    console.log(`CLI: proxyConfigPath=${proxyConfigPath || './.registry-proxy.yml'}, localYarnConfigPath=${localYarnConfigPath || './.yarnrc.yml'}, globalYarnConfigPath=${globalYarnConfigPath || join(homedir(), '.yarnrc.yml')}, port=${port || 'dynamic'}`);
    startProxyServer(proxyConfigPath, localYarnConfigPath, globalYarnConfigPath, port).catch(err => {
        console.error('Startup failed:', (err as Error).message);
        process.exit(1);
    });
}