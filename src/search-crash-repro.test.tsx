import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
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
      onOpen={() => {}}
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

describe("message row navigation", () => {
  it("routes a plain left click through the SPA callback", () => {
    const onOpen = vi.fn();
    const anchor = MessageRowContent({
      id: "message-id", who: "Sender", date: 0, subject: "Subject", snippet: "", bold: false,
      isOpen: false, onOpen,
    });
    const click = anchor.props.onClick as (event: unknown) => void;
    const preventDefault = vi.fn();
    click({
      defaultPrevented: false, button: 0, metaKey: false, ctrlKey: false, shiftKey: false, altKey: false,
      currentTarget: { getAttribute: () => null }, preventDefault,
    });
    expect(preventDefault).toHaveBeenCalledOnce();
    expect(onOpen).toHaveBeenCalledWith("message-id");
  });

  it("leaves modified clicks to the browser", () => {
    const onOpen = vi.fn();
    const anchor = MessageRowContent({
      id: "message-id", who: "Sender", date: 0, subject: "Subject", snippet: "", bold: false,
      isOpen: false, onOpen,
    });
    const click = anchor.props.onClick as (event: unknown) => void;
    const preventDefault = vi.fn();
    click({
      defaultPrevented: false, button: 0, metaKey: true, ctrlKey: false, shiftKey: false, altKey: false,
      currentTarget: { getAttribute: () => null }, preventDefault,
    });
    expect(preventDefault).not.toHaveBeenCalled();
    expect(onOpen).not.toHaveBeenCalled();
  });
});
