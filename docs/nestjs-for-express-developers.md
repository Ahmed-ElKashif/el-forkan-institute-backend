# NestJS for Express Developers

This is written for you specifically: you already know Node.js, Express,
REST API design, JWT, RBAC, MVC/3-layer architecture, SOLID principles,
Prisma, PostgreSQL, and Jest (from ITIER and BIOSELVA). None of that is
re-explained here. This doc is only about what NestJS adds on top of what
you already know, and *why* it's shaped the way it is.

Every section links to where the concept already shows up in this repo, so
you can read the doc and the real code side by side.

---

## 1. The one-sentence mental shift

**Express: you wire things together yourself.** You `require()` a service
into a route file, call `new` on it (or import a singleton instance), pass
it into your handler by hand.

**Nest: you *declare* what a class needs, and a container wires it for
you.** You never write `new UsersService()` anywhere in application code.
This is called **Dependency Injection (DI)**, and Nest's runtime IoC
("Inversion of Control") container is the thing that reads your
declarations and constructs everything in the right order.

You've already been *doing* dependency injection informally — passing a
`prisma` client into a service constructor, say — Nest just makes it a
first-class, enforced pattern instead of a convention you have to remember.

```ts
// Express, roughly:
const usersService = new UsersService(prismaClient); // you wire it
app.get('/users/me', (req, res) => usersService.findMe(req.user.id));

// Nest:
@Injectable()
export class UsersService {
  constructor(private readonly prisma: PrismaService) {} // you DECLARE it
}
// Nest's container sees the constructor, sees you need a PrismaService,
// already knows how to build one (it's a registered provider), and hands
// you a fully-constructed instance. You never call `new`.
```

Why bother? Two reasons that matter for a codebase this size:
- **Testability**: swap `PrismaService` for a mock in tests without touching
  the class under test — you just provide a different implementation to the
  same constructor slot.
- **Dependency Inversion (the "D" in SOLID, which you already use)**: a
  class can depend on an *interface* instead of a concrete class, and Nest's
  container decides which concrete implementation to hand over. We'll use
  this directly in Milestone 4 for password hashing (`IPasswordHasher`
  interface, `BcryptPasswordHasher` implementation) — same principle you
  already applied in the CV's "scoped data access model."

---

## 2. The building blocks

| Nest concept | What it is | Express equivalent |
|---|---|---|
| **Module** | A boundary that groups related controllers + providers, and declares what it exports | Loosely: a router file + its own service/repo files, except Nest *enforces* the boundary |
| **Controller** | HTTP layer only — routes in, response out, no business logic | `router.get(...)`, `router.post(...)` handlers |
| **Provider** | Anything `@Injectable()` — services, repositories, anything with business logic | A plain class/module you `require()` and instantiate yourself |
| **Pipe** | Validates/transforms request data before it reaches a handler | Hand-rolled validation at the top of a handler, or a validation middleware |
| **Guard** | Decides if a request is *allowed* to proceed (auth/authz) | Auth middleware (`requireAuth`, `requireRole`) |
| **Interceptor** | Wraps a request/response to add cross-cutting behavior (logging, transform, timing) | Generic middleware that runs before *and* after the handler |
| **Exception filter** | Centralized error → HTTP response mapping | Express's `(err, req, res, next)` error-handling middleware |

Concrete example already in this repo — [`app.module.ts`](../src/app.module.ts):

```ts
@Module({
  imports: [PrismaModule],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}
```

[`app.controller.ts`](../src/app.controller.ts) is HTTP-only — it routes
`GET /health` and delegates to `AppService`. [`app.service.ts`](../src/app.service.ts)
holds the actual logic. That split is exactly the "controller thin, service
does the work" instinct from your 3-layer architecture background — Nest
just makes the boundary a structural rule instead of a convention.

---

## 3. Decorators: how Nest reads your intent

Everywhere you see `@SomethingLikeThis()` above a class, method, or
parameter, that's a **decorator** — metadata attached to the code that
Nest's runtime reads to decide what to do. You don't need to understand how
they're implemented (TypeScript decorators + `reflect-metadata`), just what
each one tells Nest:

