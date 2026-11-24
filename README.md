# atlantis-test-harness

Some bash scripts I use to test [Atlantis](https://www.runatlantis.io) against a real VCS, since mocks only get you so far. Not affiliated with the Atlantis project.

It starts Atlantis, opens pull requests, runs `plan` and `apply` on them for real (with `terraform_data`, so no cloud is needed), and checks what Atlantis replies.

Only Bitbucket Cloud for now, and only what I needed for [runatlantis/atlantis#7130](https://github.com/runatlantis/atlantis/pull/7130).

## Running

You need `bash`, `curl`, `git`, `jq`, `openssl`, `terraform`, and Atlantis itself.

```sh
cp .env.example .env # and fill it
./run.sh bitbucket # or ./run.sh bitbucket clean draft
```

To test a build of yours, use `ATLANTIS=/path/to/atlantis ./run.sh bitbucket`. It takes about a minute per test, mostly to not hit rate limits.

## Good to know

- **Use a throwaway repository.** It creates branches, pull requests and branch restrictions. They are all for a `harness-<timestamp>` base branch, which is removed at the end. The pull requests are declined, or stay merged.
- Merge checks are only enforced on Bitbucket Premium. A trial is enough.
- Webhooks are replayed locally instead of being delivered by Bitbucket, so there is no need to expose Atlantis to the internet.
- If it gets killed, look for leftover `harness-*` branches and restrictions.

## Adding tests

Add a `test_something` function to `bitbucket/tests.sh`. For another VCS, create `<vcs>/vcs.sh` and `<vcs>/tests.sh`, using Bitbucket's as a reference.
