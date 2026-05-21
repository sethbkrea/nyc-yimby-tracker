function env(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env: ${name}`);
  return v;
}

export interface Article {
  url: string;
  address: string;
  developer: string;
  neighborhood: string;
  borough: string;
  notes: string;
  body: string;
  scraped_at: string;
}

export async function loadArticles(): Promise<Article[]> {
  // Pull articles.json via the GitHub Contents API so the same GH_TOKEN works
  // for private repos. ?ref=main pins to the default branch.
  const owner = env("GITHUB_OWNER");
  const repo = env("GITHUB_REPO");
  const res = await fetch(
    `https://api.github.com/repos/${owner}/${repo}/contents/articles.json?ref=main`,
    {
      headers: {
        Accept: "application/vnd.github.raw",
        Authorization: `Bearer ${env("GH_TOKEN")}`,
        "X-GitHub-Api-Version": "2022-11-28",
      },
      cache: "no-store",
    },
  );
  if (!res.ok) {
    throw new Error(`fetch articles.json failed: ${res.status} ${await res.text()}`);
  }
  const data = (await res.json()) as unknown;
  if (!Array.isArray(data)) throw new Error("articles.json is not an array");
  return data as Article[];
}