- `@Module(...)` — "this class defines a module boundary."
- `@Injectable()` — "this class is a provider the DI container can construct."
- `@Controller('path')` — "this class handles HTTP routes under `/path`."
- `@Get()` / `@Post()` / `@Get('health')` — "map this method to this route."
- `@Body()`, `@Param()`, `@Query()` — "extract this from the request,"
  parameter-level, so a handler signature reads like
  `login(@Body() dto: LoginDto)` instead of `login(req, res)` and manually
  reaching into `req.body`.

This is the biggest *stylistic* jump from Express: instead of one handler
function reading everything off `req`, Nest handler methods declare their
inputs as typed parameters, and decorators say where each one comes from.

---

## 4. The request lifecycle — the order things run in

This is the part worth memorizing, because guards/pipes/interceptors are
easy to reach for in the wrong order otherwise:

```
Request
  │
  ▼
Middleware            (Express-style, global or per-route — rarely needed here)
  │
  ▼
Guards                (can this request proceed at all? auth/authz — throws/returns false to reject)
  │
  ▼
Interceptors (before)  (wrap the call — logging start, timing, etc.)
  │
  ▼
Pipes                 (validate + transform the input — e.g. ZodValidationPipe)
  │
  ▼
Route Handler          (your controller method — business delegation only)
  │
  ▼
Interceptors (after)   (transform the response, stop timers, etc.)
  │
  ▼
Response
  │
  ▼
(Exception Filters catch anything thrown at any point above and map it to an HTTP response)
```

Why this order matters: **Guards run before Pipes.** Authorization is
decided before we even bother validating the request body — rejecting an
unauthenticated request shouldn't depend on whether its JSON is well-formed.
This is why `AccessTokenGuard` (coming in Milestone 5) and
`ZodValidationPipe` (already wired, see below) are separate concerns applied
in a fixed order, not one blob of "check everything" logic.

---

## 5. Pipes — already in this repo

**What we built:** [`login.schema.ts`](../src/auth/dto/login.schema.ts)
defines a zod schema; [`main.ts`](../src/main.ts) wires
`app.useGlobalPipes(new ZodValidationPipe())` globally.

```ts
export const LoginSchema = z.object({
  username: z.string().trim().min(1).max(50),
  password: z.string().min(1).refine(/* byte-length check */),
}).strict();

export class LoginDto extends createZodDto(LoginSchema) {}
```

What changes for you day to day: once a route declares
`@Body() dto: LoginDto`, the pipe has *already* validated and typed `dto`
before your handler method's first line runs. No `if (!req.body.username)`
anywhere. `.strict()` is the zod equivalent of `forbidNonWhitelisted: true`
— unknown fields fail the request instead of being silently dropped or
silently accepted.

This is the same schema-first validation instinct you already have from any
zod/Joi/Yup work — the only Nest-specific part is `createZodDto`, which
exists purely so Nest's type system has a *class* to bind the `@Body()`
parameter to.

### 5b. `@Res({ passthrough: true })` — side effects without losing Nest's response handling

Also live now, in [`auth.controller.ts`](../src/auth/auth.controller.ts):
every `login`/`refresh`/`logout` handler needs to set or clear a cookie
(`res.cookie(...)`, `res.clearCookie(...)`) *and* still return a normal
JSON body / status code the way every other handler does. Injecting the raw
Express `Response` normally (`@Res() res: Response`) hands you the entire
response — Nest steps back completely, and you must call `res.json(...)`
yourself or nothing is ever sent. Adding `{ passthrough: true }` keeps
Nest's automatic behavior (serialize your `return` value, set the status
code) while still letting you touch `res` for side effects on the way out:

```ts
async login(@Body() dto: LoginDto, @Res({ passthrough: true }) res: Response) {
  const result = await this.authService.login(dto.username, dto.password, meta);
  res.cookie('refresh_token', result.refreshToken, { httpOnly: true, /* ... */ });
  return { accessToken: result.accessToken, user: result.user }; // Nest still serializes this
}
```

