// GitHub integration helpers. Backed by the Replit GitHub connector via
// `@replit/connectors-sdk` — token refresh and auth headers are handled by the
// proxy. We DO NOT cache the connectors client because tokens expire.
import { ReplitConnectors } from "@replit/connectors-sdk";
import { logger } from "./logger";

export class GithubNotConnectedError extends Error {
  constructor(msg = "GitHub integration is not connected for this workspace") {
    super(msg);
    this.name = "GithubNotConnectedError";
  }
}

export class GithubNotFoundError extends Error {
  constructor(msg = "Repository not found or access denied") {
    super(msg);
    this.name = "GithubNotFoundError";
  }
}

export class GithubBranchNotFoundError extends Error {
  constructor(
    public readonly owner: string,
    public readonly repo: string,
    public readonly branch: string,
    msg?: string,
  ) {
    super(
      msg ??
        `Branch "${branch}" no longer exists on ${owner}/${repo}. Pick a different branch and try again.`,
    );
    this.name = "GithubBranchNotFoundError";
  }
}

function getConnectors(): ReplitConnectors {
  // Always construct a fresh client; the SDK refreshes tokens internally.
  return new ReplitConnectors();
}

async function gh(path: string): Promise<Response> {
  try {
    const connectors = getConnectors();
    return await connectors.proxy("github", path, { method: "GET" });
  } catch (err) {
    logger.warn({ err, path }, "GitHub proxy request failed");
    throw new GithubNotConnectedError();
  }
}

async function ghJson<T>(path: string): Promise<T> {
  const resp = await gh(path);
  if (resp.status === 404) {
    throw new GithubNotFoundError();
  }
  if (!resp.ok) {
    const body = await resp.text().catch(() => "");
    logger.warn({ status: resp.status, path, body }, "GitHub API error");
    throw new Error(`GitHub API error ${resp.status}`);
  }
  return (await resp.json()) as T;
}

export interface GithubRepoSummary {
  owner: string;
  name: string;
  fullName: string;
  description: string | null;
  defaultBranch: string;
  private: boolean;
  stars: number;
  language: string | null;
}

export interface GithubRepoMetadata extends GithubRepoSummary {
  licenseSpdx: string | null;
  latestReleaseTag: string | null;
  latestCommitSha: string | null;
  homepageUrl: string | null;
  readmeMarkdown: string | null;
}

interface ApiRepo {
  name: string;
  full_name: string;
  description: string | null;
  default_branch: string;
  private: boolean;
  stargazers_count: number;
  language: string | null;
  homepage?: string | null;
  owner: { login: string };
  license?: { spdx_id: string | null } | null;
}

function toSummary(r: ApiRepo): GithubRepoSummary {
  return {
    owner: r.owner.login,
    name: r.name,
    fullName: r.full_name,
    description: r.description ?? null,
    defaultBranch: r.default_branch,
    private: r.private,
    stars: r.stargazers_count ?? 0,
    language: r.language ?? null,
  };
}

export async function listRepos(opts: {
  search?: string;
  page?: number;
}): Promise<GithubRepoSummary[]> {
  const page = Math.max(1, Math.min(10, opts.page ?? 1));
  const search = opts.search?.trim() ?? "";

  if (search) {
    // Search repos accessible to the authenticated user. The connector token
    // already scopes to that user, so we add `user:@me` substitution by
    // searching against affiliated repos via the search API. The "user/org"
    // qualifier is omitted — the search endpoint returns public matches plus
    // private repos the token can see.
    const q = encodeURIComponent(`${search} fork:true`);
    const path = `/search/repositories?q=${q}&per_page=30&page=${page}`;
    const data = await ghJson<{ items: ApiRepo[] }>(path);
    return data.items.map(toSummary);
  }

  // Without a search term, list the authenticated user's own repos.
  const path = `/user/repos?per_page=30&page=${page}&sort=updated&affiliation=owner,collaborator,organization_member`;
  const data = await ghJson<ApiRepo[]>(path);
  return data.map(toSummary);
}

interface ApiRelease {
  tag_name: string;
}
interface ApiCommit {
  sha: string;
}
interface ApiReadme {
  content: string;
  encoding: string;
}
interface ApiBranch {
  name: string;
  protected?: boolean;
}

