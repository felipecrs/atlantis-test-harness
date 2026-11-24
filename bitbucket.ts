// Bitbucket Cloud. Everything is done against its own base branch, so that it
// doesn't touch the main one nor its restrictions.
import { secret, startAtlantis, type PullRequest } from "./atlantis";

const { BB_REPO, BB_EMAIL, BB_TOKEN, BB_ADMIN_TOKEN, BB2_EMAIL, BB2_TOKEN } = process.env;
const accounts = {
  main: [BB_EMAIL, BB_TOKEN],
  admin: [BB_EMAIL, BB_ADMIN_TOKEN],
  second: [BB2_EMAIL, BB2_TOKEN],
};
type Account = keyof typeof accounts;

const prefix = "harness-";
const base = `${prefix}${Date.now()}`;
export const repo = `repositories/${BB_REPO}`;

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
      ATLANTIS_REPO_ALLOWLIST: `bitbucket.org/${BB_REPO}`,
    },
    flags,
    dataDir,
  );
}

const head = async (branch: string): Promise<string> => (await api("GET", `${repo}/refs/branches/${branch}`)).target.hash;

async function commit(branch: string, files: Record<string, string>, parent: string) {
  const form = new FormData();
  for (const [name, value] of Object.entries({ ...files, branch, parents: parent, message: "Change" })) form.append(name, value);
  await api("POST", `${repo}/src`, form);
}

/** Files for a change in the given projects. */
async function change(projects: string[]) {
  const main = await Bun.file(`${import.meta.dir}/terraform/main.tf`).text();
  return Object.fromEntries(projects.map((p) => [`${p}/main.tf`, main.replace("base", crypto.randomUUID())]));
}

export async function changeBase(project: string) {
  await commit(base, await change([project]), await head(base));
  await Bun.sleep(5000);
}

export async function restrict(kind: string, value?: number) {
  const body = { kind, value, branch_match_kind: "glob", pattern: base, users: [], groups: [] };
  const { id } = await api("POST", `${repo}/branch-restrictions`, body, "admin");
  return {
    update: (value: number) => api("PUT", `${repo}/branch-restrictions/${id}`, { ...body, value }, "admin"),
    [Symbol.asyncDispose]: () => api("DELETE", `${repo}/branch-restrictions/${id}`, undefined, "admin"),
  };
}

export async function setup() {
  const { mainbranch } = await api("GET", repo);
  const yaml = await Bun.file(`${import.meta.dir}/terraform/atlantis.yaml`).text();
  await commit(base, { "atlantis.yaml": yaml, ...(await change(["p1", "p2"])) }, await head(mainbranch.name));
  await restrict("require_no_changes_requested");
  await restrict("require_tasks_to_be_completed");
  await restrict("require_passing_builds_to_merge", 1);
}

/** Also removes what was left from runs that were killed. */
export async function teardown() {
  for (const pr of (await api("GET", `${repo}/pullrequests?state=OPEN&pagelen=50`)).values) {
    if (pr.destination.branch.name.startsWith(prefix)) await api("POST", `${repo}/pullrequests/${pr.id}/decline`).catch(() => {});
  }
  for (const r of (await api("GET", `${repo}/branch-restrictions?pagelen=100`, undefined, "admin")).values) {
    if (r.pattern.startsWith(prefix)) await api("DELETE", `${repo}/branch-restrictions/${r.id}`, undefined, "admin");
  }
  for (const b of (await api("GET", `${repo}/refs/branches?pagelen=100&q=name~"${prefix}"`)).values) {
    await api("DELETE", `${repo}/refs/branches/${b.name}`);
  }
}

export async function openPR(projects: string[], { draft = false } = {}) {
  const branch = `${base}-${crypto.randomUUID().slice(0, 8)}`;
  await commit(branch, await change(projects), await head(base));
  const { id, source } = await api("POST", `${repo}/pullrequests`, {
    title: branch, draft, source: { branch: { name: branch } }, destination: { branch: { name: base } },
  });
  const path = `${repo}/pullrequests/${id}`;

  return {
    path,
    requestChanges: () => api("POST", `${path}/request-changes`),
    clearChanges: () => api("DELETE", `${path}/request-changes`),
    build: (key: string, state: "FAILED" | "INPROGRESS" | "SUCCESSFUL") =>
      api("POST", `${repo}/commit/${source.commit.hash}/statuses/build`, { key, state, url: "https://example.com" }),
    async comments() {
      const { values } = await api("GET", `${path}/comments?pagelen=100`);
      return values.filter((c: any) => !c.deleted).map((c: any) => ({ id: c.id, text: c.content.raw }));
    },
    // Without the uuid of the actor, otherwise Atlantis would ignore its own comments.
    async webhook(comment?: string) {
      const pullrequest = await api("GET", path);
      const body = JSON.stringify({
        actor: { account_id: "harness" }, repository: pullrequest.destination.repository, pullrequest,
        comment: { content: { raw: comment ?? "" } },
      });
      return {
        headers: {
          "X-Event-Key": comment ? "pullrequest:comment_created" : "pullrequest:created",
          "X-Request-UUID": "harness",
          "X-Hub-Signature": `sha256=${new Bun.CryptoHasher("sha256", secret).update(body).digest("hex")}`,
        },
        body,
      };
    },
  } satisfies PullRequest & Record<string, unknown>;
}
