# atlantis-test-harness

Some tests I use to try [Atlantis](https://www.runatlantis.io) against a real VCS, since mocks only get you so far. Not affiliated with the Atlantis project.

They start Atlantis, open pull requests, plan and apply them for real (with `terraform_data`, so no cloud is needed), and check what Atlantis replies.

Only Bitbucket Cloud for now, and only what I needed for [runatlantis/atlantis#7130](https://github.com/runatlantis/atlantis/pull/7130).

## Running

You need [mise](https://mise.jdx.dev), which installs Bun and Terraform, and Atlantis itself.

```sh
cp .env.example .env # and fill it
mise run test
mise run test -t draft # only some tests
ATLANTIS=/path/to/atlantis mise run test # a build of yours
```

It takes less than a minute per test, mostly to not hit rate limits.

## Good to know

- **Use a throwaway repository.** It creates branches, pull requests and branch restrictions, all for a `harness-<timestamp>` base branch. Anything named `harness-*` is removed at the end, including what was left from runs that were killed. The pull requests are declined, or stay merged.
- Merge checks are only enforced on Bitbucket Premium. A trial is enough.
- Webhooks are replayed locally instead of being delivered by Bitbucket, so there is no need to expose Atlantis to the internet.
- Don't run it twice at the same time.

## Adding tests

Add them to `bitbucket.test.ts`. For another VCS, create `<vcs>.ts` and `<vcs>.test.ts`, using Bitbucket's as a reference. `atlantis.ts` doesn't know about any VCS.
