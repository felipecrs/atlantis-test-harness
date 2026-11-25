# atlantis-test-harness

Some tests I use to try [Atlantis](https://www.runatlantis.io) against a real VCS, since mocks only get you so far. Not affiliated with the Atlantis project.

They start Atlantis, open pull requests, plan and apply them for real (with `terraform_data`, so no cloud is needed), and check what Atlantis replies.

Only Bitbucket Cloud and Bitbucket Server (Data Center) for now, and only what I needed for [runatlantis/atlantis#7130](https://github.com/runatlantis/atlantis/pull/7130).

## Running

You need [mise](https://mise.jdx.dev), which installs Bun, Terraform and cloudflared, and Atlantis itself. And Docker for Bitbucket Server, which runs with [Testcontainers](https://node.testcontainers.org/).

```sh
cp .env.example .env # and fill it, only needed for Bitbucket Cloud
mise run test
mise run test bitbucket-server # or bitbucket.test for Cloud
mise run test -t draft # only some tests
ATLANTIS=/path/to/atlantis mise run test # a build of yours
```

It takes less than a minute per test on Cloud, mostly to not hit rate limits. On Server it takes around 10 seconds, plus a minute to start it.

## Good to know

### Bitbucket Cloud

- See [bitbucket.md](bitbucket.md) for how to set it up from scratch.
- **Use a throwaway repository.** It creates branches, pull requests and branch restrictions, all for a `harness-<timestamp>` base branch. Anything named `harness-*` is removed at the end, including what was left from runs that were killed. The pull requests are declined, or stay merged.
- Merge checks are only enforced on Bitbucket Premium. A trial is enough.
- Webhooks are replayed locally instead of being delivered by Bitbucket. Except for one test, which exposes only `/events` with a [quick tunnel](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/do-more-with-tunnels/trycloudflare/) while it runs.
- Commits have `[skip ci]`, so that Pipelines doesn't run.
- Some tests need a second account or a merge queue, and are skipped otherwise.
- Don't run it twice at the same time.

### Bitbucket Server

- It starts from scratch every time, so there is nothing to set up. Use `BBS_IMAGE` to try another version, e.g. `atlassian/bitbucket:9.4`.
- Webhooks are real, since the container can reach Atlantis. It needs to listen on all interfaces for that, which is what it does by default.
- Drafts are a known issue, so that test is expected to fail. Bun tells when it stops failing.
- The license is the one Atlassian publishes for testing. It lasts for 3 hours.
- It needs around 3 GB of memory.

## Adding tests

Add them to `bitbucket.test.ts`. For another VCS, create `<vcs>.ts` and `<vcs>.test.ts`, using the existing ones as a reference. `atlantis.ts` doesn't know about any VCS.
