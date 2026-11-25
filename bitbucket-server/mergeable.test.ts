import { afterAll, beforeAll, expect, setDefaultTimeout, test } from "bun:test";
import { applied, failApply, waitFor } from "../atlantis";
import { openPR, setup, start, teardown } from "./client";

setDefaultTimeout(5 * 60_000);

beforeAll(setup);
afterAll(teardown);

const builds = "Not all required builds are successful yet";
const rejected = (reason: string) => `Pull request must be mergeable before running apply (${reason}).`;

test("clean", async () => {
  await using atlantis = await start();
  const pr = await openPR();
  await atlantis.plan(pr);
  expect(await atlantis.apply(pr)).toContain(applied);
});

test("plans when opened", async () => {
  await using atlantis = await start();
  const pr = await openPR({ events: ["pr:opened"] });
  await waitFor("the plan", async () => (await pr.comments()).some((c) => c.text.includes("Ran Plan for")));
});

test("draft", async () => {
  await using atlantis = await start();
  const pr = await openPR({ draft: true });
  await atlantis.plan(pr);
  expect(await atlantis.apply(pr)).toContain(rejected("Is a draft"));
});

test("conflict", async () => {
  await using atlantis = await start();
  const pr = await openPR();
  await atlantis.plan(pr);
  await pr.conflict();
  expect(await atlantis.apply(pr)).toContain(rejected("Has conflicts"));
});

test("changes requested", async () => {
  await using atlantis = await start();
  const pr = await openPR({ settings: { needsWork: true } });
  await atlantis.plan(pr);
  await pr.review("NEEDS_WORK");
  expect(await atlantis.apply(pr)).toContain(rejected("Some reviewers have requested changes"));
  await pr.review("UNAPPROVED");
  expect(await atlantis.apply(pr)).toContain(applied);
});

test("approvals and unresolved task, with automerge", async () => {
  await using atlantis = await start(["--automerge"]);
  const pr = await openPR({ settings: { requiredApprovers: 1, requiredAllTasksComplete: true } });
  await atlantis.plan(pr);
  const task = await pr.createTask();
  const rejection = await atlantis.apply(pr);
  expect(rejection).toContain("Requires approvals");
  expect(rejection).toContain("Requires all tasks to be resolved");
  await task.resolve();
  expect(await atlantis.apply(pr)).toContain(rejected("Requires approvals"));
  await pr.review("APPROVED");
  expect(await atlantis.apply(pr)).toContain(applied);
  expect(await pr.state()).toBe("MERGED");
});

test("other build", async () => {
  await using atlantis = await start();
  const pr = await openPR({ settings: { requiredSuccessfulBuilds: 1 } });
  await atlantis.plan(pr);
  await pr.build("ci", "FAILED");
  expect(await atlantis.apply(pr)).toContain(rejected(builds));
  await pr.build("ci", "INPROGRESS");
  expect(await atlantis.apply(pr)).toContain(rejected(builds));
  await pr.build("ci", "SUCCESSFUL");
  expect(await atlantis.apply(pr)).toContain(applied);
});

test("missing build", async () => {
  await using atlantis = await start();
  const pr = await openPR({ settings: { requiredSuccessfulBuilds: 4 } }); // three are from the plan
  await atlantis.plan(pr);
  expect(await atlantis.apply(pr)).toContain(rejected(builds));
  // Now that there is a failed apply, Bitbucket doesn't say that one is missing.
  expect(await atlantis.apply(pr)).toContain(rejected(builds));
  await pr.build("ci", "SUCCESSFUL");
  expect(await atlantis.apply(pr)).toContain(applied);
});

test("changes requested, with builds enforced", async () => {
  await using atlantis = await start();
  const pr = await openPR({ settings: { needsWork: true, requiredSuccessfulBuilds: 1 } });
  await atlantis.plan(pr);
  await pr.review("NEEDS_WORK");
  expect(await atlantis.apply(pr)).toContain(rejected("Some reviewers have requested changes"));
  await pr.review("UNAPPROVED");
  expect(await atlantis.apply(pr)).toContain(applied);
});

test("failed apply, with builds enforced", async () => {
  await using atlantis = await start();
  const pr = await openPR({ settings: { requiredSuccessfulBuilds: 1 } });
  await atlantis.plan(pr);
  await failApply.write("");
  expect(await atlantis.apply(pr)).toContain("local-exec provisioner error");
  await failApply.delete();
  await atlantis.plan(pr);
  expect(await atlantis.apply(pr)).toContain(applied);
});

test("not enforced", async () => {
  await using atlantis = await start();
  const pr = await openPR();
  await atlantis.plan(pr);
  await pr.review("NEEDS_WORK");
  await pr.build("ci", "FAILED");
  expect(await atlantis.apply(pr)).toContain(applied);
});
