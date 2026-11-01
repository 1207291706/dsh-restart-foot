/**
 * Browser half of the sidebar-foot restart button.
 *
 * It registers one control in `sidebar.footer.action`. The sidebar renders that
 * list in the column's foot area, directly above the settings/account seat, so the
 * control appears at the bottom-left just above the avatar entry.
 *
 * The control is a compact icon button built from the shell's own primitives —
 * `Button`, `Tooltip` and the official refresh icon — so its size, colours, hover
 * fill and focus ring are the design system's rather than this plugin's. Only the
 * state behaviour is local: click once to arm, click again to confirm; the host
 * then stops and restarts the whole application.
 *
 * Outside the desktop shell there is no application to relaunch, so the control is
 * not registered at all.
 */
window.__ModuleLoader__.load({
  // The module id must equal the package name: two ids for one bundle register
  // the factory twice, and a bare "dsh-restart-foot" is the published name.
  id: "dsh-restart-foot",
  factory: (require) => {
    const React = require("react");
    const primitives = require("@deepseek-ai/dsh-client-ui-primitives");

    const NS = "restartFoot";
    const SLOT = "sidebar.footer.action";
    const RESTART_URL = "/dsh-restart-foot/restart";
    const CSS_ID = "dsh-restart-foot/restart.css";

    //#region styles
    // Everything visual comes from the shell's Button; only the state overrides,
// the rail geometry and the state animations are declared here. There is no idle
// animation on purpose: an arrow that keeps turning draws attention away from the
// conversation.
    const css = [
      ".rsf_button{width:28px;height:28px;padding:0}",
      ".rsf_rail{width:36px;height:36px}",
      ".rsf_icon{width:15px;height:15px;display:block;transition:transform .26s var(--ds-ease-in-out, ease)}",
      // Hover: a half turn, the usual refresh affordance.
      ".rsf_button:hover .rsf_icon{transform:rotate(180deg)}",
      ".rsf_button:active .rsf_icon{transform:rotate(180deg) scale(.86)}",
      ".rsf_armed{color:var(--dsw-alias-state-error-primary)}",
      // Armed: two gentle nudges, so the confirm step is felt and not only read.
      ".rsf_armed .rsf_icon{animation:rsf-nudge 1.1s var(--ds-ease-in-out, ease) 2}",
      ".rsf_busy{cursor:progress}",
      ".rsf_busy .rsf_icon{animation:rsf-spin .9s linear infinite}",
      "@keyframes rsf-spin{from{transform:rotate(0)}to{transform:rotate(360deg)}}",
      "@keyframes rsf-nudge{0%,100%{transform:scale(1)}50%{transform:scale(1.22)}}",
      "@media (prefers-reduced-motion:reduce){.rsf_icon{transition:none}",
      ".rsf_button:hover .rsf_icon,.rsf_button:active .rsf_icon{transform:none}",
      ".rsf_armed .rsf_icon,.rsf_busy .rsf_icon{animation:none}}"
    ].join("");

    if (typeof document !== "undefined" && document.querySelector(`style[data-plugin-css="${CSS_ID}"]`) === null) {
      const tag = document.createElement("style");
      tag.dataset.plugin = "dsh-restart-foot";
      tag.dataset.pluginCss = CSS_ID;
      tag.textContent = css;
      document.head.appendChild(tag);
    }
    //#endregion

    //#region dictionaries
    const zh = {
      action: "重启 DeepSeek Harness",
      aria: "重启应用：结束整个应用进程并重新启动",
      armed: "再次点击确认重启",
      busy: "正在重启…",
      failed: "重启失败，请手动退出后重新打开"
    };
    const en = {
      action: "Restart DeepSeek Harness",
      aria: "Restart the application: quit the whole app process and start it again",
      armed: "Click again to confirm",
      busy: "Restarting…",
      failed: "Restart failed — quit and open the app manually"
    };
    //#endregion

    /** How long an armed button waits before falling back to idle. */
    const ARM_TIMEOUT_MS = 5000;
    /** How long a failure notice stays on the button. */
    const FAIL_TIMEOUT_MS = 6000;

    /**
     * Sidebar-foot restart control.
     * @param props - slot props: column geometry and the namespaced translator.
     * @returns the restart control.
     */
    function RestartButton({ wide = true, t }) {
      const tr = typeof t === "function" ? t : (key) => key;
      const [phase, setPhase] = React.useState("idle");
      const [reason, setReason] = React.useState("");
      const timer = React.useRef(null);

      React.useEffect(() => () => {
        if (timer.current !== null) window.clearTimeout(timer.current);
      }, []);

      const restart = React.useCallback(() => {
        setPhase("busy");
        setReason("");
        fetch(RESTART_URL, {
          method: "POST",
          cache: "no-store",
          headers: { "x-dsh-restart-foot": "1" }
        }).then(async (response) => {
          // The application is about to stop; this page goes away with it.
          if (response.ok) return;
          let detail = `HTTP ${response.status}`;
          try {
            const body = await response.json();
            if (body !== null && typeof body.error === "string" && body.error !== "") {
              detail = `${detail}: ${body.error}`;
            }
          } catch {
            // A non-JSON body keeps the status alone.
          }
          throw new Error(detail);
        }).catch((error) => {
          const detail = String(error?.message ?? error);
          setReason(detail);
          console.warn("[dsh-restart-foot] restart failed:", detail);
          setPhase("failed");
          timer.current = window.setTimeout(() => setPhase("idle"), FAIL_TIMEOUT_MS);
        });
      }, []);

      const onClick = React.useCallback(() => {
        if (phase === "armed") {
          if (timer.current !== null) window.clearTimeout(timer.current);
          restart();
          return;
        }
        if (phase !== "idle") return;
        setPhase("armed");
        timer.current = window.setTimeout(() => setPhase("idle"), ARM_TIMEOUT_MS);
      }, [phase, restart]);

      const label = phase === "armed"
        ? tr("armed")
        : phase === "busy"
          ? tr("busy")
          : phase === "failed"
            ? tr("failed")
            : tr("action");
      // The failure reason is only useful while the failure is showing.
      const tooltip = phase === "failed" && reason !== "" ? `${label} — ${reason}` : label;
      const className = [
        "rsf_button",
        wide ? "" : "rsf_rail",
        phase === "armed" ? "rsf_armed" : "",
        phase === "busy" ? "rsf_busy" : ""
      ].filter((entry) => entry !== "").join(" ");

      return React.createElement(
        primitives.Tooltip,
        { label: tooltip, side: "bottom", delayMs: 500 },
        React.createElement(
          primitives.Button,
          {
            size: "sm",
            className,
            "aria-label": tr("aria"),
            "aria-busy": phase === "busy" ? "true" : undefined,
            "data-dsh-restart-foot": true,
            onClick
          },
          React.createElement(primitives.IconRefreshOutlineRegular, { className: "rsf_icon" })
        )
      );
    }
    //#endregion

    //#region plugin body
    return {
      inject: ["slots", "locale"],
      apply(ctx) {
        // Only the desktop shell owns an application to relaunch.
        if (typeof location !== "undefined" && location.protocol !== "dsh-app:") return;
        ctx.effect(() => ctx.locale.register(NS, { zh, en }), "dsh-restart-foot: dictionaries");
        ctx.slots.inject(SLOT, () => ctx.slots.register({
          name: SLOT,
          id: "restart-foot",
          order: 20,
          locale: NS
        }, RestartButton));
      }
    };
    //#endregion
  }
});