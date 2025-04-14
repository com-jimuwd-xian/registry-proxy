#!/usr/bin/env node
import http, {createServer, IncomingMessage, Server as HttpServer, ServerResponse} from 'node:http';
import https, {createServer as createHttpsServer, Server as HttpsServer} from 'node:https';
import {existsSync, promises as fsPromises, readFileSync} from 'node:fs';
import {AddressInfo, ListenOptions} from 'node:net';
import {load} from 'js-yaml';
import fetch, {HeadersInit, Response} from 'node-fetch';
import {homedir} from 'os';
import {join, resolve} from 'path';
import {URL} from 'url';
import {IncomingHttpHeaders} from "http";
import {ServerOptions as HttpsServerOptions} from "https";
import logger from "../utils/logger.js";
import ConcurrencyLimiter from "../utils/ConcurrencyLimiter.js";
import {gracefulShutdown, registerProcessShutdownHook} from "./gracefullShutdown.js";
import {writePortFile} from "../port.js";
import resolveEnvValue from "../utils/resolveEnvValue.js";

const {readFile} = fsPromises;

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

const limiter = new ConcurrencyLimiter(5);

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

/**
 * 读取yml配置文件得到配置值对象{@link ProxyConfig}
 * @note 本读取操作不会解析环境变量值
 * @param proxyConfigPath 配置文件路径
 */
async function readProxyConfig(proxyConfigPath = './.registry-proxy.yml'): Promise<ProxyConfig> {
    let config: ProxyConfig | undefined = undefined;
    const resolvedPath = resolvePath(proxyConfigPath);
    try {
        const content = await readFile(resolvedPath, 'utf8');
        config = load(content) as ProxyConfig;
    } catch (e) {
        logger.error(`Failed to load proxy config from ${resolvedPath}:`, e);
        await gracefulShutdown();
    }
    if (!config?.registries) {
        logger.error('Missing required "registries" field in config');
        await gracefulShutdown();
    }
    return config as ProxyConfig;
}

/**
 * 读取yml配置文件为yml对象
 * @param path yml文件路径
 */
