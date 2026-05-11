# probe-target

Tiny startable Node HTTP server used as a real end-to-end target for
lbvd's FR-17 application startup probe and Stage 2 Tier 1 live
exploit verification.

## Run

    npm start
    # or: node server.js

The server listens on `http://localhost:3000` (override with the `PORT`
environment variable). It exits cleanly on `SIGTERM` / `SIGINT`.

## Endpoints

| Method | Path              | Behaviour                             |
| ------ | ----------------- | ------------------------------------- |
| GET    | `/health`         | `200 ok` — health probe.              |
| GET    | `/calc?expr=<JS>` | Returns `{ "result": <eval(expr)> }`. |
