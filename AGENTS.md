# appium-mcp — agent rules

## Changing this MCP: build → reconnect → verify (required final steps)

The Ratatoskr gateway launches the `appium` MCP as a long-lived stdio process
running `node /Users/gfranks/workspace/appium-mcp/dist/index.js` (confirmed in
`mcpClients.appium` in the Mac host's `~/Library/Preferences/ratatoskr/config.json`).
This repo ships TypeScript: the running process executes built output
(`dist/`), so **source edits do nothing until `npm run build` succeeds** —
building into `dist/` *is* the install step.

1. Implement and test: `npm run lint && npm test`, then `npm run build`
   (rimraf + tsc → `dist/index.js`).
2. Reconnect: reloading the config does **not** re-exec an unchanged stdio
   upstream — the gateway keeps serving the previously spawned process. Use
   ratatoskr's `reconnect-upstream` operation (upstream Lua name: `appium`),
   or restart the gateway.
3. Verify live before reporting the change as deployed: `list-server-tools`
   for `appium` must show the new tool surface; probe one cheap call if
   behavior changed.
