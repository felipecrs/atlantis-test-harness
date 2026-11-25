// Bitbucket Cloud. Everything is done against its own base branch, so that it
// doesn't touch the main one nor its restrictions.
import { test } from "bun:test";
import { secret, startAtlantis, url, type PullRequest } from "../atlantis";

const env = (name: string) => process.env[`BITBUCKET_CLOUD_${name}`];
const accounts = {
  main: [env("EMAIL"), env("TOKEN")],
  admin: [env("EMAIL"), env("ADMIN_TOKEN")],
  second: [env("SECOND_EMAIL"), env("SECOND_TOKEN")],
};
type Account = keyof typeof accounts;

const prefix = "harness-";
const base = `${prefix}${Date.now()}`;
export const repo = `repositories/${env("REPO")}`;

/** For the tests that need more than the main account. */
export const withSecondAccount = test.skipIf(!env("SECOND_TOKEN"));
export const mergeQueue = env("MERGE_QUEUE");
export const withMergeQueue = test.skipIf(!mergeQueue);

export const blockedBy = (reason: string) => `Blocked by ${reason})`;

export async function api(method: string, path: string, body?: object, as: Account = "main"): Promise<any> {
  const form = body instanceof FormData;
  const response = await fetch(`https://api.bitbucket.org/2.0/${path}`, {
    method,
    headers: {
      Authorization: `Basic ${btoa(accounts[as].join(":"))}`,
      ...(body && !form && { "Content-Type": "application/json" }),
    },
    body: form ? body : body && JSON.stringify(body),
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`${method} ${path}: ${response.status} ${text}`);
  return text.startsWith("{") ? JSON.parse(text) : text;
}

export function start(flags: string[] = [], { as = "main" as Account, dataDir = undefined as string | undefined } = {}) {
  const [email, token] = accounts[as];
  return startAtlantis(
    {
      ATLANTIS_BITBUCKET_USER: "x-bitbucket-api-token-auth",
      ATLANTIS_BITBUCKET_API_USER: email!,
      ATLANTIS_BITBUCKET_TOKEN: token!,
      ATLANTIS_BITBUCKET_WEBHOOK_SECRET: secret,
      ATLANTIS_REPO_ALLOWLIST: `bitbucket.org/${env("REPO")}`,
    },
    flags,
    dataDir,
  );
}

const head = async (branch: string): Promise<string> => (await api("GET", `${repo}/refs/branches/${branch}`)).target.hash;

async function commit(branch: string, files: Record<string, string>, parent: string) {
  const form = new FormData();
  for (const [name, value] of Object.entries({ ...files, branch, parents: parent, message: "Change [skip ci]" })) form.append(name, value);
  await api("POST", `${repo}/src`, form);
}

/** Files for a change in the given projects. */
async function change(projects: string[]) {
  const main = await Bun.file(`${import.meta.dir}/../terraform/main.tf`).text();
  return Object.fromEntries(projects.map((p) => [`${p}/main.tf`, main.replace("base", crypto.randomUUID())]));
}

export async function changeBase(project: string) {
  await commit(base, await change([project]), await head(base));
  await Bun.sleep(5000);
}

export async function restrict(kind: string, value?: number) {
  const body = { kind, branch_match_kind: "glob", pattern: base, users: [], groups: [] };
  const { id } = await api("POST", `${repo}/branch-restrictions`, { ...body, value }, "admin");
  const path = `${repo}/branch-restrictions/${id}`;
  return {
    change: (value: number) => api("PUT", path, { ...body, value }, "admin"),
    [Symbol.asyncDispose]: () => api("DELETE", path, undefined, "admin"),
  };
}

export const requireBuilds = (minimum: number) => restrict("require_passing_builds_to_merge", minimum);
/** Otherwise, Bitbucket Cloud allows merging even if merge checks fail. */
export const enforceMergeChecks = () => restrict("enforce_merge_checks");

/** Creates the base branch, without restrictions. */
export async function setup() {
  const { mainbranch } = await api("GET", repo);
  const yaml = await Bun.file(`${import.meta.dir}/../terraform/atlantis.yaml`).text();
  await commit(base, { "atlantis.yaml": yaml, ...(await change(["p1", "p2"])) }, await head(mainbranch.name));
}

/** Delivers the events for real. */
export async function createWebhook(url: string) {
  const { uuid } = await api("POST", `${repo}/hooks`, {
    description: "harness", url, secret, active: true, events: ["pullrequest:created", "pullrequest:comment_created"],
  }, "admin");
  return { [Symbol.asyncDispose]: () => api("DELETE", `${repo}/hooks/${encodeURIComponent(uuid)}`, undefined, "admin") };
}

/** Also removes what was left from runs that were killed. */
export async function teardown() {
  for (const pr of (await api("GET", `${repo}/pullrequests?state=OPEN&pagelen=50`)).values) {
    if (pr.source.branch.name.startsWith(prefix)) await api("POST", `${repo}/pullrequests/${pr.id}/decline`).catch(() => {});
  }
  for (const r of (await api("GET", `${repo}/branch-restrictions?pagelen=100`, undefined, "admin")).values) {
    if (r.pattern.startsWith(prefix)) await api("DELETE", `${repo}/branch-restrictions/${r.id}`, undefined, "admin");
  }
  for (const h of (await api("GET", `${repo}/hooks?pagelen=100`, undefined, "admin")).values) {
    if (h.description === "harness") await api("DELETE", `${repo}/hooks/${encodeURIComponent(h.uuid)}`, undefined, "admin");
  }
  for (const b of (await api("GET", `${repo}/refs/branches?pagelen=100&q=name~"${prefix}"`)).values) {
    await api("DELETE", `${repo}/refs/branches/${b.name}`);
  }
}

const createPR = (source: string, destination: string, draft = false) =>
  api("POST", `${repo}/pullrequests`, {
    title: source, draft, source: { branch: { name: source } }, destination: { branch: { name: destination } },
  });

export async function openPR(projects: string[], { draft = false, destination = base } = {}) {
  const branch = `${base}-${crypto.randomUUID().slice(0, 8)}`;
  await commit(branch, await change(projects), await head(destination));
  const { id, source } = await createPR(branch, destination, draft);
  const path = `${repo}/pullrequests/${id}`;

  return {
    path,
    comment: (raw: string, as: Account) => api("POST", `${path}/comments`, { content: { raw } }, as),
    state: async () => (await api("GET", path)).state as string,
    requestChanges: () => api("POST", `${path}/request-changes`),
    clearChanges: () => api("DELETE", `${path}/request-changes`),
    /** Merges the base branch into it. There is no API for that, other than with another pull request. */
    async update() {
      const { id } = await createPR(base, branch);
      await api("POST", `${repo}/pullrequests/${id}/merge`, { close_source_branch: false, message: "Merge [skip ci]" });
      await Bun.sleep(5000);
    },
    build: (key: string, state: "FAILED" | "INPROGRESS" | "STOPPED" | "SUCCESSFUL") =>
      api("POST", `${repo}/commit/${source.commit.hash}/statuses/build`, { key, state, url: "https://example.com" }),
    async comments() {
      const { values } = await api("GET", `${path}/comments?pagelen=100`);
      return values.filter((c: any) => !c.deleted).map((c: any) => ({ id: c.id, text: c.content.raw }));
    },
    // Replayed, without the uuid of the actor. Otherwise Atlantis would ignore its own comments.
    // Plans are sent as if the pull request was just opened.
    async send(command: string) {
      await Bun.sleep(5000); // to not hit rate limits
      const pullrequest = await api("GET", path);
      const body = JSON.stringify({
        actor: { account_id: "harness" }, repository: pullrequest.destination.repository, pullrequest,
        comment: { content: { raw: command } },
      });
      const response = await fetch(`${url}/events`, {
        method: "POST",
        headers: {
          "X-Event-Key": command === "atlantis plan" ? "pullrequest:created" : "pullrequest:comment_created",
          "X-Request-UUID": "harness",
          "X-Hub-Signature": `sha256=${new Bun.CryptoHasher("sha256", secret).update(body).digest("hex")}`,
        },
        body,
      });
      if (!response.ok) throw new Error(await response.text());
    },
  } satisfies PullRequest & Record<string, unknown>;
}
