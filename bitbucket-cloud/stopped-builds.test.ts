// Bitbucket Cloud ignores stopped builds in its merge checks, but Atlantis should
// not: https://jira.atlassian.com/browse/BCLOUD-23389
import { afterAll, beforeAll, expect, setDefaultTimeout, test } from "bun:test";
import { applied, failApply } from "../atlantis";
import { blockedBy, enforceMergeChecks, openPR, requireBuilds, setup, start, teardown } from "./client";

setDefaultTimeout(5 * 60_000);

let enforced: Awaited<ReturnType<typeof enforceMergeChecks>>;

beforeAll(async () => {
  await setup();
  await requireBuilds(1);
  enforced = await enforceMergeChecks();
});
afterAll(teardown);

test("stopped, then passed", async () => {
  await using atlantis = await start();
  const pr = await openPR(["p1"]);
  await atlantis.plan(pr);
  await pr.build("ci", "STOPPED");
  expect(await atlantis.apply(pr)).toContain(blockedBy("stopped_builds"));
  await pr.build("ci", "SUCCESSFUL");
  expect(await atlantis.apply(pr)).toContain(applied);
});

test("stopped after a failed apply, then passed", async () => {
  await using atlantis = await start();
  const pr = await openPR(["p1"]);
  await atlantis.plan(pr);
  await failApply.write("");
  expect(await atlantis.apply(pr)).toContain("local-exec provisioner error");
  await failApply.delete();
  await atlantis.plan(pr);
  await pr.build("ci", "STOPPED");
  expect(await atlantis.apply(pr)).toContain(blockedBy("failed_builds"));
  await pr.build("ci", "SUCCESSFUL");
  expect(await atlantis.apply(pr)).toContain(applied);
});

// The last one, since it changes the restrictions.
test("not enforced", async () => {
  await enforced[Symbol.asyncDispose]();
  await using atlantis = await start();
  const pr = await openPR(["p1"]);
  await atlantis.plan(pr);
  await pr.build("ci", "STOPPED");
  expect(await atlantis.apply(pr)).toContain(applied);
});
