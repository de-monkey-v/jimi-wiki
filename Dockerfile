# jimi-wiki 멀티스테이지 이미지 — web(next start)·worker(tsx) 공용. command 로 역할 구분.
FROM node:26-slim AS base
ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
RUN corepack enable && apt-get update -y && apt-get install -y --no-install-recommends openssl && rm -rf /var/lib/apt/lists/*
WORKDIR /app

# 의존성(dev 포함 — worker 가 tsx 사용)
FROM base AS deps
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile

# 빌드(prisma client 생성 + next build)
FROM base AS build
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN pnpm prisma generate && pnpm build

# 런타임
FROM base AS run
ENV NODE_ENV=production
COPY --from=build /app ./
EXPOSE 3007
# 기본은 web. worker 는 compose 에서 command 로 덮어쓴다.
CMD ["pnpm", "start"]
