import http from 'node:http';

export function makeRequest(url, options = {}) {
  return new Promise((resolve, reject) => {
    const {
      method = 'GET',
      headers = {},
      body = null,
      timeout = 3000
    } = options;

    let postData = null;
    const reqHeaders = {
      Connection: 'close',
      ...headers
    };

    if (body !== null && body !== undefined) {
      if (typeof body === 'string' || Buffer.isBuffer(body)) {
        postData = body;
      } else {
        postData = JSON.stringify(body);
        if (!reqHeaders['Content-Type'] && !reqHeaders['content-type']) {
          reqHeaders['Content-Type'] = 'application/json';
        }
      }
      if (!reqHeaders['Content-Length'] && !reqHeaders['content-length']) {
        reqHeaders['Content-Length'] = Buffer.byteLength(postData);
      }
    }

    const parsedUrl = new URL(url);
    const reqOptions = {
      hostname: parsedUrl.hostname,
      port: parsedUrl.port,
      path: `${parsedUrl.pathname}${parsedUrl.search}`,
      method,
      headers: reqHeaders,
      agent: false,
      timeout
    };

    const req = http.request(reqOptions, (res) => {
      let resBody = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => {
        resBody += chunk;
      });
      res.on('end', () => {
        resolve({
          status: res.statusCode,
          headers: res.headers,
          body: resBody,
          json: () => {
            try {
              return JSON.parse(resBody);
            } catch (err) {
              throw new Error(`Failed to parse JSON response (${res.statusCode}): "${resBody}"`);
            }
          }
        });
      });
    });

    req.on('timeout', () => {
      req.destroy();
      reject(new Error(`Request to ${url} timed out after ${timeout}ms`));
    });

    req.on('error', (err) => {
      reject(err);
    });

    if (postData) {
      req.write(postData);
    }
    req.end();
  });
}

export function sendChunkedRequest(url, options = {}) {
  return new Promise((resolve, reject) => {
    const {
      method = 'POST',
      headers = {},
      chunks = [],
      delayMs = 10,
      timeout = 5000
    } = options;

    const reqHeaders = {
      Connection: 'close',
      'Transfer-Encoding': 'chunked',
      ...headers
    };

    const parsedUrl = new URL(url);
    const reqOptions = {
      hostname: parsedUrl.hostname,
      port: parsedUrl.port,
      path: `${parsedUrl.pathname}${parsedUrl.search}`,
      method,
      headers: reqHeaders,
      agent: false,
      timeout
    };

    let settled = false;
    let resBody = '';
    let responseStatus = null;
    let responseHeaders = null;

    const finish = (result, isError = false) => {
      if (settled) return;
      settled = true;
      if (isError) {
        reject(result);
      } else {
        resolve(result);
      }
    };

    const req = http.request(reqOptions, (res) => {
      responseStatus = res.statusCode;
      responseHeaders = res.headers;
      res.setEncoding('utf8');

      res.on('data', (c) => {
        resBody += c;
      });

      res.on('end', () => {
        finish({
          status: responseStatus,
          headers: responseHeaders,
          body: resBody,
          json: () => {
            try {
              return JSON.parse(resBody);
            } catch (e) {
              throw new Error(`Failed to parse JSON response (${responseStatus}): "${resBody}"`);
            }
          }
        });
      });
    });

    req.on('timeout', () => {
      req.destroy();
      finish(new Error(`Chunked request to ${url} timed out after ${timeout}ms`), true);
    });

    req.on('error', (err) => {
      // If response has already started or completed (e.g. server responded 413 and closed socket), return response
      if (responseStatus !== null) {
        finish({
          status: responseStatus,
          headers: responseHeaders,
          body: resBody,
          json: () => {
            try {
              return JSON.parse(resBody);
            } catch {
              return null;
            }
          }
        });
      } else {
        finish(err, true);
      }
    });

    (async () => {
      try {
        for (let i = 0; i < chunks.length; i++) {
          if (req.destroyed || settled) break;
          const chunkData = chunks[i];
          const payload = Buffer.isBuffer(chunkData) ? chunkData : Buffer.from(chunkData);
          req.write(payload);
          if (delayMs > 0 && i < chunks.length - 1) {
            await new Promise((r) => setTimeout(r, delayMs));
          }
        }
        if (!req.destroyed && !settled) {
          req.end();
        }
      } catch (err) {
        // If write fails because server already answered (e.g. 413), don't immediately reject
        if (responseStatus === null) {
          finish(err, true);
        }
      }
    })();
  });
}
