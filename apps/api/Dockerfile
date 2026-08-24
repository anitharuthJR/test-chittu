# chittu-api — architecture §14's first container.
#
# TWO DECISIONS WORTH ARGUING WITH, both recorded rather than buried.
#
# 1. IT RUNS TYPESCRIPT VIA tsx, IT DOES NOT COMPILE.
#    Every workspace package points `main` at `src/index.ts`; nothing in this
#    repo has a build script or emits JavaScript. Adding tsc emit means changing
#    main/exports in nine packages and re-proving that vitest, tsx and the
#    published entry points all still resolve — a real refactor, and not the one
#    that unblocks a container today.
#    The cost is honest: a transpiler in the runtime image, and a slower cold
#    start. Before production this should become a build stage that emits to
#    dist/ and a runtime stage with neither tsx nor sources. Tracked, not solved.
#
# 2. node:22-slim, NOT distroless — for now.
#    §14 says "distroless where possible". tsx shells out and wants a real libc
#    and a package manager present at install time; distroless has neither.
#    Once (1) is done and the runtime is plain node + dist/, distroless becomes
#    straightforward and should happen in the same change.
#
# Build from the REPO ROOT, not this directory — the build context needs the
# workspace:
#
#   docker build -f apps/api/Dockerfile -t chittu-api .

# ---------------------------------------------------------------- deps ------
FROM node:22-slim AS deps

# corepack ships with node and pins pnpm from packageManager, so the image and
# the laptop resolve the identical dependency tree.
RUN corepack enable

WORKDIR /app

# Manifests only, so a source edit does not invalidate the dependency layer.
# Every workspace member's package.json is needed for pnpm to build the graph.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/api/package.json          apps/api/
COPY apps/web/package.json          apps/web/
COPY packages/consent/package.json      packages/consent/
COPY packages/contracts/package.json    packages/contracts/
COPY packages/db/package.json           packages/db/
COPY packages/maths-engine/package.json packages/maths-engine/
COPY packages/pedagogy/package.json     packages/pedagogy/
COPY packages/pipeline/package.json     packages/pipeline/
COPY packages/safety-kernel/package.json packages/safety-kernel/
COPY packages/seal/package.json         packages/seal/

# --frozen-lockfile so the image can never quietly resolve a different tree than
# CI reviewed. --ignore-scripts because postinstall in a transitive dependency is
# arbitrary code running as root at build time.
RUN --mount=type=cache,id=pnpm,target=/pnpm/store \
    pnpm config set store-dir /pnpm/store \
 && pnpm install --frozen-lockfile --ignore-scripts \
      --filter @chittu/api... --filter '!@chittu/web'

# ------------------------------------------------------------- runtime ------
FROM node:22-slim AS runtime

RUN corepack enable
ENV NODE_ENV=production

# Non-root. node:22-slim ships a `node` user (uid 1000) already.
WORKDIR /app

# The WHOLE tree from deps, not just the root node_modules. pnpm puts each
# workspace link in that package's own node_modules — packages/pipeline resolves
# @chittu/contracts through packages/pipeline/node_modules/@chittu/contracts, a
# symlink to ../../contracts. Copying only /app/node_modules produced exactly one
# error, ERR_MODULE_NOT_FOUND for @chittu/contracts, and it is worth knowing that
# is what it means rather than reaching for `pnpm install` in the runtime stage.
COPY --from=deps --chown=node:node /app ./

# Sources go on top. COPY MERGES into an existing directory rather than
# replacing it, so the node_modules above survive; .dockerignore keeps any local
# node_modules out of the context so there is nothing to clobber them with.
COPY --chown=node:node packages ./packages
COPY --chown=node:node apps/api ./apps/api
# Migrations are read at boot by applyMigrations() — see db/README.md.
COPY --chown=node:node db/migrations ./db/migrations

USER node

# 0.0.0.0 is set HERE and nowhere else. main.ts defaults to loopback precisely
# so that a laptop never publishes its API to the local network by accident.
ENV HOST=0.0.0.0
ENV PORT=8080
# Stdout is the transport in a container; a file on a replaceable task is not a
# record anyone can rely on. Empty means "no file" (apps/api/src/logging.ts).
ENV LOG_DIR=""

EXPOSE 8080

# Talks to the app rather than the process table: a listening socket that
# cannot reach Postgres is not healthy, and /health does check the database.
HEALTHCHECK --interval=30s --timeout=3s --start-period=40s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/health').then(r=>{if(!r.ok)process.exit(1);return r.json()}).then(j=>process.exit(j.status==='ok'?0:1)).catch(()=>process.exit(1))"

WORKDIR /app/apps/api

# No init shim and no shell form: node is PID 1 and receives SIGTERM directly,
# which is what the graceful shutdown in main.ts is waiting for. A shell form
# would make /bin/sh PID 1 and swallow the signal.
CMD ["node", "--import", "tsx", "src/main.ts"]
