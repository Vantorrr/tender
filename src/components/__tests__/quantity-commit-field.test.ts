import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { QuantityCommitField } from "@/components/quantity-commit-field";

function controlDisabled(html: string, tag: "input" | "button"): boolean {
  const element = html.match(new RegExp(`<${tag}\\b[^>]*>`))?.[0] ?? "";
  const withoutClass = element.replace(/\sclass="[^"]*"/g, "");
  return /(?:\s|^)disabled(?:=|\s|>)/.test(withoutClass);
}

describe("quantity commit field", () => {
  it("blocks a locked volume so the draft is not presented as saved", () => {
    let saved = false;
    const html = renderToStaticMarkup(createElement(QuantityCommitField, {
      label: "Объём",
      value: 10,
      ariaLabel: "Объём земля",
      testId: "vor-qty-locked",
      disabled: true,
      onCommit: () => {
        saved = true;
      },
    }));
    expect(controlDisabled(html, "input")).toBe(true);
    expect(controlDisabled(html, "button")).toBe(true);
    expect(html).toContain("vor-qty-locked");
    expect(saved).toBe(false);
    const open = renderToStaticMarkup(createElement(QuantityCommitField, {
      label: "Объём",
      value: 10,
      ariaLabel: "Объём земля",
      testId: "vor-qty-open",
      onCommit: () => undefined,
    }));
    expect(open).toContain("vor-qty-open");
    expect(controlDisabled(open, "input")).toBe(false);
    expect(controlDisabled(open, "button")).toBe(false);
  });
});
