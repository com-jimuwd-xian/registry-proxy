#!/usr/bin/env node
import { createServer, Server as HttpServer } from 'http';
import { createServer as createHttpsServer, Server as HttpsServer } from 'https';
import { readFileSync, promises as fsPromises } from 'fs';
import { AddressInfo } from 'net';
import { load } from 'js-yaml';
import fetch, { Response } from 'node-fetch';
import { homedir } from 'os';
import { join, resolve } from 'path';
import { URL } from 'url';

const { readFile, writeFile } = fsPromises;

interface RegistryConfig { npmAuthToken?: string; }
interface HttpsConfig { key: string; cert: string; }
interface ProxyConfig {
    registries: Record<string, RegistryConfig | null>;
    https?: HttpsConfig;
    basePath?: string;
}
interface YarnConfig { npmRegistries?: Record<string, RegistryConfig | null>; }
interface RegistryInfo { url: string; token?: string; }
interface PackageVersion { dist?: { tarball?: string }; }
interface PackageData { versions?: Record<string, PackageVersion>; }

// 并发控制队列
class ConcurrencyLimiter {
    private maxConcurrency: number;
    private current: number = 0;
    private queue: Array<() => void> = [];

    constructor(maxConcurrency: number) {
        this.maxConcurrency = maxConcurrency;
    }

    async acquire(): Promise<void> {
        if (this.current < this.maxConcurrency) {
            this.current++;
            return Promise.resolve();
        }
        return new Promise((resolve) => {
            this.queue.push(resolve);
        });
    }

    release(): void {
        this.current--;
        const next = this.queue.shift();
        if (next) {
            this.current++;
            next();
        }
    }
}

// 设置最大并发数（可调整）
const limiter = new ConcurrencyLimiter(5); // 限制为 5 个并发请求

function normalizeUrl(url: string): string {
    try {
        const urlObj = new URL(url);
        if (urlObj.protocol === 'http:' && (urlObj.port === '80' || urlObj.port === '')) {
            urlObj.port = '';
        } else if (urlObj.protocol === 'https:' && (urlObj.port === '443' || urlObj.port === '')) {
            urlObj.port = '';
        }
        if (!urlObj.pathname.endsWith('/')) {
            urlObj.pathname += '/';
        }
        console.debug(`Normalized URL: ${url} -> ${urlObj.toString()}`);
        return urlObj.toString();
    } catch (e) {
        console.error(`Invalid URL: ${url}`, e);
        return url.endsWith('/') ? url : `${url}/`;
    }
}

function resolvePath(path: string): string {
    const resolved = path.startsWith('~/') ? join(homedir(), path.slice(2)) : resolve(path);
    console.debug(`Resolved path: ${path} -> ${resolved}`);
    return resolved;
}

function removeRegistryPrefix(tarballUrl: string, registries: RegistryInfo[]): string {
    try {
        const normalizedTarball = normalizeUrl(tarballUrl);
        const normalizedRegistries = registries
            .map(r => normalizeUrl(r.url))
            .sort((a, b) => b.length - a.length);

        console.debug(`Removing registry prefix from tarball: ${normalizedTarball}`);
        for (const registry of normalizedRegistries) {
            if (normalizedTarball.startsWith(registry)) {
                const result = normalizedTarball.slice(registry.length - 1) || '/';
                console.debug(`Matched registry ${registry}, result: ${result}`);
                return result;
            }
        }
        console.debug(`No registry prefix matched for ${normalizedTarball}`);
    } catch (e) {
        console.error(`Invalid URL in removeRegistryPrefix: ${tarballUrl}`, e);
    }
    return tarballUrl;
}

async function loadProxyConfig(proxyConfigPath = './.registry-proxy.yml'): Promise<ProxyConfig> {
    const resolvedPath = resolvePath(proxyConfigPath);
    console.debug(`Loading proxy config from: ${resolvedPath}`);
    try {
        const content = await readFile(resolvedPath, 'utf8');
        const config = load(content) as ProxyConfig;
        if (!config.registries) {
            throw new Error('Missing required "registries" field in config');
        }
        console.debug('Loaded proxy config:', JSON.stringify(config, null, 2));
        return config;
    } catch (e) {
        console.error(`Failed to load proxy config from ${resolvedPath}:`, e);
        process.exit(1);
    }
}

