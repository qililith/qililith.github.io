# Do less

个人效率工具（目标管理）。本仓库是其 GitHub Pages 部署仓库。

## 仓库结构

- **`src` 分支：应用源码（你工作的地方）**
- `main` 分支：构建产物，由 GitHub Actions 自动维护，**请勿手动修改**

## 本地开发

要求 Node.js 20.19+（推荐 22 LTS）。

```bash
git clone https://github.com/qililith/qililith.github.io.git do-less
cd do-less
git checkout src
npm ci        # 有锁文件，用 npm ci 更快更稳
npm run dev   # 开发预览
npm run build # 产物在 dist/
```

## 部署

把改动推到 `src` 分支即可，Actions 会自动构建并把产物发布到 `main`（约 1 分钟）：

```bash
git add -A && git commit -m "改动说明"
git push origin src
```

## 数据同步

App 运行数据不在这个仓库里——它存在浏览器 localStorage，并通过 App 内「同步」面板加密同步到私有仓库 `qililith/do-less-data`（AES-GCM 客户端加密，GitHub 上只有密文）。

## 项目背景（协作者须知）

- 产品：个人效率工具 Do less（中文界面），用户用自己的真实目标做 dogfood 验收，改动先试用再定去留
- 设计约束：**界面不出现任何教学性文案**（功能元素自带含义）；「AI 给一版参考」与对话是规则模拟的交互演示，界面须有「AI 功能为交互演示」标注；整体追求"通过即可、不留痕迹"的轻量感
- 数据模型：localStorage（key 前缀 `xu-flow-`），meta 带 rev/updatedAt/deviceId；改动数据结构必须兼容迁移旧数据（参考 model.ts 既有迁移写法）
- 同步：src/sync.ts + src/crypto.ts 实现（AES-GCM + PBKDF2），快照密文存 qililith/do-less-data；**勿在日志/报错/提交信息中打印同步密码或 token**
- 依赖纪律：运行时仅 react/react-dom/react-router/lucide-react，勿引入组件库或模板残留
