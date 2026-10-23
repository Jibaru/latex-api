// Every command's machine-mode output is checked against the data shape its own contract
// publishes (the same one `latex-api schema` prints), so a renamed field fails here.

import { promises as fs } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { root } from "../src/app";
import { walkLeaves } from "../src/command";
import { apiDefinitions } from "../src/schema";
import {
  BASE,
  checkShape,
  type Envelope,
  json,
  ME,
  makeJob,
  memoryKeyring,
  pdf,
  problem,
  runCli,
  stubFetch,
  TOKEN,
  tempHome,
} from "./helpers";

const definitions = apiDefinitions();
const contracts = new Map(
  walkLeaves(root).map(({ path: p, command }) => [p.join(" "), command.contract]),
);

function expectContract(command: string, envelope: Envelope) {
  expect(envelope.ok, JSON.stringify(envelope)).toBe(true);
  expect(Object.keys(envelope).sort()).toEqual(["data", "meta", "ok"]);
  const contract = contracts.get(command);
  expect(contract, command).toBeDefined();
  expect(checkShape(contract!.data, envelope.data, definitions)).toEqual([]);
}

function expectError(result: { code: number; envelope: Envelope }, code: string, exit: number) {
  expect(result.code).toBe(exit);
  expect(result.envelope.ok).toBe(false);
  expect(result.envelope.error.code).toBe(code);
  expect(typeof result.envelope.error.message).toBe("string");
  expect(Object.keys(result.envelope).every((k) => ["ok", "error", "meta"].includes(k))).toBe(true);
}

const LIMITS = {
  maxUploadBytes: 52428800,
  maxUnpackedBytes: 209715200,
  maxFiles: 2000,
  maxFileBytes: 26214400,
  syncTimeoutMs: 60000,
  jobTimeoutMs: 120000,
  jobTimeoutMaxMs: 300000,
  jobMemoryBytes: 1073741824,
  jobCpus: 1,
  artifactTtlHours: 24,
  rateLimitPerKeyPerHour: 300,
  rateLimitConcurrentPerKey: 3,
  engines: ["pdflatex", "xelatex", "lualatex"],
};

const TEMPLATE = {
  id: "article",
  name: "Article",
  description: "A plain article",
  category: "paper",
  engine: "pdflatex",
  entrypoint: "main.tex",
  tags: ["paper"],
  license: "MIT",
  variables: [{ name: "title", description: "Document title" }],
  files: [{ path: "main.tex", size: 10 }],
  links: {
    self: `${BASE}/v1/templates/article`,
    archive: `${BASE}/v1/templates/article/archive`,
    preview: `${BASE}/v1/templates/article/preview`,
    compile: `${BASE}/v1/templates/article/compile`,
  },
};

async function signedIn(home: string, keyring = memoryKeyring()) {
  const routes = {
    "GET /v1/me": () => json(ME),
    "GET /v1/tokens": () => json({ tokens: [TOKEN] }),
  };
  const result = await runCli(["auth", "login", "--with-token"], {
    home,
    stdin: "lta_Ab12Cd34secret\n",
    fetch: stubFetch(routes).fetch,
    keyring: keyring.loader,
  });
  expect(result.code, result.stdout + result.stderr).toBe(0);
  return keyring;
}

