import type { NextConfig } from "next";
import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";

const pkg = JSON.parse(
  readFileSync(path.join(process.cwd(), "package.json"), "utf8"),
) as { version: string };

// Vercel/GitHub Actions build sırasında commit bilgisini ortamdan verir;
// lokal `next dev`/`next build` için git'ten okuruz.
function resolveCommitSha(): string {
  const fromEnv = process.env.VERCEL_GIT_COMMIT_SHA ?? process.env.GITHUB_SHA;
  if (fromEnv) return fromEnv;
  try {
    return execSync("git rev-parse HEAD", { encoding: "utf8" }).trim();
  } catch {
    return "";
  }
}

function resolveCommitRef(): string {
  const fromEnv = process.env.VERCEL_GIT_COMMIT_REF ?? process.env.GITHUB_REF_NAME;
  if (fromEnv) return fromEnv;
  try {
    return execSync("git rev-parse --abbrev-ref HEAD", { encoding: "utf8" }).trim();
  } catch {
    return "";
  }
}

function parseGithubRepo(value: string): string {
  const normalized = value.trim().replace(/\.git$/, "");
  const match =
    /github\.com[/:]([\w.-]+\/[\w.-]+)$/.exec(normalized) ??
    /^([\w.-]+\/[\w.-]+)$/.exec(normalized);
  return match?.[1] ?? "";
}

function resolveRepoFullName(): string {
  const configured =
    process.env.APP_GITHUB_REPOSITORY ?? process.env.GITHUB_REPOSITORY ?? "";
  const fromConfigured = parseGithubRepo(configured);
  if (fromConfigured) return fromConfigured;

  const repoOwner = process.env.VERCEL_GIT_REPO_OWNER ?? "";
  const repoSlug = process.env.VERCEL_GIT_REPO_SLUG ?? "";
  if (repoOwner && repoSlug) return `${repoOwner}/${repoSlug}`;

  try {
    return parseGithubRepo(
      execSync("git config --get remote.origin.url", { encoding: "utf8" }),
    );
  } catch {
    return "";
  }
}

const repoFullName = resolveRepoFullName();

const nextConfig: NextConfig = {
  reactCompiler: true,
  // ssh2, isteğe bağlı bir native binding (sshcrypto.node) yükler. Bundler bu
  // dosyayı ESM chunk'a yerleştiremediği için paket Node'un kendi require'ına
  // bırakılır; binding yoksa ssh2 saf JS kripto uygulamasına düşer.
  serverExternalPackages: ["ssh2"],
  env: {
    APP_VERSION: pkg.version,
    APP_COMMIT_SHA: resolveCommitSha(),
    APP_COMMIT_REF: resolveCommitRef(),
    APP_BUILD_TIME: new Date().toISOString(),
    APP_REPO_FULL_NAME: repoFullName,
    APP_REPO_URL: repoFullName ? `https://github.com/${repoFullName}` : "",
  },
  outputFileTracingIncludes: {
    "/api/invoices/*/pdf": [
      "./node_modules/@expo-google-fonts/noto-sans/400Regular/NotoSans_400Regular.ttf",
      "./node_modules/@expo-google-fonts/noto-sans/700Bold/NotoSans_700Bold.ttf",
    ],
  },
};

export default nextConfig;