Compared to Express: this is the one place Nest actually hands you the raw
`res` object you're used to — `passthrough: true` is just what stops that
from opting you out of everything Nest normally does for you.

---

## 6. Guards — built in Milestone 7

A guard is a class implementing `canActivate()`, returning (or resolving to)
`true`/`false`, or throwing. Nest runs it before the route handler.

```ts
@Injectable()
export class AccessTokenGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest();
    // verify the JWT off request.headers.authorization, attach the user, etc.
    return isValid;
  }
}

// usage:
@UseGuards(AccessTokenGuard)
@Get('me')
getMe(@CurrentUser() user: User) { ... }
```

Compared to Express `requireAuth` middleware: same *purpose*, but a guard is
a DI-aware class (it can inject `JwtTokenService`, `UsersRepository`,
whatever it needs via its constructor, same as any provider) instead of a
plain function closing over dependencies.

**Note on `/auth/refresh` — no *auth* guard there, and that's deliberate.**
Milestone 5 built `login`/`refresh`/`logout` with zero guards: a guard is a
*pre-check gate* ("is this request even allowed to reach the handler"), but
validating a refresh token — looking it up by hash, checking
`revoked_at`/`consumed_at`/`expires_at`, deciding whether to revoke a whole
token family — **is** the business logic of `AuthService.refresh()`, not a
gate in front of it. `GET /users/me` (Milestone 7) is different: by the time
that handler runs, "is this access token valid" is a yes/no precondition
completely unrelated to what the handler does next, which is exactly what a
guard is for.

### 6b. Guards aren't only for auth — `APP_GUARD` and subclassing (Milestone 6)

Milestone 6 used a guard for something that has nothing to do with
authentication: rate limiting. `AppModule` registers
`{ provide: APP_GUARD, useClass: ThrottlerGuard }` — this is the DI-token
pattern from §9, just consumed by Nest's bootstrapping instead of your own
code, and its effect is to apply `ThrottlerGuard` to **every route in the
app**, with zero `@UseGuards()` calls anywhere:

```ts
providers: [{ provide: APP_GUARD, useClass: ThrottlerGuard }],
```

For `/auth/login` specifically, a plain IP-based limit isn't enough (spec:
"IP-only is trivially bypassed" — an attacker just varies the username per
request). Rather than write a whole new guard from scratch,
[`login-throttler.guard.ts`](../src/auth/guards/login-throttler.guard.ts)
**extends** `ThrottlerGuard` and overrides just one method:

```ts
@Injectable()
export class LoginThrottlerGuard extends ThrottlerGuard {
  protected getTracker(req: Record<string, any>): Promise<string> {
    return Promise.resolve(`${req.ip}:${req.body?.username}`);
  }
}
```

Everything else (counting, storage, returning `429`) still comes from the
base class — this is inheritance used for exactly one behavioral swap, the
same restraint as `PrismaService extends PrismaClient` in Milestone 2. Apply
it with `@UseGuards(LoginThrottlerGuard)` on just the login route, alongside
the global one — both run, tracking different keys, which is intentional
layering (§ "Layered rate limiting" in `backend/agent/memory.md` has the
full reasoning and a real gotcha it produced during testing).

### 6c. Deny by default, and how a route opts out (Milestone 7)

Milestone 7 built the real thing:
[`jwt-auth.guard.ts`](../src/auth/guards/jwt-auth.guard.ts), registered the
same `APP_GUARD` way as the throttler:

```ts
providers: [
  { provide: APP_GUARD, useClass: ThrottlerGuard },
  { provide: APP_GUARD, useClass: JwtAuthGuard },
],
```

Two things worth stopping on.

**The default is inverted compared to Express.** In an Express app you
usually write `router.get('/me', requireAuth, handler)` — protection is
*opt-in*, so a route added at 2am with no `requireAuth` is silently public.
Registering the guard globally flips that: everything is protected, and a
route has to *ask* to be public with
[`@Public()`](../src/auth/decorators/public.decorator.ts). Forgetting the
decorator produces a `401` in testing, which you notice; forgetting
`requireAuth` produces a working endpoint, which you don't.

