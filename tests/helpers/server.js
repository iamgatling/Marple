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
          let done = false;
          const finish = () => {
            if (!done) {
              done = true;
              try { server.unref(); } catch {}
              res();
            }
          };
          const timer = setTimeout(finish, 500);
          timer.unref();
          try {
            if (typeof server.closeAllConnections === 'function') {
              server.closeAllConnections();
            }
            if (typeof server.closeIdleConnections === 'function') {
              server.closeIdleConnections();
            }
            for (const socket of sockets) {
              try { socket.destroy(); } catch {}
            }
            sockets.clear();
            server.close(() => {
              clearTimeout(timer);
              finish();
            });
          } catch {
            clearTimeout(timer);
            finish();
          }
        });
      };

      resolve({ server, port, baseUrl, close });
    });

    server.on('error', reject);
  });
}
