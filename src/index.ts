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
import logger from "./utils/logger";

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

const limiter = new ConcurrencyLimiter(10);

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
            logger.error('Missing required "registries" field in config');
            process.exit(1);
        }
        return config;
    } catch (e) {
        logger.error(`Failed to load proxy config from ${resolvedPath}:`, e);
        process.exit(1);
    }
}

async function readYarnConfig(path: string): Promise<YarnConfig> {
    try {
        const content = await readFile(resolvePath(path), 'utf8');
        return load(content) as YarnConfig;
    } catch (e) {
        logger.warn(`Failed to load Yarn config from ${path}:`, e);
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
    targetUrl: string,
    limiter: ConcurrencyLimiter
): Promise<Response | null> {
    await limiter.acquire();
    try {
        logger.info(`Fetching from: ${targetUrl}`);
        const headers: {} = registry.token ? {Authorization: `Bearer ${registry.token}`} : {};
        (headers as any).Collection = "keep-alive";
        const response = await fetch(targetUrl, {headers});
        logger.info(`Response from upstream ${targetUrl}: ${response.status} ${response.statusText} content-type=${response.headers.get('content-type')} content-length=${response.headers.get('content-length')} transfer-encoding=${response.headers.get('transfer-encoding')}`);
        return response.ok ? response : null;
    } catch (e) {
        if (e instanceof Error) {
            logger.error(
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

// 修改后的 writeSuccessfulResponse 函数
async function writeSuccessfulResponse(
    registryInfo: RegistryInfo,
    targetUrl: string,
    res: ServerResponse,
    upstreamResponse: Response,
    req: IncomingMessage,
    proxyInfo: ProxyInfo,
    proxyPort: number,
    registryInfos: RegistryInfo[]
): Promise<void> {

    if (!upstreamResponse.ok) throw new Error("Only 2xx upstream response is supported");

    try {
        const contentType = upstreamResponse.headers.get('content-type') || 'application/octet-stream';
        const connection = upstreamResponse.headers.get("connection") || 'keep-alive';

        // 准备通用头信息
        const safeHeaders: OutgoingHttpHeaders = {'connection': connection, 'content-type': contentType,};

        // 复制所有可能需要的头信息
        const headersToCopy = [
            'content-length',
            'content-encoding',
            'transfer-encoding',
        ];

        headersToCopy.forEach(header => {
            const value = upstreamResponse.headers.get(header);
            if (value) safeHeaders[header] = value;
        });

        if (contentType.includes('application/json')) {
            // JSON 处理逻辑
            const data = await upstreamResponse.json() as PackageData;
            if (data.versions) {
                const host = req.headers.host || `localhost:${proxyPort}`;
                const baseUrl = `${proxyInfo.https ? 'https' : 'http'}://${host}${proxyInfo.basePath === '/' ? '' : proxyInfo.basePath}`;

                for (const versionKey in data.versions) {
                    const packageVersion = data.versions[versionKey];
                    const tarball = packageVersion?.dist?.tarball;
                    if (tarball) {
                        const path = removeRegistryPrefix(tarball, registryInfos);
                        const proxiedTarballUrl: string = `${baseUrl}${path}${new URL(tarball).search || ''}`;
                        packageVersion!.dist!.tarball = proxiedTarballUrl as string;
                    }
                }
            }
            res.writeHead(upstreamResponse.status, {"content-type": contentType}).end(JSON.stringify(data));
        } else {
            // 二进制流处理
            if (!upstreamResponse.body) {
                logger.error(`Empty response body from ${targetUrl}`);
                res.writeHead(502).end('Empty Upstream Response');
            } else {
                // write back to client
                res.writeHead(upstreamResponse.status, safeHeaders);
                // stop transfer if client is closed accidentally.
                // req.on('close', () => upstreamResponse.body?.unpipe());
                // write back body data (chunked probably)
                upstreamResponse.body
                    .on('data', (chunk) => res.write(chunk))
                    .on('end', () => res.end())
                    .on('close', () => res.destroy(new Error(`Upstream server ${registryInfo.normalizedRegistryUrl} closed connection while transferring data on url ${targetUrl}`)))
                    .on('error', (err: Error) => res.destroy(new Error(`Stream error: ${err.message}`, {cause: err,})));
            }
        }
    } catch (err) {
        logger.error('Failed to write upstreamResponse:', err);
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

    logger.info('Active registries:', registryInfos.map(r => r.normalizedRegistryUrl));
    logger.info('Proxy base path:', basePathPrefixedWithSlash);
    logger.info('HTTPS:', !!proxyInfo.https);

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
        let targetRegistry: RegistryInfo | null = null;
        let targetUrl: string | null = null;
        for (const registry of registryInfos) {
            if (req.destroyed) break;
            targetRegistry = registry;
            const search = fullUrl.search || '';
            targetUrl = `${registry.normalizedRegistryUrl}${path}${search}`;
            const okResponseOrNull = await fetchFromRegistry(registry, targetUrl, limiter);
            if (okResponseOrNull) {
                successfulResponse = okResponseOrNull;
                break;
            }
        }

        // 统一回写响应
        if (successfulResponse) {
            await writeSuccessfulResponse(targetRegistry!, targetUrl!, res, successfulResponse, req, proxyInfo, proxyPort, registryInfos);
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
            logger.error(`HTTPS config error: key or cert file not found`, e);
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
                logger.error(`Port ${port} is in use, please specify a different port or free it.`);
                process.exit(1);
            }
            logger.error('Server error:', err);
            reject(err);
        });
        server.listen(port, () => {
            const address = server.address() as AddressInfo;
            proxyPort = address.port;
            const portFile = join(process.env.PROJECT_ROOT || process.cwd(), '.registry-proxy-port');
            writeFile(portFile, proxyPort.toString()).catch(e => logger.error('Failed to write port file:', e));
            logger.info(`Proxy server running on ${proxyInfo.https ? 'https' : 'http'}://localhost:${proxyPort}${basePathPrefixedWithSlash === '/' ? '' : basePathPrefixedWithSlash}`);
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
        logger.error('Failed to start server:', err);
        process.exit(1);
    });
}