**`Reflector` is how a guard reads a decorator.** `@Public()` is just
`SetMetadata('isPublic', true)` — it attaches a key/value to the handler
(or the whole controller class). The guard injects Nest's `Reflector` and
reads it back:

```ts
const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
  context.getHandler(),   // checked first
  context.getClass(),     // falls back to the controller
]);
```

`getAllAndOverride` means "handler wins over controller" — so you can mark a
whole controller public and still protect one route inside it. This
decorator-writes-metadata / guard-reads-metadata pair is the mechanism behind
almost every declarative feature in Nest (`@Roles()`, `@Throttle()`, caching,
serialization all work this way), so it's worth recognising once here.

### 6d. Custom parameter decorators — `@CurrentUser()`

The guard attaches the verified token's claims to `request.user`. Reading
that in a controller could be `@Req() req: Request` + `req.user`, but then
the controller knows about Express again. `createParamDecorator` gives you a
first-class parameter instead:

```ts
export const CurrentUser = createParamDecorator(
  (_data: unknown, context: ExecutionContext): AuthenticatedUser =>
    context.switchToHttp().getRequest<Request>().user as AuthenticatedUser,
);

// usage — no Express types anywhere in the controller signature:
@Get('me')
getMe(@CurrentUser() user: AuthenticatedUser) { ... }
```

This is the Express `req.user` convention, except the coupling to `req` lives
in one decorator file instead of in every handler. Note `src/types/express.d.ts`:
TypeScript doesn't know Express requests have a `user`, so the property is
added by declaration merging — the TS equivalent of the
`declare module 'express'` you'd write in an Express codebase's own types.

---

## 7. Interceptors — not yet built, but worth knowing now

An interceptor wraps the *entire* call (before **and** after the handler
runs), using RxJS's `Observable` under the hood. You won't need to know RxJS
deeply — the common pattern is always the same shape:

```ts
@Injectable()
export class LoggingInterceptor implements NestInterceptor {
  intercept(context: ExecutionContext, next: CallHandler): Observable<any> {
    const start = Date.now();
    return next.handle().pipe(
      tap(() => console.log(`${Date.now() - start}ms`)),
    );
  }
}
```

Where this will matter later in the build: normalizing API response shapes
(so RTK Query's `transformResponse` on the frontend has one consistent
envelope to work with), and the audit-logging requirement from the spec
(§9: "Log every export with actor and row count").

---

## 8. Exception filters — Nest's error-handling middleware

Instead of Express's `(err, req, res, next)` signature, Nest exception
filters catch specific exception types and map them to responses:

```ts
@Catch(PrismaClientKnownRequestError)
export class PrismaExceptionFilter implements ExceptionFilter {
  catch(exception: PrismaClientKnownRequestError, host: ArgumentsHost) {
    const response = host.switchToHttp().getResponse();
    response.status(409).json({ message: 'Conflict' });
  }
}
```

Nest ships a built-in one that already turns thrown `HttpException`s (and
anything unhandled) into sensible JSON error responses — you only write a
custom filter when you want to intercept a *specific* exception type and
handle it differently, like translating a raw Prisma constraint-violation
error into a clean 409.

**This built-in filter is already doing real work in this repo**, with zero
custom filter code written: `AuthService.login` (Milestone 5) just does
`throw new UnauthorizedException('Invalid username or password')` or `throw
new ForbiddenException('Account temporarily locked...')`, and Nest's default
filter turns each into the right status code + JSON body automatically. See
[`auth.service.ts`](../src/auth/auth.service.ts) — no controller-level
`try/catch` anywhere.

---

## 9. Custom providers — the part that makes DI actually powerful

So far every provider has been "just a class." Nest also lets you register
providers by **token**, which is how you implement Dependency Inversion for
real — a consumer depends on an abstract token/interface, and you decide at
module-wiring time which concrete class answers for it. **This is now real
code, built in Milestone 4** —
[`password-hasher.interface.ts`](../src/auth/interfaces/password-hasher.interface.ts),
[`bcrypt-password-hasher.ts`](../src/auth/providers/bcrypt-password-hasher.ts),
wired in [`auth.module.ts`](../src/auth/auth.module.ts):

