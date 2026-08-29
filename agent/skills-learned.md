# Skills learned — teaching log

Concept-by-concept record, scoped to the gap between what the CV already shows
(Node/Express, JWT, RBAC, MVC/3-layer, SOLID, Prisma, PostgreSQL) and what's
new here (NestJS specifics, RTK Query specifics). Each entry says what was
taught and points at where it first shows up in code.

## Milestone 1 — Nest fundamentals

- **Dependency injection via constructor + decorators.** A class marked
  `@Injectable()` becomes something Nest's container can construct and hand
  to anything that declares it in a constructor parameter — no `new` calls
  anywhere in application code. First seen:
  [`app.service.ts`](../src/app.service.ts) (`@Injectable()`),
  [`app.controller.ts`](../src/app.controller.ts)
  (`constructor(private readonly appService: AppService)`).
  Compared to Express: this replaces manually importing and instantiating a
  service module inside a route file.
- **Module as a DI boundary.** `@Module({ controllers: [...], providers:
  [...] })` declares what a module owns and can inject; `imports`/`exports`
  control what crosses module boundaries. First seen:
  [`app.module.ts`](../src/app.module.ts).
  Compared to Express: loosely analogous to grouping a router + its
  service/repo files, except Nest enforces the boundary and wires the
  injection automatically instead of manual `require`/`import`.
- **Route decorators.** `@Controller()` + `@Get('health')` map an HTTP
  verb+path to a method — declarative instead of Express's
  `app.get('/health', handler)` chaining.
- **Hot module reload via `nest start --watch`** — file changes recompile and
  restart automatically; verified by editing the route and re-curling without
  manually restarting the process.

## Milestone 2 — Prisma groundwork

- **Nest lifecycle hooks (`OnModuleInit`, `OnModuleDestroy`).** A provider
  implementing these interfaces gets `onModuleInit()`/`onModuleDestroy()`
  called automatically as part of Nest's own boot/shutdown sequence — this is
  how `PrismaService` ties DB connect/disconnect to the app's lifecycle
  instead of connecting eagerly at import time or lazily on first use with no
  clear failure point. First seen:
  [`prisma.service.ts`](../src/prisma/prisma.service.ts).
  Compared to Express: there's no equivalent hook system in plain Express —
  you'd typically call `pool.connect()` manually before `app.listen()` and
  hope nothing depends on ordering.
- **`@Global()` modules.** Normally a module's providers are only visible to
  modules that explicitly import it — real encapsulation, not a suggestion.
  `@Global()` opts a module out of that for cross-cutting infrastructure
  (here, the DB connection) so every future feature module can inject
  `PrismaService` without re-importing `PrismaModule` everywhere. First seen:
  [`prisma.module.ts`](../src/prisma/prisma.module.ts).
  Compared to Express: closer to a singleton you `require()` from anywhere,
  except Nest still resolves it through DI (mockable in tests), it's just not
  scoped to one module's import graph.
- **A class extending a generated client while also being `@Injectable()`.**
  `PrismaService extends PrismaClient` — Nest doesn't care that the class
  body is mostly generated code; anything decorated `@Injectable()` is a
  valid provider regardless of what it extends.

## Milestone 3 — Validation layer

- **Pipes.** A global `ValidationPipe`-style class (`ZodValidationPipe` here)
  intercepts every incoming request body before it reaches a controller
  method, validates/transforms it against a schema, and either lets it
  through (typed) or throws a 400 automatically. First seen:
  [`main.ts`](../src/main.ts) (`app.useGlobalPipes(...)`).
  Compared to Express: replaces a hand-rolled `if (!req.body.username) return
  res.status(400)...` block (or a middleware doing the same) at the top of
  every route handler — here it's declared once, globally, and every
  controller method just receives already-valid, correctly-typed data.
- **DTO classes generated from a schema, not hand-written.** `LoginDto
  extends createZodDto(LoginSchema)` — the class exists so Nest's pipe
  system has something to bind a controller parameter's type to
  (`@Body() body: LoginDto`), but the *validation* is entirely the zod
  schema. First seen: [`login.schema.ts`](../src/auth/dto/login.schema.ts).
  You've done schema-first validation before (this is the same instinct as
  any zod/Joi/Yup usage) — the only new part is that Nest wants a *class* to
  hang a parameter type on, and `nestjs-zod` bridges that gap for you.

## Milestone 4 — SOLID applied to Auth

- **DI tokens (`Symbol`) + custom `useClass` providers.** Beyond registering
  a class as itself, Nest lets you register a provider under an arbitrary
  token (here, `PASSWORD_HASHER`/`TOKEN_SERVICE` symbols) and decide the
  concrete implementation at module-wiring time. First seen:
  [`auth.module.ts`](../src/auth/auth.module.ts)
  (`{ provide: PASSWORD_HASHER, useClass: BcryptPasswordHasher }`), consumed
  via `@Inject(PASSWORD_HASHER)` starting next milestone in `AuthService`.
  This is the mechanism-level answer to "how do I actually do Dependency
  Inversion in Nest" — you've applied the principle before, this is just
  Nest's specific syntax for it.
