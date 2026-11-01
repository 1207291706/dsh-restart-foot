# dsh-restart-foot

A restart button for the DeepSeek Harness **desktop app**, placed at the **sidebar foot — directly above the avatar / Settings entry**.

> **English** — One row in the sidebar's foot area that stops the whole application (main process, renderers, and the DSH host itself) and starts it again, so freshly installed plugins and settings take effect without quitting by hand. Desktop shell only.

> **中文** — 在 DSH 桌面端侧栏底部、头像/设置入口的**正上方**加一枚「重启 DeepSeek Harness」按钮：点击两次确认后，结束整个应用（主进程、渲染进程、宿主自身）并重新拉起。装完插件、改完配置不用手动退出了。

## Where the button sits / 位置

The row registers in the `sidebar.footer.action` slot. The sidebar's foot area is a vertical stack
(`.footArea` → `.footerActions` → `.settingsArea`), so this list renders **directly above** the
settings / account seat:

```
┌ sidebar foot ────────────────┐
│  ⟳  Restart DeepSeek Harness  │  ← this plugin (sidebar.footer.action)
│  [avatar]  account / settings │  ← ui-settings / ui-settings-account
└───────────────────────────────┘
```

> Note: the pop-up menu behind the avatar (Settings / Feedback / Sign out) is rendered by the
> shipped package `@deepseek-ai/dsh-client-ui-settings-account` (`AccountMenu`) with hard-coded
> rows and **no insert slot**. This plugin therefore places the button in the foot row above that
> menu rather than inside it — the only additive option that does not shadow shipped UI.

## Behaviour / 行为

- **First click** arms the button (it turns into the error colour and reads “Click again to confirm”; it falls back to idle after 5 s).
- **Second click** sends `POST /dsh-restart-foot/restart`. The host writes a `cmd` batch and starts it through `wscript.exe`.
- **No console window**: `wscript.exe` is a GUI-subsystem program, so Windows never gives it a console; it runs the batch with a hidden window style. The helper is started **detached** anyway, because the desktop application owns its children through a job object — an ordinary child is killed together with the application and would never finish the restart. Detaching is what makes it survive; `wscript` is what makes it invisible.
- The batch waits 1 s so the HTTP reply reaches the page, stops every process of the application image, **polls until the image is really gone** (up to 20 s), force-stops leftovers by pid, and only then starts the executable again. Waiting matters: starting a second copy while the first is still shutting down is what makes the shell report a broken installation or an already-running instance.
- **`ELECTRON_RUN_AS_NODE` is cleared before the relaunch.** The host runs with that flag — the desktop shell starts the DSH host from the application binary in Node mode — so a helper that inherits it and starts the binary would get a plain Node process with no script, which exits at once. That failure looks exactly like “it closed and never came back”, and it is the reason this line exists.
- After starting, the batch **verifies that the application appears** (up to 20 s) and logs `application is back` or a warning, so the log alone tells you which step failed.
- Two helpers are written — the `wscript` launcher and the bare batch as a fallback — and each is tried detached first, then hidden. Launch failures are never swallowed: the page shows the reason (hover the button) and `/ping` keeps it in `lastLaunchError`.
- Log: `%TEMP%\dsh-restart-foot.log` (one line per step: request, stop, wait rounds, force-stop, start, back / did-not-appear).
- Running agent turns are interrupted, like with any restart. Session logs are on disk, so a reopened session continues.
- The control is a compact icon button built from the shell's own `Button`, `Tooltip` and refresh icon, so its colours, hover fill and focus ring follow the design system. Motion is limited to interaction: the icon turns a half turn on hover, presses down slightly, nudges twice while armed, and spins while restarting — with no idle animation, because a permanently turning arrow pulls attention away from the conversation. `prefers-reduced-motion` turns all of it off.

## Requirements / 环境要求

- DeepSeek Harness **desktop app** on Windows. The client half registers only when the page origin is
  `dsh-app:`; in a plain browser (`http://127.0.0.1:<port>`) there is no application to relaunch, so the
  row is not registered at all.
- The host half refuses with `501` unless `process.execPath` really is an application executable
  (`node.exe` from a terminal `dsh web` is rejected).
- Node 20+. No build step, no runtime npm dependencies.

## Install / 安装

**From GitHub (current route / 当前安装方式):**

```sh
dsh plugin add github:1207291706/dsh-restart-foot
# same source, explicit git form / 同一来源的 git 写法
dsh plugin add git+https://github.com/1207291706/dsh-restart-foot.git
# into a named profile / 指定 profile
dsh plugin add --profile desktop github:1207291706/dsh-restart-foot
```

**From npm — not available yet / 暂未上架 npm:** the package is finished and packed
(`npm publish --dry-run` passes), but `www.npmjs.com` returns 403 on the author's network,
so the account cannot be registered from there. The npm form below starts working the day
it is published: 包已经打好、`npm publish --dry-run` 通过，但作者所在网络访问 `www.npmjs.com`
返回 403，无法注册账号；下面这条命令在正式上架后即可使用。

```sh
dsh plugin add dsh-restart-foot
```

Then refresh the page (or restart once the old way) to pick up the client module.

**Uninstall**

```sh
dsh plugin remove dsh-restart-foot
```

## Routes / 路由

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/dsh-restart-foot/ping` | Liveness probe: platform, whether a desktop target was found, the executable path, the resolved PowerShell path, and `lastLaunchError`. |
| `POST` | `/dsh-restart-foot/restart` | Schedules the restart. Requires the `x-dsh-restart-foot: 1` header, which keeps stray GETs, prefetchers and other tabs from stopping the app; a cross-origin caller cannot set it without a CORS preflight this server never grants. |
| `POST` | `/dsh-restart-foot/restart?probe=1` | Reports the target without touching any process. |
| `POST` | `/dsh-restart-foot/selfcheck` | Diagnostic: starts `cmd` / PowerShell probes that only write marker files and run a `taskkill` against a nonexistent image, then reports exit codes and captured stderr. Touches no real process. Same header required. |

If a click seems to do nothing, this is the order to look in: the button's tooltip (the failure text),
`/dsh-restart-foot/ping` (`lastLaunchError`), `/dsh-restart-foot/selfcheck` (which launch kinds this host
can actually start), then `%TEMP%\dsh-restart-foot.log` (what the helper itself did).

The routes are served by the DSH web server and are reachable from any client that can reach the port;
bind the server to loopback (the default) if you do not want that.

## Layout / 文件

| File | Role |
| --- | --- |
| `index.js` | Host half: the routes, the helper writers and the launch attempts. |
| `client.js` | Browser half: the row registered into `sidebar.footer.action`. |
| `cordis.patch.yml` | Bundle patch: inserts the `restart-foot` row. |
| `locale/zh.json`, `locale/en.json` | `meta.title` / `meta.description` for the plugin list, plus the row's dictionaries. |
| `icon.svg` | Plugin icon (original artwork, MIT). |

## Credits / 致谢

The restart-helper approach — detached helper, stop by image name, confirm exit before starting again —
follows the MIT-licensed [`dsh-restart-button`](https://github.com/CZY1326/dsh-restart-button) by CZY1326.
This package is an independent implementation for its own slot placement, route prefix, helper script
and log file.

## License

MIT — see [LICENSE](./LICENSE).