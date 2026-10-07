// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Repository } from "./types";

const repository: Repository = {
  path: "/repo",
  name: "repo",
  branch: "main",
  head: "abc",
  ahead: 0,
  behind: 0,
  changes: [
    { path: "a.ts", status: "M", section: "unstaged" },
    { path: "b.ts", status: "M", section: "unstaged" },
    { path: "lock.json", status: "M", section: "unstaged" },
  ],
};

let version = 1;
const loadDiff = vi.fn();

function diffFor(file: string) {
  const padding = file === "lock.json" ? Array.from({ length: 600 }, () => `+${"x".repeat(400)}`) : [];
  return [`diff --git a/${file} b/${file}`, `--- a/${file}`, `+++ b/${file}`, `@@ -1,1 +1,${2 + padding.length} @@`, " keep", `+${file.replace(/\W/g, "_")}_v${version}`, ...padding].join("\n");
}

vi.mock("./api", () => ({
  checkGit: async () => ({ available: true, version: "git version 2.45.2" }),
  loadRepository: async () => repository,
  loadHistory: async () => [],
  loadDiff: (...args: unknown[]) => loadDiff(...args),
}));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn() }));

async function renderDesktopApp() {
  vi.resetModules();
  (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {};
  const { default: App } = await import("./App");
  render(<App/>);
  await screen.findByRole("button", { name: /a\.ts/ });
}

const row = (name: RegExp) => screen.getByRole("button", { name });
async function open(name: RegExp, marker: string) {
  fireEvent.click(row(name));
  await screen.findByText(new RegExp(`${marker}$`));
}
async function autoRefresh() {
  fireEvent.focus(window);
  await new Promise((resolve) => setTimeout(resolve, 400));
}

describe("diff refresh", () => {
  beforeEach(async () => {
    version = 1;
    localStorage.clear();
    localStorage.setItem("repositories", JSON.stringify(["/repo"]));
    loadDiff.mockReset();
    loadDiff.mockImplementation(async (_path: string, file: string) => diffFor(file));
    await renderDesktopApp();
    // Cache all three diffs, ending with a.ts selected.
    await open(/b\.ts/, "b_ts_v1");
    await open(/lock\.json/, "lock_json_v1");
    await open(/a\.ts/, "a_ts_v1");
    version = 2;
  });
  afterEach(() => {
    cleanup();
    delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__;
  });

  it("reloads small unselected files after an auto-refresh", async () => {
    await autoRefresh();

    await open(/b\.ts/, "b_ts_v2");
    expect(screen.queryByText("Outdated")).not.toBeInTheDocument();
  });

  it("keeps large cached diffs on auto-refresh and marks them stale", async () => {
    await autoRefresh();

    expect(screen.getByLabelText("Diff may be outdated")).toBeInTheDocument();
    fireEvent.click(row(/lock\.json/));
    expect(await screen.findByText(/lock_json_v1$/)).toBeVisible();
    expect(screen.getByText("Outdated")).toBeVisible();
  });

  it("reloads one stale file with Refresh file", async () => {
    await autoRefresh();
    await open(/lock\.json/, "lock_json_v1");

    fireEvent.click(screen.getByRole("button", { name: "Refresh file" }));

    expect(await screen.findByText(/lock_json_v2$/)).toBeVisible();
    await waitFor(() => expect(screen.queryByText("Outdated")).not.toBeInTheDocument());
    expect(screen.queryByLabelText("Diff may be outdated")).not.toBeInTheDocument();
  });

  it("drops all cached diffs, including large ones, with Refresh all", async () => {
    await autoRefresh();
    expect(screen.getByLabelText("Diff may be outdated")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /Refresh all/ }));
    await waitFor(() => expect(screen.queryByLabelText("Diff may be outdated")).not.toBeInTheDocument());

    await open(/lock\.json/, "lock_json_v2");
    await open(/b\.ts/, "b_ts_v2");
  });

  it("reloads the selected small file on auto-refresh", async () => {
    await autoRefresh();

    expect(await screen.findByText(/a_ts_v2$/)).toBeVisible();
  });
});
