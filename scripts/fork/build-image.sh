#!/bin/bash
# fork 专用构建脚本：只产出 Docker 镜像所需的 Linux 二进制与第三方许可证清单，
# 不做上游 scripts/build.sh 的全平台归档和 Android 交叉编译。
# 加 --print-version 时只打印版本号后退出，供 CI 复用同一套版本推导规则。
set -euo pipefail

readonly APP_NAME="octopus" # 容器内可执行文件名。
readonly OUTPUT_DIR="build" # Docker 构建上下文中的产物根目录。
readonly MODULE="github.com/bestruirui/octopus" # 沿用上游模块路径，避免同步上游时产生大规模冲突。
readonly COMMIT="$(git rev-parse --short HEAD 2>/dev/null || echo unknown)" # 当前提交短哈希。
readonly UPSTREAM_VERSION="$(sed -n 's|^// Version ||p' main.go | tr -d '[:space:]')" # main.go 中声明的上游版本号。
# 版本号只在本文件推导：CI 通过 --print-version 取用，避免镜像标签、前端与二进制内版本不一致。
if [ -z "${UPSTREAM_VERSION}" ]; then
    echo "无法从 main.go 解析版本号：// Version 注释格式可能已变，请同步调整本脚本" >&2
    exit 1
fi
readonly VERSION="${APP_VERSION:-${UPSTREAM_VERSION}-hz.${COMMIT}}"
readonly AUTHOR="${APP_AUTHOR:-hertz9409}" # `octopus version` 中显示的署名，可用 APP_AUTHOR 覆盖。
readonly REPO_URL="${APP_REPO_URL:-https://github.com/Hertz9409/octopus}" # banner 与界面展示的源码仓库，可用 APP_REPO_URL 覆盖。
# 自更新地址留空表示关闭自更新：fork 不发布 GitHub Release，重定向过去只会 404，
# 且会把增强版覆盖回上游版本；将来若发布自己的 Release，注入自己的地址即可启用。
readonly LDFLAGS="-X '${MODULE}/internal/conf.Version=${VERSION}' \
                  -X '${MODULE}/internal/conf.BuildTime=$(TZ='Asia/Shanghai' date +'%F %T %z')' \
                  -X '${MODULE}/internal/conf.Author=${AUTHOR}' \
                  -X '${MODULE}/internal/conf.Repo=${REPO_URL}' \
                  -X '${MODULE}/internal/conf.Commit=${COMMIT}' \
                  -X '${MODULE}/internal/update.updateUrl=' \
                  -X '${MODULE}/internal/update.updateApiUrl=' \
                  -s -w" # 注入版本信息、关闭自更新并缩小发布二进制。

if [ "${1:-}" = "--print-version" ]; then
    echo "${VERSION}"
    exit 0
fi

# Dockerfile 按 TARGETPLATFORM 读取 build/docker/${TARGETPLATFORM}/${APP_NAME}。
# 格式：TARGETPLATFORM:GOARCH:GOARM
readonly -a TARGETS=(
    "linux/amd64:amd64:"
    "linux/386:386:"
    "linux/arm64:arm64:"
    "linux/arm/v7:arm:7"
)

# static/out 由前端构建产物填充，缺失时 Go 会嵌入空目录并产出没有界面的镜像。
# 前端构建会删除原始资源，首页只会存在压缩后的 index.html.gz。
if [ ! -f "static/out/index.html" ] && [ ! -f "static/out/index.html.gz" ]; then
    echo "缺少 static/out/index.html(.gz)，请先在 web 目录执行 pnpm install && pnpm run build" >&2
    exit 1
fi

echo "Building ${APP_NAME} ${VERSION} (${COMMIT})"
for target in "${TARGETS[@]}"; do
    IFS=: read -r platform go_arch go_arm <<<"${target}"
    target_dir="${OUTPUT_DIR}/docker/${platform}"
    mkdir -p "${target_dir}"
    build_env=(GOOS=linux GOARCH="${go_arch}" CGO_ENABLED=0)
    if [ -n "${go_arm}" ]; then
        build_env+=(GOARM="${go_arm}")
    fi
    echo "Building ${platform}"
    env "${build_env[@]}" go build -trimpath -o "${target_dir}/${APP_NAME}" \
        -ldflags="${LDFLAGS}" -tags=jsoniter .
done

# Dockerfile 依赖镜像上下文中存在第三方许可证清单。
GOFLAGS="-tags=jsoniter" go run github.com/google/go-licenses/v2@v2.0.1 report . \
    --ignore "${MODULE}" >"${OUTPUT_DIR}/THIRD_PARTY_LICENSES.csv"

echo "Docker context ready: ${OUTPUT_DIR}"
