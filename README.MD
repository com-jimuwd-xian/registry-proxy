# Registry Proxy

一个轻量级的 Yarn 代理服务器，支持从多个注册表获取包，并支持身份验证。

[Switch to English README](#english-version)

## 概述

本项目提供了一个本地代理服务器（`registry-proxy`），允许 Yarn 从多个注册表获取包，并支持身份验证令牌。项目还包括一个脚本（`src/client/yarn-install`），用于自动化启动代理服务器、安装依赖和清理资源的过程。该设置确保与 Yarn 无缝集成，开发者只需使用标准的 `yarn` 命令即可通过代理安装依赖。

## 功能

- **多注册表支持**：从多个注册表（例如私有和公共注册表）获取包。
- **身份验证**：支持 `npmAuthToken` 用于认证注册表，可从 `.registry-proxy.yml`、`.yarnrc.yml` 或环境变量中解析令牌。
- **动态端口分配**：代理服务器使用动态端口（默认 `0`），确保多个项目可以并行运行而不会发生端口冲突。
- **无缝 Yarn 集成**：运行 `yarn` 时自动启动代理服务器，安装依赖后停止代理。
- **健壮的错误处理**：使用严格的 Bash 模式（`set -e`、`set -u`、`set -o pipefail`）确保脚本在发生错误时快速失败。
- **文件放置控制**：确保临时文件（`.registry-proxy-install.lock` 和 `.registry-proxy-port`）始终放置在项目根目录。

## 前置条件

- **Node.js**：版本 14 或更高。
- **Yarn**：版本 1.x 或 2.x。
- **netcat (`nc`)**：用于脚本中的端口可用性检查。安装方法：
  - macOS：`brew install netcat`
  - Ubuntu：`sudo apt-get install netcat`
- **Bash**：安装脚本需要 Bash 兼容的 shell。

## 设置

### 1. 安装 `registry-proxy`

代理服务器已发布到您的私有注册表。可以将其作为依赖安装，或使用 `npx` 直接运行。

```bash
yarn add com.jimuwd.xian.registry-proxy --registry https://repo.jimuwd.com/jimuwd/~npm/
```

或者，安装脚本使用 `npx` 运行代理服务器，因此无需显式安装。

### 2. 配置注册表

在项目根目录创建 `.registry-proxy.yml` 文件，定义注册表：

```yaml
registries:
  "https://repo.jimuwd.com/jimuwd/~npm/": {}
  "https://registry.npmjs.org/": {}
```

- 对于需要认证的注册表，可以指定 `npmAuthToken`：
  ```yaml
  registries:
    "https://repo.jimuwd.com/jimuwd/~npm/":
      npmAuthToken: "your-token-here"
    "https://registry.npmjs.org/": {}
  ```
- 令牌也可以从 `.yarnrc.yml`（本地或全局）或环境变量中获取。

### 3. 配置 Yarn

在项目根目录创建 `.yarnrc.yml` 文件，允许 Yarn 使用本地代理：

```yaml
unsafeHttpWhitelist:
  - "[::1]"
```

### 4. 安装命令
```shell
yarn dlx -p com.jimuwd.xian.registry-proxy yarn-install
```

### 5. 与 Yarn 集成

更新 `package.json`，使 `yarn` 命令自动运行脚本：

```json
{
  "scripts": {
    "preinstall": "yarn dlx -p com.jimuwd.xian.registry-proxy yarn-install",
    "install": "echo 'Custom install script is running via preinstall, skipping default install.'"
  }
}
```

- **`preinstall`**：在 Yarn 默认安装过程之前运行脚本。
- **`install`**：跳过 Yarn 默认安装行为，因为脚本已处理依赖安装。

## 使用方法

### 安装依赖

只需运行标准的 `yarn` 命令即可通过代理安装依赖：

```bash
yarn
```

- 脚本将：
   1. 在动态端口上启动代理服务器。
   2. 使用代理安装依赖。
   3. 停止代理服务器并清理临时文件。

- 指定 `registry-proxy` 版本：
  ```bash
  REGISTRY_PROXY_VERSION=1.0.0 yarn
  ```

### 示例输出

```
Waiting for proxy server to start...
Proxy server started at http://localhost:49152
Proxy server is ready on port 49152!
[yarn install 输出]
Stopping proxy server...
Received SIGTERM, shutting down...
Server closed.
Proxy server stopped.
Custom install script is running via preinstall, skipping default install.
```

### 并行构建

代理服务器使用动态端口，因此可以并行运行多个项目：

```bash
cd project1 && yarn &
cd project2 && yarn &
```

每个项目将使用不同的端口（例如 `49152` 和 `49153`）。

## 临时文件

脚本在执行期间会生成两个临时文件：

- **`.registry-proxy-install.lock`**：
   - 用途：防止脚本在同一项目中多次运行（避免 `yarn install` 导致的循环）。
   - 位置：始终放置在项目根目录（`package.json` 所在目录）。
- **`.registry-proxy-port`**：
   - 用途：存储代理服务器的动态端口号。
   - 位置：始终放置在项目根目录。

### 防止文件误放置

- 脚本通过查找 `package.json` 动态确定项目根目录，确保临时文件始终放置在正确位置，即使从子目录运行 `yarn`（例如 `cd src && yarn`）。
- 如果无法找到项目根目录，脚本将报错并退出：
  ```
  Error: Could not find project root (package.json not found)
  ```

### 清理

- 临时文件会在以下情况下自动删除：
   - 脚本成功完成时。
   - 中断（例如 `Ctrl+C`）时。
- 脚本使用信号处理（`trap`）确保即使中断也能执行清理。

## 注意事项

1. **严格模式**：
   - 脚本使用 Bash 严格模式（`set -e`、`set -u`、`set -o pipefail`）确保健壮的错误处理：
      - `set -e`：任何命令失败时退出。
      - `set -u`：未定义变量时退出。
      - `set -o pipefail`：管道中任一命令失败时退出。

2. **并行执行**：
   - 锁文件（`.registry-proxy-install.lock`）仅在同一项目内防止重复执行，不影响不同项目的并行构建。
   - 如果需要在同一项目中运行多个 `yarn` 进程（例如 CI 环境），可以考虑为每个进程使用唯一的锁文件（例如基于进程 ID）。

3. **依赖**：
   - 确保已安装 `nc`（netcat）以进行端口可用性检查。
   - 脚本使用 `npx` 运行 `registry-proxy`，无需预安装。

## 故障排除

### 代理服务器无法启动

- **症状**：`Error: Proxy server failed to start`
- **可能原因**：
   - 指定的 `REGISTRY_PROXY_VERSION` 无效。
   - 网络问题导致 `npx` 无法下载包。
- **解决方法**：
   - 验证版本：`REGISTRY_PROXY_VERSION=latest yarn`。
   - 检查网络连接并重试。

### 临时文件未清理

- **症状**：`.registry-proxy-install.lock` 或 `.registry-proxy-port` 在脚本执行后仍存在。
- **可能原因**：脚本被异常终止（例如 `kill -9` 而非 `Ctrl+C`）。
- **解决方法**：
   - 手动删除文件：
     ```bash
     rm -f .registry-proxy-install.lock .registry-proxy-port
     ```
   - 使用 `Ctrl+C` 或 `kill -TERM` 确保正常清理。

### Yarn 安装失败

- **症状**：`yarn install` 失败并显示网络错误。
- **可能原因**：代理服务器未正确启动，或注册表不可达。
- **解决方法**：
   - 检查代理服务器日志（由 `registry-proxy` 输出）。
   - 验证 `.registry-proxy.yml` 中的注册表 URL。

## 测试

### 正常安装

```bash
cd project1
yarn
```

### 子目录安装

从子目录运行 `yarn`，验证临时文件是否放置在项目根目录：

```bash
cd project1/src
yarn
ls ../.registry-proxy-install.lock ../.registry-proxy-port
```

### 中断处理

运行 `yarn` 并在执行期间按 `Ctrl+C`，验证清理：

```bash
cd project1
yarn
# 在 "Waiting for proxy server to start..." 后按 Ctrl+C
ls .registry-proxy-install.lock .registry-proxy-port
```

预期输出：文件应不存在。

### 并行构建

并行运行多个项目，验证端口分配：

```bash
cd project1 && yarn &
cd project2 && yarn &
```

## 贡献

1. Fork 本仓库。
2. 创建功能分支：`git checkout -b feature-name`。
3. 提交更改：`git commit -m "Add feature"`。
4. 推送分支：`git push origin feature-name`。
5. 提交 Pull Request。

## 许可证

MIT 许可证。详见 [LICENSE](LICENSE)。


# English Version

## Registry Proxy

A lightweight proxy server for Yarn to fetch packages from multiple registries with authentication support.

## Overview

This project provides a proxy server (`registry-proxy`) that allows Yarn to fetch packages from multiple registries, with support for authentication tokens. It also includes a script (`src/client/yarn-install`) to automate the process of starting the proxy server, installing dependencies, and cleaning up resources. The setup ensures seamless integration with Yarn, allowing developers to use the standard `yarn` command to install dependencies via the proxy.

## Features

- **Multi-Registry Support**: Fetch packages from multiple registries (e.g., private and public registries).
- **Authentication**: Supports `npmAuthToken` for authenticated registries, with token resolution from `.registry-proxy.yml`, `.yarnrc.yml`, or environment variables.
- **Dynamic Port Allocation**: The proxy server uses a dynamic port (default `0`), ensuring multiple projects can run in parallel without port conflicts.
- **Seamless Yarn Integration**: Automatically starts the proxy server when running `yarn`, installs dependencies, and stops the proxy afterward.
- **Robust Error Handling**: Uses strict Bash modes (`set -e`, `set -u`, `set -o pipefail`) to ensure the script fails fast on errors.
- **File Placement Control**: Ensures temporary files (`.registry-proxy-install.lock` and `.registry-proxy-port`) are always placed in the project root directory.

## Prerequisites

- **Node.js**: Version 14 or higher.
- **Yarn**: Version 1.x or 2.x.
- **netcat (`nc`)**: Required for port availability checks in the installation script. Install via:
   - On macOS: `brew install netcat`
   - On Ubuntu: `sudo apt-get install netcat`
- **Bash**: The installation script requires a Bash-compatible shell.

## Setup

### 1. Install `registry-proxy`

The proxy server is published to your private registry. Install it as a dependency or use `npx` to run it directly.

```bash
yarn add com.jimuwd.xian.registry-proxy --registry https://repo.jimuwd.com/jimuwd/~npm/
```

Alternatively, the installation script uses `npx` to run the proxy server, so you don't need to install it explicitly.

### 2. Configure Registries

Create a `.registry-proxy.yml` file in your project root to define the registries:

```yaml
registries:
  "https://repo.jimuwd.com/jimuwd/~npm/": {}
  "https://registry.npmjs.org/": {}
```

- You can specify `npmAuthToken` for authenticated registries:
  ```yaml
  registries:
    "https://repo.jimuwd.com/jimuwd/~npm/":
      npmAuthToken: "your-token-here"
    "https://registry.npmjs.org/": {}
  ```
- Tokens can also be sourced from `.yarnrc.yml` (local or global) or environment variables.

### 3. Configure Yarn

Create a `.yarnrc.yml` file in your project root to allow Yarn to use the local proxy:

```yaml
unsafeHttpWhitelist:
  - "[::1]"
```

### 4. install Script

use below cmd to automate the proxy setup and dependency installation.
```shell
yarn dlx -p com.jimuwd.xian.registry-proxy yarn-install
```

### 5. Integrate with Yarn

Update your `package.json` to run the script automatically when `yarn` is executed:

```json
{
  "scripts": {
    "preinstall": "yarn dlx -p com.jimuwd.xian.registry-proxy yarn-install",
    "install": "echo 'Custom install script is running via preinstall, skipping default install.'"
  }
}
```

- **`preinstall`**: Runs the script before Yarn's default install process.
- **`install`**: Skips Yarn's default install behavior, as the script already handles dependency installation.

## Usage

### Install Dependencies

Simply run the standard `yarn` command to install dependencies via the proxy:

```bash
yarn
```

- The script will:
   1. Start the proxy server on a dynamic port.
   2. Install dependencies using the proxy.
   3. Stop the proxy server and clean up temporary files.

- To specify a version of `registry-proxy`:
  ```bash
  REGISTRY_PROXY_VERSION=1.0.0 yarn
  ```

### Example Output

```
Waiting for proxy server to start...
Proxy server started at http://localhost:49152
Proxy server is ready on port 49152!
[yarn install output]
Stopping proxy server...
Received SIGTERM, shutting down...
Server closed.
Proxy server stopped.
Custom install script is running via preinstall, skipping default install.
```

### Parallel Builds

The proxy server uses dynamic ports, so you can run multiple projects in parallel:

```bash
cd project1 && yarn &
cd project2 && yarn &
```

Each project will use a different port (e.g., `49152` and `49153`).

## Temporary Files

The script generates two temporary files during execution:

- **`.registry-proxy-install.lock`**:
   - Purpose: Prevents the script from running multiple times in the same project (avoids loops caused by `yarn install`).
   - Location: Always placed in the project root directory (where `package.json` resides).
- **`.registry-proxy-port`**:
   - Purpose: Stores the dynamic port number of the proxy server.
   - Location: Always placed in the project root directory.

### Preventing Misplacement

- The script dynamically determines the project root by locating `package.json`, ensuring temporary files are always placed in the correct location, even if `yarn` is run from a subdirectory (e.g., `cd src && yarn`).
- If the project root cannot be found, the script will exit with an error:
  ```
  Error: Could not find project root (package.json not found)
  ```

### Cleanup

- Temporary files are automatically removed:
   - On successful completion of the script.
   - On interruption (e.g., `Ctrl+C`).
- The script uses signal handling (`trap`) to ensure cleanup occurs even if interrupted.

## Notes

1. **Strict Mode**:
   - The script uses Bash strict modes (`set -e`, `set -u`, `set -o pipefail`) to ensure robust error handling:
      - `set -e`: Exits on any command failure.
      - `set -u`: Exits on undefined variables.
      - `set -o pipefail`: Exits if any command in a pipeline fails.

2. **Parallel Execution**:
   - The lock file (`.registry-proxy-install.lock`) prevents multiple executions within the same project but does not affect different projects.
   - If you need to run multiple `yarn` processes in the same project (e.g., in a CI environment), consider using a unique lock file per process (e.g., based on process ID).

3. **Dependencies**:
   - Ensure `nc` (netcat) is installed for port availability checks.
   - The script uses `npx` to run `registry-proxy`, so no pre-installation is required.

## Troubleshooting

### Proxy Server Fails to Start

- **Symptom**: `Error: Proxy server failed to start`
- **Possible Causes**:
   - The specified `REGISTRY_PROXY_VERSION` is invalid.
   - Network issues prevent `npx` from downloading the package.
- **Solution**:
   - Verify the version: `REGISTRY_PROXY_VERSION=latest yarn`.
   - Check network connectivity and retry.

### Temporary Files Not Cleaned Up

- **Symptom**: `.registry-proxy-install.lock` or `.registry-proxy-port` remains after script execution.
- **Possible Cause**: The script was terminated abnormally (e.g., `kill -9` instead of `Ctrl+C`).
- **Solution**:
   - Manually remove the files:
     ```bash
     rm -f .registry-proxy-install.lock .registry-proxy-port
     ```
   - Use `Ctrl+C` or `kill -TERM` to ensure proper cleanup.

### Yarn Install Fails

- **Symptom**: `yarn install` fails with a network error.
- **Possible Cause**: The proxy server did not start correctly, or the registry is unreachable.
- **Solution**:
   - Check the proxy server logs (output by `registry-proxy`).
   - Verify the registry URLs in `.registry-proxy.yml`.

## Testing

### Normal Installation

```bash
cd project1
yarn
```

### Subdirectory Installation

Run `yarn` from a subdirectory to verify that temporary files are placed in the project root:

```bash
cd project1/src
yarn
ls ../.registry-proxy-install.lock ../.registry-proxy-port
```

### Interrupt Handling

Run `yarn` and press `Ctrl+C` during execution to verify cleanup:

```bash
cd project1
yarn
# Press Ctrl+C after "Waiting for proxy server to start..."
ls .registry-proxy-install.lock .registry-proxy-port
```

Expected output: Files should not exist.

### Parallel Builds

Run multiple projects in parallel to verify port allocation:

```bash
cd project1 && yarn &
cd project2 && yarn &
```

## Contributing

1. Fork the repository.
2. Create a feature branch: `git checkout -b feature-name`.
3. Commit your changes: `git commit -m "Add feature"`.
4. Push to the branch: `git push origin feature-name`.
5. Open a pull request.

## License

MIT License. See [LICENSE](LICENSE) for details.
