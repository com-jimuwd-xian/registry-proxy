#!/usr/bin/env node
import http, {createServer, IncomingMessage, Server as HttpServer, ServerResponse} from 'node:http';
import https, {createServer as createHttpsServer, Server as HttpsServer} from 'node:https';
import {promises as fsPromises, readFileSync} from 'fs';
import {AddressInfo, ListenOptions} from 'net';
import {load} from 'js-yaml';
import fetch, {HeadersInit, Response} from 'node-fetch';
import {homedir} from 'os';
import {join, resolve} from 'path';
import {URL} from 'url';
import logger from "./utils/logger.js";
import {IncomingHttpHeaders} from "http";
import ConcurrencyLimiter from "./utils/ConcurrencyLimiter.js";
import {ServerOptions as HttpsServerOptions} from "https";

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

const limiter = new ConcurrencyLimiter(Infinity);

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
    reqFromDownstreamClient: IncomingMessage,
    limiter: ConcurrencyLimiter
): Promise<Response | null> {
    await limiter.acquire();
    try {
        logger.info(`Fetching from upstream: ${targetUrl}`);
        const headersFromDownstreamClient: IncomingHttpHeaders = reqFromDownstreamClient.headers;
        const authorizationHeaders: {} = registry.token ? {Authorization: `Bearer ${registry.token}`} : {};
        // 合并 headersFromDownstreamClient 和 authorizationHeaders
        const mergedHeaders = {...headersFromDownstreamClient, ...authorizationHeaders,};
        // (mergedHeaders as any).connection = "keep-alive"; 不允许私自添加 connection: keep-alive header，应当最终下游客户端自己的选择
        // 替换“Host”头为upstream的host
        const upstreamHost = new URL(registry.normalizedRegistryUrl).host;
        if (mergedHeaders.host) {
            logger.info(`Replace 'Host=${mergedHeaders.host}' header in downstream request to upstream 'Host=${upstreamHost}' header when proxying to upstream ${targetUrl}.`);
            mergedHeaders.host = upstreamHost;
        }
        const response = await fetch(targetUrl, {headers: mergedHeaders as HeadersInit});
        if (response.ok) {
            logger.debug(`Success response from upstream ${targetUrl}: ${response.status} ${response.statusText}
            content-type=${response.headers.get('content-type')} content-encoding=${response.headers.get('content-encoding')} content-length=${response.headers.get('content-length')} transfer-encoding=${response.headers.get('transfer-encoding')}`);
            return response;
        } else {
            logger.info(`Failure response from upstream ${targetUrl}: ${response.status} ${response.statusText} 
            content-type=${response.headers.get('content-type')} content-encoding=${response.headers.get('content-encoding')} content-length=${response.headers.get('content-length')} transfer-encoding=${response.headers.get('transfer-encoding')}
            body=${await response.text()}`);
            return null;
        }
    } catch (e) {
        if (e instanceof Error) {
            logger.error(
                (e as any).code === 'ECONNREFUSED'
                    ? `Registry ${registry.normalizedRegistryUrl} unreachable [ECONNREFUSED]`
                    : `Error from ${registry.normalizedRegistryUrl}: ${e.message}`
            );
        } else {
            logger.error("Unknown error", e);
        }
        return null;
    } finally {
        limiter.release();
    }
}

