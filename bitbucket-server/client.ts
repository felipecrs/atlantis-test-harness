// Bitbucket Server, also known as Data Center. It runs in a container, and every
// pull request gets its own repository.
import { GenericContainer, Wait, type StartedTestContainer } from "testcontainers";
import { secret, startAtlantis, url as atlantisUrl, type PullRequest } from "../atlantis";

const image = process.env.BITBUCKET_SERVER_IMAGE ?? "atlassian/bitbucket:10.2";
// Expires 3 hours after Bitbucket starts. It's the one Atlassian publishes for testing:
// https://developer.atlassian.com/platform/marketplace/timebomb-licenses-for-testing-server-apps/
const license = "AAABrQ0ODAoPeNp9kVFvmzAQx9/9KSztLZIJZIu0RkJqA6yNViAK0G3d+uDApXgjNrKPbPn2dYG0a6fuwS8+393v//O7vAMa8yN1PerOFrPZYn5GL+OczlzvI0m6/RZ0uisMaON7LgmURF5iwvfgVy3XWpj6nGPDjRFcOqXaE4Pc1M61KEEayI8t9I+DNI6jTbC6uP73wd/FdafLmhsIOYL/yMDcOXM98p95Yyn60wp97PvW769OpFHMRfMWagb6AHoV+svLs5x9LW4+sM+3t1ds6XpfRkw7jwcgEbSPugOSdVtTatGiUHK4mUwmSZqzT+mGrTdpWAT5Kk1YkUW24AcaLFBFt0eKNdARlUayVBVo2mr1E0qk32vE9sdiOr1XzgvEaTN0MBg67hwaKioV0koY1GLbIdjJwlBUtOwMqr39KYfY1JZZclm+9jLEsmbEAZ4CBJvoIo9Ctvz2CP2GrRHe6irkL6l+S5JFiW8Pm7suSfU9l8LwXkwIB2hUaxPmYPAUm/Q2bP315w5MGXL95DmEZ839jFEE3SlNedvS6rTCkOjAm25YvOON3fMAVTj4nTAtAhRH4o+fI5MQ7xSh2mtA1bPJrq0WAgIVAIGperR8m2N0fl/GfUUJfQnd+T1aX02kk";
type User = "admin" | "atlantis" | "reviewer";

let container: StartedTestContainer;
let url: string;
let token: string;

