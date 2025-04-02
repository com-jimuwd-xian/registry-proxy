#!/bin/bash

eco "@@Deprecated@@"
eco "use yarn-install.ts instead!"

# 启用严格模式，但移除 set -e，手动处理错误
set -u  # 未定义变量时退出
set -o pipefail  # 管道中任一命令失败时退出

# 动态确定项目根目录（假设 package.json 所在目录为根目录）
find_project_root() {
  local dir="$PWD"
  while [ "$dir" != "/" ]; do
    if [ -f "$dir/package.json" ]; then
      echo "$dir"
      return 0
    fi
    dir=$(dirname "$dir")
  done
  echo "Error: Could not find project root (package.json not found)" >&2
  exit 1
}

PROJECT_ROOT=$(find_project_root)

# 定义锁文件和端口文件路径（固定在项目根目录）
LOCK_FILE="$PROJECT_ROOT/.registry-proxy-install.lock"

# 检查是否已经在运行（通过锁文件）
if [ -f "$LOCK_FILE" ]; then
  echo "Custom install script is already running (lock file $LOCK_FILE exists)."
  echo "If this is unexpected, please remove $LOCK_FILE and try again."
  exit 0  # 内层脚本直接退出，表示任务已由外层脚本完成
fi

# 创建锁文件
touch "$LOCK_FILE"

# 清理函数，支持不同的退出状态
# 参数 $1：退出状态（0 表示正常退出，1 表示异常退出）
cleanup() {
  local exit_code=${1:-1}  # 默认退出码为 1（异常退出）

  # 显式清除 EXIT 信号的 trap，避免潜在的误解
  trap - EXIT

  if [ "$exit_code" -eq 0 ]; then
    echo "Cleaning up after successful execution..."
  else
    echo "Caught interrupt signal or error, cleaning up..."
  fi

  # 清理临时文件
  rm -f "$LOCK_FILE" 2>/dev/null
  # PORT_FILE端口临时文件是registry-proxy服务器管理的文件这里不负责清理，服务器退出时会自动清理
  #rm -f "$PORT_FILE" 2>/dev/null

  # 停止代理服务器
  if [ -n "${PROXY_PID:-}" ]; then
    echo "Stopping proxy server (PID: $PROXY_PID)..."
    kill -TERM "$PROXY_PID" 2>/dev/null
    wait "$PROXY_PID" 2>/dev/null || true
    echo "Proxy server stopped."
  fi

  # 切换到项目根目录
  # shellcheck disable=SC2164
  cd "$PROJECT_ROOT"

  # 清理 npmRegistryServer 配置
  yarn config unset npmRegistryServer 2>/dev/null || true
  echo "Cleared npmRegistryServer configuration"

  # 根据退出状态退出
  exit "$exit_code"
}

# 注册信号处理
trap 'cleanup 1' SIGINT SIGTERM EXIT  # 异常退出时调用 cleanup，退出码为 1

# 切换到项目根目录
# shellcheck disable=SC2164
cd "$PROJECT_ROOT"

# 使用 yarn dlx 直接运行 registry-proxy，可通过环境变量指定registry-proxy版本号，默认是latest，registry-proxy将会被放入后台运行，并在安装结束后自动退出。
REGISTRY_PROXY_VERSION="${REGISTRY_PROXY_VERSION:-latest}"
echo "Starting registry-proxy@$REGISTRY_PROXY_VERSION in the background (logs will be displayed below)..."
# 下载registry-proxy临时可执行程序并运行  因yarn可能会缓存tarball url的缘故（yarn.lock内<package>.resolution值），这里不得已只能写死本地代理端口地址，以便无论是从缓存获取tarball url还是从代理服务提供的元数据获取tarball url地址都能成功下载tarball文件
# 但是注意 这个端口不能暴露到外部使用，只允许本地使用，避免不必要的安全隐患 事实上registry-proxy server也是只监听着::1本机端口的。
yarn dlx -p com.jimuwd.xian.registry-proxy@"$REGISTRY_PROXY_VERSION" registry-proxy .registry-proxy.yml .yarnrc.yml ~/.yarnrc.yml 40061 &
PROXY_PID=$!

# 等待代理服务器启动并写入端口，最多 30 秒
echo "Waiting for proxy server to start (up to 30 seconds)..."
PORT_FILE="$PROJECT_ROOT/.registry-proxy-port"
# shellcheck disable=SC2034
for i in {1..300}; do  # 300 次循环，每次 0.1 秒，总共 30 秒
  if [ -f "$PORT_FILE" ]; then
    PROXY_PORT=$(cat "$PORT_FILE")
    if [ -z "$PROXY_PORT" ]; then
      echo "Error: Port file $PORT_FILE is empty"
      cleanup 1
    fi
    if nc -z localhost "$PROXY_PORT" 2>/dev/null; then
      echo "Proxy server is ready on port $PROXY_PORT!"
      break
    else
      # 检查端口是否被占用
      if netstat -tuln 2>/dev/null | grep -q ":$PROXY_PORT "; then
        echo "Error: Port $PROXY_PORT is already in use by another process"
        cleanup 1
      fi
    fi
  fi
  sleep 0.1
done

# 检查是否成功启动
if [ -z "${PROXY_PORT:-}" ] || ! nc -z localhost "$PROXY_PORT" 2>/dev/null; then
  echo "Error: Proxy server failed to start after 30 seconds"
  echo "Please check the registry-proxy logs above for more details."
  cleanup 1
fi

# 动态设置 npmRegistryServer 为代理地址 注意：yarn对“localhost”域名不友好，请直接使用 [::1]
yarn config set npmRegistryServer "http://[::1]:$PROXY_PORT"
echo "Set npmRegistryServer to http://[::1]:$PROXY_PORT"

# 使用动态代理端口运行 yarn install，并捕获错误
if ! yarn install; then
  echo "Error: yarn install failed"
  cleanup 1
fi

# 正常执行完成，调用 cleanup 并传入退出码 0
cleanup 0