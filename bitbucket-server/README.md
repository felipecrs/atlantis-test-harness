# Bitbucket Server

Also known as Data Center. There is nothing to set up, other than having Docker. It starts from scratch every time with [Testcontainers](https://node.testcontainers.org/).

```sh
mise run test bitbucket-server
```

It takes a minute to start, and then around 10 seconds per test.

## Good to know

- Use `BITBUCKET_SERVER_IMAGE` to try another version, e.g. `atlassian/bitbucket:9.4`.
- Webhooks are real, since the container can reach Atlantis. It needs to listen on all interfaces for that, which is what it does by default.
- The license is the one Atlassian publishes for testing. It lasts for 3 hours.
- It needs around 3 GB of memory.
