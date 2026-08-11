import { createServer, type Server } from 'node:http';

export async function startHealthServer(host: '127.0.0.1' | '::1', port: number, status: () => unknown): Promise<Server> {
  const server = createServer((_request, response) => {
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify(status()));
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => resolve());
  });
  return server;
}
