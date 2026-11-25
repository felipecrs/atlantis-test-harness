// Delivered by Bitbucket Cloud, instead of being replayed like in the other tests.
import { afterAll, beforeAll, setDefaultTimeout } from "bun:test";
import { applied, waitFor } from "../atlantis";
import { openTunnel } from "../tunnel";
import {
  blockedBy, createWebhook, enforceMergeChecks, openPR, restrict, setup, start, teardown, withSecondAccount,
} from "./client";

setDefaultTimeout(5 * 60_000);

beforeAll(async () => {
  await setup();
  await restrict("require_no_changes_requested");
  await enforceMergeChecks();
});
afterAll(teardown);

withSecondAccount("plan and apply", async () => {
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
