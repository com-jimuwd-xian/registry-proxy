#!/usr/bin/env node
import { createServer, Server } from 'http';
import { readFile } from 'fs/promises';
import { load } from 'js-yaml';
import fetch, { Response } from 'node-fetch';
import { homedir } from 'os';
import { join } from 'path';

interface RegistryConfig { npmAuthToken?: string; }
interface ProxyConfig { registries: Record<string, RegistryConfig | null>; }
interface YarnConfig { npmRegistries?: Record<string, RegistryConfig | null>; }

async function loadRegistries(proxyConfigPath = './.registry-proxy.yml', localYarnConfigPath = './.yarnrc.yml', globalYarnConfigPath = join(homedir(), '.yarnrc.yml')): Promise<{ url: string; token?: string }[]> {
    let proxyConfig: ProxyConfig = { registries: {} };
    try {
        const proxyYamlContent = await readFile(proxyConfigPath, 'utf8');
        proxyConfig = load(proxyYamlContent) as ProxyConfig;
        console.log(`Loaded proxy config from ${proxyConfigPath}`);
    } catch (e) {
        console.error(`Failed to load ${proxyConfigPath}: ${(e as Error).message}`);
        process.exit(1);
    }

    if (!proxyConfig.registries || !Object.keys(proxyConfig.registries).length) {
        console.error(`No registries found in ${proxyConfigPath}`);
        process.exit(1);
    }

    let localYarnConfig: YarnConfig = { npmRegistries: {} };
    try {
        const localYamlContent = await readFile(localYarnConfigPath, 'utf8');
        localYarnConfig = load(localYamlContent) as YarnConfig;
        console.log(`Loaded local Yarn config from ${localYarnConfigPath}`);
    } catch (e) {
        console.warn(`Failed to load ${localYarnConfigPath}: ${(e as Error).message}`);
    }

    let globalYarnConfig: YarnConfig = { npmRegistries: {} };
    try {
        const globalYamlContent = await readFile(globalYarnConfigPath, 'utf8');
        globalYarnConfig = load(globalYamlContent) as YarnConfig;
        console.log(`Loaded global Yarn config from ${globalYarnConfigPath}`);
    } catch (e) {
        console.warn(`Failed to load ${globalYarnConfigPath}: ${(e as Error).message}`);
    }

    const registries = Object.entries(proxyConfig.registries).map(([url, regConfig]) => {
        let token: string | undefined;

        if (regConfig && 'npmAuthToken' in regConfig) {
            token = regConfig.npmAuthToken?.replace(/\${(.+)}/, (_, key) => process.env[key] || '') || regConfig.npmAuthToken;
        }

        if (!token && localYarnConfig.npmRegistries?.[url] && 'npmAuthToken' in localYarnConfig.npmRegistries[url]) {
            token = localYarnConfig.npmRegistries[url]!.npmAuthToken?.replace(/\${(.+)}/, (_, key) => process.env[key] || '') || localYarnConfig.npmRegistries[url]!.npmAuthToken;
            console.log(`Token for ${url} not found in ${proxyConfigPath}, using local Yarn config`);
        }

        if (!token && globalYarnConfig.npmRegistries?.[url] && 'npmAuthToken' in globalYarnConfig.npmRegistries[url]) {
            token = globalYarnConfig.npmRegistries[url]!.npmAuthToken?.replace(/\${(.+)}/, (_, key) => process.env[key] || '') || globalYarnConfig.npmRegistries[url]!.npmAuthToken;
            console.log(`Token for ${url} not found in local Yarn config, using global Yarn config`);
        }

        console.log(`Registry ${url}: token=${token ? 'present' : 'missing'}`);
        return { url, token };
    });

    return registries;
}

export async function startProxyServer(proxyConfigPath?: string, localYarnConfigPath?: string, globalYarnConfigPath?: string, port: number = 4873): Promise<Server> {
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

    server.listen(port, () => console.log(`Proxy server started at http://localhost:${port}`));

    process.on('SIGTERM', () => {
        console.log('Received SIGTERM, shutting down...');
        server.close(() => process.exit(0));
    });

    return server;
}

if (import.meta.url === `file://${process.argv[1]}`) {
    const proxyConfigPath = process.argv[2];
    const localYarnConfigPath = process.argv[3];
    const globalYarnConfigPath = process.argv[4];
    const port = parseInt(process.argv[5], 10) || 4873;
    console.log(`CLI: proxyConfigPath=${proxyConfigPath || './.registry-proxy.yml'}, localYarnConfigPath=${localYarnConfigPath || './.yarnrc.yml'}, globalYarnConfigPath=${globalYarnConfigPath || join(homedir(), '.yarnrc.yml')}, port=${port}`);
    startProxyServer(proxyConfigPath, localYarnConfigPath, globalYarnConfigPath, port).catch(err => {
        console.error('Startup failed:', (err as Error).message);
        process.exit(1);
    });
}