describe("envelope: account commands", () => {
  it("auth login --with-token stores the secret in the keychain and identifiers in config", async () => {
    const home = await tempHome();
    const keyring = memoryKeyring();
    const stub = stubFetch({
      "GET /v1/me": () => json(ME),
      "GET /v1/tokens": () => json({ tokens: [TOKEN] }),
    });
    const result = await runCli(["auth", "login", "--with-token"], {
      home,
      stdin: "lta_Ab12Cd34secret\n",
      fetch: stub.fetch,
      keyring: keyring.loader,
    });
    expect(result.envelopes).toHaveLength(1);
    expectContract("auth login", result.envelope);
    expect(result.envelope.data).toMatchObject({
      status: "approved",
      profile: "default",
      tokenId: "tok_cli",
      tokenPrefix: "lta_Ab12Cd34",
      storedIn: "keychain",
    });
    expect(stub.calls[0]!.headers.get("authorization")).toBe("Bearer lta_Ab12Cd34secret");
    expect(keyring.entries.get("latex-api/default")).toBe("lta_Ab12Cd34secret");
    const config = await fs.readFile(path.join(home, "config.json"), "utf8");
    expect(config).not.toContain("secret");
    expect(JSON.parse(config).profiles.default).toMatchObject({
      tokenId: "tok_cli",
      user: { email: "ada@example.com" },
    });
  });

  it("auth login --with-token refuses a secret passed as an argument and an empty stdin", async () => {
    const home = await tempHome();
    expectError(
      await runCli(["auth", "login", "--with-token", "lta_leak"], { home, stdin: "" }),
      "secret_in_argv",
      2,
    );
    expectError(
      await runCli(["auth", "login", "--with-token"], { home, stdin: "\n" }),
      "token_missing",
      2,
    );
  });

  it("auth login --with-token rejects a token the server does not accept (exit 3, nothing stored)", async () => {
    const home = await tempHome();
    const keyring = memoryKeyring();
    const result = await runCli(["auth", "login", "--with-token"], {
      home,
      stdin: "bad",
      fetch: stubFetch({ "GET /v1/me": () => problem(401, "unauthorized") }).fetch,
      keyring: keyring.loader,
    });
    expectError(result, "invalid_token", 3);
    expect(keyring.entries.size).toBe(0);
  });

  it("auth status, auth token and the not-signed-in error", async () => {
    const home = await tempHome();
    expectError(await runCli(["auth", "status"], { home }), "not_authenticated", 3);
    const keyring = await signedIn(home);
    const status = await runCli(["auth", "status"], {
      home,
      keyring: keyring.loader,
      fetch: stubFetch({ "GET /v1/me": () => json(ME) }).fetch,
    });
    expectContract("auth status", status.envelope);
    expect(status.envelope.data.token).toMatchObject({
      source: "keychain",
      prefix: "lta_Ab12Cd34",
    });
    expect(status.envelope.data.token.storage).toMatch(/keychain/);

    const raw = await runCli(["auth", "token"], { home, keyring: keyring.loader });
    expect(raw.stdout).toBe("lta_Ab12Cd34secret\n");
    const wrapped = await runCli(["auth", "token", "--json"], { home, keyring: keyring.loader });
    expectContract("auth token", wrapped.envelope);

    const rejected = await runCli(["auth", "status"], {
      home,
      keyring: keyring.loader,
      fetch: stubFetch({ "GET /v1/me": () => problem(401, "unauthorized") }).fetch,
    });
    expectError(rejected, "unauthorized", 3);
  });

  it("auth logout revokes a CLI-origin token, --keep-token does not", async () => {
    const home = await tempHome();
    const keyring = await signedIn(home);
    const stub = stubFetch({
      "GET /v1/me": () => json(ME),
      "GET /v1/tokens": () => json({ tokens: [TOKEN] }),
      "DELETE /v1/tokens/tok_cli": () => json({ apiToken: { ...TOKEN, status: "revoked" } }),
    });
    const result = await runCli(["auth", "logout"], {
      home,
      keyring: keyring.loader,
      fetch: stub.fetch,
    });
    expectContract("auth logout", result.envelope);
    expect(result.envelope.data).toMatchObject({
      loggedOut: true,
      revoked: true,
      removedFrom: ["keychain"],
    });
    expect(stub.calls.some((c) => c.method === "DELETE")).toBe(true);
    expect(keyring.entries.size).toBe(0);

    const keyring2 = await signedIn(home);
    const stub2 = stubFetch({});
    const kept = await runCli(["auth", "logout", "--keep-token"], {
      home,
      keyring: keyring2.loader,
      fetch: stub2.fetch,
    });
    expect(kept.envelope.data).toMatchObject({ revoked: false, revokeSkipped: "--keep-token" });
    expect(stub2.calls).toHaveLength(0);
  });

  it("auth logout keeps dashboard tokens on the server", async () => {
    const home = await tempHome();
    const keyring = await signedIn(home);
    const stub = stubFetch({
      "GET /v1/tokens": () => json({ tokens: [{ ...TOKEN, origin: "dashboard" }] }),
    });
    const result = await runCli(["auth", "logout"], {
      home,
      keyring: keyring.loader,
      fetch: stub.fetch,
    });
    expect(result.envelope.data.revoked).toBe(false);
    expect(result.envelope.data.revokeSkipped).toMatch(/dashboard/);
    expect(stub.calls.some((c) => c.method === "DELETE")).toBe(false);
  });

  it("token list / create / revoke (dry run, confirmation gate, --yes)", async () => {
    const home = await tempHome();
    const keyring = await signedIn(home);
    const created = {
      token: "lta_NEWSECRET",
      apiToken: { ...TOKEN, id: "tok_ci", name: "ci", expiresAt: "2027-01-20T00:00:00.000Z" },
    };
    const stub = stubFetch({
      "GET /v1/tokens": () => json({ tokens: [TOKEN, created.apiToken] }),
      "POST /v1/tokens": () => json(created, 201),
      "DELETE /v1/tokens/tok_ci": () =>
        json({ apiToken: { ...created.apiToken, status: "revoked" } }),
    });
    const opts = { home, keyring: keyring.loader, fetch: stub.fetch };

    const list = await runCli(["token", "list"], opts);
    expectContract("token list", list.envelope);
    expect(list.envelope.data.currentTokenId).toBe("tok_cli");

    const create = await runCli(["token", "create", "--name", "ci"], opts);
    expectContract("token create", create.envelope);
    expect(create.envelope.data.token).toBe("lta_NEWSECRET");
    expect(JSON.parse(stub.calls.find((c) => c.method === "POST")!.body)).toEqual({
      name: "ci",
      expiresInDays: 90,
    });
    await runCli(["token", "create", "--name", "forever", "--no-expiry"], opts);
    expect(JSON.parse(stub.calls.filter((c) => c.method === "POST")[1]!.body)).toEqual({
      name: "forever",
      expiresInDays: null,
    });
    expectError(
      await runCli(
        ["token", "create", "--name", "x", "--no-expiry", "--expires-in-days", "3"],
        opts,
      ),
      "usage",
      2,
    );
    expectError(
      await runCli(["token", "create", "--name", "x", "--expires-in-days", "0"], opts),
      "usage",
      2,
    );

    const dry = await runCli(["token", "revoke", "tok_ci", "--dry-run"], opts);
    expectContract("token revoke", dry.envelope);
    expect(dry.envelope.data).toMatchObject({ dryRun: true, revoked: false });
    const gated = await runCli(["token", "revoke", "tok_ci"], opts);
    expectError(gated, "confirmation_required", 2);
    expect(gated.envelope.error.hint).toBe("latex-api token revoke tok_ci --yes");
    expect(stub.calls.some((c) => c.method === "DELETE")).toBe(false);
    const done = await runCli(["token", "revoke", "tok_ci", "--yes"], opts);
    expectContract("token revoke", done.envelope);
    expect(done.envelope.data).toMatchObject({ revoked: true, usedByThisProfile: false });

    expectError(
      await runCli(["token", "revoke", "tok_missing", "--yes"], opts),
      "token_not_found",
      4,
    );
  });

  it("maps operator-key 403 and too-many-tokens 409 to exit 3 and 5", async () => {
    const home = await tempHome();
    const env = { LATEX_API_TOKEN: "op" };
    expectError(
      await runCli(["token", "list"], {
        home,
        env,
        fetch: stubFetch({ "GET /v1/tokens": () => problem(403, "forbidden") }).fetch,
      }),
      "forbidden",
      3,
    );
    expectError(
      await runCli(["token", "create", "--name", "x"], {
        home,
        env,
        fetch: stubFetch({ "POST /v1/tokens": () => problem(409, "too_many_tokens") }).fetch,
      }),
      "too_many_tokens",
      5,
    );
  });
});

