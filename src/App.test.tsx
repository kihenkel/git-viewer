// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import App from "./App";

describe("App", () => {
  beforeEach(() => localStorage.clear());
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

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
    expect(screen.getByText("Changed files")).toBeVisible();
    expect(screen.getAllByRole("separator")).toHaveLength(2);
    expect(screen.getByRole("button", { name: /src\/diff\.ts M/ })).toHaveAttribute("aria-pressed", "true");
  });

  it("resizes local change panes with an accessible separator", () => {
    const { container } = render(<App/>);
    const workspace = container.querySelector<HTMLElement>(".changes-workspace");
    const separator = screen.getByRole("separator", { name: "Resize panels 1 and 2" });

    expect(workspace?.style.gridTemplateColumns).toBe("29fr 6px 71fr");
    fireEvent.keyDown(separator, { key: "ArrowRight" });

    expect(workspace?.style.gridTemplateColumns).toBe("31fr 6px 69fr");
  });

  it("applies a hunk directly from its contextual action", () => {
    render(<App/>);

    fireEvent.click(screen.getByRole("button", { name: "Stage hunk" }));

    expect(screen.getByRole("status")).toHaveTextContent("Staged 1 selected hunks");
  });

  it("confirms before discarding all tracked changes", () => {
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
    render(<App/>);

    fireEvent.click(screen.getByRole("button", { name: "Discard all" }));

    expect(confirm).toHaveBeenCalledWith(expect.stringContaining("This cannot be undone"));
    expect(confirm).toHaveBeenCalledWith(expect.stringContaining("Untracked files will be kept"));
    expect(screen.queryByText("Discard all changes is ready in the desktop app")).not.toBeInTheDocument();
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

  it("hides files matching applied rules only in Local changes", () => {
    render(<App/>);

    expect(screen.queryByRole("button", { name: "Hide matching files" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /Settings/ }));
    fireEvent.change(screen.getByLabelText("Hidden file patterns"), { target: { value: "*.md\nsrc/components/" } });
    fireEvent.click(screen.getByRole("button", { name: "Apply" }));
    fireEvent.click(screen.getByRole("button", { name: /Local changes/ }));

    expect(screen.queryByRole("button", { name: /performance\.md docs U/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /DiffView\.tsx src\/components M/ })).not.toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Select a changed file" })).toBeVisible();
    expect(screen.getByText("2 files hidden by rules")).toBeVisible();
    expect(screen.getByRole("button", { name: /Local changes\s*4/ })).toBeVisible();

    const toggle = screen.getByRole("button", { name: "Hide matching files" });
    expect(toggle).toHaveAttribute("aria-pressed", "true");
    fireEvent.click(toggle);

    expect(screen.getByRole("button", { name: /performance\.md docs U/ })).toBeVisible();
    expect(screen.queryByText(/hidden by rules/)).not.toBeInTheDocument();
    expect(JSON.parse(localStorage.getItem("hide-rules:/Users/demo/Projects/tempo") ?? "null")).toEqual({ patterns: ["*.md", "src/components/"], enabled: false });
  });

  it("does not apply rules while any pattern is invalid", () => {
    render(<App/>);

    fireEvent.click(screen.getByRole("button", { name: /Settings/ }));
    fireEvent.change(screen.getByLabelText("Hidden file patterns"), { target: { value: "*.md\nfile[abc" } });
    fireEvent.click(screen.getByRole("button", { name: "Apply" }));

    expect(screen.getByRole("alert")).toHaveTextContent("Line 2: Unbalanced [");
    expect(screen.getByText("Unapplied changes")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: /Local changes/ }));
    expect(screen.getByRole("button", { name: /performance\.md docs U/ })).toBeVisible();
    expect(screen.queryByRole("button", { name: "Hide matching files" })).not.toBeInTheDocument();
  });

  it("restores saved rules and warns about hidden files before discarding all", () => {
    localStorage.setItem("hide-rules:/Users/demo/Projects/tempo", JSON.stringify({ patterns: ["*.css"], enabled: true }));
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
    render(<App/>);

    expect(screen.queryByRole("button", { name: /theme\.css src\/styles M/ })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Discard all" }));

    expect(confirm).toHaveBeenCalledWith(expect.stringContaining("This includes 1 hidden file."));
  });
});
