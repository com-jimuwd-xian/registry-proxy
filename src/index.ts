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
            console.error('Invalid request: missing URL or host header');
            res.writeHead(400).end('Invalid Request');
            return;
        }

        const fullUrl = new URL(req.url, `${proxyInfo.https ? 'https' : 'http'}://${req.headers.host}`);
        console.log(`Proxy server received request on ${fullUrl.toString()}`)
        if (!fullUrl.pathname.startsWith(basePathPrefixedWithSlash)) {
            console.error(`Path ${fullUrl.pathname} does not match basePath ${basePathPrefixedWithSlash}`);
            res.writeHead(404).end('Not Found');
            return;
        }

        const relativePathPrefixedWithSlash = basePathPrefixedWithSlash === '/' ? fullUrl.pathname : fullUrl.pathname.slice(basePathPrefixedWithSlash.length);
        console.log(`Proxying: ${relativePathPrefixedWithSlash}`);

        // 修改为按顺序尝试注册表，找到第一个成功响应即返回
        for (const {normalizedRegistryUrl, token} of registryInfos) {
            await limiter.acquire();
            try {
                const targetUrl = `${normalizedRegistryUrl}${relativePathPrefixedWithSlash}${fullUrl.search || ''}`;
                console.log(`Fetching from: ${targetUrl}`);
                const headers = token ? {Authorization: `Bearer ${token}`} : undefined;
                const response = await fetch(targetUrl, {headers});
                console.log(`Response from ${targetUrl}: ${response.status} ${response.statusText}`);

                if (response.ok) {
                    const contentType = response.headers.get('Content-Type') || 'application/octet-stream';

                    if (contentType.includes('application/json')) {
                        // application/json 元数据
                        try {
                            const data = await response.json() as PackageData;
                            if (data.versions) {
                                const requestHeadersHostFromYarnClient = req.headers.host || 'localhost:' + proxyPort;
                                console.log("Request headers.host from yarn client is", requestHeadersHostFromYarnClient);
                                const proxyBaseUrlNoSuffixedWithSlash = `${proxyInfo.https ? 'https' : 'http'}://${requestHeadersHostFromYarnClient}${basePathPrefixedWithSlash === '/' ? '' : basePathPrefixedWithSlash}`;
                                console.log("proxyBaseUrlNoSuffixedWithSlash", proxyBaseUrlNoSuffixedWithSlash);
                                for (const version in data.versions) {
                                    const dist = data.versions[version]?.dist;
                                    if (dist?.tarball) {
                                        const originalUrl = new URL(dist.tarball);
                                        const originalSearchParamsStr = originalUrl.search || '';
                                        const tarballPathPrefixedWithSlash = removeRegistryPrefix(dist.tarball, registryInfos);
                                        dist.tarball = `${proxyBaseUrlNoSuffixedWithSlash}${tarballPathPrefixedWithSlash}${originalSearchParamsStr}`;
                                        if (!tarballPathPrefixedWithSlash.startsWith("/")) console.error("bad tarballPath, must be PrefixedWithSlash", tarballPathPrefixedWithSlash);
                                    }
                                }
                            }
                            res.writeHead(200, {'Content-Type': 'application/json'});
                            res.end(JSON.stringify(data));
                            return;
                        } catch (e) {
                            console.error('Failed to parse JSON response:', e);
                            // 继续尝试下一个注册表
                        }
                    } else {
                        // 非application/json 是 application/octet-stream 是tarball
                        if (!response.body) {
                            console.error(`Empty response body from ${response.url}, status: ${response.status}`);
                            // 继续尝试下一个注册表
                            continue;
                        }
                        const contentLength = response.headers.get('Content-Length');
                        const safeHeaders: OutgoingHttpHeaders = {};
                        safeHeaders["content-type"] = contentType;
                        if (contentLength && !isNaN(Number(contentLength))) safeHeaders["content-length"] = contentLength;
                        response.body.pipe(res).on('error', (err: any) => {
                            console.error(`Stream error for ${relativePathPrefixedWithSlash}:`, err);
                            res.writeHead(502).end('Stream Error');
                        });
                        res.writeHead(response.status, safeHeaders);
                        return;
                    }
                }
            } catch (e) {
                console.error(`Failed to fetch from ${normalizedRegistryUrl}:`, e);
                // 继续尝试下一个注册表
            } finally {
                limiter.release();
            }
        }

        // 所有注册表都尝试失败
        console.error(`All registries failed for ${relativePathPrefixedWithSlash}`);
        res.writeHead(404).end('Not Found - All upstream registries failed');
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