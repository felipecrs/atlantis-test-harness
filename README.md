# atlantis-test-harness

Some tests I use to try [Atlantis](https://www.runatlantis.io) against a real VCS, since mocks only get you so far. Not affiliated with the Atlantis project.

They start Atlantis, open pull requests, plan and apply them for real (with `terraform_data`, so no cloud is needed), and check what Atlantis replies.

| Tests | What they cover | What they need from Atlantis |
| --- | --- | --- |
| [`bitbucket-cloud/mergeable`](bitbucket-cloud/mergeable.test.ts) | The `mergeable` requirement | [#7130](https://github.com/runatlantis/atlantis/pull/7130) |
| [`bitbucket-cloud/merge-queue`](bitbucket-cloud/merge-queue.test.ts) | Merge queues | [#7130](https://github.com/runatlantis/atlantis/pull/7130) |
| [`bitbucket-cloud/stopped-builds`](bitbucket-cloud/stopped-builds.test.ts) | Builds that were cancelled | A change on top of #7130, no pull request yet |
| [`bitbucket-cloud/webhooks`](bitbucket-cloud/webhooks.test.ts) | Webhooks, delivered for real | [#7130](https://github.com/runatlantis/atlantis/pull/7130) |
| [`bitbucket-server/mergeable`](bitbucket-server/mergeable.test.ts) | The `mergeable` requirement | [#7130](https://github.com/runatlantis/atlantis/pull/7130) |

Bitbucket Cloud and Bitbucket Server (Data Center) are different products, with different APIs and merge checks. So nothing is shared between their tests. See [bitbucket-cloud](bitbucket-cloud/README.md) and [bitbucket-server](bitbucket-server/README.md) for what each of them needs.

## Running

You need [mise](https://mise.jdx.dev), which installs Bun, Terraform and cloudflared, and Atlantis itself.

```sh
cp .env.example .env # and fill it, only needed for Bitbucket Cloud
mise run test # everything
mise run test bitbucket-server # only one of the folders
mise run test bitbucket-cloud/stopped-builds # only one of the files
mise run test bitbucket-cloud/mergeable -t draft # only some tests
ATLANTIS=/path/to/atlantis mise run test # a build of yours
```

Tests say what Atlantis should do, so they fail in builds that don't have the change they are for.

## Adding tests

- For something else in the same VCS, add a `<feature>.test.ts` next to the others. `setup()` doesn't configure anything in the VCS, so each file starts with what it needs.
- For another VCS, create a folder with a `client.ts`, using the existing ones as a reference. `atlantis.ts` doesn't know about any VCS.
- `start()` takes flags for Atlantis, and they win over the default ones. For example, use `--repo-config` if [repos.yaml](repos.yaml) is not what you need.
