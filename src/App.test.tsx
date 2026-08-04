// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import App from "./App";

describe("App", () => {
  beforeEach(() => localStorage.clear());
  afterEach(cleanup);

  it("filters changed files by path", () => {
    render(<App/>);

    fireEvent.change(screen.getByLabelText("Filter files"), { target: { value: "theme" } });

    expect(screen.getByRole("button", { name: /theme\.css src\/styles M/ })).toBeVisible();
    expect(screen.queryByRole("button", { name: /DiffView\.tsx src\/components M/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /performance\.md docs U/ })).not.toBeInTheDocument();
  });

  it("clears the selected diff when switching repositories", () => {
    render(<App/>);

    fireEvent.click(screen.getByRole("button", { name: /orbit-api feature\/cache/ }));

    expect(screen.getByRole("heading", { name: "orbit-api" })).toBeVisible();
    expect(screen.getByRole("heading", { name: "Select a changed file" })).toBeVisible();
    expect(screen.queryByText("src/components/DiffView.tsx")).not.toBeInTheDocument();
  });

  it("opens a selected commit file diff lazily", async () => {
    render(<App/>);

    fireEvent.click(screen.getByRole("button", { name: "History" }));
    fireEvent.click(screen.getByRole("button", { name: /src\/diff\.ts M/ }));

    expect(await screen.findByRole("button", { name: "Back to commit details" })).toBeVisible();
    expect(screen.getByText(/@@ -18,8 \+18,12 @@/)).toBeVisible();
  });

  it("applies a hunk directly from its contextual action", () => {
    render(<App/>);

    fireEvent.click(screen.getByRole("button", { name: "Stage hunk" }));

    expect(screen.getByRole("status")).toHaveTextContent("Staged 1 selected hunks");
  });

  it("falls back to explicit wheel scrolling for nested diff panes", () => {
    const { container } = render(<App/>);
    const pane = container.querySelector<HTMLElement>(".diff-scroll");
    expect(pane).not.toBeNull();
    Object.defineProperties(pane!, {
      clientHeight: { configurable: true, value: 200 },
      scrollHeight: { configurable: true, value: 800 },
      scrollTop: { configurable: true, writable: true, value: 0 },
    });

    fireEvent.wheel(pane!, { deltaY: 120 });

    expect(pane!.scrollTop).toBe(120);
  });

  it("restores each repository's previous view and filter", () => {
    render(<App/>);

    fireEvent.change(screen.getByLabelText("Filter files"), { target: { value: "theme" } });
    fireEvent.click(screen.getByRole("button", { name: /orbit-api feature\/cache/ }));
    fireEvent.click(screen.getByRole("button", { name: /tempo main 4/ }));

    expect(screen.getByLabelText("Filter files")).toHaveValue("theme");
    expect(screen.getByRole("button", { name: /theme\.css src\/styles M/ })).toBeVisible();
  });
});
