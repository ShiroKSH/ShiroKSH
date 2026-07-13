import { mkdir, readFile, writeFile } from "node:fs/promises";

const username = process.env.GITHUB_USERNAME || "ShiroKSH";
const profileStatsToken = process.env.PROFILE_STATS_TOKEN || process.env.GH_TOKEN;
const token = profileStatsToken || process.env.GITHUB_TOKEN;
const readmePath = new URL("../README.md", import.meta.url);
const cachePath = new URL("../.github/profile-pr-cache.json", import.meta.url);
const prMarkerStart = "<!-- PR-STATS:START -->";
const prMarkerEnd = "<!-- PR-STATS:END -->";
const langMarkerStart = "<!-- LANG-STATS:START -->";
const langMarkerEnd = "<!-- LANG-STATS:END -->";
const ignoredLanguages = new Set(["CMake", "CSS", "HTML", "PowerShell", "Shell"]);

async function requestJson(url, { authToken, body, method = "GET" } = {}) {
  const headers = {
    accept: "application/vnd.github+json",
    "user-agent": `${username}-profile-readme`,
  };

  if (authToken) {
    headers.authorization = `Bearer ${authToken}`;
  }

  if (body) {
    headers["content-type"] = "application/json";
  }

  const response = await fetch(url, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });

  const payload = await response.json();

  if (!response.ok) {
    const detail = payload.errors?.map((error) => error.message).join("; ") || payload.message || response.statusText;
    throw new Error(`GitHub API failed: ${detail}`);
  }

  return payload;
}

async function githubGraphql(query, variables = {}, authToken = token) {
  if (!authToken) {
    throw new Error("Set PROFILE_STATS_TOKEN, GH_TOKEN, or GITHUB_TOKEN before running this script.");
  }

  const payload = await requestJson("https://api.github.com/graphql", {
    method: "POST",
    authToken,
    body: { query, variables },
  });

  if (payload.errors?.length) {
    const detail = payload.errors.map((error) => error.message).join("; ");
    throw new Error(`GitHub GraphQL failed: ${detail}`);
  }

  return payload.data;
}

async function readPullRequestCache() {
  try {
    const raw = await readFile(cachePath, "utf8");
    const parsed = JSON.parse(raw);
    return new Map(Object.entries(parsed.pullRequests || {}));
  } catch (error) {
    if (error.code === "ENOENT") {
      return new Map();
    }

    throw error;
  }
}

const pullRequestCache = await readPullRequestCache();

function cacheNode(node) {
  return {
    title: node.title,
    url: node.url,
    mergedAt: node.mergedAt,
    createdAt: node.createdAt,
    baseRepositoryPrivate: node.baseRepositoryPrivate,
    headRefName: node.headRefName,
    headRepositoryName: node.headRepositoryName,
    headRepositoryPrivate: node.headRepositoryPrivate,
    repository: node.repository,
  };
}

async function writePullRequestCache(nodes) {
  if (process.env.UPDATE_PR_CACHE !== "1") {
    return;
  }

  const pullRequests = Object.fromEntries([...pullRequestCache.entries()].sort(([left], [right]) => left.localeCompare(right)));

  for (const node of nodes) {
    pullRequests[node.url] = cacheNode(node);
  }

  await mkdir(new URL("../.github/", import.meta.url), { recursive: true });
  await writeFile(cachePath, `${JSON.stringify({
    version: 1,
    updatedAt: new Date().toISOString(),
    pullRequests,
  }, null, 2)}\n`);
}

function nodeFromRestPullRequest(pullRequest) {
  return {
    title: pullRequest.title,
    url: pullRequest.html_url,
    mergedAt: pullRequest.merged_at,
    createdAt: pullRequest.created_at,
    baseRepositoryPrivate: pullRequest.base?.repo?.private ?? null,
    headRefName: pullRequest.head?.ref || null,
    headRepositoryName: pullRequest.head?.repo?.full_name || null,
    headRepositoryPrivate: pullRequest.head?.repo?.private ?? null,
    repository: {
      nameWithOwner: pullRequest.base?.repo?.full_name,
      url: pullRequest.base?.repo?.html_url,
      stargazerCount: pullRequest.base?.repo?.stargazers_count || 0,
    },
  };
}

async function searchPullRequestsRest(searchQuery, maxPages = 10) {
  const nodes = [];

  for (let page = 1; page <= maxPages; page += 1) {
    const params = new URLSearchParams({
      q: searchQuery,
      per_page: "100",
      page: String(page),
    });
    const result = await requestJson(`https://api.github.com/search/issues?${params}`);

    for (const item of result.items) {
      const cached = pullRequestCache.get(item.html_url);

      if (cached) {
        nodes.push({
          ...cached,
          title: item.title || cached.title,
          url: item.html_url,
          createdAt: item.created_at || cached.createdAt,
        });
        continue;
      }

      nodes.push(nodeFromRestPullRequest(await requestJson(item.pull_request.url)));
    }

    if (result.items.length < 100) {
      break;
    }
  }

  const uniqueNodes = [...new Map(nodes.map((node) => [node.url, node])).values()];
  return { count: uniqueNodes.length, nodes: uniqueNodes };
}

async function searchPullRequestsGraphql(searchQuery, maxPages = 10) {
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
    const result = await githubGraphql(query, { query: searchQuery, cursor }, profileStatsToken || token);
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

async function searchPullRequests(searchQuery) {
  if (!token && process.env.GITHUB_ACTIONS === "true") {
    const wantsMerged = searchQuery.includes("is:merged");
    const nodes = [...pullRequestCache.values()].filter((node) => wantsMerged ? Boolean(node.mergedAt) : !node.mergedAt);
    return { count: nodes.length, nodes };
  }

  return searchPullRequestsGraphql(searchQuery);
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

async function getLanguageTotals(maxPages = 5) {
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

  const totals = new Map();
  let cursor = null;

  for (let page = 0; page < maxPages; page += 1) {
    const result = await githubGraphql(query, { login: username, cursor });
    const repositories = result.user.repositories;

    for (const repo of repositories.nodes.filter((item) => !item.isArchived && !item.isPrivate)) {
      for (const edge of repo.languages.edges) {
        const language = edge.node.name;

        if (ignoredLanguages.has(language)) {
          continue;
        }

        totals.set(language, (totals.get(language) || 0) + edge.size);
      }
    }

    if (!repositories.pageInfo.hasNextPage) {
      break;
    }

    cursor = repositories.pageInfo.endCursor;
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
await writePullRequestCache([...merged.nodes, ...open.nodes]);

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
