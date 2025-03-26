# README.md

## 项目简介

`com.jimuwd.xian.registry-proxy` 是一个轻量级的 npm 代理服务器，旨在为 Node.js 项目提供多 registry 的代理和 fallback 机制。它通过读取独立的配置文件 `.registry-proxy.yml`，将多个 npm registry（如公共 registry、私有仓库等）代理到一个动态分配的本地端口，并在 `.registry-proxy.yml` 中 token 缺失时从 Yarn 配置文件（本地 `.yarnrc.yml` 和全局 `~/.yarnrc.yml`）回退获取认证信息。  
主要功能：
- **多 registry 代理**：将多个 npm registry 统一代理到本地动态端口，提供单一访问入口。
- **动态端口**：支持多个项目并行构建，避免端口冲突。
- **Fallback 机制**：按配置顺序尝试多个 registry，直到找到可用包。
- **灵活的 token 管理**：优先使用 `.registry-proxy.yml` 中的 `npmAuthToken`，缺失时从 Yarn 配置文件读取。
- **优雅关闭**：通过 SIGTERM 信号确保服务彻底停止。

这个工具特别适合在本地同时构建多个业务项目，尤其在 CI/CD 或开发环境中，能提高依赖安装的效率和灵活性。

---

## 快速上手指南

### 配置
1. **代理配置文件 `.registry-proxy.yml`**  
   在业务项目根目录创建 `.registry-proxy.yml`，指定需要代理的 registry 列表。每个 registry 必须至少是一个空对象 `{}`，否则会导致解析错误：
   ```yaml
   registries:
     "https://registry.npmjs.org/":
       {}                          # 无 token 时使用空对象
     "https://repo.jimuwd.com/jimuwd/~npm/":
       npmAuthToken: "private-token" # 可选
   ```

2. **本地 `.yarnrc.yml`**  
   在项目根目录创建或编辑 `.yarnrc.yml`，允许本地代理：
   ```yaml
   unsafeHttpWhitelist:
     - "localhost"
   ```

3. **全局 `~/.yarnrc.yml`（可选）**  
   如果 `.registry-proxy.yml` 未提供某些 registry 的 token，可以在用户主目录下的 `.yarnrc.yml` 配置回退 token：
   ```yaml
   npmRegistries:
     "https://registry.npmjs.org/":
       npmAuthToken: "global-npm-token"
     "https://repo.jimuwd.com/jimuwd/~npm/":
       npmAuthToken: "global-private-token"
   ```

### 使用
1. **创建安装脚本 `install-from-proxy-registries.sh`**  
   在项目根目录添加以下脚本，用于启动代理并安装依赖：
   ```bash
   #!/bin/bash

   # 通过 npx 运行 registry-proxy，无需预装依赖
   REGISTRY_PROXY_VERSION=${REGISTRY_PROXY_VERSION:-"latest"}
   npx com.jimuwd.xian.registry-proxy@"$REGISTRY_PROXY_VERSION" .registry-proxy.yml .yarnrc.yml ~/.yarnrc.yml &
   PROXY_PID=$!

   # 等待代理服务器启动并写入端口，最多 10 秒
   echo "Waiting for proxy server to start..."
   for i in {1..100}; do
     if [ -f .registry-proxy-port ]; then
       PROXY_PORT=$(cat .registry-proxy-port)
       if nc -z localhost "$PROXY_PORT" 2>/dev/null; then
         echo "Proxy server is ready on port $PROXY_PORT!"
         break
       fi
     fi
     sleep 0.1
   done

   # 检查是否成功启动
   if [ -z "$PROXY_PORT" ] || ! nc -z localhost "$PROXY_PORT" 2>/dev/null; then
     echo "Error: Proxy server failed to start"
     kill $PROXY_PID
     exit 1
   fi

   # 使用动态代理端口运行 yarn install
   yarn install --registry "http://localhost:$PROXY_PORT/"

   # 停止代理服务器
   echo "Stopping proxy server..."
   kill -TERM $PROXY_PID
   wait $PROXY_PID 2>/dev/null || { echo "Error: Failed to stop proxy server"; exit 1; }
   rm -f .registry-proxy-port
   echo "Proxy server stopped."
   ```

2. **添加 Yarn 脚本**  
   在 `package.json` 中定义快捷命令：
   ```json
   {
     "scripts": {
       "install": "bash install-from-proxy-registries.sh"
     }
   }
   ```

3. **运行**  
   在每个项目目录中执行以下命令启动代理并安装依赖：
   ```bash
   yarn install
   ```
    - 可选指定版本：
      ```bash
      REGISTRY_PROXY_VERSION=1.0.0 yarn install
      ```
    - 代理会在安装完成后自动停止，且多个项目可并行运行。

### 输出示例
运行后，你会看到类似以下输出（端口号会动态变化）：
```
Waiting for proxy server to start...
Proxy server started at http://localhost:49152
Proxy server is ready on port 49152!
[yarn install 输出]
Stopping proxy server...
Received SIGTERM, shutting down...
Server closed.
Proxy server stopped.
```

---

## 技术说明

