# 订单弹窗通知提示音调研

调研日期：2026-08-13（北京时间）
范围：只评估「订单弹窗通知」当前是否已有提示音、能否增加自定义/更明显的提示音；对照官方文档、供应商源码与本仓库源码核实，不改业务代码。

## 结论先行

**现在已经有提示音，且是"系统默认通知音"，不是静音弹窗：**

- **Windows**：`windows-toast.ts` 已向 SnoreToast 传 `-s Notification.Default`，SnoreToast 会把它写成 toast XML 的 `<audio src="ms-winsoundevent:Notification.Default"/>`，即播放 Windows 系统默认通知音（前提是系统通知/声音未被关闭，见 A.2）。
- **macOS**：Swift 助手已设置 `content.sound = .default`（系统默认通知音），且 `willPresent` 返回 `[.banner, .sound]`，前台也会发声。
- **网页端（GMV 大屏页）**：没有任何音频代码（全仓库唯一与声音相关的代码就是上面两处），浏览器内新订单到达时不会响铃。

**能否增加自定义/更明显的提示音：可以，但 Windows 与 macOS 的"自定义"能力差异很大：**

- **macOS 可以真正自定义**：`UNNotificationSound(named:)` 支持放一个 <30 秒的 .caf/.aiff/.wav 声音文件，但**只支持 3 类固定查找位置**（app 容器/共享 group 容器的 `Library/Sounds`、可执行文件的 main bundle）——对本项目"独立命令行二进制"形态，最可行的是 `~/Library/Sounds/<文件名>`（详见 B.2、B.3，其中有推断成分）。
- **Windows 做不到"自定义 WAV"**：SnoreToast 源码（v0.7.0 与最新 v0.9.1）对 `-s` 的值**强制加 `ms-winsoundevent:` 前缀**，而微软 toast 音频 schema 只允许固定的一批系统声音事件名；传 WAV 文件路径会被拼成无效的 `ms-winsoundevent:C:\...`，Windows 会按场景回退默认音，不会播放你的文件。**想"更明显"的最短路径是换成系统里最响的预置声音 `Notification.Looping.Alarm`（一行改动）**；真想播自定义 WAV 需要绕过 toast 链路单独播放（如 PowerShell 播放本地 WAV），或 fork/重建 SnoreToast，属于额外工作（待验证）。
- **网页端**：可以加（大屏页面已通过 `use-dashboard-stream.ts` 监听 `posting.created`），但受浏览器自动播放策略约束——**用户必须先在页面里点过一次**（点击/按键等用户手势）才能解锁发声，否则 `AudioContext` 挂起、`play()` 的 Promise 被拒。

## 现状核实（先看代码）

### 通知链路

1. `src/server/services/order-notification-service.ts`：把 dashboard 事件 `posting.created` 投影为 `OrderNotificationEvent`，经 EventEmitter + SSE 发布（`handleDashboardEvent` L122-145、`emit` L147-153）。
2. `src/server/routes/notifications.ts`：管理 API `GET/PUT /api/settings/notifications`、`POST .../test`（L23-35），本机 SSE 流 `/api/internal/notifications/stream`（L40-66）。
3. `src/server/notification-agent.ts`：常驻助手消费 SSE，节流后按平台分发——Windows 走 `showWindowsToast`（L97-105、L110-123），macOS 走 `showMacNotification`（L48-89）spawn Swift 二进制。

### Windows 现状

- `src/server/desktop-notifications/windows-toast.ts:25-35`：`buildWindowsToastArguments` 组装参数，其中 **`-s Notification.Default`**（L31）。
- `windows-toast.ts:19-22`：`snoreToastPath()` 指向 `node_modules/node-notifier/vendor/snoreToast/snoretoast-x64.exe`（node-notifier v10.0.1 自带）。
- `windows-toast.ts:85`：直接 `spawn` 该 exe——**绕过了 node-notifier 的 WindowsToaster 包装层**（这层会把不合法 sound 重置为默认值，见 A.1），所以 `-s` 的值是原样传给 SnoreToast 的。

