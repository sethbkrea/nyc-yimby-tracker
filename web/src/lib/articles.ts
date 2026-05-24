function env(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env: ${name}`);
  return v;
}

export interface Article {
  url: string;
  scraped_at: string;
  title?: string;
  body?: string;

  article_type?: string;
  address?: string;
  street_address?: string;
  neighborhood?: string;
  borough?: string;
  notes?: string;

  // Development fields
  type?: string;
  developer?: string;
  architect?: string;
  number_of_units?: number | null;
  square_footage?: number | null;
  stories?: number | null;
  height_ft?: number | null;

  // Transaction fields
  transaction_amount?: number | null;
  price_per_unit?: number | null;
  price_per_square_foot?: number | null;
  buyer?: string;
  seller?: string;
  brokers?: string;
  date_of_transaction?: string;
}

export async function loadArticles(): Promise<Article[]> {
  const owner = env("GITHUB_OWNER");
  const repo = env("GITHUB_REPO");
  const res = await fetch(
    `https://raw.githubusercontent.com/${owner}/${repo}/main/articles.json`,
    { cache: "no-store" },
  );
  if (!res.ok) {
    throw new Error(`fetch articles.json failed: ${res.status} ${await res.text()}`);
  }
  const data = (await res.json()) as unknown;
  if (!Array.isArray(data)) throw new Error("articles.json is not an array");
  return data as Article[];
}