- **A module importing another module's exports.**
  [`auth.module.ts`](../src/auth/auth.module.ts) imports `UsersModule` to
  get access to `UsersRepository` (which `UsersModule` explicitly
  `exports`s). Reinforces the module-boundary point from Milestone 2 — this
  is the *normal*, non-`@Global()` case: you import exactly the module whose
  providers you need, nothing more.
- **Verifying DI wiring by booting, not just compiling.** TypeScript
  compiling successfully doesn't prove the token graph resolves — a missing
  `provide`/`useClass` pairing only surfaces as a runtime error when Nest
  actually tries to construct the module tree. Confirmed by watching
  `AuthModule dependencies initialized` (and no error) in the boot log.

## Milestone 5 — Auth implementation

- **`@Res({ passthrough: true })`.** Injecting the raw Express `Response`
  normally means *you* own the entire response (call `res.json()` yourself,
  Nest steps back). Passing `{ passthrough: true }` lets you use `res` for
  side effects only (here, `res.cookie(...)`) while Nest still handles
  serializing your method's return value as the response body — the best of
  both. First seen: [`auth.controller.ts`](../src/auth/auth.controller.ts).
  Compared to Express: closer to just using `res` normally, except you keep
  Nest's automatic JSON serialization and status-code defaults instead of
  losing them the moment you touch `res`.
- **Built-in exception → HTTP mapping.** Throwing `new
  UnauthorizedException('...')` or `new ForbiddenException('...')` anywhere
  in a service automatically becomes a `401`/`403` JSON response with that
  message — no `try/catch` in the controller, no manual `res.status(401)`.
  Nest's built-in exception filter (§8 of the NestJS doc) catches these by
  default; a custom filter is only needed to handle an exception type
  specially. First seen throughout
  [`auth.service.ts`](../src/auth/auth.service.ts).
- **`import type` under `isolatedModules` + `emitDecoratorMetadata`.** A type
  (interface) used only as the annotation on a `@Inject()`-decorated
  constructor parameter must be imported with `import type`, not a normal
  `import` — TypeScript needs to know at a glance (without full
  cross-file analysis) that the import can be erased at compile time. Hit
  this as a real compile error (TS1272) while wiring `IPasswordHasher`/
  `ITokenService` into `AuthService`'s constructor.
- **NestJS does not auto-load `.env`.** Nothing about Nest itself reads
  environment files — that's either `@nestjs/config` (not used yet here) or
  a manual `dotenv` call. This one cost real debugging time (see
  `backend/agent/memory.md`) precisely because everything else in the app
  *looked* correctly configured. Worth remembering as a first-thing-to-check
  whenever an env-dependent feature behaves as if a config value were empty.

## Milestone 6 — Global hardening

- **Module-scoped middleware via `NestModule.configure()`.** Beyond global
  `app.use(...)` in `main.ts`, a module can implement `NestModule` and apply
  middleware to just its own routes via `MiddlewareConsumer` — `.apply(fn)`
  `.forRoutes({ path, method })`. First seen:
  [`auth.module.ts`](../src/auth/auth.module.ts) (`doubleCsrfProtection`
  scoped to `POST /auth/refresh` only). Compared to Express: same underlying
  idea as `router.use('/path', middleware)`, but declared where the route
  itself is defined rather than accumulating in one central app-setup file.
- **`APP_GUARD` — a globally-applied provider token.** Registering `{
  provide: APP_GUARD, useClass: ThrottlerGuard }` in a module's `providers`
  makes Nest apply that guard to *every* route in the app, without a single
  `@UseGuards()` anywhere. First seen: [`app.module.ts`](../src/app.module.ts).
  This is the DI-token pattern from Milestone 4 again, just consumed by
  Nest's own bootstrapping instead of application code — same mechanism,
  different caller.
- **Overriding a guard's tracking key by subclassing.** `LoginThrottlerGuard
  extends ThrottlerGuard`, overriding only `getTracker()` to key on
  `${ip}:${username}` instead of the base class's IP-only default. First
  seen: [`login-throttler.guard.ts`](../src/auth/guards/login-throttler.guard.ts).
  The base class handles everything else (storage, counting, the 429
  response) — this is inheritance used for exactly one behavioral override,
  not a full reimplementation.
- **`@Throttle()` metadata is read by every guard checking that throttler
  name on a route, not just one.** A single decorator
  (`@Throttle({ default: { limit: 5, ttl: 60_000 } })`) changed the
  effective limit for *both* the global `ThrottlerGuard` and the route-level
  `LoginThrottlerGuard` simultaneously, because they share the `'default'`
  throttler name. Worth knowing before assuming a `@Throttle()` override only
  affects the guard you were thinking about.

## Milestone 7+ — pending
