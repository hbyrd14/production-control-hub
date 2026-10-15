# Optional container image. Native installs (docs/INSTALL.md) are the primary deployment.
FROM node:22-bookworm-slim AS build
WORKDIR /app
RUN corepack enable
COPY . .
RUN pnpm install --frozen-lockfile && pnpm build && pnpm prune --prod

FROM node:22-bookworm-slim
WORKDIR /app
ENV PCH_HOST=0.0.0.0 PCH_PORT=8420 PCH_DATA_DIR=/data
COPY --from=build /app /app
VOLUME ["/data"]
EXPOSE 8420
USER node
CMD ["node", "--disable-warning=ExperimentalWarning", "apps/gateway/dist/index.js"]
