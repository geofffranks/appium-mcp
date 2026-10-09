# appium-mcp — agent rules

## Changing this MCP: build → reconnect → verify

Develop and run checks directly on the operator's Mac. The gateway has previously
been documented as launching `node /Users/gfranks/workspace/appium-mcp/dist/index.js`;
confirm the active command, arguments, environment and timeouts in the Mac's
`~/Library/Preferences/ratatoskr/config.json` (`mcpClients.appium`) before any
build or deployment. The checked-in path is not proof of the current Mac mapping.

1. Implement and test on the Mac: `npm run lint && npm test`, then `npm run build`
   (rimraf + tsc produces `dist/`).
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
   cheap call if behavior changed. Report source changes, checks, deployment,
   reconnect and live behavior as separate facts.
