const REGISTRY_PROXY_CONFIG_FILE_NAME = '.registry-proxy.yml';//server配置文件名
const PORT_FILE_NAME = '.registry-proxy-port';//server、client共享使用的端口号文件名
const YARNRC_CONFIG_FILE_NAME = '.yarnrc.yml';//server、client共享使用的yarn配置文件名


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
    npmRegistryServer?: string | null | undefined;
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

export {
    RegistryConfig,
    HttpsConfig,
    ProxyConfig,
    YarnConfig,
    RegistryInfo,
    ProxyInfo,
    PackageVersion,
    PackageData,
    REGISTRY_PROXY_CONFIG_FILE_NAME,
    PORT_FILE_NAME,
    YARNRC_CONFIG_FILE_NAME,
}