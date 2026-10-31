# Cleanly 中文版

基于 [0xCodez/cleanly](https://github.com/0xCodez/cleanly) v0.1.1 源码重新编译的简体中文版本。

## 改动

- 全部界面文案译为简体中文：智能扫描、清理、安全防护、启动加速、应用程序、空间地图、大文件、重复文件、AI 助手、设置、反馈、支持作者等页面
- 后端服务返回给界面的文案同步中文化：清理分类（临时文件、浏览器缓存、崩溃报告、开发者缓存、旧下载文件等）、安全检查说明、扫描进度、移入回收站提示、AI 助手的系统提示词
- 演示模式（demo）数据同步中文化
- `index.html` 改为 `lang="zh-CN"`，日期/时间/数字格式改用 `zh-CN`
- CSS 字体栈加入苹方 / 微软雅黑 / Noto Sans CJK 回退，保证中文显示
- macOS 隐私用途说明（桌面/文稿/下载）改为中文

保留不译：品牌名 Cleanly、Claude / ChatGPT / OpenAI / Stripe 等产品名、真实文件名与路径示例、内部枚举与键名。

## 构建

需要 Node.js 22+。

```bash
npm install
npm run build      # 类型检查 + 前端 + Electron 主进程
npm run dist:win   # Windows 安装版 + 便携版（在 Windows 上执行）
npm run dist:mac   # macOS dmg + zip（在 Mac 上执行）
```

产物在 `release/`。构建未签名，首次运行：Windows 出现 SmartScreen 时点“更多信息 → 仍要运行”；macOS 需执行 `xattr -cr /Applications/Cleanly.app`。
