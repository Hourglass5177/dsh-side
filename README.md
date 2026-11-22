<h1 align="center">dsh-side：临时侧边会话</h1>

<p align="center">
  中文 | <a href="README.en.md">English</a>
</p>

<p align="center">
  <a href="https://github.com/Hourglass5177/dsh-side/stargazers"><img src="https://img.shields.io/github/stars/Hourglass5177/dsh-side?style=flat-square" alt="stars"></a>
  <a href="LICENSE"><img src="https://img.shields.io/github/license/Hourglass5177/dsh-side?style=flat-square" alt="license"></a>
  <img src="https://img.shields.io/badge/DeepSeek_Harness-0.2.2%2B-4b6fff?style=flat-square" alt="DeepSeek Harness 0.2.2+">
</p>

---

## 简介

dsh-side 为 DeepSeek Harness 提供轻量、原生的临时侧边对话体验。它继承当前对话的内容，面板从空白开始；关闭标签页后会话停止运行，并删除该临时会话记录。

会话界面复用 DSH 原生组件：消息行、输入框、`+` 菜单、权限、模型选择、斜杠命令、`@` 引用与快捷键等，轻量、易用。

## 界面

<p align="center">
  <img src="docs/start-page.png" alt="右侧边栏开始页中的「侧边会话」卡片" height="530">
  &nbsp;&nbsp;
  <img src="docs/panel.png" alt="侧边会话面板：上方空白，底部为 DSH 原生输入框" height="530">
</p>

<p align="center">
  <img src="docs/command.png" alt="斜杠命令列表中的「侧边会话 side」">
</p>

## 上下文继承

dsh-side 将当前对话 fork 到第 0 个事件：子会话继承工作区、目录与代理预设，但不复制任何消息，因此面板从空白开始。会话日志的第 0 个事件是配置事件（权限预设或子代理描述），不会渲染为聊天行。

上下文由宿主注入：读取父会话的模型可见消息，作为一条上下文记录写入子会话。面板保持空白，模型仍可读取完整上下文。

该记录以折叠条目显示在面板顶部，展开可查看继承的具体内容。

权限沿用主对话当前的预设，侧边会话不会重复询问已经授权的操作。

## 安装

需要 DeepSeek Harness **0.2.2 及以上**（Desktop 或 Web 版）。

```bash
git clone https://github.com/Hourglass5177/dsh-side.git
```

在应用中安装本地目录：

1. 打开 **Plugins** 页面；
2. 点 **Add plugin**，选择克隆得到的 `dsh-side` 目录；
3. 列表中显示 `dsh-side` 即安装完成；
4. 重启一次应用（宿主半边需要重新加载），之后刷新页面即可使用。

输入框同样接受 Git 地址（`https://github.com/Hourglass5177/dsh-side`）；插件发布到 npm 后可直接输入 `dsh-side`。

Web / CLI 版可通过命令行安装：

```bash
dsh plugin --profile <profile> add <dsh-side 的绝对路径>
```

Desktop 的 `desktop` profile 由应用独占管理，请在插件页面中安装。

卸载：在 Plugins 中停用 `dsh-side` 一行。

## 使用

两个入口，效果一致：

- 在输入框执行 **`/side`**；
- 在右侧边栏开始页（含「工作区文件 / 新建终端 / 浏览器」的页面）点击 **侧边会话** 卡片。

面板打开后即可在底部输入框提问，回答按常规方式流式输出。继续在同一面板提问即可延续该会话。

侧边会话不会出现在会话列表里：创建后即从工作区摘除，会话本身照常运行（归档会禁止会话运行，所以这里用的是摘除）。

**关闭标签页即结束**：侧边会话停止运行并删除其磁盘记录（对应会话目录整体删除）。

## 实现要点

|              |                                                                |
| ------------ | -------------------------------------------------------------- |
| **零依赖、零构建**  | 不引入 npm 依赖，无打包与编译步骤；DSH 直接加载 `client.js` 与 `index.js`。         |
| **界面复用官方组件** | 面板使用 `conversation.content`，输入区使用 `conversation.composer.bar`。 |
| **不修改会话模型**  | 未新增事件类型，未改动主对话，未写入子代理目录；侧边会话即普通会话。                             |
| **继承交给运行时**  | 侧边会话是对当前对话在事件 0 处的 fork，工作区、目录与预设由运行时继承，插件不解析工作区。               |
| **代码规模**     | 浏览器侧约 566 行，宿主侧约 326 行，均为带注释的 JavaScript。                      |

## 已知限制

- **注入为异步过程**：浏览器创建会话并写入标题，宿主读取标题后注入（最长约 4 秒）。打开面板后立即发送消息时，首条回答可能尚未获得继承内容，注入将作用于下一个步骤。
- **要求主对话在线**：继承内容来自主对话代理的模型可见消息。主对话已卸载时，面板仍可打开，但无继承内容，宿主会输出一条日志。
- **上下文记录保留在面板顶部**：模型可见的内容需要写入会话日志，产品会渲染该日志。
- **删除为尽力而为**：若应用在「已归档、尚未执行清理」之间退出，该会话将在下次启动后的首轮清理中删除。
- 继承内容为纯文本（说话人标签与消息正文），不含工具调用的结构化载荷。

## 开发与测试

```bash
npm test
```

两个零依赖测试脚本：

- `test/client.test.mjs` 以模拟的模块加载器与 Cordis 上下文驱动浏览器半边：创建会话、写入标题、注册标签、关闭归档、失败兜底；
- `test/host.test.mjs` 以模拟的宿主上下文与真实临时目录驱动宿主半边：上下文注入、关闭后清理。

改动约定见 [CONTRIBUTING.md](CONTRIBUTING.md)，版本变更见 [CHANGELOG.md](CHANGELOG.md)。

## 许可

[MIT](LICENSE)