### macOS 现状

- `installer/macos/OzonGMVNotifier.swift:149`：`content.sound = .default`（系统默认通知音）。
- `OzonGMVNotifier.swift:42`：`willPresent` 返回 `[.banner, .sound]`（前台也显示横幅并发声）。
- `OzonGMVNotifier.swift:83`：申请权限时请求 `[.alert, .sound]`。
- `OzonGMVNotifier.swift:145-170`：`deliver()` 组装 `UNMutableNotificationContent` 并 `center.add(request)`；`trigger: nil` 立即投递。
- 注意：该助手是**独立命令行二进制**（`setActivationPolicy(.accessory)` L215，无 app bundle、无沙盒容器），`notification-agent.ts:49` 通过 `MAC_NOTIFIER_BIN` 环境变量定位它。

### 网页端现状

- `src/web` 下 grep `Audio|audio|sound|beep|play(|Howl|new Audio` **零匹配**；全仓库（含 installer、demo 数据）唯一与声音相关的代码就是上面 Windows/macOS 两处（`demo-data.ts` 里的 `wave` 是正弦波数据，与音频无关）。
- 大屏页面已有现成的 SSE 钩子：`src/web/hooks/use-dashboard-stream.ts:21-27` 用 `EventSource` 监听 `posting.created`/`posting.updated`/`sync.status`，这是将来挂网页提示音的天然位置。

## 各方案核实

### A. Windows（SnoreToast）

#### A.1 `-s/--sound` 的确切语法