describe("envelope: auth login device flow (machine mode)", () => {
  const START = {
    deviceCode: "d".repeat(40),
    userCode: "WDJB-MJHT",
    verificationUri: "https://app.test/device",
    verificationUriComplete: "https://app.test/device?code=WDJB-MJHT",
    expiresIn: 600,
    interval: 5,
  };

  function deviceRoutes(pollResponses: Array<() => Response>) {
    const queue = [...pollResponses];
    return stubFetch({
      "POST /v1/auth/device": () => json(START),
      "POST /v1/auth/device/token": () =>
        (queue.shift() ?? (() => problem(400, "expired_token")))(),
      "GET /v1/me": () => json({ ...ME, principal: { ...ME.principal, tokenId: "tok_dev" } }),
      "GET /v1/tokens": () => json({ tokens: [{ ...TOKEN, id: "tok_dev" }] }),
    });
  }

  it("streams a pending envelope, then the approved one, and stores the token", async () => {
    const home = await tempHome();
    const keyring = memoryKeyring();
    const stub = deviceRoutes([
      () => problem(428, "authorization_pending"),
      () => problem(428, "slow_down"),
      () => json({ token: "lta_DEVICE", tokenId: "tok_dev", name: "cli", user: ME.user }),
    ]);
    const result = await runCli(["auth", "login", "--no-browser"], {
      home,
      fetch: stub.fetch,
      keyring: keyring.loader,
    });
    expect(result.code, result.stderr).toBe(0);
    expect(result.envelopes).toHaveLength(2);
    const [pending, approved] = result.envelopes;
    expectContract("auth login", pending!);
    expect(pending!.data).toMatchObject({
      status: "pending",
      userCode: "WDJB-MJHT",
      verificationUriComplete: START.verificationUriComplete,
      browserOpened: false,
    });
    expectContract("auth login", approved!);
    expect(approved!.data).toMatchObject({
      status: "approved",
      tokenId: "tok_dev",
      storedIn: "keychain",
    });
    expect(result.sleeps).toEqual([5000, 5000, 7000]);
    expect(result.stderr).toMatch(/Waiting for approval/);
    expect(keyring.entries.get("latex-api/default")).toBe("lta_DEVICE");
    const start = stub.calls.find((c) => c.url.pathname === "/v1/auth/device")!;
    expect(start.headers.get("authorization")).toBeNull();
    expect(JSON.parse(start.body)).toMatchObject({
      clientName: expect.stringContaining("latex-api-cli"),
    });
    await expect(fs.access(path.join(home, "pending-login.json"))).rejects.toThrow();
  });

  it("--no-wait prints one envelope and --resume finishes the sign-in", async () => {
    const home = await tempHome();
    const keyring = memoryKeyring();
    const first = await runCli(["auth", "login", "--no-wait", "--no-browser"], {
      home,
      fetch: deviceRoutes([]).fetch,
      keyring: keyring.loader,
    });
    expect(first.envelopes).toHaveLength(1);
    expect(first.envelope.data.status).toBe("pending");
    expect(first.envelope.meta.nextSteps).toEqual(["latex-api auth login --resume"]);
    const pendingFile = await fs.readFile(path.join(home, "pending-login.json"), "utf8");
    expect(JSON.parse(pendingFile).userCode).toBe("WDJB-MJHT");

    const resumed = await runCli(["auth", "login", "--resume"], {
      home,
      fetch: deviceRoutes([
        () => json({ token: "lta_R", tokenId: "tok_dev", name: "cli", user: ME.user }),
      ]).fetch,
      keyring: keyring.loader,
    });
    expect(resumed.code).toBe(0);
    expect(resumed.envelope.data.status).toBe("approved");
    expect(keyring.entries.get("latex-api/default")).toBe("lta_R");
    expectError(await runCli(["auth", "login", "--resume"], { home }), "no_pending_login", 2);
  });

  it("reports denial (exit 3) after the pending envelope", async () => {
    const home = await tempHome();
    const result = await runCli(["auth", "login", "--no-browser"], {
      home,
      fetch: deviceRoutes([() => problem(400, "access_denied")]).fetch,
    });
    expect(result.envelopes.map((e) => e.ok)).toEqual([true, false]);
    expectError(result, "access_denied", 3);
  });

  it("says when the server has no device sign-in", async () => {
    const home = await tempHome();
    const result = await runCli(["auth", "login"], {
      home,
      fetch: stubFetch({
        "POST /v1/auth/device": () => new Response("404 page not found", { status: 404 }),
      }).fetch,
    });
    expectError(result, "device_flow_unavailable", 3);
    expect(result.envelope.error.hint).toMatch(/--with-token/);
  });
});

