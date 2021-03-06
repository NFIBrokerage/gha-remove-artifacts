const core = require("@actions/core");
const { Octokit } = require("@octokit/action");
const { throttling } = require("@octokit/plugin-throttling");
const moment = require("moment");
const yn = require("yn");

const devEnv = process.env.NODE_ENV === "dev";

if (devEnv) {
  // eslint-disable-next-line global-require, import/no-extraneous-dependencies
  require("dotenv-safe").config();
}

function getConfigs() {
  const [owner, repo] = process.env.GITHUB_REPOSITORY.split("/");
  const [age, units] = devEnv
    ? process.env.AGE.split(" ")
    : core.getInput("age", { required: true }).split(" ");
  const maxAge = moment().subtract(age, units);

  console.log(
    "Maximum artifact age:",
    age,
    units,
    "( created before",
    maxAge.format(),
    ")"
  );

  return {
    repo: {
      owner,
      repo,
    },
    pagination: {
      perPage: 100,
    },
    maxAge: moment().subtract(age, units),
    skipTags: devEnv
      ? yn(process.env.SKIP_TAGS)
      : yn(core.getInput("skip-tags")),
    retriesEnabled: true,
  };
}

const ThrottledOctokit = Octokit.plugin(throttling);

async function run() {
  const configs = getConfigs();
  const octokit = new ThrottledOctokit({
    throttle: {
      onRateLimit: (retryAfter, options) => {
        console.error(
          `Request quota exhausted for request ${options.method} ${options.url}, number of total global retries: ${options.request.retryCount}`
        );

        console.log(`Retrying after ${retryAfter} seconds!`);

        return configs.retriesEnabled;
      },
      onAbuseLimit: (retryAfter, options) => {
        console.error(
          `Abuse detected for request ${options.method} ${options.url}, retry count: ${options.request.retryCount}`
        );

        console.log(`Retrying after ${retryAfter} seconds!`);

        return configs.retriesEnabled;
      },
    },
  });

  async function getTaggedCommits() {
    const listTagsRequest = octokit.repos.listTags.endpoint.merge({
      ...configs.repo,
      per_page: configs.pagination.perPage,
      ref: "tags",
    });

    const tags = await octokit.paginate(listTagsRequest);

    return tags.map(tag => tag.commit.sha);
  }

  let taggedCommits;

  if (configs.skipTags) {
    try {
      taggedCommits = await getTaggedCommits(octokit);
    } catch (err) {
      console.error("Error while requesting tags: ", err);

      throw err;
    }
  }

  const workflowRunsRequest = octokit.actions.listRepoWorkflowRuns.endpoint.merge(
    {
      ...configs.repo,
      per_page: configs.pagination.perPage,
    }
  );

  return octokit
    .paginate(workflowRunsRequest, ({ data }, done) => {
      const stopPagination = data.find(workflowRun => {
        const createdAt = moment(workflowRun.created_at);

        return createdAt.isBefore(moment.utc().subtract(90, "days"));
      });

      if (stopPagination) {
        done();
      }

      return data;
    })
    .then(workflowRuns => {
      const artifactPromises = workflowRuns
        .filter(workflowRun => {
          const skipWorkflow =
            configs.skipTags && taggedCommits.includes(workflowRun.head_sha);

          if (skipWorkflow) {
            console.log(`Skipping tagged run ${workflowRun.head_sha}`);

            return false;
          }

          return true;
        })
        .map(workflowRun => {
          const workflowRunArtifactsRequest = octokit.actions.listWorkflowRunArtifacts.endpoint.merge(
            {
              ...configs.repo,
              per_page: configs.pagination.perPage,
              run_id: workflowRun.id,
            }
          );

          return octokit.paginate(workflowRunArtifactsRequest).then(artifacts =>
            artifacts
              .filter(artifact => {
                const createdAt = moment(artifact.created_at);

                return createdAt.isBefore(configs.maxAge);
              })
              .map(artifact => {
                if (devEnv) {
                  return new Promise(resolve => {
                    console.log(
                      `Recognized development environment, preventing ${artifact.id} from being removed.`
                    );

                    resolve();
                  });
                }

                return octokit.actions
                  .deleteArtifact({
                    ...configs.repo,
                    artifact_id: artifact.id,
                  })
                  .then(() => {
                    console.log(
                      `Successfully removed artifact with id ${artifact.id}.`
                    );
                  });
              })
          );
        });

      return Promise.all(artifactPromises).then(artifactDeletePromises =>
        Promise.all([].concat(...artifactDeletePromises))
      );
    });
}

run().catch(err => {
  core.setFailed(err.toString());
});
