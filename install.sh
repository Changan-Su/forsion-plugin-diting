#!/usr/bin/env bash
# 把谛听装进本机的 Forsion 家目录。
#   用法:sh install.sh [dev|prod]     缺省 dev(~/.forsion-dev);prod = ~/.forsion
# 只拷发布时会带的那几样(manifest、main.js、图标、Space、随包 Agent)。改了 src 先跑 node build.mjs。
# 随包的「谛听」Agent 由引擎启动时装到 <家目录>/tangu/agents/diting-companion/(已经有就保留原样)。
set -euo pipefail
MODE="${1:-dev}"
case "$MODE" in
  dev)  HOME_DIR="$HOME/.forsion-dev" ;;
  prod) HOME_DIR="$HOME/.forsion" ;;
  *) echo "用法:sh install.sh [dev|prod]" >&2; exit 2 ;;
esac
HERE="$(cd "$(dirname "$0")" && pwd)"
DEST="$HOME_DIR/plugins/diting"

# 不许从已经装好的目录里跑:下面会先删目标,等于把自己删了。
if [ "$HERE" = "$(cd "$DEST" 2>/dev/null && pwd || true)" ]; then
  echo "请从源码仓的 forsion-plugin-diting/ 目录运行 install.sh" >&2
  exit 2
fi
[ -f "$HERE/main.js" ] || { echo "没有 main.js:先跑 node build.mjs" >&2; exit 2; }

mkdir -p "$HOME_DIR/plugins"
rm -rf "$DEST"
mkdir -p "$DEST"
cp -R "$HERE/manifest.json" "$HERE/main.js" "$HERE/icon.svg" "$HERE/icon.png" "$HERE/spaces" "$HERE/agents" "$HERE/LICENSE" "$DEST/"

echo "已安装 → $DEST"
echo "重开 Forsion 后,在功能条的「…」里找「谛听」,或者命令面板里搜「谛听：打开」。"
