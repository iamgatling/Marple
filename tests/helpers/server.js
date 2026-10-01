import http from 'node:http';

export function createTestServer(app) {
  return new Promise((resolve, reject) => {
    const server = http.createServer(app);
    const sockets = new Set();

    server.on('connection', (socket) => {
      sockets.add(socket);
      socket.on('error', () => {});
      socket.on('close', () => sockets.delete(socket));
    });

    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = address.port;
      const baseUrl = `http://127.0.0.1:${port}`;

      const close = () => {
        return new Promise((res) => {
          if (typeof server.closeAllConnections === 'function') {
            server.closeAllConnections();
          }
          for (const socket of sockets) {
            socket.destroy();
          }
          sockets.clear();
          server.close(() => res());
        });
      };

      resolve({ server, port, baseUrl, close });
    });

    server.on('error', reject);
  });
}
