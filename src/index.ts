#!/usr/bin/env node
import { createServer } from 'http';
import { readFile } from 'fs/promises';
import { load } from 'js-yaml';
import fetch, { Response } from 'node-fetch';

interface RegistryConfig { npmAuthToken?: string; }
interface YarnConfig { npmRegistries?: Record<string, RegistryConfig>; }

async function loadRegistries(configPath: string): Promise<{ url: string; token?: string }[]> {
    try {
        const yamlContent = await readFile(configPath, 'utf8');
        const config = load(yamlContent) as YarnConfig;
        if (!config.npmRegistries) throw new Error('No npmRegistries found');
        return Object.entries(config.npmRegistries).map(([url, regConfig]) => ({
            url,
            token: regConfig.npmAuthToken?.replace(/\${(.+)}/, (_, key) => process.env[key] || '') || regConfig.npmAuthToken,
        }));
    } catch (e) {
        console.error('Failed to load .yarnrc.yml:', (e as Error).message);
        process.exit(1);
    }
}

export async function startProxyServer(configPath: string, port: number = 4873) {
    const registries = await loadRegistries(configPath);

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
}

if (import.meta.url === `file://${process.argv[1]}`) {
    const configPath = process.argv[2] || './.yarnrc.yml';
    const port = parseInt(process.argv[3], 10) || 4873;
    startProxyServer(configPath, port).catch(err => {
        console.error('Startup failed:', (err as Error).message);
        process.exit(1);
    });
}