describe("envelope: profiles", () => {
  it("set / list / get / use / rename / remove", async () => {
    const home = await tempHome();
    const env = { LATEX_API_URL: undefined };
    const set = await runCli(["profile", "set", "staging", "--url", "localhost:3999"], {
      home,
      env,
    });
    expectContract("profile set", set.envelope);
    expect(set.envelope.data).toMatchObject({
      created: true,
      profile: { baseUrl: "https://localhost:3999" },
    });
    const update = await runCli(["profile", "set", "staging", "--url", "http://localhost:3999"], {
      home,
      env,
    });
    expect(update.envelope.data.created).toBe(false);

    const list = await runCli(["profile", "list"], { home, env });
    expectContract("profile list", list.envelope);
    expect(list.envelope.data.profiles.map((p: { name: string }) => p.name)).toEqual([
      "default",
      "staging",
    ]);

    const use = await runCli(["profile", "use", "staging"], { home, env });
    expectContract("profile use", use.envelope);
    expect(use.envelope.meta).toMatchObject({
      profile: "staging",
      baseUrl: "http://localhost:3999",
    });
    expectError(await runCli(["profile", "use", "ghost"], { home, env }), "profile_not_found", 4);

    const get = await runCli(["profile", "get"], { home, env });
    expectContract("profile get", get.envelope);
    expect(get.envelope.data.profile).toMatchObject({ name: "staging", current: true });

    await runCli(["profile", "set", "other"], { home, env });
    expectError(
      await runCli(["profile", "rename", "staging", "other"], { home, env }),
      "profile_exists",
      5,
    );
    const rename = await runCli(["profile", "rename", "staging", "local"], { home, env });
    expectContract("profile rename", rename.envelope);
    expect(rename.envelope.data.currentProfile).toBe("local");

    const dry = await runCli(["profile", "remove", "local", "--dry-run"], { home, env });
    expectContract("profile remove", dry.envelope);
    expect(dry.envelope.data.dryRun).toBe(true);
    expectError(
      await runCli(["profile", "remove", "local"], { home, env }),
      "confirmation_required",
      2,
    );
    const removed = await runCli(["profile", "remove", "local", "--yes"], { home, env });
    expectContract("profile remove", removed.envelope);
    expect(removed.envelope.data).toMatchObject({ removed: "local", currentProfile: "other" });
    expectError(
      await runCli(["profile", "set", "bad name"], { home, env }),
      "invalid_profile_name",
      2,
    );
  });

  it("rename moves the stored credential", async () => {
    const home = await tempHome();
    const keyring = await signedIn(home);
    await runCli(["profile", "rename", "default", "personal"], { home, keyring: keyring.loader });
    expect(keyring.entries.get("latex-api/personal")).toBe("lta_Ab12Cd34secret");
    expect(keyring.entries.has("latex-api/default")).toBe(false);
  });
});

