#!/usr/bin/env node
import {createServer, IncomingMessage, OutgoingHttpHeaders, Server as HttpServer, ServerResponse} from 'http';
import {createServer as createHttpsServer, Server as HttpsServer} from 'https';
import {promises as fsPromises, readFileSync} from 'fs';
import {AddressInfo} from 'net';
import {load} from 'js-yaml';
import fetch, {Response} from 'node-fetch';
import {homedir} from 'os';
import {join, resolve} from 'path';
import {URL} from 'url';
import {Readable} from "node:stream";
import {pipeline} from "node:stream/promises";

const {readFile, writeFile} = fsPromises;

interface RegistryConfig {
    npmAuthToken?: string;
}

interface HttpsConfig {
    key: string;
    cert: string;
}

interface ProxyConfig {
    registries: Record<string, RegistryConfig | null>;
    https?: HttpsConfig;
    basePath?: string;
}

interface YarnConfig {
    npmRegistries?: Record<string, RegistryConfig | null>;
}

interface RegistryInfo {
    normalizedRegistryUrl: string;
    token?: string;
}

interface ProxyInfo {
    registries: RegistryInfo[];
    https?: HttpsConfig;
    basePath?: string;
}

interface PackageVersion {
    dist?: { tarball?: string };
}

interface PackageData {
    versions?: Record<string, PackageVersion>;
}