- SnoreToast 官方（本项目 vendor 来源是 KDE/snoretoast v0.7.0，vendor LICENSE 头注明）README 原文：
  > `[-s] <sound URI>  | Sets the sound of the notifications, for possible values see http://msdn.microsoft.com/en-us/library/windows/apps/hh761492.aspx.`
  > `[-silent]         | Don't play a sound file when showing the notifications.`

  [KDE/snoretoast README](https://github.com/KDE/snoretoast)（`-s` 说明引用的旧 MSDN 页就是后来迁到 Learn 的 toast `audio` 元素文档，见 A.3）。

- node-notifier 侧（本项目虽未用它的 toaster，但 vendor 来自它）：README 的 WindowsToaster 选项写 `sound: false // Bool | String (as defined by http://msdn.microsoft.com/en-us/library/windows/apps/hh761492.aspx)`；其 `lib/utils.js mapToWin8` 里有个限制——**`sound` 不以 `Notification.` 开头就重置为 `Notification.Default`**（`node_modules/node-notifier/lib/utils.js:431-433`）。本项目直接 spawn SnoreToast，不受这个限制，`-s` 传什么 SnoreToast 就收什么。

- **关键限制（自定义 WAV 不可行的根因）**：SnoreToast 源码 `snoretoasts.cpp` 的 `setSound()`（v0.7.0 与最新 v0.9.1 逐字相同）：

  ```cpp
  std::wstring sound;
  if (d->m_sound.find(L"ms-winsoundevent:") == std::wstring::npos) {
      sound = L"ms-winsoundevent:";
      sound.append(d->m_sound);
  } else {
      sound = d->m_sound;
  }
  ```

  → 任何 `-s` 值都会被拼成 `ms-winsoundevent:<值>`。所以：
  - `-s Notification.Default` → `ms-winsoundevent:Notification.Default` ✅ 合法系统声音；
  - `-s Notification.Looping.Alarm` → `ms-winsoundevent:Notification.Looping.Alarm` ✅ 合法系统声音；
  - `-s C:\sounds\ding.wav` → `ms-winsoundevent:C:\sounds\ding.wav` ❌ 不是合法事件名，不播放该文件。

  并且 SnoreToast 自身没有 `PlaySound` 之类的直接播放逻辑（v0.7.0 源码里只有 toast XML 的 `<audio>` 元素），声音完全交给系统 toast 渲染。

  [KDE/snoretoast 源码 snoretoasts.cpp](https://github.com/KDE/snoretoast/blob/master/src/snoretoasts.cpp)

#### A.2 当前 `-s Notification.Default` = 已经播放默认通知音

- 确认：SnoreToast 会生成 `<audio src="ms-winsoundevent:Notification.Default"/>`，微软 toast audio schema 把它列为合法值，即 Windows 系统默认通知音（"Windows Notify System Default"）。
- 是否真的发声还受以下系统条件影响（即"代码设了声音≠一定能听到"）：
  1. 该 appID（本项目 `com.ozon.gmv-dashboard`）的通知被系统允许显示横幅——node-notifier README 明确写过 toast 需要该 app "Banners enabled"（设置 > 系统 > 通知中该应用允许通知）。
  2. 系统通知声音未整体关闭：Windows 10/11 的设置 > 系统 > 通知可关闭通知及提示音；具体开关名称因系统版本而异，微软 support 文章当前链接已 404，未能从官方页面确认当前版本确切文案，**该开关名称标注"待验证"**，以系统实际界面为准。
  3. 系统音量、勿扰/专注模式（Focus Assist）等也会压掉提示音。

  [toast audio 元素 schema（MS Learn）](https://learn.microsoft.com/en-us/uwp/schemas/tiles/toastschema/element-audio) | [node-notifier README（Windows 横幅要求）](https://github.com/mikaelbr/node-notifier)

#### A.3 "自定义提示音"的最小改法

- **只换系统声音名（推荐最小改法）**：在 `windows-toast.ts:31` 把 `Notification.Default` 换成 `Notification.Looping.Alarm` 即可。它属于 schema 明确列出的合法值，是系统"循环类"告警音，比默认音更响、更易辨识。注意两点：
  - SnoreToast 生成的 toast XML **不设置 `loop="true"`**（v0.7.0 源码中 audio 元素只设 `src` 和 `silent` 两个属性），按 schema 语义 `loop` 缺省为 false，**只会播放一遍**，不会真的循环。
  - schema 备注还说明：若给 toast 指定"自定义文件路径"，系统不会播放该文件，而是"按场景播放默认音"（notification/call/alarm/reminder 对应默认音）。
- **真正播放自定义 WAV 在 toast 链路里不可行**：微软"Custom audio on toasts"文档明确自定义音频只支持 `ms-appx:///` 与 `ms-resource` 两种来源，明确不支持 `ms-appdata`、`http(s)://`、`C:/`、`F:/` 等本地路径；且这些只适用于带包标识的（打包）应用，SnoreToast 这类无包标识桌面 exe 没有 `ms-appx` 资源。所以想播自定义 WAV 只能二选一：① 在 `notification-agent.ts` 里额外 spawn 一个播放器（如 PowerShell `System.Media.SoundPlayer` 播本地 wav，或经 Windows 音频 API）与 toast 并行——**实现与效果待验证**；② fork/重建 SnoreToast 改 `setSound()`——成本高，不推荐。

  [Custom audio on toasts（MS Learn）](https://learn.microsoft.com/en-us/windows/apps/design/shell/tiles-and-notifications/custom-audio-on-toasts) | [toast audio 元素 schema（MS Learn）](https://learn.microsoft.com/en-us/uwp/schemas/tiles/toastschema/element-audio)

### B. macOS（UNUserNotificationCenter / Swift helper）

#### B.1 当前 `content.sound = .default` 的行为

- `UNNotificationSound.default` 即系统默认通知音，投递时播放（`.default` 属性是 Apple 文档明确给出的"默认系统声音"用法：*"To play the default system sound, create your sound object using the default method."*）。
- **前台/后台两种场景**：
  - 后台：系统直接投递，声音按 `content.sound` 播放；
  - 前台：`UNUserNotificationCenterDelegate.willPresent` 会被调用，Apple 文档说明**若不实现该方法，系统按"不展示"处理**；本助手返回 `[.banner, .sound]` 即"前台也显示横幅 + 播放声音"。由于本助手是投递时短暂前台运行的 accessory app，这个实现恰恰是"banner + 声音能出来"的关键（没有它前台投递会静默进通知中心）。
- **用户侧开关**：系统设置 > 通知 > 该 App（Ozon GMV）的「播放通知声音」（Apple 官方 Mac 用户指南描述 *"Play sound for notification — Let the app play notification sounds"*），另有 Focus 专注模式、音量会影响发声。

  [UNNotificationSound（Apple）](https://developer.apple.com/documentation/usernotifications/unnotificationsound) | [willPresent（Apple）](https://developer.apple.com/documentation/usernotifications/unusernotificationcenterdelegate/usernotificationcenter(_:willpresent:withcompletionhandler:)) | [Mac 用户指南：通知设置（Apple Support）](https://support.apple.com/guide/mac-help/notifications-mh40583/mac)

#### B.2 自定义提示音：`UNNotificationSound(named:)`

Apple 官方 `UNNotificationSound` 文档（init(named:) 一节）核实结果：

- 声音文件**必须已存在于用户设备上**才能播放；自定义声音对象只会在以下位置按序查找，取第一个同名文件：
  1. app 容器目录下的 `Library/Sounds`；
  2. app 共享 group 容器目录下的 `Library/Sounds`；
  3. 当前可执行文件的 **main bundle**。
- 音频数据格式：Linear PCM、MA4 (IMA/ADPCM)、µLaw、aLaw；封装文件可以是 **.aiff、.wav 或 .caf**。
- **时长必须小于 30 秒，超过则系统改播默认音**（这是"明显提示音"的硬约束）。
- 可用 `afconvert` 转换，示例：`afconvert /System/Library/Sounds/Submarine.aiff ~/Desktop/sub.caf -d ima4 -f caff -v`。
- 注意：Apple 文档**没有**提到 `~/Library/Sounds`（用户级）或 `/Library/Sounds`（系统级）是查找位置——这点与 `NSSound(named:)` 不同，**不要想当然**。

  [UNNotificationSound（Apple）](https://developer.apple.com/documentation/usernotifications/unnotificationsound) | [init(named:)（Apple）](https://developer.apple.com/documentation/usernotifications/unnotificationsound/init(named:))

#### B.3 本项目 helper 是独立二进制，声音文件放哪

- helper 无 app bundle、非沙盒（`installer/macos/OzonGMVNotifier.swift` 是独立可执行文件）。
- 按 B.2 的三类查找位置推导：
  1. 「app 容器目录」——对非沙盒进程通常即用户主目录，因此 `~/Library/Sounds/<name>.caf` 很可能命中；**这是最实用的放置方式，但"非沙盒进程容器=主目录"属于基于 macOS 沙盒语义的推断，标注"待验证"**。
  2. 「当前可执行文件的 main bundle」——裸二进制没有 bundle，资源目录大概率就是二进制所在目录，声音文件随 `MAC_NOTIFIER_BIN` 一起分发也可能命中；同样**待验证**。
  3. 共享 group 容器不适用（无 App Group 配置）。
- 落地形态：helper 增加 `--sound <name>` 参数（参照现有 `--title/--message/--open/--image` 的解析方式，`OzonGMVNotifier.swift:191-211`），`deliver()` 里把 L149 的 `content.sound = .default` 换成 `UNNotificationSound(named: name)`（找不到时系统行为：按文档语义回退默认音）。声音文件由安装脚本放到 `~/Library/Sounds/`。
- 用户可关闭声音的系统开关仍是 B.1 的「播放通知声音」开关与 Focus/音量。

### C. 网页端（GMV 大屏页面内）

#### C.1 浏览器自动播放策略（autoplay policy）

- MDN Autoplay guide 定义：**autoplay 指任何未经用户明确请求就播放的行为，包括 JS 调 `audioElement.play()`**；有声媒体（未静音、音量非 0）才受自动播放拦截。
- 允许自动播放的通用条件（至少满足其一）：
  1. 音频已静音或音量为 0；
  2. **用户已与站点交互**（点击、触摸、按键等）；
  3. 站点被浏览器加入自动播放白名单（如用户媒体参与度高，或用户手动设置）；
  4. iframe 通过 autoplay Permissions Policy 被授权。
  原文重点：*"playback of any media that includes audio is generally blocked if the playback is programmatically initiated in a tab which has not yet had any user interaction."*
- Web Audio API：在 `AudioContext` 的 source node 上 `start()` 同样受自动播放规则约束（MDN）；被拦截的上下文处于 `suspended` 状态，需在用户手势回调里 `ctx.resume()` 解锁（MDN AudioContext.resume）。
- `HTMLMediaElement.play()`：返回 Promise，播放失败（权限/拦截）会 reject——所以必须捕获 reject 并提示"需要先点击页面一次"。
- 浏览器差异：Chrome/Edge（Chromium 内核）在用户与该站点有过交互后可放开有声自动播放；Safari（WebKit）默认阻止有声自动播放，"网站应假设任何 `<audio>`/`<video>` 都需要一次用户手势点击"（WebKit 官方博客），且 Safari 提供站点级偏好设置。

  [MDN Autoplay guide](https://developer.mozilla.org/en-US/docs/Web/Media/Autoplay_guide) | [MDN HTMLMediaElement.play()](https://developer.mozilla.org/en-US/docs/Web/API/HTMLMediaElement/play) | [MDN AudioContext](https://developer.mozilla.org/en-US/docs/Web/API/AudioContext) | [WebKit: Auto-Play Policy Changes for macOS](https://webkit.org/blog/7734/auto-play-policy-changes-for-macos/) | [Chrome Autoplay policy](https://developer.chrome.com/docs/web-platform/autoplay)（该页本次抓取超时，仅作参考链接）

#### C.2 当前 web 端是否已有音频代码

- **没有**。`src/web` 全量 grep `Audio|audio|sound|beep|play(|Howl|new Audio` 零匹配；`src/web/demo-data.ts` 的 `wave` 是数据曲线，与音频无关。
- 若要做，天然挂点：`src/web/hooks/use-dashboard-stream.ts:25` 的 `posting.created` 事件回调（大屏页打开时已在监听），但必须等用户首次点击页面后再允许发声，否则 `play()` 被拒。

## 推荐的最小改动（D，仅清单，不改代码）

若要做"可配置提示音（开关/选择）"，按依赖顺序列出要动的文件：

1. **契约**：`src/shared/contracts.ts:192-198` — 扩展 `OrderNotificationSettings`，加提示音字段（如 `soundName: string` 或 `sound: "default" | "alarm" | ...`）。
2. **存储**：`src/server/db/settings-repository.ts:11-23` — 通用 KV，无需改代码，新增 key（如 `notifications.sound_name`）。
3. **服务**：`src/server/services/order-notification-service.ts` — 新增 key 常量（参照 L15-20），`view()`/`update()`（L51-64）读写新字段。
4. **路由**：`src/server/routes/notifications.ts:8` — `settingsSchema` 加可选字段；PUT handler（L24-27）透传。
5. **通知助手**：`src/server/notification-agent.ts:48-89`（`showMacNotification`）加 `--sound` 参数；`showOrder`/`showSummary`（L93-126）把声音设置传给两个平台。
6. **Windows**：`src/server/desktop-notifications/windows-toast.ts:25-35` — 把设置映射为 `-s` 值；**只能映射 ms-winsoundevent 系统声音名**（如 `Notification.Default` / `Notification.Looping.Alarm`），不能传 WAV 路径（见 A.3）。
7. **macOS helper**：`installer/macos/OzonGMVNotifier.swift` — 解析 `--sound`（参数解析在 L191-211），`deliver()` 中 L149 改 `content.sound = UNNotificationSound(named:)`；安装脚本把声音文件放到 `~/Library/Sounds/`（<30 秒，.caf/.aiff/.wav，见 B.2/B.3）。
8. **前端 API/UI**：`src/web/api.ts:228-241`（`fetchOrderNotificationSettings`/`updateOrderNotificationSettings` 负载扩展）；`src/web/pages/SettingsPage.tsx:215-240`（"新订单系统通知"卡片加提示音开关/下拉，旁加"需要系统通知声音已开启"提示）。
9. **（可选）网页内提示音**：`src/web/hooks/use-dashboard-stream.ts:25` 的 `posting.created` 处触发 `new Audio(...).play()`；必须处理自动播放拦截——首次用户交互后解锁，`play()` 的 reject 要兜底（见 C.1）。

顺序建议：先做 1→8 的"系统通知换更响声音 + 可选开关"（改动小、见效快），网页内提示音（9）单独评估。

## 官方来源清单

- [KDE/snoretoast README（`-s` 参数与用法）](https://github.com/KDE/snoretoast)
- [KDE/snoretoast 源码 snoretoasts.cpp（`setSound()` 强制 ms-winsoundevent 前缀）](https://github.com/KDE/snoretoast/blob/master/src/snoretoasts.cpp)
- [node-notifier README（WindowsToaster `sound` 选项、横幅要求）](https://github.com/mikaelbr/node-notifier)
- [node-notifier lib/utils.js（`mapToWin8` 对 sound 的限制）](https://github.com/mikaelbr/node-notifier/blob/master/lib/utils.js)
- [toast audio 元素 schema（MS Learn，`ms-winsoundevent` 合法值清单）](https://learn.microsoft.com/en-us/uwp/schemas/tiles/toastschema/element-audio)
- [Custom audio on toasts（MS Learn，自定义音频仅 ms-appx/ms-resource）](https://learn.microsoft.com/en-us/windows/apps/design/shell/tiles-and-notifications/custom-audio-on-toasts)
- [UNNotificationSound（Apple）](https://developer.apple.com/documentation/usernotifications/unnotificationsound)
- [UNNotificationSound init(named:)（Apple，查找位置与格式限制）](https://developer.apple.com/documentation/usernotifications/unnotificationsound/init(named:))
- [willPresent delegate（Apple，前台展示语义）](https://developer.apple.com/documentation/usernotifications/unusernotificationcenterdelegate/usernotificationcenter(_:willpresent:withcompletionhandler:))
- [Notifications 人机界面指南（Apple HIG）](https://developer.apple.com/design/human-interface-guidelines/notifications)
- [Mac 用户指南：通知设置（Apple Support，「播放通知声音」开关）](https://support.apple.com/guide/mac-help/notifications-mh40583/mac)
- [MDN Autoplay guide](https://developer.mozilla.org/en-US/docs/Web/Media/Autoplay_guide)
- [MDN HTMLMediaElement.play()](https://developer.mozilla.org/en-US/docs/Web/API/HTMLMediaElement/play)
- [MDN AudioContext](https://developer.mozilla.org/en-US/docs/Web/API/AudioContext)
- [WebKit: Auto-Play Policy Changes for macOS](https://webkit.org/blog/7734/auto-play-policy-changes-for-macos/)
- [Chrome Autoplay policy](https://developer.chrome.com/docs/web-platform/autoplay)（本次抓取超时，未逐条核对内容）

## 待验证项汇总

- Windows 10/11「通知声音」相关系统开关的确切名称/路径（微软 support 文章 404，未获官方页面确认，以系统界面为准）。
- macOS「非沙盒进程的 app 容器目录 = 用户主目录」的推断 → `~/Library/Sounds` 是否真能被 `UNNotificationSound(named:)` 命中（建议实现时先做一次真机验证；备选方案是声音文件随二进制放同目录）。
- Windows 播自定义 WAV 的旁路方案（PowerShell SoundPlayer 等）的可行性与体验（未实现验证）。
- `Notification.Looping.Alarm` 在 SnoreToast（不设 loop 属性）下实际听感为"播一遍"（依据 schema 语义推断，未在真机对比）。
