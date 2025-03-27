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

const limiter = new ConcurrencyLimiter(3);

function normalizeUrl(url: string): string {
    try {
        const urlObj = new URL(url);
        if (urlObj.protocol === 'http:' && (urlObj.port === '80' || urlObj.port === '')) {
            urlObj.port = '';
        } else if (urlObj.protocol === 'https:' && (urlObj.port === '443' || urlObj.port === '')) {
            urlObj.port = '';
        }
        urlObj.pathname = urlObj.pathname.replace(/\/+$/, '');
        return urlObj.toString();
    } catch (e) {
        console.error(`Invalid URL: ${url}`, e);
        return url.replace(/\/+$/, '');
    }
}

function resolvePath(path: string): string {
    return path.startsWith('~/') ? join(homedir(), path.slice(2)) : resolve(path);
}

function removeRegistryPrefix(tarballUrl: string, registries: RegistryInfo[]): string {
    try {
        const normalizedTarball = normalizeUrl(tarballUrl);
        const normalizedRegistries = registries
            .map(r => normalizeUrl(r.url))
            .sort((a, b) => b.length - a.length);

        for (const normalizedRegistry of normalizedRegistries) {
            if (normalizedTarball.startsWith(normalizedRegistry)) {
                return normalizedTarball.slice(normalizedRegistry.length) || '/';
            }
        }
    } catch (e) {
        console.error(`Invalid URL in removeRegistryPrefix: ${tarballUrl}`, e);
    }
    return tarballUrl;
}

async function loadProxyConfig(proxyConfigPath = './.registry-proxy.yml'): Promise<ProxyConfig> {
    const resolvedPath = resolvePath(proxyConfigPath);
    try {
        const content = await readFile(resolvedPath, 'utf8');
        const config = load(content) as ProxyConfig;
        if (!config.registries) {
            throw new Error('Missing required "registries" field in config');
        }
        return config;
    } catch (e) {
        console.error(`Failed to load proxy config from ${resolvedPath}:`, e);
        process.exit(1);
    }
}

async function loadYarnConfig(path: string): Promise<YarnConfig> {
    try {
        const content = await readFile(resolvePath(path), 'utf8');
        return load(content) as YarnConfig;
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
                    break;
                }
            }
        }
        registryMap.set(normalizedUrl, { url: normalizedUrl, token });
    }
    return Array.from(registryMap.values());
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
        if (!req.url || !req.headers.host) {
            console.error('Invalid request: missing URL or host header');
            res.writeHead(400).end('Invalid Request');
            return;
        }

        const fullUrl = new URL(req.url, `${proxyConfig.https ? 'https' : 'http'}://${req.headers.host}`);
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
            await limiter.acquire();
            try {
                const cleanRelativePath = relativePath.replace(/^\/+|\/+$/g, '');
                const targetUrl = `${url}/${cleanRelativePath}${fullUrl.search || ''}`;
                console.log(`Fetching from: ${targetUrl}`);
                const headers = token ? { Authorization: `Bearer ${token}` } : undefined;
                const response = await fetch(targetUrl, { headers, });
                console.log(`Response from ${targetUrl}: ${response.status} ${response.statusText}`);
                return response.ok ? response : null;
            } catch (e) {
                console.error(`Failed to fetch from ${url}:`, e);
                return null;
            } finally {
                limiter.release();
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
        if (contentType.includes('application/json')) {
            try {
                const data = await successResponse.json() as PackageData;
                if (data.versions) {
                    const proxyBase = `${proxyConfig.https ? 'https' : 'http'}://${req.headers.host || 'localhost:' + proxyPort}${basePath}`;
                    for (const version in data.versions) {
                        const dist = data.versions[version]?.dist;
                        if (dist?.tarball) {
                            const originalUrl = new URL(dist.tarball);
                            const tarballPath = removeRegistryPrefix(dist.tarball, registries);
                            dist.tarball = `${proxyBase}${tarballPath}${originalUrl.search || ''}`;
                        }
                    }
                }
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify(data));
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
            const contentLength = successResponse.headers.get('Content-Length');
            const safeHeaders = {
                'Content-Type': successResponse.headers.get('Content-Type'),
                'Content-Length': contentLength && !isNaN(Number(contentLength)) ? contentLength : undefined,
            };
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
            writeFile(portFile, proxyPort.toString()).catch(e => console.error('Failed to write port file:', e));
            console.log(`Proxy server running on ${proxyConfig.https ? 'https' : 'http'}://localhost:${proxyPort}${basePath}`);
            resolve(server);
        });
    });
}

if (import.meta.url === `file://${process.argv[1]}`) {
    const [,, configPath, localYarnPath, globalYarnPath, port] = process.argv;
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