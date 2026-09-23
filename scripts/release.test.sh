#!/usr/bin/env bash
# 发版脚本的本地回归。不访问网络，gh 用假命令。
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SCRIPT="$ROOT/scripts/release.sh"
PASS=0

fail() {
  echo "FAIL: $*" >&2
  exit 1
}

ok() {
  PASS=$((PASS + 1))
  echo "ok: $*"
}

assert_eq() {
  local got="$1" want="$2" label="$3"
  if [[ "$got" != "$want" ]]; then
    fail "${label}: 期望 [${want}] 实际 [${got}]"
  fi
}

val() {
  local key="$1" file="$2"
  grep "^${key}=" "$file" | tail -1 | cut -d= -f2-
}

TMP_ROOT="$(mktemp -d)"
trap 'rm -rf "$TMP_ROOT"' EXIT

FAKE_BIN="$TMP_ROOT/bin"
FAKE_GH_DIR="$TMP_ROOT/gh"
mkdir -p "$FAKE_BIN" "$FAKE_GH_DIR"
cat > "$FAKE_BIN/gh" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
if [[ "${1:-}" == "release" && "${2:-}" == "view" ]]; then
  tag="${3:-}"
  if [[ -f "${GH_FAKE_DIR}/${tag}.present" ]]; then
    exit 0
  fi
  if [[ -f "${GH_FAKE_DIR}/${tag}.error" ]]; then
    echo "authentication failed" >&2
    exit 1
  fi
  echo "release not found" >&2
  exit 1
fi
echo "unexpected gh args: $*" >&2
exit 1
EOF
chmod +x "$FAKE_BIN/gh"

bash -n "$SCRIPT"

new_repo() {
  local name="$1" origin work
  origin="$TMP_ROOT/${name}.git"
  work="$TMP_ROOT/${name}"
  git init --bare -b main "$origin" >/dev/null
  git init -b main "$work" >/dev/null
  git -C "$work" config user.email "test@example.com"
  git -C "$work" config user.name "test"
  echo '{"name":"deskpet","version":"1.0.0"}' > "$work/package.json"
  git -C "$work" add package.json
  git -C "$work" commit -m "init" >/dev/null
  git -C "$work" tag -a v1.0.0 -m "deskpet v1.0.0"
  git -C "$work" remote add origin "$origin"
  git -C "$work" push -u origin main >/dev/null
  git -C "$work" push origin v1.0.0 >/dev/null
  echo "$work"
}

OUT_N=0
run_prepare() {
  local work="$1" out event ref bump
  OUT_N=$((OUT_N + 1))
  out="$TMP_ROOT/out-$OUT_N"
  event="${2:-push}"
  ref="${3:-refs/heads/main}"
  bump="${4:-patch}"
  : > "$out"
  # 脚本日志走 stderr，stdout 只留结果文件路径，方便 $(run_prepare)。
  RELEASE_WORKDIR="$work" \
    RELEASE_EVENT="$event" \
    RELEASE_REF="$ref" \
    RELEASE_BUMP="$bump" \
    RELEASE_BASE_SHA="$(git -C "$work" rev-parse HEAD)" \
    GITHUB_OUTPUT="$out" \
    GH_FAKE_DIR="$FAKE_GH_DIR" \
    PATH="$FAKE_BIN:$PATH" \
    bash "$SCRIPT" prepare >&2
  echo "$out"
}

mark_release() {
  local tag="$1"
  : > "$FAKE_GH_DIR/${tag}.present"
}