class ConcurrencyLimiter {
    private readonly maxConcurrency: number;
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

function removeEndingSlashAndForceStartingSlash(str: string | undefined | null): string {
    if (!str) return '/';
    let trimmed = str.trim();
    if (trimmed === '/') return '/';
    if (trimmed === '') return '/';
    if (!trimmed.startsWith('/')) trimmed = '/' + trimmed;
    return trimmed.replace(/\/+$/, '');
}

function normalizeUrl(httpOrHttpsUrl: string): string {
    if (!httpOrHttpsUrl.startsWith("http")) throw new Error("http(s) url must starts with 'http(s)://'");
    try {
        const urlObj = new URL(httpOrHttpsUrl);
        if (urlObj.protocol === 'http:' && (urlObj.port === '80' || urlObj.port === '')) {
            urlObj.port = '';
        } else if (urlObj.protocol === 'https:' && (urlObj.port === '443' || urlObj.port === '')) {
            urlObj.port = '';
        }
        return urlObj.toString().replace(/\/+$/, '');
    } catch (e) {
        throw new Error(`Invalid URL: ${httpOrHttpsUrl}`, {cause: e});
    }
}

function resolvePath(path: string): string {
    return path.startsWith('~/') ? join(homedir(), path.slice(2)) : resolve(path);
}

function removeRegistryPrefix(tarballUrl: string, registries: RegistryInfo[]): string {
    const normalizedTarball = normalizeUrl(tarballUrl);
    const normalizedRegistries = registries
        .map(r => normalizeUrl(r.normalizedRegistryUrl))
        .sort((a, b) => b.length - a.length);
    for (const normalizedRegistry of normalizedRegistries) {
        if (normalizedTarball.startsWith(normalizedRegistry)) {
            return normalizedTarball.slice(normalizedRegistry.length) || '/';
        }
    }
    throw new Error(`Can't find tarball url ${tarballUrl} does not match given registries ${normalizedRegistries}`)
}

async function readProxyConfig(proxyConfigPath = './.registry-proxy.yml'): Promise<ProxyConfig> {
    const resolvedPath = resolvePath(proxyConfigPath);
    try {
        const content = await readFile(resolvedPath, 'utf8');
        const config = load(content) as ProxyConfig;
        if (!config.registries) {
            console.error('Missing required "registries" field in config');
            process.exit(1);
        }
        return config;
    } catch (e) {
        console.error(`Failed to load proxy config from ${resolvedPath}:`, e);
        process.exit(1);
    }
}

async function readYarnConfig(path: string): Promise<YarnConfig> {
    try {
        const content = await readFile(resolvePath(path), 'utf8');
        return load(content) as YarnConfig;
    } catch (e) {
        console.warn(`Failed to load Yarn config from ${path}:`, e);
        return {};
    }
}

async function loadProxyInfo(
    proxyConfigPath = './.registry-proxy.yml',
    localYarnConfigPath = './.yarnrc.yml',
    globalYarnConfigPath = join(homedir(), '.yarnrc.yml')
): Promise<ProxyInfo> {
    const [proxyConfig, localYarnConfig, globalYarnConfig] = await Promise.all([
        readProxyConfig(proxyConfigPath),
        readYarnConfig(localYarnConfigPath),
        readYarnConfig(globalYarnConfigPath)
    ]);
    const registryMap = new Map<string, RegistryInfo>();
    for (const [proxiedRegUrl, proxyRegConfig] of Object.entries(proxyConfig.registries)) {
        const normalizedProxiedRegUrl = normalizeUrl(proxiedRegUrl);
        let token = proxyRegConfig?.npmAuthToken;
        if (!token) {
            const yarnConfigs = [localYarnConfig, globalYarnConfig];
            for (const yarnConfig of yarnConfigs) {
                if (yarnConfig.npmRegistries) {
                    const foundEntry = Object.entries(yarnConfig.npmRegistries)
                        .find(([registryUrl]) => normalizedProxiedRegUrl === normalizeUrl(registryUrl))
                    if (foundEntry) {
                        const [, registryConfig] = foundEntry;
                        if (registryConfig?.npmAuthToken) {
                            token = registryConfig.npmAuthToken;
                            break;
                        }
                    }
                }
            }
        }
        registryMap.set(normalizedProxiedRegUrl, {normalizedRegistryUrl: normalizedProxiedRegUrl, token});
    }
    const registries = Array.from(registryMap.values());
    const https = proxyConfig.https;
    const basePath = removeEndingSlashAndForceStartingSlash(proxyConfig.basePath);
    return {registries, https, basePath};
}

async function fetchFromRegistry(
    registry: RegistryInfo,
    path: string,
    search: string,
    limiter: ConcurrencyLimiter
): Promise<Response | null> {
    await limiter.acquire();
    try {
        const targetUrl = `${registry.normalizedRegistryUrl}${path}${search || ''}`;
        console.log(`Fetching from: ${targetUrl}`);
        const headers = registry.token ? { Authorization: `Bearer ${registry.token}` } : undefined;
        const response = await fetch(targetUrl, { headers });
        console.log(`Response from ${targetUrl}: ${response.status} ${response.statusText}`);
        return response.ok ? response : null;
    } catch (e) {
        if (e instanceof Error) {
            console.error(
                (e as any).code === 'ECONNREFUSED'
                    ? `Registry ${registry.normalizedRegistryUrl} unreachable [ECONNREFUSED]`
                    : `Error from ${registry.normalizedRegistryUrl}: ${e.message}`
            );
        }
        return null;
    } finally {
        limiter.release();
    }
}

// 修改后的 writeResponse 函数
async function writeResponse(
    res: ServerResponse,
    response: Response,
    req: IncomingMessage,
    proxyInfo: ProxyInfo,
    proxyPort: number,
    registryInfos: RegistryInfo[]
): Promise<void> {
    const contentType = response.headers.get('Content-Type') || 'application/octet-stream';

    // 准备通用头信息
    const safeHeaders: OutgoingHttpHeaders = {
        'content-type': contentType,
        'connection': 'keep-alive'
    };

    // 复制所有可能需要的头信息
    const headersToCopy = [
        'cache-control', 'etag', 'last-modified',
        'content-encoding', 'content-length'
    ];

    headersToCopy.forEach(header => {
        const value = response.headers.get(header);
        if (value) safeHeaders[header] = value;
    });

    try {
        if (contentType.includes('application/json')) {
            // JSON 处理逻辑
            const data = await response.json() as PackageData;
            if (data.versions) {
                const host = req.headers.host || `localhost:${proxyPort}`;
                const baseUrl = `${proxyInfo.https ? 'https' : 'http'}://${host}${proxyInfo.basePath === '/' ? '' : proxyInfo.basePath}`;

                for (const version in data.versions) {
                    const tarball = data.versions[version]?.dist?.tarball;
                    if (tarball) {
                        const path = removeRegistryPrefix(tarball, registryInfos);
                        data.versions[version]!.dist!.tarball = `${baseUrl}${path}${new URL(tarball).search || ''}`;
                    }
                }
            }
            res.writeHead(200, safeHeaders);
            res.end(JSON.stringify(data));
        } else {
            // 二进制流处理
            if (!response.body) {
                console.error('Empty response body');
                process.exit(1);
            }

            // 修复流类型转换问题
            let nodeStream: NodeJS.ReadableStream;
            if (typeof Readable.fromWeb === 'function') {
                // Node.js 17+ 标准方式
                nodeStream = Readable.fromWeb(response.body as any);
            } else {
                // Node.js 16 及以下版本的兼容方案
                const { PassThrough } = await import('stream');
                const passThrough = new PassThrough();
                const reader = (response.body as any).getReader();

                const pump = async () => {
                    const { done, value } = await reader.read();
                    if (done) return passThrough.end();
                    passThrough.write(value);
                    await pump();
                };

                pump().catch(err => passThrough.destroy(err));
                nodeStream = passThrough;
            }

            res.writeHead(response.status, safeHeaders);
            await pipeline(nodeStream, res);
        }
    } catch (err) {
        console.error('Failed to write response:', err);
        if (!res.headersSent) {
            res.writeHead(502).end('Internal Server Error');
        }
    }
}

export async function startProxyServer(
    proxyConfigPath?: string,
    localYarnConfigPath?: string,
    globalYarnConfigPath?: string,
    port: number = 0
): Promise<HttpServer | HttpsServer> {
    const proxyInfo = await loadProxyInfo(proxyConfigPath, localYarnConfigPath, globalYarnConfigPath);
    const registryInfos = proxyInfo.registries;
    const basePathPrefixedWithSlash: string = removeEndingSlashAndForceStartingSlash(proxyInfo.basePath);

    console.log('Active registries:', registryInfos.map(r => r.normalizedRegistryUrl));
    console.log('Proxy base path:', basePathPrefixedWithSlash);
    console.log('HTTPS:', !!proxyInfo.https);

    let proxyPort: number;

    const requestHandler = async (req: IncomingMessage, res: ServerResponse) => {
        if (!req.url || !req.headers.host) {
            res.writeHead(400).end('Invalid Request');
            return;
        }

        const fullUrl = new URL(req.url, `${proxyInfo.https ? 'https' : 'http'}://${req.headers.host}`);
        if (!fullUrl.pathname.startsWith(basePathPrefixedWithSlash)) {
            res.writeHead(404).end('Not Found');
            return;
        }

        const path = basePathPrefixedWithSlash === '/'
            ? fullUrl.pathname
            : fullUrl.pathname.slice(basePathPrefixedWithSlash.length);

        // 顺序尝试注册表，获取第一个成功响应
        let successfulResponse: Response | null = null;
        for (const registry of registryInfos) {
            if (req.destroyed) break;

            const response = await fetchFromRegistry(
                registry,
                path,
                fullUrl.search,
                limiter
            );

            if (response) {
                successfulResponse = response;
                break;
            }
        }

        // 统一回写响应
        if (successfulResponse) {
            await writeResponse(res, successfulResponse, req, proxyInfo, proxyPort, registryInfos);
        } else {
            res.writeHead(404).end('All upstream registries failed');
        }
    };

    let server: HttpServer | HttpsServer;
    if (proxyInfo.https) {
        const {key, cert} = proxyInfo.https;
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

    const promisedServer: Promise<HttpServer | HttpsServer> = new Promise((resolve, reject) => {
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
            console.log(`Proxy server running on ${proxyInfo.https ? 'https' : 'http'}://localhost:${proxyPort}${basePathPrefixedWithSlash}`);
            resolve(server);
        });
    });

    return promisedServer as Promise<HttpServer | HttpsServer>;
}

if (import.meta.url === `file://${process.argv[1]}`) {
    const [, , configPath, localYarnPath, globalYarnPath, port] = process.argv;
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