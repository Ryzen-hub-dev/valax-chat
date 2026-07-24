# Valax 移动端

此目录使用 Capacitor 8 将线上 Valax 工作区封装为 Android 与 iOS 原生应用。应用加载
`https://discord-bot.valaxscrub.shop`，因此 Discord OAuth、Bot Token 加密、MongoDB、频道消息、
回复、成员搜索、私信、群发活动和通知设置仍使用与网页版完全相同的后端。

## 首次准备

```powershell
cd mobile
pnpm install
pnpm run sync
pnpm run verify
```

Android 需要 JDK 21 与 Android SDK Platform 36。构建脚本会优先使用 `JAVA_HOME`、
`ANDROID_HOME`，也会自动识别 `$HOME/.codex/toolchains/valax-android` 中的本地工具链。检查环境：

```powershell
pnpm run doctor
```

## Android 安装包

调试 APK：

```powershell
pnpm run android:apk
```

产物位于 `android/app/build/outputs/apk/debug/app-debug.apk`。
脚本还会复制一份到 `build-output/Valax-1.0.0-android-debug.apk`，可直接安装测试。

上架 Google Play 应使用签名后的 AAB。先复制 `android/key.properties.example` 为
`android/key.properties`，填入发布证书路径与密码，再运行：

```powershell
pnpm run android:aab
```

发布产物位于 `android/app/build/outputs/bundle/release/app-release.aab`。证书、密码和
`key.properties` 不应提交到版本库。

## iOS 安装包

iOS 必须在 macOS 上使用 Xcode 和 Apple Developer 证书完成签名：

```bash
cd mobile
pnpm install
pnpm run sync
pnpm run ios:open
```

在 Xcode 中选择 `App` Target，设置 Team 与唯一 Bundle Identifier，然后使用
`Product > Archive > Distribute App` 导出 TestFlight 或签名后的 IPA。Windows 无法合法生成
可安装、可签名的 IPA。

Windows 交付目录中的 `Valax-1.0.0-ios-project.zip` 是可带到 Mac 的完整 Xcode 工程源包。

## 发布前检查

1. Discord Developer Portal 的回调地址保持为
   `https://discord-bot.valaxscrub.shop/api/callback`。
2. 线上 `/api/health` 正常，Vercel 环境变量已完整配置。
3. 在真机上检查 Discord 登录、返回跳转、相机/文件选择、通知声音与安全区域。
4. 每次网页或 Capacitor 配置变更后运行 `pnpm run sync`。
