# Bitbucket Cloud

## Good to know

- **Use a throwaway repository.** It creates branches, pull requests and branch restrictions, all for a `harness-<timestamp>` base branch. Anything named `harness-*` is removed at the end, including what was left from runs that were killed. The pull requests are declined, or stay merged.
- Merge checks are only enforced on Bitbucket Premium. A trial is enough.
- Webhooks are replayed locally instead of being delivered by Bitbucket Cloud. Except in `webhooks.test.ts`, which exposes only `/events` with a [quick tunnel](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/do-more-with-tunnels/trycloudflare/) while it runs.
- Commits have `[skip ci]`, so that Pipelines doesn't run.
- Some tests need a second account or a merge queue, and are skipped otherwise.
- Don't run it twice at the same time.
- It takes less than a minute per test, mostly to not hit rate limits.

## Setting it up

Everything that has to be done by hand, from scratch. It takes around 30 minutes. The tests create and remove everything else by themselves (branches, pull requests, branch restrictions, webhooks).

### 1. Repository

1. Use a workspace that you own, and start a Premium trial in **Workspace settings → Plans and billing**. Merge checks are not enforced without it.
2. Create a private repository just for this, with a `main` branch (including a README is enough).

### 2. Tokens

Create them in <https://id.atlassian.com/manage-profile/security/api-tokens>, with **Create API token with scopes**, and choosing Bitbucket. I don't think scopes can be changed afterwards, so you'd need to create another one.

| Variable | Account | Scopes |
| --- | --- | --- |
| `BITBUCKET_CLOUD_TOKEN` | Yours | `read:user`, `read:repository`, `write:repository`, `read:pullrequest`, `write:pullrequest` |
| `BITBUCKET_CLOUD_ADMIN_TOKEN` | Yours | `read:repository`, `admin:repository`, `read:pullrequest`, `read:webhook`, `write:webhook`, `delete:webhook` |
| `BITBUCKET_CLOUD_SECOND_TOKEN` | The second one | The same as `BITBUCKET_CLOUD_TOKEN` |

The scopes end with `:bitbucket`. What they are for:

- `BITBUCKET_CLOUD_TOKEN` is what Atlantis uses. It has no admin scopes on purpose, to not hide permission problems.
- `BITBUCKET_CLOUD_ADMIN_TOKEN` is only used by the tests, for branch restrictions, default reviewers and webhooks. `read:pullrequest` is needed to create webhooks for pull request events.
- `BITBUCKET_CLOUD_SECOND_TOKEN` is for approving, commenting (Atlantis ignores comments from its own account), and for running Atlantis as someone that can't merge.

To see the scopes a token has:

```sh
curl -s -o /dev/null -D - -u "$BITBUCKET_CLOUD_EMAIL:$BITBUCKET_CLOUD_ADMIN_TOKEN" "https://api.bitbucket.org/2.0/repositories/$BITBUCKET_CLOUD_REPO" | grep -i x-oauth-scopes
```

### 3. Second account

Optional, the tests that need it are skipped otherwise.

1. Create another Atlassian account, and log in to Bitbucket with it once.
2. Invite it to the workspace, and give it **Read** to the repository. It must not be able to merge, so check that it's not in a group that gives it more than that.
3. Create its token, as above.

### 4. Merge queue

Optional, the tests that need it are skipped otherwise. There is no API to create or activate a queue, and it requires Pipelines.

1. In **Repository settings → Pipelines → Settings**, enable Pipelines. If it adds a starter `bitbucket-pipelines.yml` to `main`, delete it. Otherwise, its builds would be in the pull requests of the tests.
2. Create a `merge-queue` branch from `main`, with this `bitbucket-pipelines.yml`:

   ```yaml
   pipelines:
     merge-queues:
       harness: # same name as the queue
         - step:
             clone:
               enabled: false
             script:
               - sleep 30
   ```

   The `sleep` is so that there is time to try applying while the pull request is in the queue.
3. In **Repository settings → Workflow → Merge queues**, create one:
   - Name: `harness`
   - Target branch: `merge-queue`
   - Build concurrency: 1
   - Merge strategy: Merge commit
4. Activate it, in the **…** menu. It's created as inactive.
5. Set `BITBUCKET_CLOUD_MERGE_QUEUE=merge-queue` in `.env`.

### 5. Running

```sh
cp .env.example .env # and fill it
mise run test bitbucket-cloud
```

If it fails in an unexpected way:

- `403` with `required privilege scopes`: the token is missing the scopes it says.
- `429`: the mergeability API doesn't like more than around 10 calls in a few seconds. Wait a bit, and don't run anything else with the same account.
- `Blocked by in_progress_builds` or `failed_builds` out of nowhere: Pipelines is running in the pull request. See the starter file above.
- Timeouts, or `running terraform version timed out`: the machine is probably overloaded.

### 6. Cleaning up

1. Revoke the tokens.
2. Delete the repository, and the second account's access to the workspace.
3. Cancel the Premium trial.
