"use strict";
const http = require("node:http");

const PORT = process.env.PORT ? Number(process.env.PORT) : 3000;

function unsafeEval(expr) {
  return eval(expr);
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);

  if (url.pathname === "/health") {
    res.writeHead(200, { "Content-Type": "text/plain" });
    res.end("ok");
    return;
  }

  if (url.pathname === "/calc") {
    const expr = url.searchParams.get("expr") ?? "0";
    try {
      const result = unsafeEval(expr);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ result }));
    } catch (e) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: String(e) }));
    }
    return;
  }

  res.writeHead(404, { "Content-Type": "text/plain" });
  res.end("not found");
});

server.listen(PORT, () => {
  // Single-line startup banner; the probe agent looks for "listening" /
  // port to decide when the server is ready.
  console.log(`probe-target listening on http://localhost:${PORT}`);
});

function stop() {
  server.close(() => process.exit(0));
  // Force exit if anything keeps the loop alive past 2 s.
  setTimeout(() => process.exit(0), 2000).unref();
}
process.on("SIGTERM", stop);
process.on("SIGINT", stop);
