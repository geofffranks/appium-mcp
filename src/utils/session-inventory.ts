import {createServer, type Server} from 'node:http';

import {listSessions} from '../session-store.js';

let server: Server | undefined;
let endpoint: string | undefined;

/** Start the private WebDriver-compatible inventory endpoint used for owned sessions. */
export async function startSessionInventory(): Promise<string> {
  if (server?.listening && endpoint) {
    return endpoint;
  }
  server = createServer((request, response) => {
    if (request.method !== 'GET' || (request.url !== '/sessions' && request.url !== '/wd/hub/sessions')) {
      response.writeHead(404).end();
      return;
    }
    const sessions = listSessions().filter((session) => session.ownership === 'owned');
    response.writeHead(200, {'content-type': 'application/json'});
    response.end(JSON.stringify({value: sessions.map(({sessionId, capabilities}) => ({id: sessionId, capabilities}))}));
  });
  await new Promise<void>((resolve, reject) => {
    server!.once('error', reject);
    server!.listen(0, '127.0.0.1', () => resolve());
  });
  const bound = server.address();
  if (!bound || typeof bound === 'string') {
    throw new Error('Could not determine loopback session inventory endpoint.');
  }
  endpoint = `http://127.0.0.1:${bound.port}`;
  return endpoint;
}

export async function stopSessionInventory(): Promise<void> {
  if (!server?.listening) {
    return;
  }
  const current = server;
  server = undefined;
  endpoint = undefined;
  await new Promise<void>((resolve, reject) => current.close((error) => (error ? reject(error) : resolve())));
}

export function sessionInventoryEndpoint(): string | undefined {
  return endpoint;
}
