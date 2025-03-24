
# README.md

## 项目简介

`com.jimuwd.xian.registry-proxy` 是一个轻量级的 npm 代理服务器，旨在为 Node.js 项目提供多 registry 的代理和 fallback 机制。它通过读取 Yarn 的配置文件（`.yarnrc.yml`），将多个 npm registry（如公共 registry、私有仓库等）代理到一个本地端口（默认 `4873`），并支持在本地 token 缺失时从全局配置文件回退获取认证信息。  
主要功能：
- **多 registry 代理**：将多个 npm registry 统一代理到本地端口，提供单一访问入口。
- **Fallback 机制**：按配置顺序尝试多个 registry，直到找到可用包。
- **灵活的 token 管理**：优先使用本地配置文件中的 `npmAuthToken`，缺失时从全局配置文件读取。
- **优雅关闭**：支持通过 SIGTERM 信号优雅停止服务。

这个工具特别适合需要同时访问多个 npm 源（例如公司私有仓库和公共 npm registry）的开发场景，尤其在 CI/CD 或本地开发中，能显著提高依赖安装的稳定性和效率。

---

## 快速上手指南

### 安装
在你的业务项目中，将 `com.jimuwd.xian.registry-proxy` 添加为开发依赖。假设你的私有 Yarn 仓库地址为 `https://your-private-registry.example.com/`：

```bash
yarn add --dev com.jimuwd.xian.registry-proxy --registry https://your-private-registry.example.com/
```

### 配置
1. **本地 `.yarnrc.yml`**  
   在业务项目根目录创建或编辑 `.yarnrc.yml`，指定需要代理的 registry 和本地代理地址。对于需要认证的 registry，建议添加 `npmAlwaysAuth: true`：
   ```yaml
   npmRegistries:
     "http://localhost:4873/":
       npmAuthToken: "local-token" # 可选
     "https://registry.npmjs.org/":
       # token 可省略，从全局读取
     "https://your-private-registry.example.com/":
       npmAuthToken: "private-token" # 可选
       npmAlwaysAuth: true          # 强制要求认证

   npmRegistryServer: "http://localhost:4873/"
   unsafeHttpWhitelist:
     - "localhost"
   ```

2. **全局 `~/.yarnrc.yml`（可选）**  
   如果本地未提供某些 registry 的 token，可以在用户主目录下的 `.yarnrc.yml` 配置回退 token：
   ```yaml
   npmRegistries:
     "https://registry.npmjs.org/":
       npmAuthToken: "global-npm-token"
     "https://your-private-registry.example.com/":
       npmAuthToken: "global-private-token"
       npmAlwaysAuth: true
   ```

### 使用
1. **创建启动脚本 `start-proxy.sh`**  
   在项目根目录添加以下脚本，用于启动代理并安装依赖：
   ```bash
   #!/bin/bash

   # 启动代理服务器并记录 PID
   yarn run registry-proxy .yarnrc.yml ~/.yarnrc.yml &
   PROXY_PID=$!

   # 等待代理服务器启动，最多 10 秒
   echo "Waiting for proxy server to start on port 4873..."
   for i in {1..100}; do
     if nc -z localhost 4873 2>/dev/null; then
       echo "Proxy server is ready!"
       break
     fi
     sleep 0.1
   done

   # 检查是否成功启动
   if ! nc -z localhost 4873 2>/dev/null; then
     echo "Error: Proxy server failed to start on port 4873"
     kill $PROXY_PID
     exit 1
   fi

   # 使用本地代理运行 yarn install
   yarn install --registry http://localhost:4873/

   # 停止代理服务器
   echo "Stopping proxy server..."
   kill -TERM $PROXY_PID
   wait $PROXY_PID 2>/dev/null
   echo "Proxy server stopped."
   ```

2. **添加 Yarn 脚本**  
   在 `package.json` 中定义快捷命令：
   ```json
   {
     "scripts": {
       "start-proxy": "registry-proxy .yarnrc.yml ~/.yarnrc.yml",
       "install": "bash start-proxy.sh"
     }
   }
   ```

3. **运行**  
   执行以下命令启动代理并安装依赖：
   ```bash
   yarn install
   ```
    - 代理会在安装完成后自动停止。

