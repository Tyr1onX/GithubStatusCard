import { afterEach, beforeEach, describe, expect, it } from "@jest/globals";
import "@testing-library/jest-dom";
import axios from "axios";
import MockAdapter from "axios-mock-adapter";
import { calculateRank } from "../src/calculateRank.js";
import { clearContributedToCache, fetchStats } from "../src/fetchers/stats.js";

// Test parameters.
const data_stats = {
  data: {
    user: {
      name: "Anurag Hazra",
      repositoriesContributedTo: { totalCount: 61 },
      commits: {
        totalCommitContributions: 100,
      },
      reviews: {
        totalPullRequestReviewContributions: 50,
      },
      pullRequests: { totalCount: 300 },
      mergedPullRequests: { totalCount: 240 },
      openIssues: { totalCount: 100 },
      closedIssues: { totalCount: 100 },
      followers: { totalCount: 100 },
      repositoryDiscussions: { totalCount: 10 },
      repositoryDiscussionComments: { totalCount: 40 },
      repositories: {
        totalCount: 5,
        nodes: [
          { name: "test-repo-1", stargazers: { totalCount: 100 } },
          { name: "test-repo-2", stargazers: { totalCount: 100 } },
          { name: "test-repo-3", stargazers: { totalCount: 100 } },
        ],
        pageInfo: {
          hasNextPage: true,
          endCursor: "cursor",
        },
      },
    },
  },
};

const data_year2003 = JSON.parse(JSON.stringify(data_stats));
data_year2003.data.user.commits.totalCommitContributions = 428;

const data_without_pull_requests = {
  data: {
    user: {
      ...data_stats.data.user,
      pullRequests: { totalCount: 0 },
      mergedPullRequests: { totalCount: 0 },
    },
  },
};

const data_repo = {
  data: {
    user: {
      repositories: {
        nodes: [
          { name: "test-repo-4", stargazers: { totalCount: 50 } },
          { name: "test-repo-5", stargazers: { totalCount: 50 } },
        ],
        pageInfo: {
          hasNextPage: false,
          endCursor: "cursor",
        },
      },
    },
  },
};

const data_repo_zero_stars = {
  data: {
    user: {
      repositories: {
        nodes: [
          { name: "test-repo-1", stargazers: { totalCount: 100 } },
          { name: "test-repo-2", stargazers: { totalCount: 100 } },
          { name: "test-repo-3", stargazers: { totalCount: 100 } },
          { name: "test-repo-4", stargazers: { totalCount: 0 } },
          { name: "test-repo-5", stargazers: { totalCount: 0 } },
        ],
        pageInfo: {
          hasNextPage: true,
          endCursor: "cursor",
        },
      },
    },
  },
};

const error = {
  errors: [
    {
      type: "NOT_FOUND",
      path: ["user"],
      locations: [],
      message: "Could not resolve to a User with the login of 'noname'.",
    },
  ],
};

const mock = new MockAdapter(axios);

beforeEach(() => {
  process.env.FETCH_MULTI_PAGE_STARS = "false"; // Set to `false` to fetch only one page of stars.
  clearContributedToCache();
  mock.onPost("https://api.github.com/graphql").reply((cfg) => {
    let req = JSON.parse(cfg.data);
    const q = req.query || "";

    if (
      req.variables &&
      req.variables.startTime &&
      req.variables.startTime.startsWith("2003")
    ) {
      return [200, data_year2003];
    }

    // Isolated contributed-to micro-query.
    if (
      q.includes("contributedToCount") ||
      (q.includes("repositoriesContributedTo") &&
        !q.includes("totalCommitContributions"))
    ) {
      return [200, data_stats];
    }

    // Cheap fallback metric.
    if (
      q.includes("contributedToFallback") ||
      q.includes("totalRepositoriesWithContributedCommits")
    ) {
      return [
        200,
        {
          data: {
            user: {
              contributionsCollection: {
                totalRepositoriesWithContributedCommits: 42,
              },
            },
          },
        },
      ];
    }

    return [
      200,
      q.includes("totalCommitContributions") ? data_stats : data_repo,
    ];
  });
});

afterEach(() => {
  mock.reset();
  clearContributedToCache();
});

