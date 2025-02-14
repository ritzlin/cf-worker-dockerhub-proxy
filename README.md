# DockerHub Proxy in Cloudflare Worker

A cloudflare worker that acts as a proxy for dockerhub.

## Development

```bash
pnpm install
pnpm dev
```

Create a `.dev.vars` file from the `.dev.vars.example`, and fill in with your own development kv id.

## Deployment

Create a `wrangler.production.toml` file from the `wrangler.production.toml.example`, and fill in with your own production kv id.

```bash
chmod +x deploy.sh
./deploy.sh
```