clear_releases() {
  rm -f "$FAKE_GH_DIR"/*
}

# 文档与脚本使用同一条手动提交说明。
grep -F 'chore: release v%s [skip release]' "$SCRIPT" >/dev/null
grep -F 'npm version patch -m "chore: release v%s [skip release]"' "$ROOT/README.md" >/dev/null
ok "README 与脚本的手动发版命令一致"

clear_releases
mark_release v1.0.0
work="$(new_repo match-tag)"
git -C "$work" checkout -q v1.0.0
out="$(run_prepare "$work" push "refs/tags/v1.0.0")"
assert_eq "$(val skip "$out")" false "tag-skip"
assert_eq "$(val push "$out")" false "tag-push"
assert_eq "$(val version "$out")" "1.0.0" "tag-version"
ok "标签与 package.json 一致时不递增"

clear_releases
work="$(new_repo mismatch)"
set +e
RELEASE_WORKDIR="$work" RELEASE_EVENT=push RELEASE_REF=refs/tags/v9.9.9 RELEASE_BUMP=patch \
  RELEASE_BASE_SHA="$(git -C "$work" rev-parse HEAD)" GITHUB_OUTPUT="$TMP_ROOT/mismatch-out" \
  GH_FAKE_DIR="$FAKE_GH_DIR" PATH="$FAKE_BIN:$PATH" \
  bash "$SCRIPT" prepare >"$TMP_ROOT/mismatch.txt" 2>&1
rc=$?
set -e
[[ "$rc" -ne 0 ]] || fail "版本不一致时应失败"
grep -q "不一致" "$TMP_ROOT/mismatch.txt"
ok "标签与 package.json 不一致时失败"

clear_releases
mark_release v1.0.0
work="$(new_repo patch)"
echo note > "$work/note.txt"
git -C "$work" add note.txt
git -C "$work" commit -m "feat: 径向透视" >/dev/null
# 文件内容里的标记不能当成发版指令。
echo "[release major]" > "$work/note.txt"
git -C "$work" add note.txt
git -C "$work" commit -m "docs: 更新说明" >/dev/null
git -C "$work" push origin main >/dev/null
out="$(run_prepare "$work")"
assert_eq "$(val skip "$out")" false "patch-skip"
assert_eq "$(val push "$out")" true "patch-push"
assert_eq "$(val version "$out")" "1.0.1" "patch-version"
assert_eq "$(node -p "require('$work/package.json').version")" "1.0.1" "patch-file"
assert_eq "$(git -C "$work" show origin/main:package.json)" '{"name":"deskpet","version":"1.0.0"}' "prepare 不应已经推送"
ok "默认 patch，且不读取文件内容里的标记"

clear_releases
mark_release v1.0.0
work="$(new_repo minor)"
git -C "$work" commit --allow-empty -m "调整透视" -m "[release minor]" >/dev/null
git -C "$work" push origin main >/dev/null
out="$(run_prepare "$work")"
assert_eq "$(val version "$out")" "1.1.0" "minor-version"
ok "提交正文中的 minor 标记"

clear_releases
mark_release v1.0.0
work="$(new_repo major)"
git -C "$work" commit --allow-empty -m "小改" -m "[release minor]" >/dev/null
git -C "$work" commit --allow-empty -m "不兼容" -m "[release major]" >/dev/null
git -C "$work" push origin main >/dev/null
out="$(run_prepare "$work")"
assert_eq "$(val version "$out")" "2.0.0" "major-version"
ok "major 优先于 minor"

clear_releases
mark_release v1.0.0
work="$(new_repo untagged)"
echo '{"name":"deskpet","version":"1.2.0"}' > "$work/package.json"
git -C "$work" add package.json
git -C "$work" commit -m "chore: 预先写成 1.2.0" -m "[release minor]" >/dev/null
git -C "$work" push origin main >/dev/null
out="$(run_prepare "$work")"
assert_eq "$(val version "$out")" "1.2.0" "untagged-version"
assert_eq "$(val push "$out")" true "untagged-push"
ok "尚未打标签的 package.json 版本直接发布，不再递增"

clear_releases
mark_release v1.0.0
work="$(new_repo supersede)"
git -C "$work" commit --allow-empty -m "feat: A" >/dev/null
git -C "$work" push origin main >/dev/null
base="$(git -C "$work" rev-parse HEAD)"
other="$TMP_ROOT/supersede-other"
git clone "$TMP_ROOT/supersede.git" "$other" >/dev/null
git -C "$other" config user.email "test@example.com"
git -C "$other" config user.name "test"
git -C "$other" commit --allow-empty -m "feat: B" >/dev/null
git -C "$other" push origin main >/dev/null
out="$(run_prepare "$work")"
assert_eq "$(val skip "$out")" true "supersede-skip"
assert_eq "$(node -p "require('$work/package.json').version")" "1.0.0" "supersede-version"
ok "落后于更新的功能提交时跳过（基准 ${base:0:7}）"

clear_releases
mark_release v1.0.0
work="$(new_repo republish)"
git -C "$work" commit --allow-empty -m "feat: 待补发" >/dev/null
parent="$(git -C "$work" rev-parse HEAD)"
echo '{"name":"deskpet","version":"1.0.1"}' > "$work/package.json"
git -C "$work" add package.json
git -C "$work" commit -m "chore: release v1.0.1 [skip release]" >/dev/null
git -C "$work" tag -a v1.0.1 -m "deskpet v1.0.1"
git -C "$work" push origin HEAD:main >/dev/null
git -C "$work" push origin v1.0.1 >/dev/null
git -C "$work" checkout --detach "$parent" >/dev/null
out="$(run_prepare "$work")"
assert_eq "$(val skip "$out")" false "republish-skip"
assert_eq "$(val push "$out")" false "republish-push"
assert_eq "$(val version "$out")" "1.0.1" "republish-version"
assert_eq "$(val commit "$out")" "$(git -C "$work" rev-parse v1.0.1^{})" "republish-commit"
ok "仅有发版提交且 Release 缺失时补发，不再递增"

clear_releases
mark_release v1.0.0
mark_release v1.0.1
work="$(new_repo already)"
git -C "$work" commit --allow-empty -m "feat: 已发布过" >/dev/null
parent="$(git -C "$work" rev-parse HEAD)"
echo '{"name":"deskpet","version":"1.0.1"}' > "$work/package.json"
git -C "$work" add package.json
git -C "$work" commit -m "chore: release v1.0.1 [skip release]" >/dev/null
git -C "$work" tag -a v1.0.1 -m "deskpet v1.0.1"
git -C "$work" push origin HEAD:main >/dev/null
git -C "$work" push origin v1.0.1 >/dev/null
git -C "$work" checkout --detach "$parent" >/dev/null
out="$(run_prepare "$work")"
assert_eq "$(val skip "$out")" true "already-skip"
ok "发版提交已经发布时，旧的运行跳过"

clear_releases
mark_release v1.0.0
work="$(new_repo gh-error)"
git -C "$work" commit --allow-empty -m "feat: 查询失败" >/dev/null
git -C "$work" push origin main >/dev/null
: > "$FAKE_GH_DIR/v1.0.0.error"
rm -f "$FAKE_GH_DIR/v1.0.0.present"
set +e
RELEASE_WORKDIR="$work" RELEASE_EVENT=push RELEASE_REF=refs/heads/main RELEASE_BUMP=patch \
  RELEASE_BASE_SHA="$(git -C "$work" rev-parse HEAD)" GITHUB_OUTPUT="$TMP_ROOT/gh-error-out" \
  GH_FAKE_DIR="$FAKE_GH_DIR" PATH="$FAKE_BIN:$PATH" \
  bash "$SCRIPT" prepare >"$TMP_ROOT/gh-error.txt" 2>&1
rc=$?
set -e
[[ "$rc" -ne 0 ]] || fail "gh 查询失败时应中止"
grep -q "查询 GitHub Release" "$TMP_ROOT/gh-error.txt"
assert_eq "$(node -p "require('$work/package.json').version")" "1.0.0" "gh-error-version"
ok "查询 Release 失败时不改版本"

clear_releases
mark_release v1.0.0
work="$(new_repo dispatch)"
git -C "$work" commit --allow-empty -m "feat: 手动" >/dev/null
git -C "$work" push origin main >/dev/null
# 故意让本地落后，dispatch 应切到 origin/main 再按输入递增。
git -C "$work" reset --hard HEAD~1 >/dev/null
out="$(run_prepare "$work" workflow_dispatch refs/heads/main minor)"
assert_eq "$(val version "$out")" "1.1.0" "dispatch-version"
assert_eq "$(val push "$out")" true "dispatch-push"
RELEASE_WORKDIR="$work" GITHUB_OUTPUT="$TMP_ROOT/dispatch-seal" PATH="$FAKE_BIN:$PATH" \
  bash "$SCRIPT" seal
assert_eq "$(git -C "$work" rev-parse --abbrev-ref HEAD)" "HEAD" "dispatch-seal-detached"
assert_eq "$(git -C "$work" cat-file -t v1.1.0)" "tag" "dispatch-seal-tag"
ok "手动触发按输入的级别递增，并使用 origin/main"

clear_releases
mark_release v1.0.0
work="$(new_repo seal-push)"
git -C "$work" commit --allow-empty -m "feat: 需要打包" >/dev/null
git -C "$work" push origin main >/dev/null
base="$(git -C "$work" rev-parse HEAD)"
out="$(run_prepare "$work")"
assert_eq "$(val version "$out")" "1.0.1" "seal-version"
RELEASE_WORKDIR="$work" GITHUB_OUTPUT="$TMP_ROOT/seal-out" PATH="$FAKE_BIN:$PATH" \
  bash "$SCRIPT" seal
assert_eq "$(git -C "$work" rev-parse --abbrev-ref HEAD)" "main" "seal-stays-on-main"
assert_eq "$(git -C "$work" cat-file -t v1.0.1)" "tag" "annotated-tag"
assert_eq "$(git -C "$work" log -1 --format=%s)" "chore: release v1.0.1 [skip release]" "seal-subject"
[[ -z "$(git -C "$work" status --porcelain)" ]] || fail "seal 后工作区应干净"
RELEASE_WORKDIR="$work" RELEASE_BASE_SHA="$base" GITHUB_OUTPUT="$TMP_ROOT/push-out" \
  PATH="$FAKE_BIN:$PATH" bash "$SCRIPT" push
remote="$TMP_ROOT/seal-push-check"
git clone "$TMP_ROOT/seal-push.git" "$remote" >/dev/null
assert_eq "$(node -p "require('$remote/package.json').version")" "1.0.1" "pushed-version"
assert_eq "$(git -C "$remote" cat-file -t v1.0.1)" "tag" "pushed-tag"
assert_eq "$(git -C "$remote" rev-parse v1.0.1^{})" "$(git -C "$remote" rev-parse HEAD)" "tag-at-head"
ok "seal 打附注标签，push 把提交和标签送到 origin"

clear_releases
mark_release v1.0.0
work="$(new_repo push-race)"
git -C "$work" commit --allow-empty -m "feat: A" >/dev/null
git -C "$work" push origin main >/dev/null
base="$(git -C "$work" rev-parse HEAD)"
out="$(run_prepare "$work")"
assert_eq "$(val version "$out")" "1.0.1" "race-version"
RELEASE_WORKDIR="$work" GITHUB_OUTPUT="$TMP_ROOT/race-seal" PATH="$FAKE_BIN:$PATH" bash "$SCRIPT" seal
other="$TMP_ROOT/push-race-other"
git clone "$TMP_ROOT/push-race.git" "$other" >/dev/null
git -C "$other" config user.email "test@example.com"
git -C "$other" config user.name "test"
git -C "$other" commit --allow-empty -m "feat: B" >/dev/null
git -C "$other" push origin main >/dev/null
RELEASE_WORKDIR="$work" RELEASE_BASE_SHA="$base" GITHUB_OUTPUT="$TMP_ROOT/race-push" \
  PATH="$FAKE_BIN:$PATH" bash "$SCRIPT" push
assert_eq "$(val skip "$TMP_ROOT/race-push")" true "race-skip"
git -C "$other" fetch origin --tags >/dev/null
if git -C "$other" rev-parse -q --verify refs/tags/v1.0.1 >/dev/null; then
  fail "被更新的 main 拒绝后不应留下 v1.0.1"
fi
ok "推送时 main 已前进则放弃，不推标签"

clear_releases
mark_release v1.0.0
work="$(new_repo cut)"
git -C "$work" commit --allow-empty -m "feat: 手动切版" >/dev/null
git -C "$work" push origin main >/dev/null
RELEASE_WORKDIR="$work" PATH="$FAKE_BIN:$PATH" bash "$SCRIPT" cut minor
remote="$TMP_ROOT/cut-check"
git clone "$TMP_ROOT/cut.git" "$remote" >/dev/null
assert_eq "$(node -p "require('$remote/package.json').version")" "1.1.0" "cut-version"
assert_eq "$(git -C "$remote" log -1 --format=%s)" "chore: release v1.1.0 [skip release]" "cut-subject"
assert_eq "$(git -C "$remote" cat-file -t v1.1.0)" "tag" "cut-annotated"
ok "cut 推送附注标签和跳过自动发版的提交"

work="$(new_repo cut-dirty)"
echo x >> "$work/package.json"
set +e
RELEASE_WORKDIR="$work" bash "$SCRIPT" cut patch >"$TMP_ROOT/cut-dirty.txt" 2>&1
rc=$?
set -e
[[ "$rc" -ne 0 ]] || fail "脏工作区应拒绝 cut"
grep -q "不干净" "$TMP_ROOT/cut-dirty.txt"
ok "cut 拒绝脏工作区"

work="$(new_repo cut-branch)"
git -C "$work" checkout -q -b feature
set +e
RELEASE_WORKDIR="$work" bash "$SCRIPT" cut patch >"$TMP_ROOT/cut-branch.txt" 2>&1
rc=$?
set -e
[[ "$rc" -ne 0 ]] || fail "非 main 应拒绝 cut"
grep -q "请在 main" "$TMP_ROOT/cut-branch.txt"
ok "cut 拒绝非 main"

# 脚本位于仓库内部时会先拷贝再执行，避免 checkout 改掉正在跑的文件。
clear_releases
mark_release v1.0.0
work="$(new_repo reexec)"
git -C "$work" commit --allow-empty -m "feat: 从仓库内执行" >/dev/null
git -C "$work" push origin main >/dev/null
mkdir -p "$work/scripts"
cp "$SCRIPT" "$work/scripts/release.sh"
reexec_out="$TMP_ROOT/reexec-out"
: > "$reexec_out"
(
  cd "$work"
  RELEASE_EVENT=push \
    RELEASE_REF=refs/heads/main \
    RELEASE_BUMP=patch \
    RELEASE_BASE_SHA="$(git rev-parse HEAD)" \
    GITHUB_OUTPUT="$reexec_out" \
    GH_FAKE_DIR="$FAKE_GH_DIR" \
    PATH="$FAKE_BIN:$PATH" \
    bash scripts/release.sh prepare
)
assert_eq "$(val version "$reexec_out")" "1.0.1" "reexec-version"
assert_eq "$(node -p "require('$work/package.json').version")" "1.0.1" "reexec-file"
ok "从仓库内部执行时版本决定仍然正确"

echo
echo "全部通过：${PASS}"
