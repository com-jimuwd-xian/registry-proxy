
# README.md

## 项目简介

`com.jimuwd.xian.registry-proxy` 是一个轻量级的 npm 代理服务器，旨在为 Node.js 项目提供多 registry 的代理和 fallback 机制。它通过读取独立的配置文件 `.registry-proxy.yml`，将多个 npm registry（如公共 registry、私有仓库等）代理到一个本地端口（默认 `4873`），并支持在 `.registry-proxy.yml` 中 token 缺失时从 Yarn 配置文件（本地 `.yarnrc.yml` 和全局 `~/.yarnrc.yml`）回退获取认证信息。  
主要功能：
- **多 registry 代理**：将多个 npm registry 统一代理到本地端口，提供单一访问入口。
- **Fallback 机制**：按配置顺序尝试多个 registry，直到找到可用包。
- **灵活的 token 管理**：优先使用 `.registry-proxy.yml` 中的 `npmAuthToken`，缺失时从 Yarn 配置文件读取。
- **优雅关闭**：支持通过 SIGTERM 信号优雅停止服务。

这个工具特别适合需要同时访问多个 npm 源的开发场景，尤其在 CI/CD 或本地开发中，能提高依赖安装的稳定性和效率。

---

## 快速上手指南

### 安装
在你的业务项目中，将 `com.jimuwd.xian.registry-proxy` 添加为开发依赖。假设你的私有 Yarn 仓库地址为 `https://your-private-registry.example.com/`：

```bash
yarn add --dev com.jimuwd.xian.registry-proxy --registry https://your-private-registry.example.com/
```

### 配置
1. **代理配置文件 `.registry-proxy.yml`**  
   在业务项目根目录创建 `.registry-proxy.yml`，指定需要代理的 registry 列表：
   ```yaml
   registries:
     "http://localhost:4873/":
       npmAuthToken: "local-token" # 可选
     "https://registry.npmjs.org/":
       # token 可省略，从 Yarn 配置读取
     "https://your-private-registry.example.com/":
       npmAuthToken: "private-token" # 可选
       npmAlwaysAuth: true          # 强制要求认证
   ```

2. **本地 `.yarnrc.yml`**  
   在项目根目录创建或编辑 `.yarnrc.yml`，指定 Yarn 使用本地代理地址：
   ```yaml
   npmRegistryServer: "http://localhost:4873/"
   unsafeHttpWhitelist:
     - "localhost"
   ```

3. **全局 `~/.yarnrc.yml`（可选）**  
   如果 `.registry-proxy.yml` 未提供某些 registry 的 token，可以在用户主目录下的 `.yarnrc.yml` 配置回退 token：
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
   yarn run registry-proxy .registry-proxy.yml .yarnrc.yml ~/.yarnrc.yml &
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
       "start-proxy": "registry-proxy .registry-proxy.yml .yarnrc.yml ~/.yarnrc.yml",
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
   - **代理配置文件**：从指定路径（默认 `./.registry-proxy.yml`）读取 `registries`，提取 `registryUrl` 和 `npmAuthToken`。
   - **Yarn 配置文件回退**：如果 `.registry-proxy.yml` 中 token 缺失，依次从本地 `.yarnrc.yml`（默认 `./.yarnrc.yml`）和全局 `~/.yarnrc.yml`（默认 `~/.yarnrc.yml`）读取对应 `registryUrl` 的 `npmAuthToken`。
   - **安全设计**：将 `registryUrl` 和 token 配置独立于 `.registry-proxy.yml`，避免敏感信息直接写入 Yarn 配置文件并提交到代码仓库。回退到 Yarn 配置的 token（尤其是全局配置）进一步降低安全隐患。
   - **优先级**：`.registry-proxy.yml` token > 本地 `.yarnrc.yml` token > 全局 `~/.yarnrc.yml` token > 无 token。
   - **错误处理**：`.registry-proxy.yml` 必须存在且包含 `registries`，否则退出。

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
   - `js-yaml@^4.1.0`：解析 `.registry-proxy.yml` 和 `.yarnrc.yml` 文件。
- **Node.js 版本**：推荐 v14+，测试于 v20.17.0。

### CLI 参数
```bash
registry-proxy [proxyConfigPath] [localYarnConfigPath] [globalYarnConfigPath] [port]
```
- `proxyConfigPath`：代理配置文件路径，默认 `./.registry-proxy.yml`。
- `localYarnConfigPath`：本地 Yarn 配置文件路径，默认 `./.yarnrc.yml`。
- `globalYarnConfigPath`：全局 Yarn 配置文件路径，默认 `~/.yarnrc.yml`。
- `port`：代理服务器端口，默认 `4873`。

示例：
```bash
yarn run registry-proxy ./custom-registry.yml ./custom-yarn.yml ~/.custom-yarn.yml 54321
```

### 配置说明
- **`.registry-proxy.yml`**：
   - 使用 `registries` 字段定义代理的 registry 列表，与 Yarn 的 `npmRegistries` 区分。
   - 示例：
     ```yaml
     registries:
       "https://your-private-registry.example.com/":
         npmAuthToken: "private-token"
         npmAlwaysAuth: true
     ```
- **`npmAlwaysAuth: true`**：
   - 在需要认证的 registry 下添加此配置，表示所有请求必须携带 `npmAuthToken`。
   - **原因**：某些私有仓库要求即使访问公共包也需要认证，设置此项避免因缺少 token 导致的 401 错误。
- **Yarn 配置**：
   - `.yarnrc.yml` 仅用于设置 `npmRegistryServer` 和回退 token，不定义代理的 registry 列表。

### 注意事项
1. **端口冲突**：
   - 默认端口 `4873` 是 Verdaccio 的惯用端口，可能与其他工具冲突。
   - 检查端口占用：`lsof -i :4873`。
   - 可通过参数指定其他端口（如 `54321`）。
2. **配置文件格式**：
   - 确保 `.registry-proxy.yml` 包含 `registries` 字段，`.yarnrc.yml` 包含 `npmRegistryServer`。
3. **日志**：
   - 当前通过 `console.log` 输出启动信息，可扩展为文件日志。
4. **安全性**：
   - 代理运行于本地，未开放外部访问，确保 `unsafeHttpWhitelist` 配置正确。
   - 优先将 token 放入 `.registry-proxy.yml` 或全局 `.yarnrc.yml`，避免提交到代码仓库。

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

### 测试流程
1. **构建并发布**：
   ```bash
   cd registry-proxy
   yarn install
   yarn build
   yarn publish --registry https://your-private-registry.example.com/
   ```
2. **业务项目配置**：
   - `.registry-proxy.yml`：
     ```yaml
     registries:
       "http://localhost:4873/":
         npmAuthToken: "local-token"
       "https://registry.npmjs.org/":
         # 无 token，回退到 Yarn 配置
       "https://your-private-registry.example.com/":
         npmAuthToken: "private-token"
         npmAlwaysAuth: true
     ```
   - `.yarnrc.yml`：
     ```yaml
     npmRegistryServer: "http://localhost:4873/"
     unsafeHttpWhitelist:
       - "localhost"
     ```
   - `~/.yarnrc.yml`：
     ```yaml
     npmRegistries:
       "https://registry.npmjs.org/":
         npmAuthToken: "global-npm-token"
     ```
3. **运行**：
   ```bash
   yarn install
   ```


