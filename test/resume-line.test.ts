import { describe, expect, test } from "bun:test";
import { patchResumeLine, rewriteResumeLine, type WritableLike } from "../src/resume-line";

describe("rewriteResumeLine", () => {
  test("rebrands pi's plain resume line", () => {
    expect(rewriteResumeLine("To resume this session: pi --session abc-123\n")).toBe(
      "To resume this session: npx free-pi-cli --session abc-123\n",
    );
  });

  test("preserves pi's own flags, including a non-default --session-dir", () => {
    const line = "To resume this session: pi --session-dir '/tmp/my sessions' --session abc-123\n";
    expect(rewriteResumeLine(line)).toBe(
      "To resume this session: npx free-pi-cli --session-dir '/tmp/my sessions' --session abc-123\n",
    );
  });

  test("rewrites through the dim ANSI styling pi wraps the label in", () => {
    const styled = "\u001b[2mTo resume this session:\u001b[22m pi --session abc-123\n";
    expect(rewriteResumeLine(styled)).toContain("npx free-pi-cli --session abc-123");
    expect(rewriteResumeLine(styled)).not.toMatch(/:\[22m pi /);
  });

  test("leaves an unrelated chunk byte-identical", () => {
    const chunk = "some other output mentioning pi and a session\n";
    expect(rewriteResumeLine(chunk)).toBe(chunk);
  });

  test("never rewrites a bare 'pi' elsewhere in a resume-line chunk", () => {
    // The word must directly follow the label to be treated as the command.
    const chunk = "To resume this session: pi --session x\nlater: pi is the harness\n";
    expect(rewriteResumeLine(chunk)).toBe(
      "To resume this session: npx free-pi-cli --session x\nlater: pi is the harness\n",
    );
  });
});

describe("patchResumeLine", () => {
  function fakeStream(): { stream: WritableLike; written: (string | Uint8Array)[] } {
    const written: (string | Uint8Array)[] = [];
    const stream: WritableLike = {
      write(chunk: string | Uint8Array): boolean {
        written.push(chunk);
        return true;
      },
    };
    return { stream, written };
  }

  test("rewrites the resume line on the way through", () => {
    const { stream, written } = fakeStream();
    patchResumeLine(stream);
    stream.write("To resume this session: pi --session abc\n");
    expect(written[0]).toBe("To resume this session: npx free-pi-cli --session abc\n");
  });

  test("passes non-string chunks through untouched (never corrupts TUI bytes)", () => {
    const { stream, written } = fakeStream();
    patchResumeLine(stream);
    const bytes = new Uint8Array([0x1b, 0x5b, 0x32, 0x4a]);
    stream.write(bytes);
    expect(written[0]).toBe(bytes);
  });

  test("restore() puts the original write back", () => {
    const { stream, written } = fakeStream();
    const restore = patchResumeLine(stream);
    restore();
    stream.write("To resume this session: pi --session abc\n");
    expect(written[0]).toBe("To resume this session: pi --session abc\n");
  });
});
