import { afterAll, beforeAll, expect, setDefaultTimeout, test } from "bun:test";
import { failApply, newDataDir, waitFor } from "./atlantis";
import { api, changeBase, createWebhook, openPR, repo, requireBuilds, restrict, setup, start, teardown } from "./bitbucket";
import { openTunnel } from "./tunnel";

setDefaultTimeout(5 * 60_000);

let enforced: Awaited<ReturnType<typeof restrict>>;

beforeAll(async () => {
  await setup();
  enforced = await restrict("enforce_merge_checks");
});
afterAll(teardown);

const applied = "Apply complete!";
const blockedBy = (reason: string) => `Blocked by ${reason})`;
const mergeQueue = process.env.BB_MERGE_QUEUE;
const withMergeQueue = test.skipIf(!mergeQueue);
const withSecondAccount = test.skipIf(!process.env.BB2_TOKEN);

/** Otherwise they would conflict, and Bitbucket would remove them from the queue. */
const emptyMergeQueue = () =>
  waitFor("the merge queue to be empty", async () => {
    await Bun.sleep(5000);
    const { values } = await api("GET", `${repo}/merge-queues`);
    return values.find((q: any) => q.target_branch.name === mergeQueue).queue_size === 0;
  });

const merged = (pr: Awaited<ReturnType<typeof openPR>>) =>
  waitFor("the merge", async () => {
    await Bun.sleep(5000);
    return (await pr.state()) === "MERGED";
  });

/** Requests changes, which should block the apply until they are cleared. */
async function changesRequested(flags: string[] = [], options?: Parameters<typeof start>[1]) {
  await using atlantis = await start(flags, options);
  const pr = await openPR(["p1"]);
  await atlantis.plan(pr);
  await pr.requestChanges();
  expect(await atlantis.apply(pr)).toContain(blockedBy("no_changes_requested"));
  await pr.clearChanges();
  expect(await atlantis.apply(pr)).toContain(applied);
  return pr;
}

test("clean", async () => {
  await using atlantis = await start();
  const pr = await openPR(["p1"]);
  await atlantis.plan(pr);
  expect(await atlantis.apply(pr)).toContain(applied);
});

test("draft", async () => {
  await using atlantis = await start();
  const pr = await openPR(["p1"], { draft: true });
  await atlantis.plan(pr);
  expect(await atlantis.apply(pr)).toContain(blockedBy("DRAFT"));
});

test("conflict", async () => {
  await using atlantis = await start();
  const pr = await openPR(["p1"]);
  await changeBase("p1");
  await atlantis.plan(pr);
  expect(await atlantis.apply(pr)).toContain(blockedBy("conflicts"));
});

test("changes requested", async () => {
  await changesRequested();
});

withSecondAccount("changes requested, with an account that can't merge", async () => {
  await changesRequested([], { as: "second" });
});

test("changes requested, with automerge", async () => {
  const pr = await changesRequested(["--automerge"]);
  expect(await pr.state()).toBe("MERGED");
});

test("changes requested, with the longest status name", async () => {
  await changesRequested([`--vcs-status-name=${"a".repeat(35)}`]);
});

test("too long status name", async () => {
  const started = start([`--vcs-status-name=${"a".repeat(36)}`]).then((atlantis) => atlantis[Symbol.asyncDispose]());
  await expect(started).rejects.toThrow("cannot be longer than 35 characters");
});

test("two servers", async () => {
  const servers = [["one", "two", newDataDir()], ["two", "one", newDataDir()]];
  const onEach = async (run: (atlantis: Awaited<ReturnType<typeof start>>) => Promise<unknown>) => {
    for (const [name, other, dataDir] of servers) {
      await using atlantis = await start([`--vcs-status-name=${name}`, `--ignore-vcs-status-names=${other}`], { dataDir });
      await run(atlantis);
    }
  };
  const pr = await openPR(["p1"]);
  await onEach((atlantis) => atlantis.plan(pr));
  await pr.requestChanges();
  await onEach(async (atlantis) => expect(await atlantis.apply(pr)).toContain(blockedBy("no_changes_requested")));
  await pr.clearChanges();
  await onEach(async (atlantis) => expect(await atlantis.apply(pr)).toContain(applied));
});

test("unresolved task", async () => {
  await using atlantis = await start();
  const pr = await openPR(["p1"]);
  await atlantis.plan(pr);
  const task = await api("POST", `${pr.path}/tasks`, { content: { raw: "Do it" } });
  expect(await atlantis.apply(pr)).toContain(blockedBy("resolved_tasks"));
  await api("PUT", `${pr.path}/tasks/${task.id}`, { state: "RESOLVED" });
  expect(await atlantis.apply(pr)).toContain(applied);
});