async function readYarnConfig(path: string): Promise<YarnConfig> {
    try {
        if (existsSync(path)) {
            const content = await readFile(resolvePath(path), 'utf8');
            return load(content) as YarnConfig;
        } else {
            logger.info(`Skip reading ${path}, because it does not exist.`)
            return {};
        }
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
        let token = resolveEnvValue(proxyRegConfig?.npmAuthToken);
        if (!token) {
            const yarnConfigs = [localYarnConfig, globalYarnConfig];
            for (const yarnConfig of yarnConfigs) {
                if (yarnConfig.npmRegistries) {
                    const foundEntry = Object.entries(yarnConfig.npmRegistries)
                        .find(([registryUrl]) => normalizedProxiedRegUrl === normalizeUrl(registryUrl))
                    if (foundEntry) {
                        const [, registryConfig] = foundEntry;
                        if (registryConfig?.npmAuthToken) {
                            // .yarnrc.yml内的配置值，暂时不处理环境变量值，未来按需扩展
                            token = registryConfig.npmAuthToken;
                            break;
                        }
                    }
                }
            }
        }
        registryMap.set(normalizedProxiedRegUrl, {
            normalizedRegistryUrl: normalizedProxiedRegUrl,
            token: token ? token : undefined
        });
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
        // 替换“Host”头为upstream的host，注意这里要目标url，不能直接使用registryInfo内的normalizedUrl，以便兼容重定向的情况（此时targetUrl的host可能与registryInfo.normalizedUrl不同）.
        const upstreamHost = new URL(targetUrl).host;
        if (mergedHeaders.host) {
            logger.debug(() => `Replace 'Host=${mergedHeaders.host}' header in downstream request to upstream 'Host=${upstreamHost}' header when proxying to upstream ${targetUrl}.`);
            mergedHeaders.host = upstreamHost;
        }
        const response = await fetch(targetUrl, {headers: mergedHeaders as HeadersInit});
        if (response.ok) {
            logger.debug(() => `Success response from upstream ${targetUrl}: ${response.status} ${response.statusText}
            content-type=${response.headers.get('content-type')} content-encoding=${response.headers.get('content-encoding')} content-length=${response.headers.get('content-length')} transfer-encoding=${response.headers.get('transfer-encoding')}`);
            return response;
        } else if (response.status === 302 || response.status === 307 || response.status === 303) {
            // 302 Found / 303 See Other / 307 Temporary Redirect 临时重定向 是常见的 HTTP 状态码，用于告知客户端请求的资源已被临时移动到另一个 URL，客户端应使用新的 URL 重新发起请求。
            // 一个典型的例子：registry.npmmirror.com镜像仓库 会对其tarball下载地址临时重定向到cdn地址，比如你访问https://registry.npmmirror.com/color-name/-/color-name-1.1.4.tgz，会得到
            // Status Code: 302 Found
            // location: https://cdn.npmmirror.com/packages/color-name/1.1.4/color-name-1.1.4.tgz
            // 此时 registry-proxy 的行为：主动跟随重定向，然后将 response from redirected url 透传给下游。
            const redirectedLocation = response.headers.get('location');
            if (redirectedLocation) {
                logger.info(`${response.status} ${response.statusText} response from upstream ${targetUrl}
                Fetching from redirected location=${redirectedLocation}`);
                return await fetchFromRegistry(registry, redirectedLocation, reqFromDownstreamClient, limiter);
            } else {
                logger.warn(`${response.status} ${response.statusText} response from upstream ${targetUrl}, but redirect location is empty, skip fetching from ${targetUrl}`);
                // Return null means skipping current upstream registry.
                return null;
            }
        } else if (response.status === 301) {
            // HTTP 301 Permanently Moved.
            logger.info(`${response.status} ${response.statusText} response from upstream ${targetUrl}, moved to location=${response.headers.get('location')}`);
            // 对于301永久转义响应，registry-proxy 的行为：透传给下游客户端，让客户端自行跳转（提示：这个跳转后的请求将不再走registry-proxy代理了）
            return response;
        } else {
            // Fetch form one of the configured upstream registries failed, this is expected behavior, not error.
            logger.debug(async () => `Failure response from upstream ${targetUrl}: ${response.status} ${response.statusText} 
            content-type=${response.headers.get('content-type')} content-encoding=${response.headers.get('content-encoding')} content-length=${response.headers.get('content-length')} transfer-encoding=${response.headers.get('transfer-encoding')}
            body=${await response.text()}`);
            // Return null means skipping current upstream registry.
            return null;
        }
    } catch (e) {
        // Fetch form one of the configured upstream registries failed, this is expected behavior, not error.
        if (e instanceof Error) {
            const errCode = (e as any).code;
            if (errCode === 'ECONNREFUSED') {
                logger.info(`Upstream ${targetUrl} refused connection [ECONNREFUSED], skip fetching from registry ${registry.normalizedRegistryUrl}`);
            } else if (errCode === 'ENOTFOUND') {
                logger.info(`Unknown upstream domain name in ${targetUrl} [ENOTFOUND], skip fetching from registry ${registry.normalizedRegistryUrl}.`)
            } else {
                // Other net error code, print log with stacktrace
                logger.warn(`Failed to fetch from ${targetUrl}, ${e.message}`, e);
            }
        } else {
            logger.error("Unknown error", e);
        }
        // Return null means skipping current upstream registry.
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
    _proxyPort: number,
    registryInfos: RegistryInfo[]
): Promise<void> {

    logger.debug(() => `Writing upstream registry server ${registryInfo.normalizedRegistryUrl}'s ${upstreamResponse.status}${upstreamResponse.statusText ? (' "' + upstreamResponse.statusText + '"') : ''} response to downstream client.`)

    if (!upstreamResponse.ok) throw new Error("Only 2xx upstream response is supported");

    try {
        const contentType = upstreamResponse.headers.get("content-type");
        if (contentType?.includes('application/json')) { // JSON 处理逻辑
            const data = await upstreamResponse.json() as PackageData;
            if (data.versions) { // 处理node依赖包元数据
                logger.debug(() => "Write package meta data application/json response from upstream to downstream", targetUrl);
                const host = reqFromDownstreamClient.headers.host;
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
            // remove transfer-encoding = chunked header if present, because the content-length is fixed.
            resToDownstreamClient.removeHeader('transfer-encoding');
            /* 默认是 connection: keep-alive 和 keep-alive: timeout=5
            resToDownstreamClient.setHeader('connection', 'close');
            resToDownstreamClient.removeHeader('Keep-Alive');*/
            resToDownstreamClient.setHeader('content-type', contentType);
            resToDownstreamClient.setHeader('content-length', Buffer.byteLength(bodyData));
            logger.info(`Response to downstream client headers`, JSON.stringify(resToDownstreamClient.getHeaders()), targetUrl);
            resToDownstreamClient.writeHead(upstreamResponse.status).end(bodyData);
        } else if (contentType?.includes('application/octet-stream')) { // 二进制流处理
            logger.debug(() => `Write application/octet-stream response from upstream to downstream, upstream url is ${targetUrl}`);
            if (!upstreamResponse.body) {
                logger.error(`Empty response body from upstream ${targetUrl}`);
                resToDownstreamClient.writeHead(502).end('Empty Upstream Response');
            } else {
                // write back to client
                const safeHeaders: Map<string, number | string | readonly string[]> = new Map<string, number | string | readonly string[]>();
                // 复制所有可能需要的头信息（不包含安全相关的敏感头信息，如access-control-allow-origin、set-cookie、server、strict-transport-security等，这意味着代理服务器向下游客户端屏蔽了这些认证等安全数据）
                // 也不能包含cf-cache-status、cf-ray（Cloudflare 特有字段）可能干扰客户端解析。
                const headersToCopy = ['cache-control', 'etag', 'last-modified', 'vary', 'connection', 'keep-alive', 'content-encoding'];
                headersToCopy.forEach(header => {
                    const value = upstreamResponse.headers.get(header);
                    if (value) safeHeaders.set(header, value);
                });
                // 强制设置二进制流传输的响应头，需要使用 ServerResponse.setHeaders(safeHeaders)来覆盖现有headers而不是ServerResponse.writeHead(status,headers)来合并headers，避免不必要的麻烦
                resToDownstreamClient.setHeaders(safeHeaders);
                resToDownstreamClient.setHeader("content-type", contentType);
                resToDownstreamClient.removeHeader('content-length');
                resToDownstreamClient.setHeader('transfer-encoding', 'chunked');
                /* 这两个header使用upstream透传过来的header即可
                resToDownstreamClient.setHeader('connection', 'close');
                resToDownstreamClient.removeHeader('Keep-Alive');*/
                logger.info(`Response to downstream client headers`, JSON.stringify(resToDownstreamClient.getHeaders()), targetUrl);
                // 不再writeHead()而是设置状态码，然后执行pipe操作
                resToDownstreamClient.statusCode = upstreamResponse.status;
                resToDownstreamClient.statusMessage = upstreamResponse.statusText;
                // stop pipe when req from client is closed accidentally.
                // this is good when proxying big stream from upstream to downstream.
                const cleanup = () => {
                    reqFromDownstreamClient.off('close', cleanup);
                    logger.debug(() => `Req from downstream client is closed, stop pipe from upstream ${targetUrl} to downstream client.`);
                    upstreamResponse.body?.unpipe();
                };
                reqFromDownstreamClient.on('close', cleanup);
                reqFromDownstreamClient.on('end', () => logger.info("Req from downstream client ends."));
                // clean up when server closes connection to downstream client.
                const cleanup0 = () => {
                    resToDownstreamClient.off('close', cleanup0);
                    logger.debug(() => `Close connection to downstream client, upstream url is ${targetUrl}`);
                    // upstreamResponse.body?.unpipe();
                }
                resToDownstreamClient.on('close', cleanup0);
                // write back body data (chunked probably)
                // pipe upstream body-stream to downstream stream and automatically ends the stream to downstream when upstream stream is ended.
                upstreamResponse.body.pipe(resToDownstreamClient, {end: true});
                upstreamResponse.body
                    .on('data', (chunk) => logger.debug(() => `Chunk transferred from ${targetUrl} to downstream client size=${Buffer.byteLength(chunk)}bytes`))
                    .on('end', () => logger.info(`Upstream server ${targetUrl} response.body stream ended.`))
                    // connection will be closed automatically when all chunk data is transferred (after stream ends).
                    .on('close', () => logger.debug(() => `Upstream ${targetUrl} closed stream.`))
                    .on('error', (err: Error) => {
                        const errMsg = `Stream error between upstream and registry-proxy server: ${err.message}. Upstream url is ${targetUrl}`;
                        logger.error(errMsg);
                        resToDownstreamClient.destroy(new Error(errMsg, {cause: err,}));
                        reqFromDownstreamClient.destroy(new Error(errMsg, {cause: err,}));
                    });
            }
        } else {
            if (!contentType) {
                logger.warn(`Response from upstream content-type header is absent, ${targetUrl} `);
            } else {
                logger.warn(`Write unsupported content-type=${contentType} response from upstream to downstream. Upstream url is ${targetUrl}`);
            }
            const bodyData = await upstreamResponse.text();
            {
                // 对于不规范的registry server，我们对其header做合理化整理，如下
                {
                    // 默认是 connection: keep-alive 和 keep-alive: timeout=5，这里直接给它咔嚓掉
                    resToDownstreamClient.setHeader('connection', 'close');
                    resToDownstreamClient.removeHeader('Keep-Alive');
                }
                if (contentType) resToDownstreamClient.setHeader('content-type', contentType); else resToDownstreamClient.removeHeader('content-type');
                {
                    // 强制用固定的content-length
                    resToDownstreamClient.removeHeader('transfer-encoding');
                    resToDownstreamClient.setHeader('content-length', Buffer.byteLength(bodyData));
                }
                logger.debug(() => `Response to downstream client headers ${JSON.stringify(resToDownstreamClient.getHeaders())} Upstream url is ${targetUrl}`);
            }
            resToDownstreamClient.writeHead(upstreamResponse.status).end(bodyData);
        }
    } catch (err) {
        logger.error('Failed to transfer upstream response to downstream client', err);
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
            await gracefulShutdown();
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
        const errHandler = async (err: NodeJS.ErrnoException) => {
            if (err.code === 'EADDRINUSE') {
                reject(new Error(`Port ${port} is in use, please specify a different port or free it.`, {cause: err,}));
            } else {
                reject(new Error('Server error', {cause: err,}));
            }
        };
        const connectionHandler = (socket: any) => {
            socket.setTimeout(60000);
            socket.setKeepAlive(true, 30000);
            logger.debug(() => "Server on connection",);
        };
        server.on('error', errHandler/*this handler will call 'reject'*/);
        server.on('connection', connectionHandler);
        // 安全提示：为了代理服务器的安全性，暂时只监听本机ipv6地址【127.0.0.1】，不能对本机之外暴露本代理服务地址避免造成安全隐患。
        // 兼容性说明：
        // 1、不使用ipv6地址因为旧的docker容器内部并未开放ipv6，为了最大成都兼容容器内运行registry-proxy，只使用ipv4了。
        // 2、yarn客户端应当通过127.0.0.1:<port>而非localhost:<port>来访问本服务，原因是yarn客户端环境解析“localhost”至多个地址，它会尝试轮询每个地址，其中某地址可能会报错ECONNREFUSED错误码，会导致yarn install执行失败。
        const ipv4LocalhostIp = '127.0.0.1';
        const listenOptions: ListenOptions = {port, host: ipv4LocalhostIp, ipv6Only: false};
        server.listen(listenOptions, async () => {
            const addressInfo = server.address() as AddressInfo;
            port = addressInfo.port;// 回写上层局部变量
            await writePortFile(port);
            logger.info(`Proxy server running on ${proxyInfo.https ? 'https' : 'http'}://${ipv4LocalhostIp}:${port}${basePathPrefixedWithSlash === '/' ? '' : basePathPrefixedWithSlash}`);
            resolve(server);
        });
    });

    return promisedServer as Promise<HttpServer | HttpsServer>;
}

// 当前模块是否是直接运行的入口文件，而不是被其他模块导入的
if (import.meta.url === `file://${process.argv[1]}`) {
    registerProcessShutdownHook();
    const [, , configPath, localYarnPath, globalYarnPath, port] = process.argv;
    startProxyServer(
        configPath,
        localYarnPath,
        globalYarnPath,
        parseInt(port, 10) || 0
    ).catch(async err => {
        logger.error('Failed to start server', err);
        await gracefulShutdown();
    });
}