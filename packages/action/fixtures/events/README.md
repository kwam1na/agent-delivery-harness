# Simulated event fixtures

Each file models one GitHub webhook delivery as the Action sees it: the `env`
the runner exports, and the `event` payload `GITHUB_EVENT_PATH` points at.

The Action is driven as a function over an injected environment/filesystem seam,
so the whole failure-class table is exercised from these payloads without a
GitHub Actions runner anywhere. Git itself is **not** simulated — the tests build
real temporary repositories, including a real synthetic merge commit, and point
the fixture's placeholders at the shas that come out of them.

Placeholders substituted by the test harness before the payload is handed over:

| Token                | Meaning                                                  |
| -------------------- | -------------------------------------------------------- |
| `{{WORKSPACE}}`      | absolute path of the checked-out repository               |
| `{{EVENT_PATH}}`     | absolute path the event payload was written to            |
| `{{HEAD_SHA}}`       | the pull request head commit — what the Action verifies   |
| `{{BASE_SHA}}`       | the base branch tip at delivery time                      |
| `{{MERGE_SHA}}`      | the synthetic merge commit — recorded, never verified     |

`GITHUB_SHA` deliberately carries `{{MERGE_SHA}}` in every pull-request fixture:
on a `pull_request` event that variable is the *merge* commit, and a fixture that
quietly set it to the head would make the head-vs-merge-ref proof vacuous.