async function writeResponseToDownstreamClient(
    registryInfo: RegistryInfo,
    targetUrl: string,
    resToDownstreamClient: ServerResponse,
    upstreamResponse: Response,
    reqFromDownstreamClient: IncomingMessage,
    proxyInfo: ProxyInfo,
    proxyPort: number,
    registryInfos: RegistryInfo[]
): Promise<void> {

    logger.info(`Writing upstream registry server ${registryInfo.normalizedRegistryUrl}'s ${upstreamResponse.status}${upstreamResponse.statusText ? (' "' + upstreamResponse.statusText + '"') : ''} response to downstream client.`)

    if (!upstreamResponse.ok) throw new Error("Only 2xx upstream response is supported");

    try {
        const contentType = upstreamResponse.headers.get("content-type") /*|| "application/octet-stream"*/;
        if (!contentType) {
            logger.error(`Response from upstream content-type header is absent, ${targetUrl} `);
            process.exit(1);
        }
        if (contentType.includes('application/json')) { // JSON 处理逻辑
            const data = await upstreamResponse.json() as PackageData;
            if (data.versions) { // 处理node依赖包元数据
                logger.info("Write package meta data application/json response from upstream to downstream", targetUrl);
                const host = reqFromDownstreamClient.headers.host || `127.0.0.1:${proxyPort}`;
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
            } else {
                logger.info("Write none meta data application/json response from upstream to downstream", targetUrl);
            }
            const bodyData = JSON.stringify(data);
            resToDownstreamClient.removeHeader('Transfer-Encoding');
            // 默认是 connection: keep-alive 和 keep-alive: timeout=5，这里直接给它咔嚓掉
            resToDownstreamClient.setHeader('Connection', 'close');
            resToDownstreamClient.removeHeader('Keep-Alive');
            resToDownstreamClient.setHeader('content-type', contentType);
            resToDownstreamClient.setHeader('content-length', Buffer.byteLength(bodyData));
            logger.info(`Response to downstream client headers`, JSON.stringify(resToDownstreamClient.getHeaders()), targetUrl);
            resToDownstreamClient.writeHead(upstreamResponse.status).end(bodyData);
        } else if (contentType.includes('application/octet-stream')) { // 二进制流处理
            logger.info("Write application/octet-stream response from upstream to downstream", targetUrl);
            if (!upstreamResponse.body) {
                logger.error(`Empty response body from upstream ${targetUrl}`);
                resToDownstreamClient.writeHead(502).end('Empty Upstream Response');
            } else {
                // write back to client
                // 准备通用响应头信息
                const safeHeaders: Map<string, number | string | readonly string[]> = new Map<string, number | string | readonly string[]>();
                safeHeaders.set("Content-Type", contentType);
                // 复制所有可能需要的头信息（不包含安全相关的敏感头信息，如access-control-allow-origin、set-cookie、server、strict-transport-security等，这意味着代理服务器向下游客户端屏蔽了这些认证等安全数据）
                // 也不能包含cf-cache-status、cf-ray（Cloudflare 特有字段）可能干扰客户端解析。
                const headersToCopy = ['cache-control', 'connection', 'content-encoding', 'content-length', /*'date',*/ 'etag', 'last-modified', 'transfer-encoding', 'vary',];
                headersToCopy.forEach(header => {
                    const value = upstreamResponse.headers.get(header);
                    if (value) safeHeaders.set(header, value);
                });
                // 必须使用 ServerResponse.setHeaders(safeHeaders)来覆盖现有headers而不是ServerResponse.writeHead(status,headers)来合并headers！
                // 这个坑害我浪费很久事件来调试！
                resToDownstreamClient.setHeaders(safeHeaders);

                // 调试代码
                resToDownstreamClient.removeHeader('content-encoding');
                resToDownstreamClient.removeHeader('Transfer-Encoding');
                resToDownstreamClient.removeHeader('content-length');
                resToDownstreamClient.setHeader('transfer-encoding', 'chunked');
                // 默认是 connection: keep-alive 和 keep-alive: timeout=5，这里直接给它咔嚓掉
                resToDownstreamClient.removeHeader('connection');
                resToDownstreamClient.setHeader('connection', 'close');
                resToDownstreamClient.removeHeader('Keep-Alive');
                resToDownstreamClient.removeHeader('content-type');
                resToDownstreamClient.setHeader('content-type', contentType);


                logger.info(`Response to downstream client headers`, JSON.stringify(resToDownstreamClient.getHeaders()), targetUrl);
                // 不再writeHead()而是设置状态码，然后执行pipe操作
                resToDownstreamClient.statusCode = upstreamResponse.status;
                resToDownstreamClient.statusMessage = upstreamResponse.statusText;
                // resToDownstreamClient.writeHead(upstreamResponse.status);
                // stop pipe when req from client is closed accidentally.
                const cleanup = () => {
                    reqFromDownstreamClient.off('close', cleanup);
                    logger.info(`Req from downstream client is closed, stop pipe from upstream ${targetUrl} to downstream client.`);
                    // upstreamResponse.body?.unpipe();
                };
                reqFromDownstreamClient.on('close', cleanup);
                reqFromDownstreamClient.on('end', () => logger.info("Req from downstream client ends."));
                // clean up when server closes connection to downstream client.
                const cleanup0 = () => {
                    resToDownstreamClient.off('close', cleanup0);
                    logger.info(`Close connection to downstream client, upstream url is ${targetUrl}`);
                    // upstreamResponse.body?.unpipe();
                }
                resToDownstreamClient.on('close', cleanup0);
                // write back body data (chunked probably)
                // pipe upstream body to downstream client
                upstreamResponse.body.pipe(resToDownstreamClient, {end: true});
                upstreamResponse.body
                    .on('data', (chunk) => logger.debug(`Chunk transferred from ${targetUrl} to downstream client size=${chunk.length}`))
                    .on('end', () => {
                        logger.info(`Upstream server ${targetUrl} response.body ended.`);
                        // resToDownstreamClient.end();
                    })
                    // connection will be closed automatically when all chunk data is transferred (after stream ends).
                    .on('close', () => {
                        logger.info(`Upstream server ${targetUrl} closed connection.`);
                    })
                    .on('error', (err: Error) => {
                        const errMsg = `Stream error: ${err.message}`;
                        logger.error(errMsg);
                        resToDownstreamClient.destroy(new Error(errMsg, {cause: err,}));
                        reqFromDownstreamClient.destroy(new Error(errMsg, {cause: err,}));
                    });
            }
        } else {
            logger.warn(`Write unsupported content-type=${contentType} response from upstream to downstream ${targetUrl}`);
            const bodyData = await upstreamResponse.text();
            resToDownstreamClient.removeHeader('Transfer-Encoding');
            // 默认是 connection: keep-alive 和 keep-alive: timeout=5，这里直接给它咔嚓掉
            resToDownstreamClient.setHeader('Connection', 'close');
            resToDownstreamClient.removeHeader('Keep-Alive');
            resToDownstreamClient.setHeader('content-type', contentType);
            resToDownstreamClient.setHeader('content-length', Buffer.byteLength(bodyData));
            logger.info(`Response to downstream client headers`, JSON.stringify(resToDownstreamClient.getHeaders()), targetUrl);
            resToDownstreamClient.writeHead(upstreamResponse.status).end(bodyData);
        }
    } catch (err) {
        logger.error('Failed to write upstreamResponse:', err);
        if (!resToDownstreamClient.headersSent) {
            resToDownstreamClient.writeHead(502).end('Internal Server Error');
        }
    }
}

