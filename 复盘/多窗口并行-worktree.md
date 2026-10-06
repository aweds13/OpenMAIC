# 多窗口并行：worktree 怎么建、还差哪四步

> 用途：两个对话窗口要**同时**改这个仓库时，各开一棵 worktree，别共用一个工作区。
> 规矩在 `../AGENTS.md` §11；这里只写**怎么落地**（以及我踩过的坑）。

---

## 一、为什么必须分开

2026-10-06 实测到的一次：两个窗口共用主树，双方**都在改 `AGENTS.md`**。
一次 `git add AGENTS.md` 就把对方写的那一段一起提交了 —— 提交信息只讲一件事，
内容里却多了一整节。更麻烦的是 `AGENTS.md` 从此**描述了一个代码还没进 git 的功能**。

`git add <单个文件>` 也不安全：那个文件两边都在改时，一样会互相卷。
**根治靠隔离，不靠更小心的 add。**

---

## 二、建

```bash
cd D:/文档/jelly_ware/program/OpenMAIC
git worktree add ../OpenMAIC-<主题> -b <分支>
```

建完长这样（`git worktree list`）：

```
".../program/OpenMAIC"        5677a9f [my-extensions]
".../program/OpenMAIC-<主题>"  5677a9f [<分支>]
```

---

## 三、★ 还差四步（新建的 worktree 是**开不起来**的）

`git worktree` 只给一份干净的**源码检出**。`.gitignore` 里的东西一概没有。

### 1. `.env.local`（必需）

它是 gitignored 的，新 worktree 里**不存在** —— 没有 `DATABASE_URL`，
应用起来也是残的。

```bash
cp ../OpenMAIC/.env.local .
```

### 2. `node_modules`（必需）

```bash
corepack pnpm install --frozen-lockfile
```

两个注意：

- **`pnpm` 不在 PATH 上**，要用 `corepack pnpm`。
  `corepack enable pnpm` 会 **EPERM**（要写 `C:\Program Files\nodejs`，没权限）。
- **它的 `postinstall` 会失败。** `postinstall` 是 `pnpm run build:packages`，
  而那个脚本内部调的是**裸 `pnpm`** —— 不在 PATH 上就报
  `'pnpm' 不是内部或外部命令`。依赖其实已经装好了（pnpm 走全局 store 硬链接，
  很快也不占额外磁盘），**只是工作区包没构建**。

构建这一步两种绕法：

**(a) 同 commit 时直接从主树拷产物**（我就是这么做的；两边 commit 相同时
产物等价）：

```bash
for p in mathml2omml pptxgenjs @openmaic/dsl @openmaic/generation \
         @openmaic/storage @openmaic/importer @openmaic/renderer @openmaic/editor; do
  rm -rf "packages/$p/dist"
  cp -r "../OpenMAIC/packages/$p/dist" "packages/$p/dist"
done
node scripts/sync-maic-importer.mjs      # 把 importer 的 bundle 放进 public/vendor/
```

**(b) 自己造一个 `pnpm` shim 放进 PATH**（源头解决，但要自己维护）：

```cmd
@echo off
node "C:\Users\asus\AppData\Local\node\corepack\v1\pnpm\10.28.0\bin\pnpm.cjs" %*
```

### 3. 端口（必需）

两个 `next dev` 不能都用 3000。第二个要显式换端口。

### 4. `.next` —— 不用管

每个 worktree 各有一份，互不干扰。

---

## 四、验证它真能跑

别只看"装完了"。跑一条最快的用例：

```bash
./node_modules/.bin/vitest run tests/agent-runtime/browse-url-capability.test.ts
```

---

## 五、拆掉

```bash
git worktree remove ../OpenMAIC-<主题>
```

**先确认那棵树里没有未提交的东西**，否则会被拒（这是保护，不是报错）。

---

## 六、一条**没实测过**的注意

owner 是 **cookie** 派生的，而 cookie **不区分端口**（按 host 存）——
所以 `127.0.0.1:3001` 理论上应该看到和 `:3000` 同一批课程。
但 localStorage **区分端口**（按 origin 存），第一次打开有可能被当成新 owner。

**用的时候验一下**：开 `:3001`，看左边的课程数是不是和 `:3000` 一样。
不一样就是这条成立，那第二个窗口得手动带上 owner。
