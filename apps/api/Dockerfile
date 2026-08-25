# chittu-api — architecture §14's first container.
#
# Four stages: deps (full, for the compiler) -> build (tsc emit) ->
# prod-deps (runtime tree, no devDependencies) -> runtime (distroless).
#
# THE RUNTIME IMAGE CONTAINS NO TYPESCRIPT, NO SOURCES AND NO SHELL.
# The first version of this file ran src/*.ts through tsx because nothing in the
# repo emitted JavaScript. That is now fixed at the root: every relative import
# in packages/ carries an explicit `.js`, which is what Node's ESM resolver
# requires and what `moduleResolution: nodenext` demands of an emitted .d.ts.
# Without it `export * from './client'` resolves under vitest and fails under
# node — so the 1054-test suite stayed green while the container could not boot.
# scripts/smoke-dist.mjs exists to catch exactly that, because the test suite
# structurally cannot: it resolves @chittu/* through the `development` export
# condition, i.e. the sources, not the artifact.
#
# Build from the REPO ROOT — the context needs the workspace:
#
#   docker build -f apps/api/Dockerfile -t chittu-api .

# ---------------------------------------------------------------- base ------
# Manifests only. BOTH dependency trees below derive from this, so the --prod
# install starts from an empty node_modules and never has to purge a dev tree —
# pnpm refuses that without a TTY (ERR_PNPM_ABORTED_REMOVE_MODULES_DIR_NO_TTY)
# and the usual workaround, CI=true, silences a prompt that is there for a
# reason. Two clean installs from one lockfile is the honest shape.
FROM node:22-slim AS base

# corepack ships with node and pins pnpm from packageManager, so the image and
# the laptop resolve the identical dependency tree.
RUN corepack enable
WORKDIR /app

# Manifests only, so a source edit does not invalidate the dependency layer.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/api/package.json               apps/api/
COPY packages/consent/package.json       packages/consent/
COPY packages/contracts/package.json     packages/contracts/
COPY packages/db/package.json            packages/db/
COPY packages/disengagement/package.json packages/disengagement/
COPY packages/maths-engine/package.json  packages/maths-engine/
COPY packages/pedagogy/package.json      packages/pedagogy/
COPY packages/pipeline/package.json      packages/pipeline/
COPY packages/reading-coach/package.json packages/reading-coach/
COPY packages/safety-kernel/package.json packages/safety-kernel/
COPY packages/seal/package.json          packages/seal/

# Store location only — NO install here. An install (or even `pnpm fetch`) in
# this stage leaves a node_modules/.modules.yaml behind, and the --prod install
# downstream then treats it as a tree to purge and stops for a TTY that a build
# does not have.
RUN pnpm config set store-dir /pnpm/store

# ---------------------------------------------------------------- deps ------
# The full tree, devDependencies included: tsc lives there.
FROM base AS deps
WORKDIR /app
# --frozen-lockfile so the image can never quietly resolve a different tree than
# the local verify run reviewed. --ignore-scripts because a postinstall in a
# transitive dependency is arbitrary code running as root at build time.
RUN --mount=type=cache,id=pnpm,target=/pnpm/store \
    pnpm install --frozen-lockfile --ignore-scripts --filter @chittu/api...

# --------------------------------------------------------------- build ------
FROM deps AS build
WORKDIR /app
COPY packages ./packages
COPY apps/api ./apps/api
COPY tsconfig.base.json ./
# Topological: pnpm orders workspace builds by dependency graph, so @chittu/db
# is emitted before apps/api compiles against its generated .d.ts.
RUN pnpm -r --filter @chittu/api... build

# ----------------------------------------------------------- prod-deps ------
# A second, DEVELOPMENT-FREE dependency tree. Resolved from the same lockfile,
# so it is a subset of what was built against and never a different resolution.
FROM base AS prod-deps
WORKDIR /app
RUN --mount=type=cache,id=pnpm,target=/pnpm/store \
    pnpm install --frozen-lockfile --ignore-scripts --prod --filter @chittu/api...

# ------------------------------------------------------------- runtime ------
# Distroless: no shell, no package manager, no libc tooling — nothing an
# attacker who reaches RCE can pivot through. Possible only because the runtime
# is now plain node + dist/.
FROM gcr.io/distroless/nodejs22-debian12 AS runtime
ENV NODE_ENV=production
WORKDIR /app

# The WHOLE tree, not just the root node_modules. pnpm puts each workspace link
# in that package's own node_modules — packages/pipeline resolves @chittu/contracts
# through packages/pipeline/node_modules/@chittu/contracts, a symlink to
# ../../contracts. Copying only /app/node_modules produced exactly one error,
# ERR_MODULE_NOT_FOUND for @chittu/contracts, and it is worth knowing that is
# what it means rather than reaching for an install in the runtime stage.
COPY --from=prod-deps --chown=nonroot:nonroot /app ./

# Compiled output only. No .ts anywhere in this image.
COPY --from=build --chown=nonroot:nonroot /app/packages/consent/dist       ./packages/consent/dist
COPY --from=build --chown=nonroot:nonroot /app/packages/contracts/dist     ./packages/contracts/dist
COPY --from=build --chown=nonroot:nonroot /app/packages/db/dist            ./packages/db/dist
COPY --from=build --chown=nonroot:nonroot /app/packages/disengagement/dist ./packages/disengagement/dist
COPY --from=build --chown=nonroot:nonroot /app/packages/maths-engine/dist  ./packages/maths-engine/dist
COPY --from=build --chown=nonroot:nonroot /app/packages/pedagogy/dist      ./packages/pedagogy/dist
COPY --from=build --chown=nonroot:nonroot /app/packages/pipeline/dist      ./packages/pipeline/dist
COPY --from=build --chown=nonroot:nonroot /app/packages/reading-coach/dist ./packages/reading-coach/dist
COPY --from=build --chown=nonroot:nonroot /app/packages/safety-kernel/dist ./packages/safety-kernel/dist
COPY --from=build --chown=nonroot:nonroot /app/packages/seal/dist          ./packages/seal/dist
COPY --from=build --chown=nonroot:nonroot /app/apps/api/dist               ./apps/api/dist

# Migrations are read at boot by applyMigrations() — see db/README.md.
COPY --chown=nonroot:nonroot db/migrations ./db/migrations

USER nonroot

# 0.0.0.0 is set HERE and nowhere else. main.ts defaults to loopback precisely
# so that a laptop never publishes its API to the local network by accident.
ENV HOST=0.0.0.0
ENV PORT=8080
# Stdout is the transport in a container; a file on a replaceable task is not a
# record anyone can rely on. Empty means "no file" (apps/api/src/logging.ts).
ENV LOG_DIR=""

EXPOSE 8080

# Talks to the app rather than the process table: a listening socket that cannot
# reach Postgres is not healthy, and /health does check the database. Absolute
# node path because distroless has no shell and no PATH lookup for CMD.
HEALTHCHECK --interval=30s --timeout=3s --start-period=40s --retries=3 \
  CMD ["/nodejs/bin/node", "-e", "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/health').then(r=>{if(!r.ok)process.exit(1);return r.json()}).then(j=>process.exit(j.status==='ok'?0:1)).catch(()=>process.exit(1))"]

WORKDIR /app/apps/api

# The distroless image's ENTRYPOINT is node, so CMD is just the script. No shell
# form and no init shim: node is PID 1 and receives SIGTERM directly, which is
# what the graceful shutdown in main.ts is waiting for.
CMD ["dist/main.js"]
