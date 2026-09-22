#!/usr/bin/env bash
# 桌宠发版。
#
#   prepare  决定版本。需要时只改 package.json / package-lock.json，不提交。
#   seal     把版本号提交到本地并打附注标签，不推送。
#   push     把 seal 的提交和标签推到 origin/main。
#   cut      手动发版：npm version + git push --follow-tags。
#
# 手动两条命令须与 cut 里的 npm version 参数保持一致（见 README）：
#   npm version <patch|minor|major> -m "chore: release v%s [skip release]"
#   git push origin HEAD --follow-tags
#
# 自动路径在同一次 GitHub Actions 里构建并创建 Release。
# 不能只推标签就指望 tag 路径再跑一遍：GITHUB_TOKEN 推送不会触发新的 workflow。
set -euo pipefail

# git checkout 会改掉仓库里的脚本文件。先拷到临时文件再执行，并把仓库根记在环境变量里。
if [[ "${RELEASE_SCRIPT_COPIED:-}" != 1 ]]; then
  _src="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/$(basename "${BASH_SOURCE[0]}")"
  _repo="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
  _work="${RELEASE_WORKDIR:-$_repo}"
  _work="$(cd "$_work" && pwd)"
  case "$_src" in
    "$_work"/*)
      _copy="$(mktemp)"
      cp "$_src" "$_copy"
      export RELEASE_SCRIPT_COPIED=1
      export RELEASE_REPO_ROOT="$_repo"
      exec bash "$_copy" "$@"
      ;;
  esac
  unset _src _repo _work _copy
fi

export GIT_TERMINAL_PROMPT=0
REPO_ROOT="${RELEASE_REPO_ROOT:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
cd "${RELEASE_WORKDIR:-$REPO_ROOT}"

die() {
  echo "$*" >&2
  exit 1
}

emit() {
  if [[ -z "${GITHUB_OUTPUT:-}" ]]; then
    echo "$1=$2"
    return
  fi
  echo "$1=$2" >> "$GITHUB_OUTPUT"
}

current_version() {
  node -p "require('./package.json').version"
}

have_tag() {
  git rev-parse -q --verify "refs/tags/$1" >/dev/null 2>&1
}

# present / missing；其它错误直接失败，避免把网络故障当成「还没发布」而盖掉旧 Release。
release_state() {
  local tag="$1" err rc
  command -v gh >/dev/null 2>&1 || die "找不到 gh，无法确认 Release 是否已存在。"
  set +e
  err="$(gh release view "$tag" 2>&1)"
  rc=$?
  set -e
  if [[ "$rc" -eq 0 ]]; then
    echo present
    return 0
  fi
  if grep -qi 'not found' <<<"$err"; then
    echo missing
    return 0
  fi
  die "查询 GitHub Release（$tag）失败：$err"
}

# 范围内是否全部是自动/手动发版提交（至少一条）。
only_release_ahead() {
  local range="$1" subject any=false
  while IFS= read -r subject; do
    [[ -z "$subject" ]] && continue
    any=true
    # 右侧不引用，按通配比较主题行。
    if [[ "$subject" != chore:\ release\ v* ]]; then
      return 1
    fi
  done < <(git log --format=%s "$range")
  [[ "$any" == true ]]
}

decide_bump_from_history() {
  local last log
  last="$(git describe --tags --match 'v[0-9]*' --abbrev=0 2>/dev/null || true)"
  if [[ -n "$last" ]]; then
    log="$(git log "${last}..HEAD" --format=%B)"
  else
    log="$(git log --format=%B)"
  fi
  if grep -q '\[release major\]' <<<"$log"; then
    echo major
  elif grep -q '\[release minor\]' <<<"$log"; then
    echo minor
  else
    echo patch
  fi
}

cmd_prepare() {
  local event="${RELEASE_EVENT:?}"
  local ref="${RELEASE_REF:?}"
  local bump="${RELEASE_BUMP:-patch}"
  local original_head head main pkg state switched=false

  if [[ "$ref" == refs/tags/v* ]]; then
    local tag="${ref#refs/tags/}"
    local ver="${tag#v}"
    pkg="$(current_version)"
    if [[ "$ver" != "$pkg" ]]; then
      die "标签 ${tag} 与 package.json 版本 ${pkg} 不一致。先改版本再打标签。"
    fi
    echo "标签 ${tag} 与 package.json 一致，不递增版本。"
    emit skip false
    emit version "$pkg"
    emit push false
    emit commit "$(git rev-parse HEAD)"
    return 0
  fi

  git fetch origin main --tags --force
  original_head="$(git rev-parse HEAD)"

  if [[ "$event" == "push" ]]; then
    head="$original_head"
    main="$(git rev-parse origin/main)"
    if [[ "$head" != "$main" ]]; then
      if ! git merge-base --is-ancestor "$head" "$main"; then
        die "HEAD（$head）不在 origin/main 的历史上，拒绝发版。"
      fi
      if ! only_release_ahead "${head}..${main}"; then
        echo "跳过：origin/main 已有更新的提交，由那次推送发版。"
        emit skip true
        emit version ""
        emit push false
        emit commit ""
        return 0
      fi
      echo "origin/main 只多出发版提交，改到该提交上检查是否要补发。"
      git checkout --detach "$main"
      switched=true
    fi
    bump="$(decide_bump_from_history)"
  elif [[ "$event" == "workflow_dispatch" ]]; then
    git checkout --detach origin/main
    case "$bump" in
      patch|minor|major) ;;
      *) die "不支持的版本级别：${bump}（需要 patch、minor 或 major）" ;;
    esac
  else
    die "不支持的事件：${event}"
  fi

  echo "版本级别：${bump}"
  pkg="$(current_version)"

  if [[ "$switched" == true ]] && have_tag "v$pkg"; then
    state="$(release_state "v$pkg")"
    if [[ "$state" == present ]]; then
      echo "跳过：v${pkg} 已经发布。"
      emit skip true
      emit version ""
      emit push false
      emit commit ""
      return 0
    fi
  fi

  if have_tag "v$pkg"; then
    state="$(release_state "v$pkg")"
    if [[ "$state" == present ]]; then
      case "$bump" in
        patch|minor|major) ;;
        *) die "不支持的版本级别：${bump}（需要 patch、minor 或 major）" ;;
      esac
      npm version "$bump" --no-git-tag-version
      pkg="$(current_version)"
      if have_tag "v$pkg"; then
        die "递增后的标签 v${pkg} 已经存在，停止以免覆盖。"
      fi
      echo "下一版本：${pkg}（将推送提交和标签）"
      emit push true
      emit commit ""
    else
      echo "标签 v${pkg} 已在，但还没有 GitHub Release，本次只补发。"
      emit push false
      emit commit "$(git rev-parse "v${pkg}^{}")"
    fi
  else
    echo "v${pkg} 还没有标签，按 package.json 发布这一版，不再递增。"
    emit push true
    emit commit ""
  fi

  emit skip false
  emit version "$pkg"
}

cmd_seal() {
  local version
  version="$(current_version)"
  git config user.name "github-actions[bot]"
  git config user.email "41898282+github-actions[bot]@users.noreply.github.com"

  if [[ -n "$(git status --porcelain -- package.json package-lock.json)" ]]; then
    git add -- package.json
    if [[ -f package-lock.json ]]; then
      git add -- package-lock.json
    fi
    git commit \
      -m "chore: release v${version} [skip release]" \
      -m "自动发版：只更新版本号。提交说明含跳过标记，避免这次推送再次发版。"
  fi

  if ! have_tag "v${version}"; then
    git tag -a "v${version}" -m "deskpet v${version}"
  fi

  if ! have_tag "v${version}"; then
    die "未能创建标签 v${version}"
  fi
  echo "本地标签 v${version} -> $(git rev-parse --short "v${version}^{}")"
  emit skip false
  emit commit "$(git rev-parse HEAD)"
}

cmd_push() {
  local base="${RELEASE_BASE_SHA:?}"
  local version
  version="$(current_version)"

  if ! git push origin "HEAD:main"; then
    git fetch origin main
    if git merge-base --is-ancestor "$base" origin/main; then
      echo "推送被拒绝：main 已包含本次功能提交，交给更新的运行发版。"
      emit skip true
      emit commit ""
      return 0
    fi
    die "推送 main 失败，且本次提交不在 origin/main 的历史上。"
  fi

  git push origin "refs/tags/v${version}:refs/tags/v${version}"
  echo "已推送 main 与标签 v${version}"
  emit skip false
  emit commit "$(git rev-parse HEAD)"
}

cmd_cut() {
  local level="${1:-patch}"
  local branch
  case "$level" in
    patch|minor|major) ;;
    *) die "用法: scripts/release.sh cut patch|minor|major" ;;
  esac
  if [[ -n "$(git status --porcelain)" ]]; then
    die "工作区不干净，先提交或还原后再发版。"
  fi
  branch="$(git rev-parse --abbrev-ref HEAD)"
  if [[ "$branch" != "main" ]]; then
    die "请在 main 上发版（当前是 ${branch}）。"
  fi
  git fetch origin main --tags
  if [[ "$(git rev-parse HEAD)" != "$(git rev-parse origin/main)" ]]; then
    die "本地 main 与 origin/main 不一致，请先 git pull 再发版。"
  fi
  # 与 README 手动步骤使用同一提交说明。方括号标记让 main 上的自动任务跳过，只走标签构建。
  npm version "$level" -m "chore: release v%s [skip release]"
  git push origin HEAD --follow-tags
  echo "已推送 v$(current_version)。标签会触发 Release workflow 构建并发布。安装包未签名。"
}

usage() {
  die "用法: scripts/release.sh prepare|seal|push|cut [patch|minor|major]"
}

case "${1:-}" in
  prepare) cmd_prepare ;;
  seal) cmd_seal ;;
  push) cmd_push ;;
  cut) shift; cmd_cut "$@" ;;
  *) usage ;;
esac
