FROM node:22-bookworm-slim AS build
WORKDIR /app

ARG VITE_ROLEGAIN_AUTH_MODE=supabase
ARG VITE_SUPABASE_URL
ARG VITE_SUPABASE_PUBLISHABLE_KEY
ENV VITE_ROLEGAIN_AUTH_MODE=$VITE_ROLEGAIN_AUTH_MODE
ENV VITE_SUPABASE_URL=$VITE_SUPABASE_URL
ENV VITE_SUPABASE_PUBLISHABLE_KEY=$VITE_SUPABASE_PUBLISHABLE_KEY

COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build

FROM node:22-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production
ENV HOST=0.0.0.0

COPY package.json package-lock.json ./
RUN npm ci --omit=dev \
    && npm install --global @openai/codex@0.146.0 \
    && npx playwright install --with-deps chromium
COPY --from=build /app/dist ./dist
COPY --from=build /app/migrations ./migrations
COPY --from=build /app/.agents ./.agents
COPY --from=build /app/src/02-search/browser/application-form-autofill.js ./src/02-search/browser/application-form-autofill.js

EXPOSE 4317
CMD ["node", "dist/server/src/server/index.js"]
