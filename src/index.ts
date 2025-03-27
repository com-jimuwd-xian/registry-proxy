#!/usr/bin/env node
import { createServer, Server as HttpServer } from 'http';
import { createServer as createHttpsServer, Server as HttpsServer } from 'https';
import { readFileSync, promises as fsPromises } from 'fs';
import { AddressInfo } from 'net';
import { load } from 'js-yaml';
import fetch, { Response } from 'node-fetch';
import { homedir } from 'os';
import { join, resolve } from 'path';
import { URL } from 'url'; // 显式导入URL

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

function normalizeUrl(url: string): string {
    return url.endsWith('/') ? url : `${url}/`;
}

function resolvePath(path: string): string {
    return path.startsWith('~/') ? join(homedir(), path.slice(2)) : resolve(path);
}

function removeRegistryPrefix(tarballUrl: string, registries: RegistryInfo[]): string {
    try {
        const tarballObj = new URL(tarballUrl);
        const normalizedRegistries = registries
            .map(r => ({
                url: normalizeUrl(r.url),
                urlObj: new URL(r.url)
            }))
            .sort((a, b) => b.url.length - a.url.length);

        for (const { url, urlObj } of normalizedRegistries) {
            if (
                tarballObj.protocol === urlObj.protocol &&
                tarballObj.host === urlObj.host &&
                tarballObj.pathname.startsWith(urlObj.pathname)
            ) {
                return tarballUrl.slice(url.length - 1);
            }
        }
    } catch (e) {
        console.error(`Invalid URL: ${tarballUrl}`, e);
    }
    return tarballUrl;
}

async function loadProxyConfig(
    proxyConfigPath = './.registry-proxy.yml'
): Promise<ProxyConfig> {
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

    return Object.entries(proxyConfig.registries).map(([url, regConfig]) => {
        let token = regConfig?.npmAuthToken;
        const normalizedUrl = normalizeUrl(url);

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

        return { url: normalizedUrl, token };
    });
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
            res.writeHead(400).end('Invalid Request');
            return;
        }

        // Handle base path
        const fullUrl = new URL(req.url, `${proxyConfig.https ? 'https' : 'http'}://${req.headers.host}`);
        if (basePath && !fullUrl.pathname.startsWith(basePath)) {
            res.writeHead(404).end('Not Found');
            return;
        }

        const relativePath = basePath
            ? fullUrl.pathname.slice(basePath.length)
            : fullUrl.pathname;

        console.log(`Proxying: ${relativePath}`);

        const responses = await Promise.all(
            registries.map(async ({ url, token }) => {
                try {
                    const targetUrl = `${url}${relativePath}${fullUrl.search || ''}`;
                    const headers = token ? { Authorization: `Bearer ${token}` } : undefined;
                    const response = await fetch(targetUrl, { headers });
                    return response.ok ? response : null;
                } catch (e) {
                    console.error(`Failed to fetch from ${url}:`, e);
                    return null;
                }
            })
        );

        const successResponse = responses.find((r): r is Response => r !== null);
        if (!successResponse) {
            res.writeHead(404).end('Not Found');
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
                res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(data));
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
            res.writeHead(successResponse.status, safeHeaders);
            successResponse.body.pipe(res);
        }
    };

    let server: HttpServer | HttpsServer;
    if (proxyConfig.https) {
        const { key, cert } = proxyConfig.https;
        try {
            await fsPromises.access(resolvePath(key));
            await fsPromises.access(resolvePath(cert));
        } catch (e) {
            console.error(`HTTPS config error: key or cert file not found`, e);
            process.exit(1);
        }
        const httpsOptions = {
            key: readFileSync(resolvePath(key)),
            cert: readFileSync(resolvePath(cert)),
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