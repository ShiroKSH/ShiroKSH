import { readFile, writeFile } from "node:fs/promises";

const username = process.env.GITHUB_USERNAME || "ShiroKSH";
const token = process.env.PROFILE_STATS_TOKEN || process.env.GH_TOKEN || process.env.GITHUB_TOKEN;
const readmePath = new URL("../README.md", import.meta.url);
const prMarkerStart = "<!-- PR-STATS:START -->";
const prMarkerEnd = "<!-- PR-STATS:END -->";
const langMarkerStart = "<!-- LANG-STATS:START -->";
const langMarkerEnd = "<!-- LANG-STATS:END -->";
const ignoredLanguages = new Set(["CMake", "CSS", "HTML", "PowerShell", "Shell"]);

async function githubGraphql(query, variables = {}) {
  if (!token) {
    throw new Error("Set PROFILE_STATS_TOKEN, GH_TOKEN, or GITHUB_TOKEN before running this script.");
  }

  const response = await fetch("https://api.github.com/graphql", {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      "user-agent": `${username}-profile-readme`,
    },
    body: JSON.stringify({ query, variables }),
  });

  const payload = await response.json();

  if (!response.ok || payload.errors?.length) {
    const detail = payload.errors?.map((error) => error.message).join("; ") || payload.message || response.statusText;
    throw new Error(`GitHub GraphQL failed: ${detail}`);
  }

  return payload.data;
}

async function searchPullRequests(searchQuery, maxPages = 10) {
  const query = `
    query SearchPullRequests($query: String!, $cursor: String) {
      search(query: $query, type: ISSUE, first: 100, after: $cursor) {
        pageInfo {
          hasNextPage
          endCursor
        }
        nodes {
          ... on PullRequest {
            title
            url
            mergedAt
            createdAt
            headRefName
            headRepository {
              nameWithOwner
              isPrivate
            }
            baseRepository {
              nameWithOwner
              url
              stargazerCount
              isPrivate
            }
            repository {
              nameWithOwner
              url
              stargazerCount
              isPrivate
            }
          }
        }
      }
    }
  `;

  const nodes = [];
  let cursor = null;

  for (let page = 0; page < maxPages; page += 1) {
    const result = await githubGraphql(query, { query: searchQuery, cursor });
    const search = result.search;

    nodes.push(...search.nodes.filter(Boolean).map((node) => ({
      title: node.title,
      url: node.url,
      mergedAt: node.mergedAt,
      createdAt: node.createdAt,
      baseRepositoryPrivate: node.baseRepository?.isPrivate ?? node.repository?.isPrivate ?? null,
      headRefName: node.headRefName || null,
      headRepositoryName: node.headRepository?.nameWithOwner || null,
      headRepositoryPrivate: node.headRepository?.isPrivate ?? null,
      repository: {
        nameWithOwner: node.repository?.nameWithOwner || node.baseRepository?.nameWithOwner,
        url: node.repository?.url || node.baseRepository?.url,
        stargazerCount: node.repository?.stargazerCount ?? node.baseRepository?.stargazerCount ?? 0,
      },
    })));

    if (!search.pageInfo.hasNextPage) {
      break;
    }

    cursor = search.pageInfo.endCursor;
  }

  const uniqueNodes = [...new Map(nodes.map((node) => [node.url, node])).values()];
  return { count: uniqueNodes.length, nodes: uniqueNodes };
}

function pullRequestBranchKey(node) {
  if (node.headRepositoryName && node.headRefName && node.headRepositoryPrivate === false) {
    return `branch:${node.headRepositoryName}:${node.headRefName}`;
  }

  return `pr:${node.url}`;
}

function betterPullRequestRepresentative(left, right) {
  const leftStars = left.repository?.stargazerCount || 0;
  const rightStars = right.repository?.stargazerCount || 0;

  if (rightStars !== leftStars) {
    return rightStars > leftStars ? right : left;
  }

  const leftTime = new Date(left.mergedAt || left.createdAt || 0).getTime();
  const rightTime = new Date(right.mergedAt || right.createdAt || 0).getTime();
  return rightTime > leftTime ? right : left;
}

function dedupePullRequestsByBranch(nodes) {
  const uniqueNodes = new Map();

  for (const node of nodes) {
    const key = pullRequestBranchKey(node);
    const current = uniqueNodes.get(key);
    uniqueNodes.set(key, current ? betterPullRequestRepresentative(current, node) : node);
  }

  return [...uniqueNodes.values()];
}

async function listOwnedRepositories(maxPages = 5) {
  const query = `
    query UserRepositories($login: String!, $cursor: String) {
      user(login: $login) {
        repositories(
          first: 100
          after: $cursor
          ownerAffiliations: OWNER
          isFork: false
          orderBy: { field: UPDATED_AT, direction: DESC }
        ) {
          pageInfo {
            hasNextPage
            endCursor
          }
          nodes {
            isArchived
            isPrivate
            languages(first: 20, orderBy: { field: SIZE, direction: DESC }) {
              edges {
                size
                node {
                  name
                }
              }
            }
          }
        }
      }
    }
  `;

  const repositories = [];
  let cursor = null;

  for (let page = 0; page < maxPages; page += 1) {
    const result = await githubGraphql(query, { login: username, cursor });
    const pageItems = result.user.repositories;
    repositories.push(...pageItems.nodes.filter((repo) => !repo.isArchived && !repo.isPrivate));

    if (!pageItems.pageInfo.hasNextPage) {
      break;
    }

    cursor = pageItems.pageInfo.endCursor;
  }

  return repositories;
}