```ts
export const PASSWORD_HASHER = Symbol('PASSWORD_HASHER');

export interface IPasswordHasher {
  hash(plain: string): Promise<string>;
  verify(plain: string, hash: string): Promise<boolean>;
}

@Injectable()
export class BcryptPasswordHasher implements IPasswordHasher { /* ... */ }

// in AuthModule:
providers: [
  { provide: PASSWORD_HASHER, useClass: BcryptPasswordHasher },
],

// in AuthService (Milestone 5, not written yet):
constructor(@Inject(PASSWORD_HASHER) private readonly hasher: IPasswordHasher) {}
```

Why a `Symbol` and not just the string `'PASSWORD_HASHER'`? Two different
files could accidentally pick the same string as a token by coincidence
(string collisions are silent); a `Symbol()` is guaranteed unique by the
language itself, so a typo or a naming clash becomes a compile-time error
instead of a runtime mystery. We did exactly the same thing for
`TOKEN_SERVICE` in
[`token.service.interface.ts`](../src/auth/interfaces/token.service.interface.ts) —
`JwtTokenService` implements `ITokenService` (JWT access-token sign/verify
**and** opaque refresh-token generation/hashing) with zero AuthService code
written yet, but the DI graph already resolves cleanly (verified by booting
the app and watching `AuthModule dependencies initialized` with no error).

If we ever swap bcrypt for argon2id (the spec explicitly leaves this open),
**exactly one line changes** — the `useClass` in `auth.module.ts` — and
`AuthService` will never notice, because it only ever depends on the
`IPasswordHasher` shape. This is the same "depend on the interface, not the
implementation" principle from your CV's SOLID experience, just expressed
through Nest's provider registration syntax instead of a manual factory
function.

Other provider shapes worth knowing:
- `useValue` — register a plain object/constant (e.g. a config object) as if it were a provider.
- `useFactory` — register a provider built by a function, useful when construction needs async work or other injected values.

---

## 10. Module scoping — `@Global()` and why it's rare

By default, a provider is only visible inside the module that declares it,
*unless* another module explicitly imports that module. This is real
encapsulation, not a suggestion — forgetting to import a module gives you a
DI resolution error at boot, not a silent bug.

[`prisma.module.ts`](../src/prisma/prisma.module.ts) opts out of this with
`@Global()`, because nearly every future feature module needs
`PrismaService` — repeating that import everywhere would be pure
boilerplate for something genuinely cross-cutting (a DB connection). Most
modules should **not** be global; reaching for `@Global()` by default would
erase the whole point of module boundaries. Use it only for true
infrastructure-level singletons.

**A related but different kind of scoping: middleware to just one module's
routes.** A module can implement `NestModule` and declare a `configure()`
method to apply Express-style middleware to only its own routes:

```ts
export class AuthModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer
      .apply(doubleCsrfProtection)
      .forRoutes({ path: 'auth/refresh', method: RequestMethod.POST });
  }
}
```

This is what [`auth.module.ts`](../src/auth/auth.module.ts) does for the
CSRF middleware from Milestone 6 — scoped to exactly `POST /auth/refresh`,
the one cookie-authenticated route (spec §7.3). Compared to Express: the
same idea as `router.use('/path', middleware)`, just declared inside the
module that owns the route instead of accumulating as path strings in
`main.ts` as the app grows.

---

## 11. Lifecycle hooks — already in this repo

[`prisma.service.ts`](../src/prisma/prisma.service.ts) implements
`OnModuleInit`/`OnModuleDestroy`:

```ts
export class PrismaService extends PrismaClient implements OnModuleInit, OnModuleDestroy {
  async onModuleInit() { await this.$connect(); }
  async onModuleDestroy() { await this.$disconnect(); }
}
```

Nest calls `onModuleInit()` as part of its own boot sequence and
`onModuleDestroy()` on shutdown. This is what ties DB connection setup to
the application's lifecycle instead of connecting eagerly at import time or
lazily on first query with no clear failure point — if the DB is
unreachable, the app fails to boot with a clear error, which we actually
verified by watching `PrismaModule dependencies initialized` appear in the
boot log after a clean restart.

