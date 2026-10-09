# appium-mcp — agent rules

## Changing this MCP: build → reconnect → verify

Use portable source checks in the available development environment, and use the
operator's real Mac for iOS runtime validation and any deployment. A mounted
Linux worktree can run Node lint/tests/build but cannot verify Xcode, simulator,
Mac-native dependency, or live MCP behavior. The gateway has previously been
documented as launching `node /Users/gfranks/workspace/appium-mcp/dist/index.js`;
confirm the active command, arguments, environment and timeouts in the Mac's
`~/Library/Preferences/ratatoskr/config.json` (`mcpClients.appium`) before any
build or deployment. The checked-in path is not proof of the current Mac mapping.

1. Run available portable checks: `npm run lint && npm test`, then `npm run build`
   (rimraf + tsc produces `dist/`). Run iOS simulator/device checks only on the
   Mac with explicit task authority and the assigned simulator.
2. Confirm the active command's source and output paths. Deploy the complete
   `dist/` output only to the verified Mac-visible destination; do not copy Linux
   `node_modules` or native dependencies. Do not overwrite another owner's files.
3. Before reconnecting, assess all pending Ratatoskr config changes, eligible
   `NeedsLogin` peers, affected services and active owners. Coordinate with every
   affected owner and establish recovery. If host config or impact cannot be
   inspected, defer reconnect/reload for operator coordination.
4. After authorized deployment, reconnect the `appium` upstream so the gateway
   re-executes the unchanged stdio definition. A config reload alone does not
   replace the running process. Do not restart the gateway as a shortcut.
5. Verify the live tool surface with `list-server-tools` for `appium`; probe one
   cheap call if behavior changed. Report source checks, Mac validation, deployment,
   reconnect and live behavior as separate facts.

## Shared iOS effort ownership

Appium and native iOS callers must use the same `ios-app-dev-mcp` executable,
user identity and durable effort state. Native callers send the versioned JSON
`effort` CLI protocol; configure an absolute `APPIUM_MCP_EFFORT_CLI_PATH` when
needed. Appium retains its co-installed sibling-binary and `PATH` resolution for
compatibility. Do not add a second operation admission around an Appium tool:
its managed calls already admit and finish their own operation.

The shared boot resource is kind `simulatorBoot`, ID
`simulator-boot:<UDID>`. Record pending intent before boot and confirm it only
after successful boot; native owned shutdown requires this exact resource and
will not infer ownership from simulator state. Keep Appium's explicit UDID,
WDA/listener ownership, prepared capability hints, no-reset/no-fallback behavior,
recovery diagnostics and bounded/redacted readiness reporting. Appium setup and
owned WDA/session cleanup remain in Appium; native lifecycle cleanup may shut
down an effort-booted simulator only after Appium-owned resources are gone.
