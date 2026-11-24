// Runs Atlantis, and commands in it. Nothing in here is specific to a VCS.
import { closeSync, mkdtempSync, openSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { $ } from "bun";

const url = `http://localhost:${process.env.PORT ?? 4141}`;
const work = mkdtempSync(join(tmpdir(), "atlantis-"));
process.on("exit", () => rmSync(work, { recursive: true, force: true }));

export const secret = crypto.randomUUID();
/** Applies fail while this file exists. */
export const failApply = Bun.file(join(work, "fail-apply"));

export interface PullRequest {
  comments(): Promise<{ id: number; text: string }[]>;
  /** The webhook for a comment, or for when the pull request is opened. */
  webhook(comment?: string): Promise<{ headers: Record<string, string>; body: string }>;
}

async function waitFor(what: string, condition: () => Promise<boolean>) {
  for (let i = 0; i < 120; i++) {
    if (await condition()) return;
    await Bun.sleep(500);
  }
  throw new Error(`timed out waiting for ${what}`);
}

const healthy = () => fetch(`${url}/healthz`).then((r) => r.ok, () => false);

export const newDataDir = () => mkdtempSync(join(work, "data-"));

/** Stops when it goes out of scope, if declared with `await using`. */
export async function startAtlantis(env: Record<string, string>, flags: string[] = [], dataDir = newDataDir()) {
  if (await healthy()) throw new Error(`there is something running at ${url} already`);
  const { terraform_version } = await $`terraform version -json`.json();
  const log = join(work, "atlantis.log");
  const fd = openSync(log, "w");
  const server = Bun.spawn(
    [
      process.env.ATLANTIS ?? "atlantis", "server", `--port=${new URL(url).port}`, `--atlantis-url=${url}`,
      `--data-dir=${dataDir}`, `--repo-config=${import.meta.dir}/repos.yaml`,
      `--default-tf-version=${terraform_version}`, "--tf-download=false", ...flags,
    ],
    { env: { ...process.env, ...env, FAIL_APPLY: failApply.name }, stdout: fd, stderr: fd },
  );
  closeSync(fd);
  const stop = async () => {
    server.kill();
    await server.exited;
  };
  try {
    await waitFor("atlantis", async () => {
      if (server.exitCode !== null) throw new Error(await Bun.file(log).text());
      return healthy();
    });
  } catch (e) {
    await stop();
    throw e;
  }

  /** Returns what Atlantis replied. */
  async function run(pr: PullRequest, comment?: string) {
    const seen = new Set((await pr.comments()).map((c) => c.id));
    await Bun.sleep(5000); // to not hit rate limits
    const response = await fetch(`${url}/events`, { method: "POST", ...(await pr.webhook(comment)) });
    if (!response.ok) throw new Error(await response.text());
    await Bun.sleep(3000); // it's handled in the background
    await waitFor("the command", async () => {
      const status = (await (await fetch(`${url}/status`)).json()) as { in_progress_operations: number };
      return status.in_progress_operations === 0;
    });
    return (await pr.comments()).filter((c) => !seen.has(c.id)).map((c) => c.text).join("\n");
  }

  return {
    plan: (pr: PullRequest) => run(pr),
    apply: (pr: PullRequest, project?: string) => run(pr, `atlantis apply${project ? ` -p ${project}` : ""}`),
    [Symbol.asyncDispose]: stop,
  };
}