export interface GithubBranchSummary {
  name: string;
  isDefault: boolean;
  protected: boolean;
}

async function getReadme(
  owner: string,
  repo: string,
  branch?: string,
): Promise<string | null> {
  // The README endpoint accepts `?ref=<branch>` to resolve against a specific
  // branch instead of the repo's default branch.
  const path = branch
    ? `/repos/${owner}/${repo}/readme?ref=${encodeURIComponent(branch)}`
    : `/repos/${owner}/${repo}/readme`;
  try {
    const data = await ghJson<ApiReadme>(path);
    if (data.encoding === "base64") {
      try {
        return Buffer.from(data.content, "base64").toString("utf8");
      } catch {
        return null;
      }
    }
    return data.content ?? null;
  } catch (err) {
    if (err instanceof GithubNotFoundError) return null;
    throw err;
  }
}

export async function listBranches(
  owner: string,
  repo: string,
): Promise<GithubBranchSummary[]> {
  // Walk all pages of /branches (per_page=100, GitHub max). A short-page
  // response signals we've hit the end. The hard cap is a paranoia stop
  // — even huge monorepos rarely have >5k branches, and we don't want a
  // pathological repo to peg the API server forever.
  const collected: ApiBranch[] = [];
  const PER_PAGE = 100;
  const MAX_PAGES = 50; // 5,000 branches, far beyond any realistic repo
  for (let page = 1; page <= MAX_PAGES; page += 1) {
    const data = await ghJson<ApiBranch[]>(
      `/repos/${owner}/${repo}/branches?per_page=${PER_PAGE}&page=${page}`,
    );
    collected.push(...data);
    if (data.length < PER_PAGE) break;
  }
  // Look up the repo's default branch so the picker can pre-select it.
  const repoData = await ghJson<ApiRepo>(`/repos/${owner}/${repo}`);
  const defaultBranch = repoData.default_branch;
  return collected.map((b) => ({
    name: b.name,
    isDefault: b.name === defaultBranch,
    protected: b.protected === true,
  }));
}

async function getLatestReleaseTag(
  owner: string,
  repo: string,
): Promise<string | null> {
  try {
    const data = await ghJson<ApiRelease>(
      `/repos/${owner}/${repo}/releases/latest`,
    );
    return data.tag_name ?? null;
  } catch (err) {
    if (err instanceof GithubNotFoundError) return null;
    throw err;
  }
}

async function getLatestCommitSha(
  owner: string,
  repo: string,
  branch: string,
): Promise<string | null> {
  // Re-throw NotFound here so the caller can convert it into a clear
  // "branch missing" error — silently returning null would let an outdated
  // branch selection survive a re-sync without surfacing the problem.
  const data = await ghJson<ApiCommit>(
    `/repos/${owner}/${repo}/commits/${encodeURIComponent(branch)}`,
  );
  return data.sha ?? null;
}

export async function getRepoMetadata(
  owner: string,
  repo: string,
  branchOverride?: string | null,
): Promise<GithubRepoMetadata> {
  const r = await ghJson<ApiRepo>(`/repos/${owner}/${repo}`);
  const summary = toSummary(r);
  const branch =
    branchOverride && branchOverride.length > 0
      ? branchOverride
      : summary.defaultBranch;
  let commitSha: string | null;
  try {
    commitSha = await getLatestCommitSha(owner, repo, branch);
  } catch (err) {
    // The /commits/{ref} endpoint returns 404 when the branch is gone.
    // Surface this as a typed error so callers can show an actionable
    // message and re-prompt the admin to pick a different branch instead
    // of silently falling back to the repo's default branch.
    if (err instanceof GithubNotFoundError) {
      throw new GithubBranchNotFoundError(owner, repo, branch);
    }
    throw err;
  }
  const [readme, releaseTag] = await Promise.all([
    getReadme(owner, repo, branch),
    getLatestReleaseTag(owner, repo),
  ]);
  return {
    ...summary,
    // The summary already carries the repo's true default branch in
    // `defaultBranch`; the README/commit/etc above are scoped to the
    // requested branch (which may be the same).
    licenseSpdx: r.license?.spdx_id ?? null,
    latestReleaseTag: releaseTag,
    latestCommitSha: commitSha,
    homepageUrl: r.homepage ?? null,
    readmeMarkdown: readme,
  };
}