describe("Test fetchStats", () => {
  it("should fetch correct stats", async () => {
    let stats = await fetchStats("anuraghazra");
    const rank = calculateRank({
      all_commits: false,
      commits: 100,
      prs: 300,
      reviews: 50,
      issues: 200,
      repos: 5,
      stars: 300,
      followers: 100,
    });

    expect(stats).toStrictEqual({
      contributedTo: 61,
      name: "Anurag Hazra",
      totalCommits: 100,
      totalIssues: 200,
      totalPRs: 300,
      totalPRsMerged: 0,
      mergedPRsPercentage: 0,
      totalReviews: 50,
      totalStars: 300,
      totalDiscussionsStarted: 0,
      totalDiscussionsAnswered: 0,
      rank,
    });
  });

  it("should fetch selected-year and all-time commits together", async () => {
    mock.onGet(/\/search\/commits/).reply(200, { total_count: 1000 });

    const stats = await fetchStats(
      "anuraghazra",
      false,
      [],
      false,
      false,
      false,
      2026,
      true,
    );

    expect(stats.totalCommits).toBe(100);
    expect(stats.totalCommitsAllTime).toBe(1000);
  });

  it("should stop fetching when there are repos with zero stars", async () => {
    mock.reset();
    clearContributedToCache();
    process.env.FETCH_MULTI_PAGE_STARS = "true";
    let repoPageCalls = 0;

    mock.onPost("https://api.github.com/graphql").reply((cfg) => {
      const req = JSON.parse(cfg.data);
      const q = req.query || "";
      if (
        q.includes("contributedToCount") ||
        (q.includes("repositoriesContributedTo") &&
          !q.includes("totalCommitContributions"))
      ) {
        return [200, data_stats];
      }
      if (q.includes("totalCommitContributions")) {
        return [200, data_stats];
      }
      // Pagination-only query (no totalCommitContributions).
      repoPageCalls += 1;
      return [200, data_repo_zero_stars];
    });

    let stats = await fetchStats("anuraghazra");
    // First page all non-zero stars → one more page, then zeros stop further pages.
    expect(repoPageCalls).toBe(1);
    expect(stats.totalStars).toBe(600);
    expect(stats.contributedTo).toBe(61);
  });

  it("should throw error", async () => {
    mock.reset();
    mock.onPost("https://api.github.com/graphql").reply(200, error);

    await expect(fetchStats("anuraghazra")).rejects.toThrow(
      "Could not resolve to a User with the login of 'noname'.",
    );
  });

  it("should keep main stats when contributedTo hits resource limits and use fallback", async () => {
    mock.reset();
    clearContributedToCache();
    const limitError = {
      data: { user: null },
      errors: [
        {
          type: "RESOURCE_LIMITS_EXCEEDED",
          path: ["user", "repositoriesContributedTo"],
          locations: [{ line: 1, column: 1 }],
          message: "Resource limits for this query exceeded.",
        },
      ],
    };

    mock.onPost("https://api.github.com/graphql").reply((cfg) => {
      const req = JSON.parse(cfg.data);
      const q = req.query || "";
      if (
        q.includes("contributedToCount") ||
        (q.includes("repositoriesContributedTo") &&
          !q.includes("totalCommitContributions"))
      ) {
        return [200, limitError];
      }
      if (
        q.includes("contributedToFallback") ||
        q.includes("totalRepositoriesWithContributedCommits")
      ) {
        return [
          200,
          {
            data: {
              user: {
                contributionsCollection: {
                  totalRepositoriesWithContributedCommits: 42,
                },
              },
            },
          },
        ];
      }
      return [200, data_stats];
    });

    let stats = await fetchStats("anuraghazra");
    expect(stats.name).toBe("Anurag Hazra");
    expect(stats.totalPRs).toBe(300);
    expect(stats.contributedTo).toBe(42);
  });

  it("should reuse cached contributedTo without calling GraphQL again", async () => {
    mock.reset();
    clearContributedToCache();
    let contributedCalls = 0;

    mock.onPost("https://api.github.com/graphql").reply((cfg) => {
      const req = JSON.parse(cfg.data);
      const q = req.query || "";
      if (
        q.includes("contributedToCount") ||
        (q.includes("repositoriesContributedTo") &&
          !q.includes("totalCommitContributions"))
      ) {
        contributedCalls += 1;
        return [200, data_stats];
      }
      return [200, data_stats];
    });

    const first = await fetchStats("anuraghazra");
    const second = await fetchStats("anuraghazra");
    expect(first.contributedTo).toBe(61);
    expect(second.contributedTo).toBe(61);
    expect(contributedCalls).toBe(1);
  });

  it("should fetch total commits", async () => {
    mock.reset();
    clearContributedToCache();
    mock.onPost("https://api.github.com/graphql").reply((cfg) => {
      const req = JSON.parse(cfg.data);
      const q = req.query || "";
      if (
        q.includes("contributedToCount") ||
        (q.includes("repositoriesContributedTo") &&
          !q.includes("totalCommitContributions"))
      ) {
        return [200, data_stats];
      }
      return [200, data_stats];
    });
    mock.onGet(/\/search\/commits/).reply(200, { total_count: 1000 });

    let stats = await fetchStats("anuraghazra", true);
    const rank = calculateRank({
      all_commits: true,
      commits: 1000,
      prs: 300,
      reviews: 50,
      issues: 200,
      repos: 5,
      stars: 300,
      followers: 100,
    });

    expect(stats).toStrictEqual({
      contributedTo: 61,
      name: "Anurag Hazra",
      totalCommits: 1000,
      totalIssues: 200,
      totalPRs: 300,
      totalPRsMerged: 0,
      mergedPRsPercentage: 0,
      totalReviews: 50,
      totalStars: 300,
      totalDiscussionsStarted: 0,
      totalDiscussionsAnswered: 0,
      rank,
    });
  });

  it("should throw specific error when include_all_commits true and invalid username", async () => {
    expect(fetchStats("asdf///---", true)).rejects.toThrow(
      new Error("Invalid username provided."),
    );
  });

  it("should throw specific error when include_all_commits true and API returns error", async () => {
    mock.reset();
    clearContributedToCache();
    mock.onPost("https://api.github.com/graphql").reply(200, data_stats);
    mock
      .onGet(/\/search\/commits/)
      .reply(200, { error: "Some test error message" });

    await expect(fetchStats("anuraghazra", true)).rejects.toThrow(
      "Could not fetch total commits.",
    );
  });

  it("should exclude stars of the `test-repo-1` repository", async () => {
    mock.reset();
    clearContributedToCache();
    mock.onPost("https://api.github.com/graphql").reply((cfg) => {
      const req = JSON.parse(cfg.data);
      const q = req.query || "";
      if (
        q.includes("contributedToCount") ||
        (q.includes("repositoriesContributedTo") &&
          !q.includes("totalCommitContributions"))
      ) {
        return [200, data_stats];
      }
      return [
        200,
        q.includes("totalCommitContributions") ? data_stats : data_repo,
      ];
    });
    mock.onGet(/\/search\/commits/).reply(200, { total_count: 1000 });

    let stats = await fetchStats("anuraghazra", true, ["test-repo-1"]);
    const rank = calculateRank({
      all_commits: true,
      commits: 1000,
      prs: 300,
      reviews: 50,
      issues: 200,
      repos: 5,
      stars: 200,
      followers: 100,
    });

    expect(stats).toStrictEqual({
      contributedTo: 61,
      name: "Anurag Hazra",
      totalCommits: 1000,
      totalIssues: 200,
      totalPRs: 300,
      totalPRsMerged: 0,
      mergedPRsPercentage: 0,
      totalReviews: 50,
      totalStars: 200,
      totalDiscussionsStarted: 0,
      totalDiscussionsAnswered: 0,
      rank,
    });
  });

  it("should fetch two pages of stars if 'FETCH_MULTI_PAGE_STARS' env variable is set to `true`", async () => {
    process.env.FETCH_MULTI_PAGE_STARS = true;

    let stats = await fetchStats("anuraghazra");
    const rank = calculateRank({
      all_commits: false,
      commits: 100,
      prs: 300,
      reviews: 50,
      issues: 200,
      repos: 5,
      stars: 400,
      followers: 100,
    });

    expect(stats).toStrictEqual({
      contributedTo: 61,
      name: "Anurag Hazra",
      totalCommits: 100,
      totalIssues: 200,
      totalPRs: 300,
      totalPRsMerged: 0,
      mergedPRsPercentage: 0,
      totalReviews: 50,
      totalStars: 400,
      totalDiscussionsStarted: 0,
      totalDiscussionsAnswered: 0,
      rank,
    });
  });

  it("should fetch one page of stars if 'FETCH_MULTI_PAGE_STARS' env variable is set to `false`", async () => {
    process.env.FETCH_MULTI_PAGE_STARS = "false";

    let stats = await fetchStats("anuraghazra");
    const rank = calculateRank({
      all_commits: false,
      commits: 100,
      prs: 300,
      reviews: 50,
      issues: 200,
      repos: 5,
      stars: 300,
      followers: 100,
    });

    expect(stats).toStrictEqual({
      contributedTo: 61,
      name: "Anurag Hazra",
      totalCommits: 100,
      totalIssues: 200,
      totalPRs: 300,
      totalPRsMerged: 0,
      mergedPRsPercentage: 0,
      totalReviews: 50,
      totalStars: 300,
      totalDiscussionsStarted: 0,
      totalDiscussionsAnswered: 0,
      rank,
    });
  });

  it("should fetch one page of stars if 'FETCH_MULTI_PAGE_STARS' env variable is not set", async () => {
    process.env.FETCH_MULTI_PAGE_STARS = undefined;

    let stats = await fetchStats("anuraghazra");
    const rank = calculateRank({
      all_commits: false,
      commits: 100,
      prs: 300,
      reviews: 50,
      issues: 200,
      repos: 5,
      stars: 300,
      followers: 100,
    });

    expect(stats).toStrictEqual({
      contributedTo: 61,
      name: "Anurag Hazra",
      totalCommits: 100,
      totalIssues: 200,
      totalPRs: 300,
      totalPRsMerged: 0,
      mergedPRsPercentage: 0,
      totalReviews: 50,
      totalStars: 300,
      totalDiscussionsStarted: 0,
      totalDiscussionsAnswered: 0,
      rank,
    });
  });

  it("should not fetch additional stats data when it not requested", async () => {
    let stats = await fetchStats("anuraghazra");
    const rank = calculateRank({
      all_commits: false,
      commits: 100,
      prs: 300,
      reviews: 50,
      issues: 200,
      repos: 5,
      stars: 300,
      followers: 100,
    });

    expect(stats).toStrictEqual({
      contributedTo: 61,
      name: "Anurag Hazra",
      totalCommits: 100,
      totalIssues: 200,
      totalPRs: 300,
      totalPRsMerged: 0,
      mergedPRsPercentage: 0,
      totalReviews: 50,
      totalStars: 300,
      totalDiscussionsStarted: 0,
      totalDiscussionsAnswered: 0,
      rank,
    });
  });

  it("should fetch additional stats when it requested", async () => {
    let stats = await fetchStats("anuraghazra", false, [], true, true, true);
    const rank = calculateRank({
      all_commits: false,
      commits: 100,
      prs: 300,
      reviews: 50,
      issues: 200,
      repos: 5,
      stars: 300,
      followers: 100,
    });

    expect(stats).toStrictEqual({
      contributedTo: 61,
      name: "Anurag Hazra",
      totalCommits: 100,
      totalIssues: 200,
      totalPRs: 300,
      totalPRsMerged: 240,
      mergedPRsPercentage: 80,
      totalReviews: 50,
      totalStars: 300,
      totalDiscussionsStarted: 10,
      totalDiscussionsAnswered: 40,
      rank,
    });
  });

  it("should get commits of provided year", async () => {
    let stats = await fetchStats(
      "anuraghazra",
      false,
      [],
      false,
      false,
      false,
      2003,
    );

    const rank = calculateRank({
      all_commits: false,
      commits: 428,
      prs: 300,
      reviews: 50,
      issues: 200,
      repos: 5,
      stars: 300,
      followers: 100,
    });

    expect(stats).toStrictEqual({
      contributedTo: 61,
      name: "Anurag Hazra",
      totalCommits: 428,
      totalIssues: 200,
      totalPRs: 300,
      totalPRsMerged: 0,
      mergedPRsPercentage: 0,
      totalReviews: 50,
      totalStars: 300,
      totalDiscussionsStarted: 0,
      totalDiscussionsAnswered: 0,
      rank,
    });
  });

  it("should return correct data when user don't have any pull requests", async () => {
    mock.reset();
    mock
      .onPost("https://api.github.com/graphql")
      .reply(200, data_without_pull_requests);
    const stats = await fetchStats("anuraghazra", false, [], true);
    const rank = calculateRank({
      all_commits: false,
      commits: 100,
      prs: 0,
      reviews: 50,
      issues: 200,
      repos: 5,
      stars: 300,
      followers: 100,
    });

    expect(stats).toStrictEqual({
      contributedTo: 61,
      name: "Anurag Hazra",
      totalCommits: 100,
      totalIssues: 200,
      totalPRs: 0,
      totalPRsMerged: 0,
      mergedPRsPercentage: 0,
      totalReviews: 50,
      totalStars: 300,
      totalDiscussionsStarted: 0,
      totalDiscussionsAnswered: 0,
      rank,
    });
  });
});