function getDownstreamClientIp(req: IncomingMessage) {
    // 如果经过代理（如 Nginx），取 X-Forwarded-For 的第一个 IP
    const forwardedFor = req.headers['x-forwarded-for'];
    if (forwardedFor) {
        return forwardedFor.toString().split(',')[0].trim();
    }
    // 直接连接时，取 socket.remoteAddress
    return req.socket.remoteAddress;
}

// deprecated 出于安全考虑只监听::1地址，废弃本注释：同时启动ipv6,ipv4监听，比如当客户端访问http://localhost:port时，无论客户端DNS解析到IPV4-127.0.0.1还是IPV6-::1地址，咱server都能轻松应对！
export async function startProxyServer(
    proxyConfigPath?: string,
    localYarnConfigPath?: string,
    globalYarnConfigPath?: string,
    port: number = 0, // if port==0, then the server will choose an unused port instead.
): Promise<HttpServer | HttpsServer> {
    const proxyInfo = await loadProxyInfo(proxyConfigPath, localYarnConfigPath, globalYarnConfigPath);
    const registryInfos = proxyInfo.registries;
    const basePathPrefixedWithSlash: string = removeEndingSlashAndForceStartingSlash(proxyInfo.basePath);

    logger.info('Active registries:', registryInfos.map(r => r.normalizedRegistryUrl));
    logger.info('Proxy base path:', basePathPrefixedWithSlash);
    logger.info('HTTPS:', !!proxyInfo.https);

    const requestHandler = async (reqFromDownstreamClient: IncomingMessage, resToDownstreamClient: ServerResponse) => {

        const downstreamUserAgent = reqFromDownstreamClient.headers["user-agent"]; // "curl/x.x.x"
        const downstreamIp = getDownstreamClientIp(reqFromDownstreamClient);
        const downstreamRequestedHttpMethod = reqFromDownstreamClient.method; // "GET", "POST", etc.
        const downstreamRequestedHost = reqFromDownstreamClient.headers.host; // "example.com:8080"
        const downstreamRequestedFullPath = reqFromDownstreamClient.url; //  "/some/path?param=1&param=2"

        logger.info(`Received downstream request from '${downstreamUserAgent}' ${downstreamIp} ${downstreamRequestedHttpMethod} ${downstreamRequestedHost} ${downstreamRequestedFullPath}
        Proxy server request handler rate limit is ${limiter.maxConcurrency}`);

        if (!downstreamRequestedFullPath || !downstreamRequestedHost) {
            logger.warn(`400 Invalid Request, downstream ${downstreamUserAgent} req.url is absent or downstream.headers.host is absent.`)
            resToDownstreamClient.writeHead(400).end('Invalid Request');
            return;
        }
        const baseUrl = `${proxyInfo.https ? 'https' : 'http'}://${downstreamRequestedHost}`;
        const fullUrl = new URL(downstreamRequestedFullPath, baseUrl);
        if (!fullUrl.pathname.startsWith(basePathPrefixedWithSlash)) {
            resToDownstreamClient.writeHead(404).end('Not Found');
            return;
        }

        const path = basePathPrefixedWithSlash === '/'
            ? fullUrl.pathname
            : fullUrl.pathname.slice(basePathPrefixedWithSlash.length);
        const search = fullUrl.search || '';
        const targetPath = path + search;

        logger.info(`Proxying to ${targetPath}`);

        // 按配置顺序尝试注册表，获取第一个成功响应
        let successfulResponseFromUpstream: Response | null = null;
        let targetRegistry: RegistryInfo | null = null;
        let targetUrl: string | null = null;
        for (const registry_i of registryInfos) {
            targetRegistry = registry_i;
            targetUrl = `${targetRegistry.normalizedRegistryUrl}${targetPath}`;
            if (reqFromDownstreamClient.destroyed) {
                // 如果下游客户端自己提前断开（或取消）请求，那么这里不再逐个fallback方式请求（fetch）上游数据了，直接退出循环并返回
                logger.warn(`Downstream ${reqFromDownstreamClient.headers["user-agent"]} request is destroyed, no need to proxy request to upstream ${targetUrl} any more.`)
                return;
            }
            const okResponseOrNull = await fetchFromRegistry(targetRegistry, targetUrl, reqFromDownstreamClient, limiter);
            if (okResponseOrNull) {
                successfulResponseFromUpstream = okResponseOrNull;
                break;
            }
        }

        // 统一回写响应
        if (successfulResponseFromUpstream) {
            await writeResponseToDownstreamClient(targetRegistry!, targetUrl!, resToDownstreamClient, successfulResponseFromUpstream, reqFromDownstreamClient, proxyInfo, port, registryInfos);
        } else {
            resToDownstreamClient.writeHead(404).end('All upstream registries failed');
        }
    };


    // deprecated 废弃本注释：需要同时启动ipv6,ipv4监听，比如当客户端访问http://localhost:port时，无论客户端DNS解析到IPV4-127.0.0.1还是IPV6-::1地址，咱server都能轻松应对！
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
        const httpsOptions: HttpsServerOptions = {
            key: readFileSync(keyPath),
            cert: readFileSync(certPath),
        };
        server = createHttpsServer(httpsOptions, requestHandler);
        logger.info("Proxy server's maxSockets is", https.globalAgent.maxSockets)
    } else {
        server = createServer(requestHandler);
        logger.info("Proxy server's maxSockets is", http.globalAgent.maxSockets);
    }

    // server参数暂时写死
    const serverMaxConnections = 10000;
    const serverTimeoutMs = 60000;
    logger.info(`Proxy server's initial maxConnections is ${server.maxConnections}, adjusting to ${serverMaxConnections}`);
    server.maxConnections = serverMaxConnections;
    logger.info(`Proxy server's initial timeout is ${server.timeout}ms, adjusting to ${serverTimeoutMs}ms`);
    server.timeout = serverTimeoutMs;

    const promisedServer: Promise<HttpServer | HttpsServer> = new Promise((resolve, reject) => {
        const errHandler = (err: NodeJS.ErrnoException) => {
            if (err.code === 'EADDRINUSE') {
                logger.error(`Port ${port} is in use, please specify a different port or free it.`, err);
                process.exit(1);
            }
            logger.error('Server error:', err);
            reject(err);
        };
        const connectionHandler = (socket: any) => {
            logger.info("Server on connection")
            socket.setTimeout(60000);
            socket.setKeepAlive(true, 30000);
        };
        server.on('error', errHandler/*this handler will call 'reject'*/);
        server.on('connection', connectionHandler);
        // 为了代理服务器的安全性，暂时只监听本机ipv6地址【::1】，不能对本机之外暴露本代理服务地址避免造成安全隐患
        // 注意：截止目前yarn客户端如果通过localhost:<port>来访问本服务，可能会报错ECONNREFUSED错误码，原因是yarn客户端环境解析“localhost”至多个地址，它会尝试轮询每个地址。
        const listenOptions: ListenOptions = {port, host: '::1', ipv6Only: true};
        server.listen(listenOptions, () => {
            const addressInfo = server.address() as AddressInfo;
            port = addressInfo.port;// 回写上层局部变量
            const portFile = join(process.env.PROJECT_ROOT || process.cwd(), '.registry-proxy-port');
            writeFile(portFile, addressInfo.port.toString()).catch(e => logger.error(`Failed to write port file: ${portFile}`, e));
            logger.info(`Proxy server running on ${proxyInfo.https ? 'https' : 'http'}://localhost:${addressInfo.port}${basePathPrefixedWithSlash === '/' ? '' : basePathPrefixedWithSlash}`);
            resolve(server);
        });
    });

    return promisedServer as Promise<HttpServer | HttpsServer>;
}

if (import.meta.url === `file://${process.argv[1]}`) {
    // 确保进程捕获异常
    process.on('uncaughtException', (err) => {
        logger.error('Fatal error:', err);
        process.exit(1);
    });
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