async function loadYarnConfig(path: string): Promise<YarnConfig> {
    console.debug(`Loading Yarn config from: ${path}`);
    try {
        const content = await readFile(resolvePath(path), 'utf8');
        const config = load(content) as YarnConfig;
        console.debug(`Loaded Yarn config from ${path}:`, JSON.stringify(config, null, 2));
        return config;
    } catch (e) {
        console.warn(`Failed to load Yarn config from ${path}:`, e);
        return {};
    }
}

async function loadRegistries(
    proxyConfigPath = './.registry-proxy.yml',
    localYarnConfigPath = './.yarnrc.yml',
    globalYarnConfigPath = join(homedir(), '.yarnrc.yml')
): Promise<RegistryInfo[]> {
    console.debug('Loading registries...');
    const [proxyConfig, localYarnConfig, globalYarnConfig] = await Promise.all([
        loadProxyConfig(proxyConfigPath),
        loadYarnConfig(localYarnConfigPath),
        loadYarnConfig(globalYarnConfigPath)
    ]);

    const registryMap = new Map<string, RegistryInfo>();
    for (const [url, regConfig] of Object.entries(proxyConfig.registries)) {
        const normalizedUrl = normalizeUrl(url);
        let token = regConfig?.npmAuthToken;

        if (!token) {
            const yarnConfigs = [localYarnConfig, globalYarnConfig];
            for (const config of yarnConfigs) {
                const registryConfig = config.npmRegistries?.[normalizedUrl] ||
                    config.npmRegistries?.[url];
                if (registryConfig?.npmAuthToken) {
                    token = registryConfig.npmAuthToken;
                    console.debug(`Found token for ${normalizedUrl} in Yarn config`);
                    break;
                }
            }
        }
        registryMap.set(normalizedUrl, { url: normalizedUrl, token });
    }
    const registries = Array.from(registryMap.values());
    console.log('Loaded registries:', registries);
    return registries;
}

