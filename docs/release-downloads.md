## 下载选择

| 文件 | 适用场景 | 如何使用 |
| --- | --- | --- |
| `aihub-auto_..._x64-setup.exe` | 大多数 Windows x64 用户 | 推荐。运行 NSIS 安装器，获得桌面窗口、托盘和签名更新。 |
| `aihub-auto-desktop-windows-x64.zip` | Windows x64 免安装使用 | 解压后直接运行 `aihub-auto-desktop.exe`。它同样带桌面窗口和托盘；Windows 10/11 通常自带所需 WebView2。 |
| `aihub-auto_..._x64.dmg` / `..._aarch64.dmg` | Intel / Apple Silicon macOS | 挂载后拖入 Applications。 |
| `aihub-auto_..._amd64.deb` | Debian/Ubuntu x64 桌面 | 用系统软件安装器或 `apt` 安装；后续由系统包管理器更新。 |
| `aihub-auto-<platform>-<arch>.zip` | 无界面部署、其他 Linux 发行版，或只需路由器 | standalone 路由器，不含桌面窗口或托盘。解压后运行 `aihub-auto`（Windows 为 `aihub-auto.exe`），再打开 `http://127.0.0.1:8787/ui`。 |

`*.sig` 和 `latest.json` 供桌面更新器校验和发现更新，不需要手动打开。Windows 安装包和 macOS DMG 已使用 minisign 进行更新校验；Windows Authenticode 与 macOS Developer ID/公证尚未配置，系统仍可能显示发行方提示。