### 项目结构
```
com.jimuwd.xian.registry-proxy/
├── src/
│   └── index.ts       # 主逻辑：代理服务器实现
├── package.json       # 项目配置和依赖
├── tsconfig.json      # TypeScript 配置
└── dist/              # 编译后的输出目录
```

### 功能实现
1. **配置加载（`loadRegistries`）**：
    - **代理配置文件**：从指定路径（默认 `./.registry-proxy.yml`）读取 `registries`，支持 `~/` 路径解析。
    - **URL 规范化**：自动去除 `registryUrl` 尾部斜杠，确保 `https://example.com/path/` 和 `https://example.com/path` 被视为同一地址，后配置覆盖前配置。
    - **Yarn 配置文件回退**：如果 `.registry-proxy.yml` 中 token 缺失，依次从本地 `.yarnrc.yml` 和全局 `~/.yarnrc.yml` 读取对应 `registryUrl` 的 `npmAuthToken`。
    - **安全设计**：将 `registryUrl` 和 token 配置独立于 `.registry-proxy.yml`，避免敏感信息写入 Yarn 配置文件并提交到代码仓库。
    - **优先级**：`.registry-proxy.yml` token > 本地 `.yarnrc.yml` token > 全局 `~/.yarnrc.yml` token > 无 token。
    - **错误处理**：`.registry-proxy.yml` 必须存在且包含 `registries`，否则退出。

2. **代理逻辑**：
    - **服务器**：使用 Node.js 的 `http.createServer` 创建本地 HTTP 服务，默认使用动态端口（`port = 0`）。
    - **端口分配**：系统自动分配可用端口，并写入 `.registry-proxy-port` 文件。
    - **请求转发**：将所有请求按配置顺序转发到目标 registry，附带对应的 `Authorization: Bearer <token>`（如果存在）。
    - **Fallback**：依次尝试每个 registry，直到返回成功响应（`response.ok`）或全部失败（返回 404）。

3. **进程管理**：
    - **优雅关闭**：监听 `SIGTERM` 信号，先关闭服务器再退出进程，5 秒超时强制退出。
    - **脚本集成**：通过 shell 脚本动态运行代理，记录 PID 和端口，安装完成后停止服务。

### 技术栈
- **语言**：TypeScript（ES Modules）。
- **模块系统**：`"module": "nodenext"`，兼容 Node.js v20+。
- **依赖**：
    - `node-fetch@^3.3.2`：发起 HTTP 请求。
    - `js-yaml@^4.1.0`：解析 `.registry-proxy.yml` 和 `.yarnrc.yml` 文件。
- **Node.js 版本**：推荐 v14+，测试于 v20.17.0。

### CLI 参数
```bash
npx com.jimuwd.xian.registry-proxy [proxyConfigPath] [localYarnConfigPath] [globalYarnConfigPath] [port]
```
- `proxyConfigPath`：代理配置文件路径，默认 `./.registry-proxy.yml`。
- `localYarnConfigPath`：本地 Yarn 配置文件路径，默认 `./.yarnrc.yml`。
- `globalYarnConfigPath`：全局 Yarn 配置文件路径，默认 `~/.yarnrc.yml`。
- `port`：代理服务器端口，默认 `0`（动态分配）。

示例：
```bash
npx com.jimuwd.xian.registry-proxy ./custom-registry.yml ./custom-yarn.yml ~/.custom-yarn.yml
```

### 配置说明
- **`.registry-proxy.yml`**：
    - 使用 `registries` 字段定义代理的 registry 列表。
    - **格式要求**：每个 `registryUrl` 后必须跟一个对象（至少是 `{}`），否则解析为 `null` 会导致运行时错误。
    - 示例：
      ```yaml
      registries:
        "https://repo.jimuwd.com/jimuwd/~npm/":
          npmAuthToken: "private-token"
      ```
- **`.yarnrc.yml`**：
    - 仅用于设置 `unsafeHttpWhitelist`，代理地址由脚本动态提供。

### 注意事项
1. **并行构建**：
    - 每个项目使用独立端口，支持本地多项目同时构建。
    - 无需预装 `com.jimuwd.xian.registry-proxy`，通过 `npx` 动态运行。
2. **路径支持**：
    - 支持 `~/` 路径，如 `~/.yarnrc.yml`。
3. **日志顺序**：
    - 停止时先打印 `Received SIGTERM, shutting down...`，然后 `Server closed.`，最后脚本输出 `Proxy server stopped.`。
4. **优雅退出**：
    - 确保服务器关闭后进程退出，超时强制终止。

### 开发与发布
1. **构建**：
   ```bash
   yarn build
   ```
2. **发布到私有仓库**：
   ```bash
   yarn publish --registry https://repo.jimuwd.com/jimuwd/~npm/
   ```

---

### 测试流程
1. **准备项目**：
    - 项目目录包含 `.registry-proxy.yml`、`install-from-proxy-registries.sh` 和 `package.json`。
2. **运行**：
   ```bash
   cd project1 && yarn install &
   cd project2 && yarn install &
   ```
3. **验证**：
    - 检查两个项目使用不同端口。
    - 确保日志顺序正确，且进程正常退出（`ps aux | grep registry-proxy` 无残留）。
