import { afterAll, expect, setDefaultTimeout } from "bun:test";
import { applied, waitFor } from "../atlantis";
import { api, blockedBy, mergeQueue, openPR, repo, start, teardown, withMergeQueue } from "./client";

setDefaultTimeout(5 * 60_000);

afterAll(teardown);

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

withMergeQueue("automerge", async () => {
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

withMergeQueue("already in it", async () => {
  await using atlantis = await start();
  await emptyMergeQueue();
  const pr = await openPR(["p1"], { destination: mergeQueue });
  await atlantis.plan(pr);
  await api("POST", `${pr.path}/merge`);
  expect(await atlantis.apply(pr)).toContain(blockedBy("QUEUED"));
  await merged(pr);
});