### 输出示例
运行后，你会看到类似以下输出：
```
Waiting for proxy server to start on port 4873...
Proxy server started at http://localhost:4873
Proxy server is ready!
[yarn install 输出]
Stopping proxy server...
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
    - **本地配置文件**：从指定路径（默认 `./.yarnrc.yml`）读取 `npmRegistries`，提取 `registryUrl` 和 `npmAuthToken`。
    - **全局配置文件**：如果本地 token 缺失，从指定路径（默认 `~/.yarnrc.yml`）读取对应 `registryUrl` 的 token。
    - **安全设计**：本地 token 缺失时回退到全局 token 的设计，是为了避免将敏感的 `npmAuthToken` 写入项目配置文件并提交到代码仓库，从而降低安全隐患。全局配置文件（如 `~/.yarnrc.yml`）通常存储在用户主目录，不会被版本控制系统追踪。
    - **优先级**：本地 token > 全局 token > 无 token。
    - **错误处理**：本地配置文件必须存在且包含 `npmRegistries`，否则退出。

2. **代理逻辑**：
    - **服务器**：使用 Node.js 的 `http.createServer` 创建本地 HTTP 服务，默认监听 `4873` 端口。
    - **请求转发**：将所有请求按配置顺序转发到目标 registry，附带对应的 `Authorization: Bearer <token>`（如果存在）。
    - **Fallback**：依次尝试每个 registry，直到返回成功响应（`response.ok`）或全部失败（返回 404）。

3. **进程管理**：
    - **优雅关闭**：监听 `SIGTERM` 信号，关闭服务器并退出进程。
    - **脚本集成**：通过 shell 脚本记录 PID，安装完成后发送 SIGTERM 停止服务。

### 技术栈
- **语言**：TypeScript（ES Modules）。
- **模块系统**：`"module": "nodenext"`，兼容 Node.js v20+。
- **依赖**：
    - `node-fetch@^3.3.2`：发起 HTTP 请求。
    - `js-yaml@^4.1.0`：解析 `.yarnrc.yml` 文件。
- **Node.js 版本**：推荐 v14+，测试于 v20.17.0。

### CLI 参数
```bash
registry-proxy [localConfigPath] [globalConfigPath] [port]
```
- `localConfigPath`：本地 `.yarnrc.yml` 路径，默认 `./.yarnrc.yml`。
- `globalConfigPath`：全局 `.yarnrc.yml` 路径，默认 `~/.yarnrc.yml`。
- `port`：代理服务器端口，默认 `4873`。

示例：
```bash
yarn run registry-proxy ./custom.yml ~/.custom.yml 54321
```

### 配置说明
- **`npmAlwaysAuth: true`**：
    - 在 `.yarnrc.yml` 中为需要认证的 registry 添加此配置，表示对该 registry 的所有请求都必须携带 `npmAuthToken`。
    - **原因**：某些私有 npm 仓库（例如 Nexus 或 Artifactory）要求即使访问公共包，也需要认证。设置 `npmAlwaysAuth: true` 确保代理在转发请求时始终附带 token，避免因缺少认证导致的 401 错误。
    - 如果不设置此项，Yarn 可能只在下载受限包时发送 token，而对公开包跳过认证，可能导致请求失败。

### 注意事项
1. **端口冲突**：
    - 默认端口 `4873` 是 Verdaccio 的惯用端口，可能与其他工具冲突。
    - 检查端口占用：`lsof -i :4873`。
    - 可通过参数指定其他端口（如 `54321`）。
2. **配置文件格式**：
    - 确保 `.yarnrc.yml` 遵循 Yarn 的格式，`npmRegistries` 为必填项。
3. **日志**：
    - 当前通过 `console.log` 输出启动信息，可扩展为文件日志。
4. **安全性**：
    - 代理运行于本地，未开放外部访问，确保 `unsafeHttpWhitelist` 配置正确。
    - 避免将 token 写入本地 `.yarnrc.yml`，优先使用全局配置或环境变量。

### 开发与发布
1. **构建**：
   ```bash
   yarn build
   ```
2. **发布到私有仓库**：
   ```bash
   yarn publish --registry https://your-private-registry.example.com/
   ```

---
