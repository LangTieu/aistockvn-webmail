import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { MessageRowContent } from "./shared-mail-views";

function renderSearchResult(item: { from?: { address?: string; name?: string } }) {
  const from = item.from;
  const avatarLabel = from ? from.name || from.address : "";
  return renderToStaticMarkup(
    <MessageRowContent
      id="search-result"
      avatarLabel={avatarLabel}
      who={avatarLabel ?? ""}
      date={0}
      subject="Search result"
      snippet=""
      bold={false}
      isOpen={false}
    />,
  );
}

describe("Inbox search result rendering", () => {
  it("renders a result with an empty malformed sender without throwing", () => {
    expect(() => renderSearchResult({ from: { address: undefined, name: undefined } })).not.toThrow();
    expect(renderSearchResult({ from: { address: undefined, name: undefined } })).toContain("?");
  });

  it("renders a result with no sender without throwing", () => {
    expect(() => renderSearchResult({})).not.toThrow();
    expect(renderSearchResult({})).toContain("?");
  });
});
