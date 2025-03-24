#!/usr/bin/env node
import { createServer, Server } from 'http';
import { readFile } from 'fs/promises';
import { load } from 'js-yaml';
import fetch, { Response } from 'node-fetch';
import { homedir } from 'os';
import { join } from 'path';

interface RegistryConfig { npmAuthToken?: string; }
interface YarnConfig { npmRegistries?: Record<string, RegistryConfig>; }

async function loadRegistries(localConfigPath = './.yarnrc.yml', globalConfigPath = join(homedir(), '.yarnrc.yml')): Promise<{ url: string; token?: string }[]> {
    let localConfig: YarnConfig = {};
    try {
        const localYamlContent = await readFile(localConfigPath, 'utf8');
        localConfig = load(localYamlContent) as YarnConfig;
        console.log(`Loaded local config from ${localConfigPath}`);
    } catch (e) {
        console.error(`Failed to load ${localConfigPath}: ${(e as Error).message}`);
        process.exit(1);
    }

    if (!localConfig.npmRegistries || !Object.keys(localConfig.npmRegistries).length) {
        console.error(`No npmRegistries found in ${localConfigPath}`);
        process.exit(1);
    }

    let globalConfig: YarnConfig = {};
    try {
        const globalYamlContent = await readFile(globalConfigPath, 'utf8');
        globalConfig = load(globalYamlContent) as YarnConfig;
        console.log(`Loaded global config from ${globalConfigPath}`);
    } catch (e) {
        console.warn(`Failed to load ${globalConfigPath}: ${(e as Error).message}`);
    }

    const registries = Object.entries(localConfig.npmRegistries).map(([url, localRegConfig]) => {
        let token = localRegConfig.npmAuthToken?.replace(/\${(.+)}/, (_, key) => process.env[key] || '') || localRegConfig.npmAuthToken;
        if (!token && globalConfig.npmRegistries && globalConfig.npmRegistries[url]) {
            token = globalConfig.npmRegistries[url].npmAuthToken?.replace(/\${(.+)}/, (_, key) => process.env[key] || '') || globalConfig.npmRegistries[url].npmAuthToken;
            console.log(`Token for ${url} not found in local config, using global token`);
        }
        console.log(`Registry ${url}: token=${token ? 'present' : 'missing'}`);
        return { url, token };
    });

    return registries;
}

export async function startProxyServer(localConfigPath?: string, globalConfigPath?: string, port: number = 4873): Promise<Server> {
    console.log('Starting proxy server...');
    const registries = await loadRegistries(localConfigPath, globalConfigPath);

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
    const localConfigPath = process.argv[2];
    const globalConfigPath = process.argv[3];
    const port = parseInt(process.argv[4], 10) || 4873;
    console.log(`CLI: localConfigPath=${localConfigPath || './.yarnrc.yml'}, globalConfigPath=${globalConfigPath || join(homedir(), '.yarnrc.yml')}, port=${port}`);
    startProxyServer(localConfigPath, globalConfigPath, port).catch(err => {
        console.error('Startup failed:', (err as Error).message);
        process.exit(1);
    });
}