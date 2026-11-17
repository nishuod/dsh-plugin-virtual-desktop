# Quickstart: one auditable action

This short demo assumes installation and Windows prerequisites are complete. Runtime and permission prompts may take longer than 30 seconds; no timing promise is made. Use a dedicated harmless test application, not a password manager or terminal.

1. Call `desktop_open_child_session` with the Windows PiP backend and approve the startup request when shown. If diagnostics identify an orphan owned by this plugin, call `desktop_reset_child_session` once, then reopen.
2. Call `desktop_open_application` with `{"appId":"vmware-workstation"}` or an allowed local executable `path`. Proceed only when the result and authorized target are ready. If `needs_review`, review the window in the panel; do not bypass authorization.
3. Call `desktop_get_screenshot`. Record its `id`, `epoch`, `windowId`, geometry, UIA tree and privacy metadata. Screen content may be sent to the configured model; read [PRIVACY](PRIVACY.md).
4. Choose a harmless named button in the fresh UIA evidence and authorize one click using [PUBLIC-API](PUBLIC-API.md). If only image coordinates are available, verify them against that exact frame. A frame cannot be reused for another input.
5. Inspect the action receipt and a fresh frame. Assert the intended UIA state changed and the relevant screenshot content changed. A delivered event or changed image hash alone does not prove the desired application behavior. Stop/revoke the task when done.

Never retry an unconfirmed input automatically. Use `reason`, `nextTool` and fresh diagnostics to decide the next safe step. Autonomous `desktop_start_task` is experimental and disabled by default.