async function api(method: string, path: string, body?: object, as: User = "admin"): Promise<any> {
  const form = body instanceof FormData;
  const response = await fetch(`${url}/rest/${path}`, {
    method,
    // The passwords are the same as the names.
    headers: {
      Authorization: `Basic ${btoa(`${as}:${as}`)}`,
      "X-Atlassian-Token": "no-check", // needed by old versions
      ...(body && !form && { "Content-Type": "application/json" }),
    },
    body: form ? body : body && JSON.stringify(body),
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`${method} ${path}: ${response.status} ${text}`);
  return text && JSON.parse(text);
}

export async function setup() {
  container = await new GenericContainer(image)
    .withExposedPorts(7990)
    .withExtraHosts([{ host: "host.docker.internal", ipAddress: "host-gateway" }])
    .withEnvironment({
      SETUP_LICENSE: license,
      SETUP_BASEURL: "http://localhost:7990",
      SETUP_DISPLAYNAME: "harness",
      SETUP_SYSADMIN_USERNAME: "admin",
      SETUP_SYSADMIN_PASSWORD: "admin",
      SETUP_SYSADMIN_DISPLAYNAME: "admin",
      SETUP_SYSADMIN_EMAILADDRESS: "admin@example.com",
      SEARCH_ENABLED: "false",
      // Disabled by default since version 10. Atlantis uses a token, this is for us.
      JVM_SUPPORT_RECOMMENDED_ARGS: "-Dcom.atlassian.plugins.authentication.basic.auth.filter.force.allow=true",
    })
    .withWaitStrategy(Wait.forHttp("/status", 7990).forResponsePredicate((body) => body.includes("RUNNING")))
    .withStartupTimeout(5 * 60_000)
    .start();
  url = `http://localhost:${container.getMappedPort(7990)}`;

  await api("POST", "api/1.0/projects", { key: "H", name: "harness" });
  for (const name of ["atlantis", "reviewer"]) {
    const query = new URLSearchParams({ name, password: name, displayName: name, emailAddress: `${name}@example.com` });
    await api("POST", `api/1.0/admin/users?${query}`);
    await api("PUT", `api/1.0/projects/H/permissions/users?name=${name}&permission=PROJECT_WRITE`);
  }
  ({ token } = await api("PUT", "access-tokens/1.0/users/atlantis", { name: "harness", permissions: ["REPO_WRITE"] }, "atlantis"));
}

export const teardown = () => container?.stop();

export const start = (flags: string[] = []) =>
  startAtlantis(
    {
      ATLANTIS_BITBUCKET_BASE_URL: url,
      ATLANTIS_BITBUCKET_USER: "atlantis",
      ATLANTIS_BITBUCKET_TOKEN: token,
      ATLANTIS_BITBUCKET_WEBHOOK_SECRET: secret,
      ATLANTIS_REPO_ALLOWLIST: "*",
    },
    flags,
  );

/** Merge checks are repository settings, so they go in here. */
export async function openPR({ settings = {}, draft = false, events = ["pr:comment:added"] } = {}) {
  const name = crypto.randomUUID();
  const repo = `api/1.0/projects/H/repos/${name}`;
  await api("POST", "api/1.0/projects/H/repos", { name, defaultBranch: "main" });
  await api("POST", `${repo}/settings/pull-requests`, settings);
  await api("POST", `${repo}/webhooks`, {
    name: "atlantis", active: true, events, configuration: { secret },
    url: `http://host.docker.internal:${new URL(atlantisUrl).port}/events`,
  });

  const terraform = await Bun.file(`${import.meta.dir}/../terraform/main.tf`).text();
  async function commit(branch: string, file: string, content: string, options: Record<string, string> = {}) {
    const form = new FormData();
    for (const [key, value] of Object.entries({ branch, content, message: "Change", ...options })) form.append(key, value);
    return (await api("PUT", `${repo}/browse/${file}`, form)).id as string;
  }
  const change = (branch: string, sourceCommitId: string, options = {}) =>
    commit(branch, "p1/main.tf", terraform.replace("base", crypto.randomUUID()), { sourceCommitId, ...options });

  await commit("main", "atlantis.yaml", await Bun.file(`${import.meta.dir}/../terraform/atlantis.yaml`).text());
  await commit("main", "p2/main.tf", terraform);
  const base = await commit("main", "p1/main.tf", terraform);
  const head = await change("change", base, { sourceBranch: "main" });
  const ref = (branch: string) => ({ id: `refs/heads/${branch}`, repository: { slug: name, project: { key: "H" } } });
  const { id } = await api("POST", `${repo}/pull-requests`, {
    title: "Change", draft, fromRef: ref("change"), toRef: ref("main"), reviewers: [{ user: { name: "reviewer" } }],
  });
  const path = `${repo}/pull-requests/${id}`;
  const comment = (text: string, severity = "NORMAL") => api("POST", `${path}/comments`, { text, severity });

  return {
    /** Makes it conflict with the base branch. */
    conflict: () => change("main", base),
    review: (status: "APPROVED" | "NEEDS_WORK" | "UNAPPROVED") =>
      api("PUT", `${path}/participants/reviewer`, { status }, "reviewer"),
    createTask: async () => {
      const { id, version } = await comment("Do it", "BLOCKER");
      return { resolve: () => api("PUT", `${path}/comments/${id}`, { version, state: "RESOLVED" }) };
    },
    build: (key: string, state: "FAILED" | "INPROGRESS" | "SUCCESSFUL") =>
      api("POST", `build-status/1.0/commits/${head}`, { key, state, url: "https://example.com" }),
    state: async () => (await api("GET", path)).state as string,
    /** Only the ones from Atlantis. */
    async comments() {
      const { values } = await api("GET", `${path}/activities?limit=100`);
      return values
        .filter((a: any) => a.action === "COMMENTED" && a.user.name === "atlantis")
        .map((a: any) => ({ id: a.comment.id, text: a.comment.text }));
    },
    // This one is not replayed, Bitbucket delivers it.
    send: (command: string) => comment(command),
  } satisfies PullRequest & Record<string, unknown>;
}