describe("envelope: compile and jobs", () => {
  async function project() {
    const dir = await tempHome("latex-proj-");
    await fs.writeFile(
      path.join(dir, "main.tex"),
      "\\documentclass{article}\\begin{document}Hi\\end{document}\n",
    );
    return dir;
  }

  it("compile writes the PDF and returns the job", async () => {
    const home = await tempHome();
    const dir = await project();
    const job = makeJob({ id: "job_c", mode: "sync" });
    const stub = stubFetch({
      "POST /v1/compile": () => json({ job }),
      "GET /v1/jobs/job_c/pdf": () => pdf(),
    });
    const out = path.join(dir, "out.pdf");
    const result = await runCli(["compile", dir, "-o", out], {
      home,
      env: { LATEX_API_TOKEN: "t" },
      fetch: stub.fetch,
    });
    expect(result.code, result.stdout).toBe(0);
    expectContract("compile", result.envelope);
    expect(result.envelope.data.pdf).toEqual({ path: out, bytes: 15 });
    expect((await fs.readFile(out)).subarray(0, 5).toString()).toBe("%PDF-");
    const ledger = await runCli(["jobs", "list", "--local"], { home });
    expectContract("jobs list", ledger.envelope);
    expect(ledger.envelope.data.jobs[0]).toMatchObject({
      id: "job_c",
      status: "succeeded",
      mode: "sync",
    });
  });

  it("compile failure: exit 1 with diagnostics in error.details", async () => {
    const home = await tempHome();
    const dir = await project();
    const diagnostics = [
      { severity: "error", file: "main.tex", line: 1, message: "Undefined control sequence." },
    ];
    const stub = stubFetch({
      "POST /v1/compile": () =>
        problem(422, "compile_failed", {
          jobId: "job_f",
          errors: 1,
          warnings: 0,
          diagnostics,
          logUrl: `${BASE}/v1/jobs/job_f/log`,
        }),
    });
    const result = await runCli(["compile", dir], {
      home,
      env: { LATEX_API_TOKEN: "t" },
      fetch: stub.fetch,
    });
    expectError(result, "compile_failed", 1);
    expect(result.envelope.error.details).toMatchObject({ jobId: "job_f", errors: 1, diagnostics });
    expect(result.envelope.error.hint).toMatch(/diagnostics/);
  });

  it("compile also fails (exit 1) when the JSON job comes back failed", async () => {
    const home = await tempHome();
    const dir = await project();
    const failed = makeJob({
      id: "job_x",
      status: "failed",
      error: { reason: "compile_failed", message: "LaTeX reported errors" },
    });
    const result = await runCli(["compile", dir], {
      home,
      env: { LATEX_API_TOKEN: "t" },
      fetch: stubFetch({ "POST /v1/compile": () => json({ job: failed }) }).fetch,
    });
    expectError(result, "compile_failed", 1);
    expect(result.envelope.error.details.jobId).toBe("job_x");
  });

  it("compile usage errors: missing path, unknown flag, not signed in", async () => {
    const home = await tempHome();
    expectError(
      await runCli(["compile", "does-not-exist.tex"], { home, env: { LATEX_API_TOKEN: "t" } }),
      "path_not_found",
      2,
    );
    expectError(await runCli(["compile", ".", "--fast"], { home }), "unknown_flag", 2);
    const dir = await project();
    expectError(await runCli(["compile", dir], { home }), "not_authenticated", 3);
  });

  it("jobs create --wait downloads the PDF and records submitted + finished", async () => {
    const home = await tempHome();
    const dir = await project();
    const queued = makeJob({
      id: "job_a",
      status: "queued",
      result: undefined,
      finishedAt: undefined,
    });
    const done = makeJob({ id: "job_a" });
    let gets = 0;
    const stub = stubFetch({
      "POST /v1/jobs": () => json({ job: queued }, 202),
      "GET /v1/jobs/job_a": () => json({ job: gets++ === 0 ? queued : done }),
      "GET /v1/jobs/job_a/events": () =>
        new Response("no sse here", { status: 200, headers: { "content-type": "text/plain" } }),
      "GET /v1/jobs/job_a/pdf": () => pdf(),
    });
    const out = path.join(dir, "a.pdf");
    const result = await runCli(["jobs", "create", dir, "--wait", "-o", out], {
      home,
      env: { LATEX_API_TOKEN: "t" },
      fetch: stub.fetch,
    });
    expect(result.code, result.stdout + result.stderr).toBe(0);
    expectContract("jobs create", result.envelope);
    expect(result.envelope.data.pdf.path).toBe(out);
    const lines = (await fs.readFile(path.join(home, "jobs.jsonl"), "utf8"))
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l));
    expect(lines.map((l) => l.event)).toEqual(["submitted", "finished"]);

    const noWait = await runCli(["jobs", "create", dir], {
      home,
      env: { LATEX_API_TOKEN: "t" },
      fetch: stubFetch({ "POST /v1/jobs": () => json({ job: { ...queued, id: "job_b" } }, 202) })
        .fetch,
    });
    expectContract("jobs create", noWait.envelope);
    expect(noWait.envelope.meta.nextSteps[0]).toMatch(/^latex-api jobs wait job_b -o /);
    const local = await runCli(["jobs", "list", "--local"], { home });
    expect(
      local.envelope.data.jobs.map((j: { id: string; status: string }) => [j.id, j.status]),
    ).toEqual([
      ["job_b", "queued"],
      ["job_a", "succeeded"],
    ]);
  });

  it("jobs list / get / logs / pdf / cancel and their error exits", async () => {
    const home = await tempHome();
    const dir = await tempHome("latex-out-");
    const env = { LATEX_API_TOKEN: "t" };
    const stub = stubFetch({
      "GET /v1/jobs": (req) =>
        json({ jobs: [makeJob()].slice(0, Number(req.url.searchParams.get("limit") ?? 20)) }),
      "GET /v1/jobs/job_1": () => json({ job: makeJob() }),
      "GET /v1/jobs/job_1/log": () =>
        new Response("This is pdfTeX\n", {
          status: 200,
          headers: { "content-type": "text/plain" },
        }),
      "GET /v1/jobs/job_1/pdf": () => pdf(),
      "DELETE /v1/jobs/job_1": () => problem(409, "job_finished"),
      "GET /v1/jobs/missing": () => problem(404, "job_not_found"),
    });
    const opts = { home, env, fetch: stub.fetch };
    const list = await runCli(["jobs", "list", "--limit", "5"], opts);
    expectContract("jobs list", list.envelope);
    expect(stub.calls[0]!.url.searchParams.get("limit")).toBe("5");
    expectError(await runCli(["jobs", "list", "--limit", "500"], opts), "usage", 2);
    expectContract("jobs get", (await runCli(["jobs", "get", "job_1"], opts)).envelope);
    const logs = await runCli(["jobs", "logs", "job_1"], opts);
    expectContract("jobs logs", logs.envelope);
    expect(logs.envelope.data.log).toContain("pdfTeX");
    const out = path.join(dir, "x.pdf");
    expectContract("jobs pdf", (await runCli(["jobs", "pdf", "job_1", "-o", out], opts)).envelope);
    expectError(await runCli(["jobs", "cancel", "job_1"], opts), "job_finished", 5);
    expectError(await runCli(["jobs", "get", "missing"], opts), "job_not_found", 4);
  });
});

