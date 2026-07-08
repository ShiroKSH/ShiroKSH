import { readFile, writeFile } from "node:fs/promises";

const username = process.env.GITHUB_USERNAME || "ShiroKSH";
const token = process.env.PROFILE_STATS_TOKEN || process.env.GH_TOKEN || process.env.GITHUB_TOKEN;
const readmePath = new URL("../README.md", import.meta.url);
const markerStart = "<!-- PR-STATS:START -->";
const markerEnd = "<!-- PR-STATS:END -->";

async function githubJson(url, authToken = token) {
  const headers = {
    accept: "application/vnd.github+json",
    "user-agent": `${username}-profile-readme`,
    "x-github-api-version": "2022-11-28",
  };

  if (authToken) {
    headers.authorization = `Bearer ${authToken}`;
  }

  const response = await fetch(url, {
    headers: {
      ...headers,
    },
  });

  const payload = await response.json();

  if ((response.status === 401 || response.status === 403) && authToken) {
    return githubJson(url, null);
  }

  if (!response.ok) {
    throw new Error(`GitHub API failed: ${payload.message || response.statusText}`);
  }

  return payload;
}

async function searchPullRequests(searchQuery, maxPages = 10) {
  const nodes = [];
  let totalCount = 0;

  for (let page = 1; page <= maxPages; page += 1) {
    const params = new URLSearchParams({
      q: searchQuery,
      per_page: "100",
      page: String(page),
    });
    const result = await githubJson(`https://api.github.com/search/issues?${params}`);
    totalCount = result.total_count;

    nodes.push(...result.items.map((item) => ({
      title: item.title,
      url: item.html_url,
      mergedAt: item.closed_at,
      createdAt: item.created_at,
      repositoryApiUrl: item.repository_url,
    })));

    if (result.items.length < 100) {
      break;
    }
  }

  const uniqueNodes = [...new Map(nodes.map((node) => [node.url, node])).values()];
  return { count: totalCount, nodes: uniqueNodes };
}

async function hydrateRepositories(nodes) {
  const repositories = new Map();

  for (const node of nodes) {
    if (!repositories.has(node.repositoryApiUrl)) {
      const repo = await githubJson(node.repositoryApiUrl);
      repositories.set(node.repositoryApiUrl, {
        nameWithOwner: repo.full_name,
        url: repo.html_url,
        stargazerCount: repo.stargazers_count,
      });
    }

    node.repository = repositories.get(node.repositoryApiUrl);
  }

  return nodes;
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
    `| Merged public PRs | **${formatNumber(merged.count)}** |`,
    `| Open public PRs | **${formatNumber(open.count)}** |`,
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

  lines.push("", `<sub>Auto-parsed from GitHub Search. Last updated ${new Date().toISOString().slice(0, 10)}.</sub>`);
  return lines.join("\n");
}

const [merged, open] = await Promise.all([
  searchPullRequests(`author:${username} is:pr is:merged is:public`),
  searchPullRequests(`author:${username} is:pr is:open is:public`),
]);

await hydrateRepositories(merged.nodes);

const readme = await readFile(readmePath, "utf8");
const generated = renderStats({ merged, open });
const pattern = new RegExp(`${markerStart}[\\s\\S]*?${markerEnd}`);

if (!pattern.test(readme)) {
  throw new Error("README is missing PR stats markers.");
}

await writeFile(readmePath, readme.replace(pattern, `${markerStart}\n${generated}\n${markerEnd}`));