async function getLanguageTotals() {
  const repositories = await listOwnedRepositories();
  const totals = new Map();

  for (const repo of repositories) {
    for (const edge of repo.languages.edges) {
      const language = edge.node.name;
      const bytes = edge.size;

      if (ignoredLanguages.has(language)) {
        continue;
      }

      totals.set(language, (totals.get(language) || 0) + bytes);
    }
  }

  return [...totals.entries()]
    .map(([language, bytes]) => ({ language, bytes }))
    .sort((left, right) => right.bytes - left.bytes);
}

function formatNumber(value) {
  return new Intl.NumberFormat("en-US").format(value);
}

function formatStars(value) {
  if (value >= 1000) {
    return `${(value / 1000).toFixed(value >= 10000 ? 0 : 1)}k`;
  }

  return String(value);
}

function formatDate(value) {
  return new Date(value).toISOString().slice(0, 10);
}

function escapeMarkdown(value) {
  return value.replaceAll("|", "\\|").replaceAll("\n", " ");
}

function progressBar(percent) {
  const filled = Math.max(1, Math.round(percent / 10));
  return "#".repeat(filled) + "-".repeat(10 - filled);
}

function renderStats({ merged, open }) {
  const bestByStars = merged.nodes
    .filter((node) => node.repository)
    .sort((left, right) => {
      const starDelta = right.repository.stargazerCount - left.repository.stargazerCount;
      if (starDelta !== 0) {
        return starDelta;
      }

      return new Date(right.mergedAt || right.createdAt) - new Date(left.mergedAt || left.createdAt);
    })[0];

  const latestMerged = merged.nodes
    .filter((node) => node.mergedAt)
    .sort((left, right) => new Date(right.mergedAt) - new Date(left.mergedAt))[0];

  const lines = [
    `| signal | value |`,
    `| --- | --- |`,
    `| Unique merged public PR branches | **${formatNumber(merged.count)}** |`,
    `| Unique open public PR branches | **${formatNumber(open.count)}** |`,
  ];

  if (bestByStars) {
    lines.push(
      `| Biggest repo with my merged PR | [${escapeMarkdown(bestByStars.repository.nameWithOwner)}](${bestByStars.repository.url}) - ${formatStars(bestByStars.repository.stargazerCount)} stars |`,
      `| Best star-target PR | [${escapeMarkdown(bestByStars.title)}](${bestByStars.url}) |`,
    );
  }

  if (latestMerged) {
    lines.push(
      `| Latest merged PR | [${escapeMarkdown(latestMerged.title)}](${latestMerged.url}) - ${formatDate(latestMerged.mergedAt)} |`,
    );
  }

  lines.push("", `<sub>Auto-parsed from GitHub Search, deduped by public head branch. Last updated ${new Date().toISOString().slice(0, 10)}.</sub>`);
  return lines.join("\n");
}

function renderLanguages(languages) {
  const topLanguages = languages.slice(0, 6);
  const totalBytes = topLanguages.reduce((sum, item) => sum + item.bytes, 0);

  if (!topLanguages.length || totalBytes === 0) {
    return "No public repository language data yet.";
  }

  return [
    `| language | share |`,
    `| --- | --- |`,
    ...topLanguages.map((item) => {
      const percent = (item.bytes / totalBytes) * 100;
      return `| ${escapeMarkdown(item.language)} | \`${progressBar(percent)}\` ${percent.toFixed(1)}% |`;
    }),
    "",
    `<sub>Auto-parsed from owned public repositories. Last updated ${new Date().toISOString().slice(0, 10)}.</sub>`,
  ].join("\n");
}

const [merged, open] = await Promise.all([
  searchPullRequests(`author:${username} is:pr is:merged`),
  searchPullRequests(`author:${username} is:pr is:open`),
]);

merged.nodes = merged.nodes.filter((node) => node.baseRepositoryPrivate === false);
open.nodes = open.nodes.filter((node) => node.baseRepositoryPrivate === false);
merged.nodes = dedupePullRequestsByBranch(merged.nodes);
open.nodes = dedupePullRequestsByBranch(open.nodes);
merged.count = merged.nodes.length;
open.count = open.nodes.length;
const languages = await getLanguageTotals();

const readme = await readFile(readmePath, "utf8");
const generatedPrStats = renderStats({ merged, open });
const generatedLangStats = renderLanguages(languages);
const prPattern = new RegExp(`${prMarkerStart}[\\s\\S]*?${prMarkerEnd}`);
const langPattern = new RegExp(`${langMarkerStart}[\\s\\S]*?${langMarkerEnd}`);

if (!prPattern.test(readme)) {
  throw new Error("README is missing PR stats markers.");
}

if (!langPattern.test(readme)) {
  throw new Error("README is missing language stats markers.");
}

await writeFile(
  readmePath,
  readme
    .replace(prPattern, `${prMarkerStart}\n${generatedPrStats}\n${prMarkerEnd}`)
    .replace(langPattern, `${langMarkerStart}\n${generatedLangStats}\n${langMarkerEnd}`),
);