describe("envelope: templates, meta, doctor, schema, skill", () => {
  it("templates list / get and meta commands", async () => {
    const home = await tempHome();
    const stub = stubFetch({
      "GET /v1/templates": () => json({ templates: [TEMPLATE] }),
      "GET /v1/templates/article": () => json({ template: TEMPLATE }),
      "GET /v1/limits": () => json(LIMITS),
      "GET /health": () =>
        json({ status: "ok", version: "test", checks: { compiler: { ok: true, detail: "img" } } }),
      "GET /v1/stats": () =>
        json({
          last24h: { total: 1, succeeded: 1, failed: 0, cached: 0 },
          durationMs: { p50: 100, p95: 200 },
          queueDepth: 0,
          storage: { usedBytes: 10 },
          compilerVersion: "x",
          byStatus: { succeeded: 1 },
        }),
    });
    const opts = { home, fetch: stub.fetch };
    expectContract("templates list", (await runCli(["templates", "list"], opts)).envelope);
    expectContract("templates get", (await runCli(["templates", "get", "article"], opts)).envelope);
    expectContract("limits", (await runCli(["limits"], opts)).envelope);
    expectContract("health", (await runCli(["health"], opts)).envelope);
    expectContract(
      "stats",
      (await runCli(["stats"], { ...opts, env: { LATEX_API_TOKEN: "t" } })).envelope,
    );
    expect(
      stub.calls.find((c) => c.url.pathname === "/v1/templates")!.headers.get("authorization"),
    ).toBeNull();
  });

  it("health degraded is an error envelope (exit 3); rate limits are exit 5; network is exit 3", async () => {
    const home = await tempHome();
    const degraded = await runCli(["health"], {
      home,
      fetch: stubFetch({
        "GET /health": () =>
          json({ status: "degraded", version: "v", checks: { compiler: { ok: false } } }, 503),
      }).fetch,
    });
    expectError(degraded, "server_degraded", 3);
    expect(degraded.envelope.error.details.health.status).toBe("degraded");
    const limited = await runCli(["limits"], {
      home,
      fetch: stubFetch({ "GET /v1/limits": () => problem(429, "rate_limited", { retryAfter: 30 }) })
        .fetch,
    });
    expectError(limited, "rate_limited", 5);
    const offline = await runCli(["limits"], {
      home,
      fetch: (async () => {
        throw new TypeError("fetch failed");
      }) as unknown as typeof fetch,
    });
    expectError(offline, "network_error", 3);
  });

  it("doctor: healthy with a token, doctor_failed without one", async () => {
    const home = await tempHome();
    const routes = {
      "GET /health": () =>
        json({ status: "ok", version: "v1", checks: { compiler: { ok: true, detail: "image" } } }),
      "GET /v1/me": () => json(ME),
      "* registry.npmjs.org": () => json({ version: "0.2.0" }),
    };
    const failing = await runCli(["doctor"], { home, fetch: stubFetch(routes).fetch });
    expectError(failing, "doctor_failed", 3);
    const checks = failing.envelope.error.details.checks as Array<{ name: string; status: string }>;
    expect(Object.fromEntries(checks.map((c) => [c.name, c.status]))).toEqual({
      config: "pass",
      profile: "pass",
      credential: "fail",
      credential_valid: "skip",
      api_reachable: "pass",
      compiler: "pass",
      cli_version: "pass",
    });
    const healthy = await runCli(["doctor"], {
      home,
      env: { LATEX_API_TOKEN: "t" },
      fetch: stubFetch(routes).fetch,
    });
    expectContract("doctor", healthy.envelope);
    expect(healthy.envelope.data.healthy).toBe(true);
    const offlineNpm = await runCli(["doctor"], {
      home,
      env: { LATEX_API_TOKEN: "t" },
      fetch: stubFetch({
        ...routes,
        "* registry.npmjs.org": () => new Response("x", { status: 404 }),
      }).fetch,
    });
    expect(offlineNpm.envelope.data.checks.at(-1)).toMatchObject({
      name: "cli_version",
      status: "skip",
    });
  });

  it("schema lists every command and filters by name", async () => {
    const home = await tempHome();
    const all = await runCli(["schema"], { home });
    expectContract("schema", all.envelope);
    const names = all.envelope.data.commands.map((c: { command: string }) => c.command);
    expect(names).toEqual([...contracts.keys()]);
    expect(all.envelope.data.schemaVersion).toBe(1);
    expect(Object.keys(all.envelope.data.exitCodes)).toEqual(["0", "1", "2", "3", "4", "5"]);
    const one = await runCli(["schema", "token", "create"], { home });
    expect(one.envelope.data.commands).toHaveLength(1);
    expect(one.envelope.data.commands[0].flags.map((f: { name: string }) => f.name)).toEqual([
      "--name",
      "--expires-in-days",
      "--expiry",
    ]);
    expect(one.envelope.data.commands[0].flags[2].negation).toBe("--no-expiry");
    const group = await runCli(["schema", "jobs"], { home });
    expect(group.envelope.data.commands.length).toBe(7);
    expectError(await runCli(["schema", "nope"], { home }), "command_not_found", 4);
  });

  it("skill get prints raw Markdown, or the envelope with --json", async () => {
    const home = await tempHome();
    const raw = await runCli(["skill", "get"], { home });
    expect(raw.code).toBe(0);
    expect(raw.stdout.startsWith("---\nname: latex-api")).toBe(true);
    const wrapped = await runCli(["skill", "get", "--json"], { home });
    expectContract("skill get", wrapped.envelope);
  });

  it("bare invocation and bare groups describe the commands in machine mode", async () => {
    const home = await tempHome();
    const bare = await runCli([], { home });
    expect(bare.code).toBe(0);
    expect(bare.envelope.data.commands.length).toBe(contracts.size);
    const tokenGroup = await runCli(["token"], { home });
    expect(tokenGroup.envelope.data.commands.map((c: { command: string }) => c.command)).toEqual([
      "token list",
      "token create",
      "token revoke",
    ]);
    expectError(await runCli(["token", "ls"], { home }), "command_not_found", 2);
  });
});