withSecondAccount("approvals", async () => {
  const { uuid } = await api("GET", "user", undefined, "second");
  const reviewer = `${repo}/default-reviewers/${encodeURIComponent(uuid)}`;
  await using stack = new AsyncDisposableStack();
  await api("PUT", reviewer, undefined, "admin");
  stack.defer(() => api("DELETE", reviewer, undefined, "admin"));
  stack.use(await restrict("require_approvals_to_merge", 1));
  stack.use(await restrict("require_default_reviewer_approvals_to_merge", 1));

  await using atlantis = await start();
  const pr = await openPR(["p1"]);
  await atlantis.plan(pr);
  expect(await atlantis.apply(pr)).toContain(blockedBy("minimum_approvals, minimum_default_reviewer_approvals"));
  await api("POST", `${pr.path}/approve`, undefined, "second");
  expect(await atlantis.apply(pr)).toContain(applied);
});

test("commits behind", async () => {
  await using behind = await restrict("require_commits_behind", 0);
  await using atlantis = await start();
  const pr = await openPR(["p1"]);
  await changeBase("p2");
  await atlantis.plan(pr);
  expect(await atlantis.apply(pr)).toContain(blockedBy("maximum_commits_behind"));
  await pr.update();
  await atlantis.plan(pr);
  expect(await atlantis.apply(pr)).toContain(applied);
});

test("other build", async () => {
  await using atlantis = await start();
  const pr = await openPR(["p1"]);
  await atlantis.plan(pr);
  await pr.build("ci", "FAILED");
  expect(await atlantis.apply(pr)).toContain(blockedBy("failed_builds"));
  await pr.build("ci", "INPROGRESS");
  expect(await atlantis.apply(pr)).toContain(blockedBy("failed_builds, in_progress_builds"));
  await pr.build("ci", "SUCCESSFUL");
  expect(await atlantis.apply(pr)).toContain(applied);
});

test("missing build", async () => {
  await using stack = new AsyncDisposableStack();
  stack.defer(() => requireBuilds(1));
  await requireBuilds(3); // two are from the plan
  await using atlantis = await start();
  const pr = await openPR(["p1"]);
  await atlantis.plan(pr);
  expect(await atlantis.apply(pr)).toContain("minimum_successful_builds");
  expect(await atlantis.apply(pr)).toContain("minimum_successful_builds");
  await pr.build("ci", "SUCCESSFUL");
  expect(await atlantis.apply(pr)).toContain(applied);
});

test("own failed plan", async () => {
  await using atlantis = await start();
  const pr = await openPR(["p1"]);
  await atlantis.plan(pr);
  await pr.build("atlantis/plan", "FAILED");
  expect(await atlantis.apply(pr)).toContain(blockedBy("failed_builds"));
});

test("partial apply", async () => {
  await using atlantis = await start();
  const pr = await openPR(["p1", "p2"]);
  await atlantis.plan(pr);
  expect(await atlantis.apply(pr, "p1")).toContain(applied);
  expect(await atlantis.apply(pr, "p2")).toContain(applied);
});

test("failed apply", async () => {
  await using atlantis = await start();
  const pr = await openPR(["p1"]);
  await atlantis.plan(pr);
  await failApply.write("");
  expect(await atlantis.apply(pr)).toContain("local-exec provisioner error");
  await failApply.delete();
  await atlantis.plan(pr);
  expect(await atlantis.apply(pr)).toContain(applied);
});

withSecondAccount("real webhooks", async () => {
  await using tunnel = await openTunnel();
  await using webhook = await createWebhook(tunnel.url);
  await using atlantis = await start();
  const pr = await openPR(["p1"]);
  const replied = (what: string, text: string) =>
    waitFor(what, async () => {
      await Bun.sleep(2000);
      return (await pr.comments()).some((c) => c.text.includes(text));
    });
  await replied("the plan", "Ran Plan for");
  await pr.requestChanges();
  await pr.comment("atlantis apply", "second");
  await replied("the rejection", blockedBy("no_changes_requested"));
  await pr.clearChanges();
  await pr.comment("atlantis apply", "second");
  await replied("the apply", applied);
});

withMergeQueue("merge queue, with automerge", async () => {
  await using atlantis = await start(["--automerge"]);
  await emptyMergeQueue();
  const pr = await openPR(["p1"], { destination: mergeQueue });
  await atlantis.plan(pr);
  const reply = await atlantis.apply(pr);
  expect(reply).toContain(applied);
  expect(reply).not.toContain("Automerging failed");
  expect(await pr.state()).not.toBe("MERGED"); // it's only queued
  await merged(pr);
});

withMergeQueue("already in the merge queue", async () => {
  await using atlantis = await start();
  await emptyMergeQueue();
  const pr = await openPR(["p1"], { destination: mergeQueue });
  await atlantis.plan(pr);
  await api("POST", `${pr.path}/merge`);
  expect(await atlantis.apply(pr)).toContain(blockedBy("pullrequest_state_check"));
  await merged(pr);
});

// The last one, since it changes the restrictions.
test("not enforced", async () => {
  await enforced[Symbol.asyncDispose]();
  await using atlantis = await start();
  const pr = await openPR(["p1"]);
  await atlantis.plan(pr);
  await pr.requestChanges();
  await pr.build("ci", "FAILED");
  expect(await atlantis.apply(pr)).toContain(applied);
});