export async function startProxyServer(
    proxyConfigPath?: string,
    localYarnConfigPath?: string,
    globalYarnConfigPath?: string,
    port: number = 0
): Promise<HttpServer | HttpsServer> {
    const proxyConfig = await loadProxyConfig(proxyConfigPath);
    const registries = await loadRegistries(proxyConfigPath, localYarnConfigPath, globalYarnConfigPath);
    const basePath = proxyConfig.basePath ? `/${proxyConfig.basePath.replace(/^\/|\/$/g, '')}` : '';

    console.log('Active registries:', registries.map(r => r.url));
    console.log('Proxy base path:', basePath || '/');
    console.log('HTTPS:', !!proxyConfig.https);

    let proxyPort: number;

    const requestHandler = async (req: any, res: any) => {
        console.debug(`Received request: ${req.method} ${req.url}`);
        if (!req.url || !req.headers.host) {
            console.error('Invalid request: missing URL or host header');
            res.writeHead(400).end('Invalid Request');
            return;
        }

        const fullUrl = new URL(req.url, `${proxyConfig.https ? 'https' : 'http'}://${req.headers.host}`);
        console.debug(`Full URL: ${fullUrl.toString()}`);
        if (basePath && !fullUrl.pathname.startsWith(basePath)) {
            console.error(`Path ${fullUrl.pathname} does not match basePath ${basePath}`);
            res.writeHead(404).end('Not Found');
            return;
        }

        const relativePath = basePath
            ? fullUrl.pathname.slice(basePath.length)
            : fullUrl.pathname;
        console.log(`Proxying: ${relativePath}`);

        const fetchPromises = registries.map(async ({ url, token }) => {
            await limiter.acquire(); // 获取并发许可
            try {
                const cleanRelativePath = relativePath.replace(/\/+$/, '');
                const targetUrl = `${url}${cleanRelativePath}${fullUrl.search || ''}`;
                console.log(`Fetching from: ${targetUrl}`);
                const headers = token ? { Authorization: `Bearer ${token}` } : undefined;
                const response = await fetch(targetUrl, { headers });
                console.log(`Response from ${url}: ${response.status} ${response.statusText}`);
                console.debug(`Response headers from ${url}:`, Object.fromEntries(response.headers.entries()));
                return response.ok ? response : null;
            } catch (e) {
                console.error(`Failed to fetch from ${url}:`, e);
                return null;
            } finally {
                limiter.release(); // 释放并发许可
            }
        });

        const responses = await Promise.all(fetchPromises);
        const successResponse = responses.find((r): r is Response => r !== null);
        if (!successResponse) {
            console.error(`All registries failed for ${relativePath}`);
            res.writeHead(404).end('Not Found - All upstream registries failed');
            return;
        }

        const contentType = successResponse.headers.get('Content-Type') || 'application/octet-stream';
        console.debug(`Content-Type: ${contentType}`);
        if (contentType.includes('application/json')) {
            try {
                const data = await successResponse.json() as PackageData;
                if (data.versions) {
                    const proxyBase = `${proxyConfig.https ? 'https' : 'http'}://${req.headers.host || 'localhost:' + proxyPort}${basePath}`;
                    console.debug(`Rewriting tarball URLs with proxy base: ${proxyBase}`);
                    for (const version in data.versions) {
                        const dist = data.versions[version]?.dist;
                        if (dist?.tarball) {
                            const originalUrl = new URL(dist.tarball);
                            const tarballPath = removeRegistryPrefix(dist.tarball, registries);
                            dist.tarball = `${proxyBase}${tarballPath}${originalUrl.search || ''}`;
                            console.debug(`Rewrote tarball: ${originalUrl} -> ${dist.tarball}`);
                        }
                    }
                }
                res.writeHead(200, { 'Content-Type': 'application/json' });
                const jsonResponse = JSON.stringify(data);
                res.end(jsonResponse);
            } catch (e) {
                console.error('Failed to parse JSON response:', e);
                res.writeHead(502).end('Invalid Upstream Response');
            }
        } else {
            if (!successResponse.body) {
                console.error(`Empty response body from ${successResponse.url}, status: ${successResponse.status}`);
                res.writeHead(502).end('Empty Response Body');
                return;
            }
            const safeHeaders = {
                'Content-Type': successResponse.headers.get('Content-Type'),
                'Content-Length': successResponse.headers.get('Content-Length'),
            };
            console.debug(`Streaming response with headers:`, safeHeaders);
            res.writeHead(successResponse.status, safeHeaders);
            successResponse.body.pipe(res).on('error', (err:any) => {
                console.error(`Stream error for ${relativePath}:`, err);
                res.writeHead(502).end('Stream Error');
            });
        }
    };

    let server: HttpServer | HttpsServer;
    if (proxyConfig.https) {
        const { key, cert } = proxyConfig.https;
        const keyPath = resolvePath(key);
        const certPath = resolvePath(cert);
        console.debug(`Loading HTTPS key: ${keyPath}, cert: ${certPath}`);
        try {
            await fsPromises.access(keyPath);
            await fsPromises.access(certPath);
        } catch (e) {
            console.error(`HTTPS config error: key or cert file not found`, e);
            process.exit(1);
        }
        const httpsOptions = {
            key: readFileSync(keyPath),
            cert: readFileSync(certPath),
        };
        server = createHttpsServer(httpsOptions, requestHandler);
    } else {
        server = createServer(requestHandler);
    }

    return new Promise((resolve, reject) => {
        server.on('error', (err: NodeJS.ErrnoException) => {
            if (err.code === 'EADDRINUSE') {
                console.error(`Port ${port} is in use, please specify a different port or free it.`);
                process.exit(1);
            }
            console.error('Server error:', err);
            reject(err);
        });
        server.listen(port, () => {
            const address = server.address() as AddressInfo;
            proxyPort = address.port;
            const portFile = join(process.env.PROJECT_ROOT || process.cwd(), '.registry-proxy-port');
            console.debug(`Writing port ${proxyPort} to file: ${portFile}`);
            writeFile(portFile, proxyPort.toString()).catch(e => console.error('Failed to write port file:', e));
            console.log(`Proxy server running on ${proxyConfig.https ? 'https' : 'http'}://localhost:${proxyPort}${basePath}`);
            resolve(server);
        });
    });
}

if (import.meta.url === `file://${process.argv[1]}`) {
    const [,, configPath, localYarnPath, globalYarnPath, port] = process.argv;
    console.log(`Starting server with args: configPath=${configPath}, localYarnPath=${localYarnPath}, globalYarnPath=${globalYarnPath}, port=${port}`);
    startProxyServer(
        configPath,
        localYarnPath,
        globalYarnPath,
        parseInt(port, 10) || 0
    ).catch(err => {
        console.error('Failed to start server:', err);
        process.exit(1);
    });
}