Other hooks exist (`OnApplicationBootstrap`, `OnApplicationShutdown`,
`BeforeApplicationShutdown`) for finer-grained control, but
`OnModuleInit`/`OnModuleDestroy` cover the vast majority of real cases.

---

## 12. Testing — you already know this part

Nest testing is built on Jest (which you've already used on ITIER) via
`@nestjs/testing`'s `Test.createTestingModule()` — it spins up a real DI
container scoped to just the providers/controllers you list, so you can
inject mocks in place of real dependencies:

```ts
const module = await Test.createTestingModule({
  controllers: [AuthController],
  providers: [
    AuthService,
    { provide: PASSWORD_HASHER, useValue: mockHasher }, // swap in a mock
  ],
}).compile();
```

This is the same DI mechanism as production — you're not mocking modules at
the `jest.mock()` import level, you're substituting what the *container*
hands to the constructor. `login.schema.spec.ts` (Milestone 3) is a plain
Jest test with no Nest test module at all, because a zod schema has no
dependencies to inject — you only need `Test.createTestingModule` once a
class actually has constructor dependencies.

---

## 13. Cheat sheet: "I want to do X"

| You want to... | Express instinct | Nest way |
|---|---|---|
| Group related routes | A router file | A `@Module()` with its controllers/providers |
| Share a service across routes | `require()` a singleton | Inject it via constructor; Nest's container is the singleton scope by default |
| Validate a request body | Middleware or manual `if` checks | A DTO + pipe (`LoginDto` + `ZodValidationPipe`) |
| Protect a route | Auth middleware | A `@UseGuards(...)`-decorated guard |
| Run logic before *and* after a handler | Middleware calling `next()` in the middle | An interceptor |
| Handle errors centrally | `(err, req, res, next)` middleware | An exception filter (built-in one already covers most cases) |
| Depend on an abstraction, not a concrete class | Manual factory function | A DI token + `useClass`/`useFactory` |
| Run setup/teardown tied to app start/stop | Manual code before `app.listen()` | `OnModuleInit`/`OnModuleDestroy` |

---

## 14. What Phases 1–6 added, in Nest terms

Everything below is a Nest concept the earlier sections had not needed yet.
Each one is linked to the file where it actually appears.

### 14.1 `APP_FILTER` — a global exception filter

§8 showed filters as a concept. [`prisma-exception.filter.ts`](../src/common/prisma-exception.filter.ts)
is the real one, registered the same DI-token way as the guards:

```ts
providers: [{ provide: APP_FILTER, useClass: PrismaExceptionFilter }],
```

It extends `BaseExceptionFilter`, maps the three Prisma error codes that are
genuinely client mistakes (P2002 → 409, P2003 → 409, P2025 → 404), and calls
`super.catch()` for everything else. That last part is the important half: an
unmapped driver error is a *bug*, and dressing it up as a 4xx would hide it.

Compared to Express: this is the `app.use((err, req, res, next) => …)`
handler, except Nest routes an error to it by **type** rather than making one
handler test `instanceof` for every case.

### 14.2 Custom parameter decorators that carry request context

§6d introduced `@CurrentUser()`. Phase 1 added a second one,
[`@CurrentActor()`](../src/common/actor.decorator.ts), which bundles
`{ userId, ipAddress, userAgent }` for the audit log.

Worth understanding *why it is a decorator and not a request-scoped provider*.
Nest can give you the request through `@Inject(REQUEST)`, but doing so makes
that provider **request-scoped**, and scope is contagious: every service that
injects it becomes request-scoped too, and Nest rebuilds that whole slice of
the dependency graph on every call. A parameter decorator reads the same
request with none of that.

### 14.3 `@nestjs/schedule` and why the cron is hourly

[`reminder.scheduler.ts`](../src/messaging/reminder.scheduler.ts) uses
`@Cron('0 * * * *')` — hourly — and then checks
`institute_settings.reminder_weekday` / `reminder_send_time` to decide
whether this is the hour. A `@Cron` expression is fixed at class-decoration
time, so encoding "Thursday 18:00" in it would make changing the reminder time
a redeploy. The settings row is the head teacher's; the cron just wakes up.

The interesting part is not the decorator, it is what replaces a queue (spec
§7.7): **the database is the lock**. `job_runs` is UNIQUE
`(job_name, run_key)`, and the row is INSERTed before any work starts. Two
instances racing produce one winner and one `P2002`, which is the correct
answer for the loser. This is the same trick as `message_campaigns` being
UNIQUE on `(template, section, target_date)`.

### 14.4 `FileInterceptor` and `StreamableFile`

[`import.controller.ts`](../src/import/import.controller.ts) takes an upload
with `@UseInterceptors(FileInterceptor('file', { limits: { fileSize } }))` —
Nest's wrapper around multer, with the size cap enforced before the buffer is
fully in memory.

The counterpart is worth remembering because it caused a real bug: **returning
a `Buffer` from a controller does not send bytes.** Nest's default serializer
JSON-encodes it into `{"type":"Buffer","data":[…]}`, so the response had an
`xlsx` Content-Type and a JSON body. The fix is
`return new StreamableFile(buffer)` — see
[`export.controller.ts`](../src/import/export.controller.ts).

### 14.5 `satisfies` + `GetPayload` — typing a Prisma `include` once

Not a Nest feature, but it appears in every service written in these phases:

```ts
const EXAM_SHAPE = {
  include: { curriculum: { include: { subjects: { select: { name_ar: true } } } } },
} satisfies Prisma.examsDefaultArgs;

type ExamRecord = Prisma.examsGetPayload<typeof EXAM_SHAPE>;
```

`satisfies` checks the object against Prisma's argument type **without
widening it**, so `GetPayload` can then derive the exact row shape the query
returns, relations included. Declaring the include inline instead would leave
the mapper function untyped.

### 14.6 Where the business rules deliberately are *not*

[`src/rules/`](../src/rules/) contains no `@Injectable()`, no Prisma import
and no Nest import. Plain functions over plain data.

That is a deliberate inversion of the instinct this doc has been building: not
everything belongs in a provider. DI earns its keep when something needs to be
*swapped* (`IPasswordHasher`) or *shared* (`PrismaService`). A pure
calculation needs neither, and making it a provider would mean a testing module
just to check that three failed subjects and a limit of three produces a carry.

## Where we are, and what's next

Built so far: `AppModule` → `AppController`/`AppService` (Milestone 1),
`PrismaModule`/`PrismaService` with lifecycle hooks (Milestone 2),
`LoginDto` + global validation pipe (Milestone 3), the `IPasswordHasher`/
`ITokenService` DI-token pattern from §9 (Milestone 4),
`AuthService`/`AuthController` with real `POST /auth/login|refresh|logout`
routes (Milestone 5), and now global hardening — helmet/cors/hpp in
`main.ts`, `APP_GUARD`+subclassed `ThrottlerGuard` for layered rate limiting
(§6b), and `csrf-csrf` scoped to just `/auth/refresh` via module-level
middleware (§10) (Milestone 6, this doc's freshest example — verified live:
CSP/CORS headers present, 6 rapid logins → 5 allowed then `429`, CSRF round
trip rejects without the header and accepts with it, and the full Jest suite
plus `npx eslint src` both clean).

Milestone 7 built `JwtAuthGuard` as a second global `APP_GUARD` (deny by
default), `@Public()` for the four routes that opt out, `@CurrentUser()` as a
custom parameter decorator, and `UsersController`/`UsersService` behind them
for `GET /users/me` — the first genuinely protected route (§6c, §6d;
verified live: `/health` still 200s, `/users/me` is 401 without a token, 200
with one, 401 with a tampered token or a non-Bearer scheme, and
`password_hash` never appears in the response).

Coming next: the frontend track's RTL React shell, and — on the backend —
`RolesGuard` plus the repository-level branch/section scoping layer, both
landing with the first endpoints that actually need them (spec §3).

See `backend/agent/skills-learned.md` for the running, timestamped log of
exactly which concept was introduced at which milestone, with links into the
real code.
